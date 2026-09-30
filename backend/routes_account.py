"""Read-only TCBS account endpoints: sync, plan, insights, forecasts, risk, journal, reports, tools."""

import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

import autosync
import forecast
import forecast_tracking
import nav_history
import notify
import personal_rules
import pipeline
import portfolio_insights
import portfolio_plan
import pretrade
import quant_service
import tcbs_account
import weekly_report
from agents.llm import call_llm, normalize_provider, resolve_api_key, LLMError, DEFAULT_MODELS
from agents.prompts import PORTFOLIO_REVIEW_PROMPT, GROUNDING_RULES
from guards import _require_local
from routes_quant import _need_data

router = APIRouter()


def _tcbs_http_error(e: "tcbs_account.TcbsError") -> HTTPException:
    return HTTPException(status_code=401 if e.needs_login else 502,
                         detail={"message": str(e), "needs_login": e.needs_login})


class TcbsLoginRequest(BaseModel):
    otp: str


class PortfolioReviewRequest(BaseModel):
    provider: Optional[str] = "gemini"
    apiKey: Optional[str] = None
    model: Optional[str] = None


class PortfolioPlanRequest(BaseModel):
    goalPct: float = Field(default=20.0, gt=0, le=500)
    goalMonths: int = Field(default=12, ge=1, le=60)
    monthlyContribution: float = Field(default=0, ge=0, le=100_000_000_000)


def _analysis_or_404():
    snapshot = tcbs_account.load_snapshot()
    if not snapshot:
        raise HTTPException(status_code=404, detail={"message": "Chưa đồng bộ dữ liệu TCBS.", "needs_login": False})
    return tcbs_account.analyze_snapshot(snapshot)


_build_plan = pipeline.build_plan


@router.get("/api/account/status")
def api_account_status(request: Request):
    _require_local(request)
    return tcbs_account.status()


@router.post("/api/account/login")
def api_account_login(req: TcbsLoginRequest, request: Request):
    _require_local(request)
    try:
        tcbs_account.login(req.otp)
    except tcbs_account.TcbsError as e:
        raise HTTPException(status_code=400, detail={"message": str(e), "needs_login": True})
    return tcbs_account.status()


@router.post("/api/account/sync")
def api_account_sync(request: Request):
    _require_local(request)
    try:
        snapshot = tcbs_account.sync()
    except tcbs_account.TcbsError as e:
        raise _tcbs_http_error(e)
    return tcbs_account.analyze_snapshot(snapshot)


@router.get("/api/account/portfolio")
def api_account_portfolio(request: Request):
    _require_local(request)
    return _analysis_or_404()


@router.post("/api/account/plan")
def api_account_plan(req: PortfolioPlanRequest, request: Request):
    _require_local(request)
    return _build_plan(_analysis_or_404(), req.goalPct, req.goalMonths, req.monthlyContribution)


@router.get("/api/account/insights")
def api_account_insights(request: Request):
    _require_local(request)
    return pipeline.insights(_analysis_or_404())


@router.get("/api/account/forecast")
def api_account_forecast(request: Request):
    _require_local(request)
    analysis = _analysis_or_404()
    history = pipeline.history_for([h["ticker"] for h in analysis["holdings"]], years=3)
    return {"forecasts": pipeline.forecasts_for(_build_plan(analysis), history),
            "method": "GARCH(1,1) + Filtered Historical Simulation (stationary bootstrap), walk-forward validated"}


@router.get("/api/account/risk")
def api_account_risk(request: Request, riskPct: float = Query(default=1.0, gt=0, le=10)):
    _require_local(request)
    return pipeline.risk_context(_analysis_or_404(), riskPct)["risk"]


class TradeNoteRequest(BaseModel):
    key: str = Field(max_length=200)
    tag: Optional[str] = None
    note: str = Field(default="", max_length=300)


@router.post("/api/account/journal/note")
def api_account_journal_note(req: TradeNoteRequest, request: Request):
    _require_local(request)
    try:
        return portfolio_insights.set_note(req.key, req.tag, req.note)
    except KeyError as e:
        raise HTTPException(status_code=404, detail={"message": str(e.args[0]), "needs_login": False})
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"message": str(e), "needs_login": False})


@router.post("/api/account/report")
def api_account_report(request: Request):
    _require_local(request)
    return pipeline.weekly_report_now(_analysis_or_404())


@router.get("/api/account/reports")
def api_account_reports(request: Request):
    _require_local(request)
    return {"reports": weekly_report.list_reports(), "current_week": weekly_report.week_id()}


@router.get("/api/account/reports/{name}")
def api_account_report_get(name: str, request: Request):
    _require_local(request)
    markdown = weekly_report.read_report(name)
    if markdown is None:
        raise HTTPException(status_code=404, detail={"message": "Không có báo cáo này.", "needs_login": False})
    return {"name": name, "markdown": markdown}


def _bad_request(e: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail={"message": str(e), "needs_login": False})


def _vnd_input(v: Optional[float]) -> Optional[float]:
    """Accept prices typed in thousand VND (25.5) or VND (25500)."""
    return None if v is None else (v * 1000 if 0 < v < 1000 else v)


@router.get("/api/account/nav")
def api_account_nav(request: Request):
    _require_local(request)
    h = nav_history.load()
    days = sorted(h["days"])
    index = pipeline.history_for([], years=max(1, (len(days) // 250) + 1)).get("VNINDEX", []) if days else []
    led = tcbs_account.load_ledger()
    out = nav_history.metrics(h, index, tcbs_account.ledger_flows(led), led.get("covered_from"), led.get("covered_to"))
    out["cash_ledger"] = tcbs_account.ledger_summary(led)
    return out


@router.get("/api/account/attribution")
def api_account_attribution(request: Request):
    _require_local(request)
    h = nav_history.load()
    if len(h["days"]) < 2:
        return {"days": len(h["days"]), "by_ticker": [], "by_sector": [], "price_pnl": 0, "other": 0, "since": None}
    tickers = sorted({t for d in h["days"].values() for t in d["positions"]})
    from company_cache import cached_profiles
    sectors = {t: p["sectorVn"] for t, p in cached_profiles(tickers).items() if p.get("sectorVn")}
    lookup = None
    try:
        import market_db
        panel = market_db.price_panel(tickers, since=min(h["days"]))
        def lookup(t, day):  # noqa: E306  (closed positions: last stored close on or before `day`)
            rows = [c for d, c, _ in panel.get(t, []) if d <= day]
            return rows[-1] if rows else None
    except Exception:
        pass
    led = tcbs_account.load_ledger()
    points = nav_history.metrics(h, [], tcbs_account.ledger_flows(led), led.get("covered_from"), led.get("covered_to"))["points"]
    return nav_history.attribution(h, sectors, lookup, points)


class NavFlowRequest(BaseModel):
    date: str
    amount: Optional[float] = None


@router.post("/api/account/nav/flow")
def api_account_nav_flow(req: NavFlowRequest, request: Request):
    _require_local(request)
    try:
        nav_history.set_flow(req.date, req.amount)
    except ValueError as e:
        raise _bad_request(e)
    return {"ok": True}


@router.get("/api/account/rules")
def api_account_rules(request: Request):
    _require_local(request)
    rules = personal_rules.load_rules()
    snapshot = tcbs_account.load_snapshot()
    violations = []
    if snapshot:
        analysis = tcbs_account.analyze_snapshot(snapshot)
        violations = personal_rules.evaluate(analysis, pipeline.sectors_for([h["ticker"] for h in analysis["holdings"]]), rules)
    return {"rules": rules, "violations": violations, "tags": list(portfolio_insights.TRADE_TAGS)}


@router.post("/api/account/rules")
def api_account_rules_save(update: dict, request: Request):
    _require_local(request)
    try:
        personal_rules.save_rules(update)
    except (ValueError, TypeError) as e:
        raise _bad_request(e)
    return api_account_rules(request)


class PretradeRequest(BaseModel):
    ticker: str = Field(pattern=r"^[A-Za-z0-9]{1,6}$")
    price: float = Field(gt=0)
    stop: float = Field(gt=0)
    target: Optional[float] = Field(default=None, gt=0)
    quantity: Optional[int] = Field(default=None, gt=0)


@router.post("/api/account/pretrade")
def api_account_pretrade(req: PretradeRequest, request: Request):
    _require_local(request)
    analysis = _analysis_or_404()
    ticker = req.ticker.upper()
    price, stop, target = _vnd_input(req.price), _vnd_input(req.stop), _vnd_input(req.target)
    tickers = [h["ticker"] for h in analysis["holdings"]]
    history = pipeline.history_for(tickers + [ticker], years=3)
    companies = pipeline.companies_for(list(dict.fromkeys(tickers + [ticker])))
    sectors = {t: c.get("sectorVn") for t, c in companies.items() if c.get("sectorVn")}
    levels = {"breakeven": None, "stop_loss": stop, "target": target or companies.get(ticker, {}).get("targetPrice")}
    fc = forecast.forecast_ticker([c for _, c in history.get(ticker, [])], [c for _, c in history.get("VNINDEX", [])], levels, validate=False)
    import portfolio_advanced
    s = analysis["summary"]
    regime = portfolio_advanced.market_regime([c for _, c in history.get("VNINDEX", [])], s["stock_value"] / s["nav"] * 100 if s["nav"] else 0)
    import _vci
    try:
        news = _vci.company_news(ticker, days=30, size=20)
    except Exception:
        news = []
    from company_cache import avg_traded_value
    result = pretrade.run_checks(analysis, personal_rules.load_rules(), ticker, price, stop, target, req.quantity,
                                 companies.get(ticker) or {}, sectors, history, fc, regime, news,
                                 adv_value=avg_traded_value(ticker))
    return {"ticker": ticker, "price": round(price), "stop": round(stop), "target": round(target) if target else None, **result}


class TradePlanRequest(BaseModel):
    ticker: str = Field(pattern=r"^[A-Za-z0-9]{1,6}$")
    price: float = Field(gt=0)
    stop: float = Field(gt=0)
    target: Optional[float] = None
    quantity: Optional[int] = None
    reason: Optional[str] = None
    note: str = Field(default="", max_length=300)
    verdict: Optional[str] = None


@router.post("/api/account/pretrade/plan")
def api_account_pretrade_plan(req: TradePlanRequest, request: Request):
    _require_local(request)
    from datetime import date as _date
    try:
        return portfolio_insights.add_plan({"date": _date.today().isoformat(), "ticker": req.ticker.upper(),
                                            "price": _vnd_input(req.price), "stop": _vnd_input(req.stop), "target": _vnd_input(req.target),
                                            "quantity": req.quantity, "reason": req.reason, "note": req.note, "verdict": req.verdict})
    except ValueError as e:
        raise _bad_request(e)


@router.get("/api/account/forecast/score")
def api_account_forecast_score(request: Request):
    _require_local(request)
    log = forecast_tracking.load_log()
    tickers = sorted({e["ticker"] for e in log.values()})
    history = pipeline.history_for(tickers, years=1) if tickers else {}
    return forecast_tracking.score(log, history)


@router.get("/api/account/advanced")
def api_account_advanced(request: Request, alternatives: bool = Query(default=False)):
    _require_local(request)
    return pipeline.advanced(_analysis_or_404(), alternatives)


@router.get("/api/account/autosync")
def api_account_autosync(request: Request):
    _require_local(request)
    tail = []
    if os.path.isfile(autosync.LOG):
        with open(autosync.LOG, encoding="utf-8", errors="replace") as f:
            tail = f.read().splitlines()[-5:]
    return {"installed": autosync.installed(), "mode": autosync.mode(), "times": [f"{h:02d}:{m:02d}" for h, m in autosync.TIMES],
            "telegram_configured": bool(os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID")),
            "log": tail}


class AutosyncRequest(BaseModel):
    enable: bool


@router.post("/api/account/autosync")
def api_account_autosync_set(req: AutosyncRequest, request: Request):
    _require_local(request)
    try:
        autosync.install() if req.enable else autosync.uninstall()
    except Exception as e:
        raise _bad_request(e)
    return api_account_autosync(request)


@router.post("/api/account/notify/test")
def api_account_notify_test(request: Request):
    _require_local(request)
    return notify.deliver([{"id": "test", "text": "✅ TraderAI: thông báo thử nghiệm hoạt động."}])


@router.get("/api/account/factors")
def api_account_factors(request: Request):
    _require_local(request)
    _need_data()
    analysis = _analysis_or_404()
    nav = nav_history.metrics(nav_history.load(), [])
    return quant_service.portfolio_regression(analysis["holdings"], nav.get("points", []))


@router.get("/api/account/grades")
def api_account_grades(request: Request):
    _require_local(request)
    _need_data()
    analysis = _analysis_or_404()
    out = []
    for h in analysis["holdings"]:
        card = quant_service.stock_card(h["ticker"])
        out.append({"ticker": h["ticker"], "weight_pct": h["weight_pct"], "card": card})
    return {"holdings": out}


@router.post("/api/account/review")
def api_account_review(req: PortfolioReviewRequest, request: Request):
    _require_local(request)
    analysis = _analysis_or_404()
    provider = normalize_provider(req.provider)
    api_key = resolve_api_key(provider, req.apiKey)
    if api_key and analysis["holdings"]:
        model = req.model or DEFAULT_MODELS.get(provider)
        try:
            text = call_llm(
                prompt=f"{tcbs_account.llm_portfolio_brief(analysis)}\n\n{portfolio_plan.plan_brief(_build_plan(analysis))}",
                system_prompt=f"{PORTFOLIO_REVIEW_PROMPT}\n\n{GROUNDING_RULES}",
                provider=provider, api_key=api_key, model=model,
            )
            return {"content": text, "engine": f"{provider}:{model}"}
        except LLMError as e:
            return {"content": tcbs_account.heuristic_review(analysis), "engine": "heuristic",
                    "warning": f"LLM gặp lỗi, dùng chế độ Heuristic: {e}"}
    return {"content": tcbs_account.heuristic_review(analysis), "engine": "heuristic"}
