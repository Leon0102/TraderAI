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
from news import fetch_tcbs_news, fetch_rss_news, aggregate_sentiment, get_mock_news  # noqa: E402
import hashlib

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
    articles = []
    source = 'mock'

    try:
        if action == 'market' or (not ticker and not tickers):
            rss_articles = fetch_rss_news()
            if rss_articles:
                articles = rss_articles
                source = 'rss'
            else:
                articles = get_mock_news()

        elif tickers:
            ticker_list = [t.strip() for t in tickers.split(',')]
            for t in ticker_list[:5]:
                articles.extend(fetch_tcbs_news(t))
            articles.extend(fetch_rss_news())
            if articles:
                source = 'tcbs+rss'
            else:
                articles = get_mock_news()

        elif ticker:
            tcbs = fetch_tcbs_news(ticker)
            rss = fetch_rss_news()
            rss_filtered = [a for a in rss if ticker in a.get('relatedTickers', [])]
            articles = tcbs + rss_filtered + [a for a in rss if ticker not in a.get('relatedTickers', [])]
            if articles:
                source = 'tcbs+rss' if tcbs else 'rss'
            else:
                articles = get_mock_news(ticker)
    except Exception:
        articles = get_mock_news(ticker)

    seen = set()
    unique = []
    for a in articles:
        h = hashlib.md5(a.get('title', '').encode()).hexdigest()[:12]
        if h not in seen:
            seen.add(h)
            unique.append(a)
    articles = unique[:15]

    sentiment = aggregate_sentiment(articles, ticker)
    return {"articles": articles, "sentiment": sentiment, "source": source}


if __name__ == "__main__":
    print("🚀 TraderAI Backend starting...")
    print("📊 Reusing api/*.py data-fetching logic (TCBS + vnstock)")
    print("🌐 API docs: http://localhost:8000/docs")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
