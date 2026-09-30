"""
The computation chain shared by the HTTP server and the auto-sync job:
snapshot analysis -> plan -> history -> forecasts -> risk / insights / advanced / report.
"""

from typing import Any, Dict, List, Optional, Tuple

import forecast
import forecast_tracking
import portfolio_advanced
import portfolio_insights
import portfolio_plan
import risk_tools
import weekly_report

History = Dict[str, List[Tuple[str, float]]]


def build_plan(analysis: Dict[str, Any], goal_pct: float = 20.0, goal_months: int = 12, monthly: float = 0.0) -> Dict[str, Any]:
    market = portfolio_plan.fetch_market_data([h["ticker"] for h in analysis["holdings"]])
    return portfolio_plan.build_plan(analysis, market, goal_pct, goal_months, monthly)


def forecasts_for(plan: Dict[str, Any], history: History) -> Dict[str, Any]:
    """Forecast every position; `history` is {ticker: [(date, close)]} including VNINDEX."""
    index = [c for _, c in history.get("VNINDEX", [])]
    out = {}
    for p in plan["positions"]:
        levels = {"breakeven": p["breakeven"], "stop_loss": p.get("stop_loss"), "target": p.get("target")}
        out[p["ticker"]] = forecast.forecast_ticker([c for _, c in history.get(p["ticker"], [])], index, levels)
    forecast_tracking.log_forecasts(out)  # keep score of our own forecasts week by week
    return out


def history_for(tickers: List[str], years: int = 5) -> History:
    return risk_tools.fetch_dated_history(list(dict.fromkeys(tickers + ["VNINDEX"])), years=years)


def betas_for(analysis: Dict[str, Any], history: History) -> Dict[str, Optional[float]]:
    tickers = [h["ticker"] for h in analysis["holdings"]]
    bench = portfolio_insights.benchmark(analysis["holdings"], {t: {"closes": history.get(t, [])} for t in tickers},
                                         history.get("VNINDEX", []), analysis["summary"]["nav"])
    return {row["ticker"]: row["beta"] for row in bench["stocks"]}


def risk_context(analysis: Dict[str, Any], risk_pct: float = 1.0) -> Dict[str, Any]:
    """Plan, 5-year history, forecasts, betas and risk tools in one pass."""
    plan = build_plan(analysis)
    history = history_for([h["ticker"] for h in analysis["holdings"]])
    forecasts = forecasts_for(plan, history)
    betas = betas_for(analysis, history)
    risk = risk_tools.build_risk(analysis, plan, history, forecasts, betas, risk_pct)
    return {"plan": plan, "history": history, "forecasts": forecasts, "betas": betas, "risk": risk}


def companies_for(tickers: List[str]) -> Dict[str, Dict[str, Any]]:
    import os
    import sys

    api_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "api"))
    if api_dir not in sys.path:
        sys.path.append(api_dir)  # append: api/agents.py must not shadow the backend agents package
    import _vci
    from concurrent.futures import ThreadPoolExecutor
    from company_cache import cached_profiles

    out = cached_profiles(tickers)          # local database first: instant
    missing = [t for t in tickers if t not in out]

    def one(t: str) -> Dict[str, Any]:
        try:
            return _vci.company_info(t) or {}
        except Exception:
            return {}

    # Vietcap's profile endpoint takes seconds per call; fetch what the database lacks in parallel.
    if missing:
        with ThreadPoolExecutor(max_workers=8) as pool:
            out.update(dict(zip(missing, pool.map(one, missing))))
    return {t: out.get(t, {}) for t in tickers}


def insights(analysis: Dict[str, Any]) -> Dict[str, Any]:
    tickers = [h["ticker"] for h in analysis["holdings"]]
    market = portfolio_plan.fetch_market_data(tickers)
    index_closes, companies, news = portfolio_insights.fetch_insight_data(tickers)
    return portfolio_insights.build_insights(analysis, market, index_closes, companies, news)


def advanced(analysis: Dict[str, Any], with_alternatives: bool = False) -> Dict[str, Any]:
    holdings = analysis["holdings"]
    tickers = [h["ticker"] for h in holdings]
    universe = portfolio_advanced.fetch_universe(tickers) if with_alternatives else []
    history = history_for(tickers + universe, years=3)
    companies = companies_for(list(dict.fromkeys(tickers + universe)))
    s = analysis["summary"]
    stock_pct = s["stock_value"] / s["nav"] * 100 if s["nav"] else 0.0
    total = sum(h["market_value"] for h in holdings) or 1.0
    out: Dict[str, Any] = {
        "correlation": portfolio_advanced.correlation_clusters(tickers, history),
        "regime": portfolio_advanced.market_regime([c for _, c in history.get("VNINDEX", [])], stock_pct),
        "black_litterman": portfolio_advanced.black_litterman(
            tickers, history, {t: (companies.get(t) or {}).get("marketCap") for t in tickers},
            portfolio_advanced.analyst_views({t: companies.get(t) for t in tickers}, {h["ticker"]: h["price"] for h in holdings}),
            {h["ticker"]: h["market_value"] / total for h in holdings}),
    }
    if with_alternatives:
        weak = [h["ticker"] for h in holdings if h["pnl_pct"] <= -7]
        for h in holdings:  # also anything trading below its 200-session average
            px = [c for _, c in history.get(h["ticker"], [])]
            if len(px) >= 200 and px[-1] < sum(px[-200:]) / 200 and h["ticker"] not in weak:
                weak.append(h["ticker"])
        out["alternatives"] = portfolio_advanced.alternatives(holdings, weak, history, companies, universe)
    return out


def sectors_for(tickers: List[str]) -> Dict[str, str]:
    return {t: (c or {}).get("sectorVn") for t, c in companies_for(tickers).items() if (c or {}).get("sectorVn")}


def weekly_report_now(analysis: Dict[str, Any]) -> Dict[str, str]:
    ctx = risk_context(analysis)
    markdown = weekly_report.build_report(analysis, ctx["plan"], insights(analysis), ctx["forecasts"], ctx["risk"])
    return {"name": weekly_report.save_report(markdown), "markdown": markdown}
