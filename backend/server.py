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
from stocks import get_top_stocks  # noqa: E402
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
def api_market():
    return get_market_overview()


@app.get("/api/market/analysis")
def api_market_analysis():
    return get_market_analysis()


@app.get("/api/stocks")
def api_stocks(count: int = Query(default=20, le=50)):
    return get_top_stocks(count)


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


if __name__ == "__main__":
    print("🚀 TraderAI Backend starting...")
    print("📊 Reusing api/*.py data-fetching logic (TCBS + vnstock)")
    print("🌐 API docs: http://localhost:8000/docs")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
