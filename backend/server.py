"""
TraderAI Backend - FastAPI server for local development.

This is a thin HTTP wrapper around the same data-fetching logic used by the
Vercel serverless functions in api/*.py, so there is a single source of
truth for how TCBS/vnstock data is fetched, cached, and normalized.
Run: python3 backend/server.py
"""

import warnings
warnings.filterwarnings('ignore')

import os
import sys
from datetime import datetime, timedelta
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'api'))
from market import get_market_overview, get_market_analysis  # noqa: E402
from stocks import get_top_stocks, get_symbols  # noqa: E402
from finance import get_finance  # noqa: E402
from history import get_history  # noqa: E402
from news import get_news as _get_news  # noqa: E402

app = FastAPI(title="TraderAI API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/market")
def api_market(action: Optional[str] = Query(default=None)):
    # Matches api/market.py's query-param convention (?action=analysis),
    # since the frontend calls this same path either way.
    return get_market_analysis() if action == 'analysis' else get_market_overview()


@app.get("/api/stocks")
def api_stocks(count: int = Query(default=20, ge=1, le=50), action: Optional[str] = Query(default=None)):
    # ?action=symbols -> every listed stock, for search autocomplete
    return get_symbols() if action == 'symbols' else get_top_stocks(count)


@app.get("/api/history")
def api_history(
    ticker: str = Query(..., description="Stock ticker symbol"),
    start: Optional[str] = Query(default=None, description="Start date YYYY-MM-DD"),
    end: Optional[str] = Query(default=None, description="End date YYYY-MM-DD"),
):
    if not end:
        end = datetime.now().strftime('%Y-%m-%d')
    if not start:
        start = (datetime.now() - timedelta(days=120)).strftime('%Y-%m-%d')
    return get_history(ticker, start, end)


@app.get("/api/finance")
def api_finance(ticker: str = Query(...)):
    return get_finance(ticker)


@app.get("/api/listing")
def api_listing():
    """Get all listed stocks using vnstock (no TCBS equivalent, kept local-only)."""
    try:
        from vnstock import listing_companies
        df = listing_companies()
        stocks = []
        for _, row in df.iterrows():
            stocks.append({
                "ticker": row.get('ticker', ''),
                "name": row.get('organShortName', row.get('organName', '')),
                "exchange": row.get('comGroupCode', ''),
                "industry": row.get('icbName', ''),
                "vn30": bool(row.get('VN30', False)),
            })
        return {"data": stocks, "total": len(stocks), "source": "vnstock"}
    except Exception as e:
        return {"data": [], "total": 0, "source": "error", "error": str(e)}


@app.get("/api/news")
def api_news(
    ticker: Optional[str] = Query(default=None),
    tickers: Optional[str] = Query(default=None),
    action: Optional[str] = Query(default=None),
):
    return _get_news(ticker=ticker, tickers=tickers, action=action)


# ==========================================
# Multi-Agent Council Endpoints (TradingAgents)
# ==========================================
import json  # noqa: E402

from fastapi import HTTPException  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402


def _load_env_files():
    """Minimal .env loader (backend/.env, project .env, then .env.local) so GEMINI_API_KEY / OPENAI_API_KEY work locally."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for path in (os.path.join(root, 'backend', '.env'), os.path.join(root, '.env'), os.path.join(root, '.env.local')):
        if not os.path.isfile(path):
            continue
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_files()

sys.path.insert(0, os.path.dirname(__file__))
from agents.council import AgentCouncil, validate_ticker  # noqa: E402
from agents.llm import DEFAULT_MODELS  # noqa: E402


class AgentAnalyzeRequest(BaseModel):
    ticker: str
    provider: Optional[str] = "gemini"
    # Sent in the body (never the URL) so keys don't end up in access logs
    apiKey: Optional[str] = None
    model: Optional[str] = None


def _council_for(req: AgentAnalyzeRequest) -> AgentCouncil:
    try:
        validate_ticker(req.ticker)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return AgentCouncil(provider=req.provider or "gemini", api_key=req.apiKey, model=req.model)


@app.get("/api/agents/config")
def api_agents_config():
    gemini_env = bool(os.environ.get("GEMINI_API_KEY"))
    openai_env = bool(os.environ.get("OPENAI_API_KEY"))
    return {
        "has_gemini_env": gemini_env,
        "has_openai_env": openai_env,
        "active_provider": "gemini" if gemini_env else ("openai" if openai_env else "heuristic"),
        "default_models": DEFAULT_MODELS,
    }


@app.post("/api/agents/analyze")
def api_agents_analyze(req: AgentAnalyzeRequest):
    return _council_for(req).run_council(req.ticker)


@app.post("/api/agents/stream")
def api_agents_stream(req: AgentAnalyzeRequest):
    council = _council_for(req)

    def event_generator():
        try:
            for event in council.run_council_stream(req.ticker):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as e:  # surface failures to the UI instead of silently cutting the stream
            err = {"type": "error", "message": f"Lỗi hội đồng AI: {e}"}
            yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ==========================================
# TCBS account (read-only, local machine only)
# ==========================================
import ipaddress  # noqa: E402
from urllib.parse import urlparse  # noqa: E402

from fastapi import Request  # noqa: E402

import tcbs_account  # noqa: E402
import storage as storage_mod  # noqa: E402
import portfolio_plan  # noqa: E402
import portfolio_insights  # noqa: E402
import forecast  # noqa: E402
import risk_tools  # noqa: E402
import weekly_report  # noqa: E402
import pipeline  # noqa: E402
import nav_history  # noqa: E402
import personal_rules  # noqa: E402
import pretrade  # noqa: E402
import forecast_tracking  # noqa: E402
import autosync  # noqa: E402
import notify  # noqa: E402
from agents.llm import call_llm, normalize_provider, resolve_api_key, LLMError  # noqa: E402
from agents.prompts import PORTFOLIO_REVIEW_PROMPT, GROUNDING_RULES  # noqa: E402

_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}
# Docker: requests reach the backend from the nginx container, not 127.0.0.1. docker-compose sets
# ACCOUNT_TRUSTED_NETWORKS to its private bridge network and publishes ports on 127.0.0.1 only.
_TRUSTED_NETS = [ipaddress.ip_network(n.strip()) for n in os.environ.get("ACCOUNT_TRUSTED_NETWORKS", "").split(",") if n.strip()]


def _is_trusted_client(host: str) -> bool:
    if host in _LOCAL_HOSTS:
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(ip in net for net in _TRUSTED_NETS)


def _require_local(request: Request) -> None:
    """Account data must not leak: the server binds 0.0.0.0 and CORS allows any origin,
    so reject callers from other machines and pages served from other sites."""
    client = request.client.host if request.client else ""
    origin = request.headers.get("origin")
    if not _is_trusted_client(client) or (origin and urlparse(origin).hostname not in _LOCAL_HOSTS):
        raise HTTPException(status_code=403, detail="Dữ liệu tài khoản TCBS chỉ truy cập được từ máy local.")


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


@app.get("/api/account/status")
def api_account_status(request: Request):
    _require_local(request)
    return tcbs_account.status()


@app.post("/api/account/login")
def api_account_login(req: TcbsLoginRequest, request: Request):
    _require_local(request)
    try:
        tcbs_account.login(req.otp)
    except tcbs_account.TcbsError as e:
        raise HTTPException(status_code=400, detail={"message": str(e), "needs_login": True})
    return tcbs_account.status()


@app.post("/api/account/sync")
def api_account_sync(request: Request):
    _require_local(request)
    try:
        snapshot = tcbs_account.sync()
    except tcbs_account.TcbsError as e:
        raise _tcbs_http_error(e)
    return tcbs_account.analyze_snapshot(snapshot)


@app.get("/api/account/portfolio")
def api_account_portfolio(request: Request):
    _require_local(request)
    return _analysis_or_404()


@app.post("/api/account/plan")
def api_account_plan(req: PortfolioPlanRequest, request: Request):
    _require_local(request)
    return _build_plan(_analysis_or_404(), req.goalPct, req.goalMonths, req.monthlyContribution)


@app.get("/api/account/insights")
def api_account_insights(request: Request):
    _require_local(request)
    return pipeline.insights(_analysis_or_404())


@app.get("/api/account/forecast")
def api_account_forecast(request: Request):
    _require_local(request)
    analysis = _analysis_or_404()
    history = pipeline.history_for([h["ticker"] for h in analysis["holdings"]], years=3)
    return {"forecasts": pipeline.forecasts_for(_build_plan(analysis), history),
            "method": "GARCH(1,1) + Filtered Historical Simulation (stationary bootstrap), walk-forward validated"}


@app.get("/api/account/risk")
def api_account_risk(request: Request, riskPct: float = Query(default=1.0, gt=0, le=10)):
    _require_local(request)
    return pipeline.risk_context(_analysis_or_404(), riskPct)["risk"]


class TradeNoteRequest(BaseModel):
    key: str = Field(max_length=200)
    tag: Optional[str] = None
    note: str = Field(default="", max_length=300)


@app.post("/api/account/journal/note")
def api_account_journal_note(req: TradeNoteRequest, request: Request):
    _require_local(request)
    try:
        return portfolio_insights.set_note(req.key, req.tag, req.note)
    except KeyError as e:
        raise HTTPException(status_code=404, detail={"message": str(e.args[0]), "needs_login": False})
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"message": str(e), "needs_login": False})


@app.post("/api/account/report")
def api_account_report(request: Request):
    _require_local(request)
    return pipeline.weekly_report_now(_analysis_or_404())


@app.get("/api/account/reports")
def api_account_reports(request: Request):
    _require_local(request)
    return {"reports": weekly_report.list_reports(), "current_week": weekly_report.week_id()}


@app.get("/api/account/reports/{name}")
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


@app.get("/api/account/nav")
def api_account_nav(request: Request):
    _require_local(request)
    h = nav_history.load()
    days = sorted(h["days"])
    index = pipeline.history_for([], years=max(1, (len(days) // 250) + 1)).get("VNINDEX", []) if days else []
    return nav_history.metrics(h, index)


class NavFlowRequest(BaseModel):
    date: str
    amount: Optional[float] = None


@app.post("/api/account/nav/flow")
def api_account_nav_flow(req: NavFlowRequest, request: Request):
    _require_local(request)
    try:
        nav_history.set_flow(req.date, req.amount)
    except ValueError as e:
        raise _bad_request(e)
    return {"ok": True}


@app.get("/api/account/rules")
def api_account_rules(request: Request):
    _require_local(request)
    rules = personal_rules.load_rules()
    snapshot = tcbs_account.load_snapshot()
    violations = []
    if snapshot:
        analysis = tcbs_account.analyze_snapshot(snapshot)
        violations = personal_rules.evaluate(analysis, pipeline.sectors_for([h["ticker"] for h in analysis["holdings"]]), rules)
    return {"rules": rules, "violations": violations, "tags": list(portfolio_insights.TRADE_TAGS)}


@app.post("/api/account/rules")
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


@app.post("/api/account/pretrade")
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
    result = pretrade.run_checks(analysis, personal_rules.load_rules(), ticker, price, stop, target, req.quantity,
                                 companies.get(ticker) or {}, sectors, history, fc, regime, news)
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


@app.post("/api/account/pretrade/plan")
def api_account_pretrade_plan(req: TradePlanRequest, request: Request):
    _require_local(request)
    from datetime import date as _date
    try:
        return portfolio_insights.add_plan({"date": _date.today().isoformat(), "ticker": req.ticker.upper(),
                                            "price": _vnd_input(req.price), "stop": _vnd_input(req.stop), "target": _vnd_input(req.target),
                                            "quantity": req.quantity, "reason": req.reason, "note": req.note, "verdict": req.verdict})
    except ValueError as e:
        raise _bad_request(e)


@app.get("/api/account/forecast/score")
def api_account_forecast_score(request: Request):
    _require_local(request)
    log = forecast_tracking.load_log()
    tickers = sorted({e["ticker"] for e in log.values()})
    history = pipeline.history_for(tickers, years=1) if tickers else {}
    return forecast_tracking.score(log, history)


@app.get("/api/account/advanced")
def api_account_advanced(request: Request, alternatives: bool = Query(default=False)):
    _require_local(request)
    return pipeline.advanced(_analysis_or_404(), alternatives)


@app.get("/api/account/autosync")
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


@app.post("/api/account/autosync")
def api_account_autosync_set(req: AutosyncRequest, request: Request):
    _require_local(request)
    try:
        autosync.install() if req.enable else autosync.uninstall()
    except Exception as e:
        raise _bad_request(e)
    return api_account_autosync(request)


@app.post("/api/account/notify/test")
def api_account_notify_test(request: Request):
    _require_local(request)
    return notify.deliver([{"id": "test", "text": "✅ TraderAI: thông báo thử nghiệm hoạt động."}])


# ==========================================
# Quant: market database, scores, validation, market views
# ==========================================
import threading as _threading  # noqa: E402

import quant_service  # noqa: E402
import market_views  # noqa: E402

_market_cache: dict = {}


@app.get("/api/quant/status")
def api_quant_status():
    return quant_service.status()


@app.post("/api/quant/ingest")
def api_quant_ingest(request: Request, quick: bool = Query(default=False)):
    _require_local(request)  # heavy job: only from this machine
    if quant_service.status().get("running"):
        return {"started": False, "message": "Đang chạy."}
    _threading.Thread(target=quant_service.run_pipeline, kwargs={"quick": quick}, daemon=True).start()
    _market_cache.clear()
    return {"started": True}


def _need_data():
    if not quant_service.available():
        raise HTTPException(status_code=404, detail={"message": "Chưa có dữ liệu thị trường — bấm 'Nạp dữ liệu'.", "needs_login": False})


@app.get("/api/quant/screener")
def api_quant_screener(sector: Optional[str] = None, grade: Optional[str] = Query(default=None, pattern="^[A-F]$"),
                       limit: int = Query(default=100, ge=1, le=400)):
    _need_data()
    return quant_service.screener(sector, grade, limit)


@app.get("/api/quant/stock/{ticker}")
def api_quant_stock(ticker: str):
    _need_data()
    try:
        validate_ticker(ticker)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    card = quant_service.stock_card(ticker)
    if not card:
        raise HTTPException(status_code=404, detail={"message": "Mã này chưa đủ thanh khoản hoặc chưa có BCTC để chấm điểm.", "needs_login": False})
    return card


@app.get("/api/quant/validation")
def api_quant_validation():
    _need_data()
    v = quant_service.validation_summary()
    if not v:
        raise HTTPException(status_code=404, detail={"message": "Chưa chạy kiểm định.", "needs_login": False})
    return v


@app.get("/api/quant/market")
def api_quant_market():
    _need_data()
    import time as _time
    hit = _market_cache.get("views")
    if not hit or _time.time() - hit[0] > 600:
        _market_cache["views"] = (_time.time(), market_views.all_views())
    return _market_cache["views"][1]


@app.get("/api/account/factors")
def api_account_factors(request: Request):
    _require_local(request)
    _need_data()
    analysis = _analysis_or_404()
    nav = nav_history.metrics(nav_history.load(), [])
    return quant_service.portfolio_regression(analysis["holdings"], nav.get("points", []))


@app.get("/api/account/grades")
def api_account_grades(request: Request):
    _require_local(request)
    _need_data()
    analysis = _analysis_or_404()
    out = []
    for h in analysis["holdings"]:
        card = quant_service.stock_card(h["ticker"])
        out.append({"ticker": h["ticker"], "weight_pct": h["weight_pct"], "card": card})
    return {"holdings": out}


@app.post("/api/account/review")
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


if storage_mod.using_database():
    print(f"🗄️  Storage: Postgres (imported {storage_mod.import_files_once()} existing runtime documents)")

if __name__ == "__main__":
    print("🚀 TraderAI Backend starting...")
    print("📊 Reusing api/*.py data-fetching logic (SSI + DNSE + Vietcap)")
    print("🤖 Multi-Agent Council (TradingAgents) enabled at /api/agents/*")
    print("🌐 API docs: http://localhost:8000/docs")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
