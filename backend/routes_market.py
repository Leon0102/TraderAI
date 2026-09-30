"""Public market data endpoints (same data layer as the Vercel functions in api/)."""

import os
import sys
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Query

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "api"))  # append: api/agents.py must not shadow backend/agents
from market import get_market_overview, get_market_analysis  # noqa: E402
from stocks import get_top_stocks, get_symbols  # noqa: E402
from finance import get_finance  # noqa: E402
from history import get_history  # noqa: E402
from news import get_news as _get_news  # noqa: E402

router = APIRouter()


@router.get("/api/market")
def api_market(action: Optional[str] = Query(default=None)):
    # Matches api/market.py's query-param convention (?action=analysis),
    # since the frontend calls this same path either way.
    return get_market_analysis() if action == 'analysis' else get_market_overview()


@router.get("/api/stocks")
def api_stocks(count: int = Query(default=20, ge=1, le=50), action: Optional[str] = Query(default=None)):
    # ?action=symbols -> every listed stock, for search autocomplete
    return get_symbols() if action == 'symbols' else get_top_stocks(count)


@router.get("/api/history")
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


@router.get("/api/finance")
def api_finance(ticker: str = Query(...)):
    result = get_finance(ticker)
    if result.get("source") == "error" or not result.get("data"):
        # Vietcap/TCBS gave nothing (e.g. no ratio row for this ticker): compute from our own
        # database of published statements instead of dropping to demo data.
        try:
            import quant_service
            local = quant_service.local_finance(ticker)
        except Exception:
            local = None
        if local:
            return {"data": local, "source": "local"}
    return result


@router.get("/api/listing")
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


@router.get("/api/news")
def api_news(
    ticker: Optional[str] = Query(default=None),
    tickers: Optional[str] = Query(default=None),
    action: Optional[str] = Query(default=None),
):
    return _get_news(ticker=ticker, tickers=tickers, action=action)
