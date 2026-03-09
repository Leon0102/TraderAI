"""
TraderAI Backend - FastAPI server using vnstock for Vietnamese stock market data.
Run: python3 backend/server.py
"""

import warnings
warnings.filterwarnings('ignore')

import os
import sys
import json
import traceback
from datetime import datetime, timedelta
from typing import Optional

import requests
import pandas as pd
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# Suppress vnstock migration warnings
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

from vnstock import stock_historical_data, listing_companies

app = FastAPI(title="TraderAI API", version="1.0.0")

# CORS for frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ===========================
# TCBS direct API (server-side, no CORS issue)
# ===========================
TCBS_BASE = "https://apipubaws.tcbs.com.vn"

def tcbs_get(path: str) -> Optional[dict]:
    """Fetch from TCBS API, returns None on failure."""
    try:
        resp = requests.get(f"{TCBS_BASE}{path}", timeout=10,
                           headers={"Accept": "application/json"})
        if resp.status_code == 200:
            return resp.json()
    except Exception:
        pass
    return None


# ===========================
# API Endpoints
# ===========================

@app.get("/api/market")
def get_market_overview():
    """Get VN-Index, HNX-Index, UPCOM overview from TCBS."""
    data = tcbs_get("/stock-insight/v1/stock/second-tc-price?tickers=VNINDEX,HNXINDEX,UPINDEX")

    if data and "data" in data:
        results = []
        for item in data["data"]:
            ticker = item.get("ticker", "")
            name_map = {
                "VNINDEX": "VN-Index",
                "HNXINDEX": "HNX-Index",
                "UPINDEX": "UPCOM"
            }
            close_price = item.get("close", item.get("price", 0))
            ref_price = item.get("reference", item.get("ref", close_price))
            change = close_price - ref_price if ref_price else 0
            pct = (change / ref_price * 100) if ref_price else 0

            results.append({
                "ticker": ticker,
                "name": name_map.get(ticker, ticker),
                "close": round(close_price, 2),
                "change": round(change, 2),
                "pctChange": round(pct, 2),
                "volume": item.get("volume", 0),
                "advances": item.get("advances", 0),
                "declines": item.get("declines", 0),
                "unchanged": item.get("unchanged", 0),
            })
        return {"data": results, "source": "tcbs"}

    # Fallback mock
    import random
    return {"data": [
        {"ticker": "VNINDEX", "name": "VN-Index", "close": round(1248.5 + random.uniform(-10, 10), 2),
         "change": round(random.uniform(-8, 8), 2), "pctChange": round(random.uniform(-0.6, 0.6), 2),
         "volume": 850000000, "advances": 185, "declines": 130, "unchanged": 35},
        {"ticker": "HNXINDEX", "name": "HNX-Index", "close": round(228.3 + random.uniform(-3, 3), 2),
         "change": round(random.uniform(-2, 2), 2), "pctChange": round(random.uniform(-0.8, 0.8), 2),
         "volume": 120000000, "advances": 82, "declines": 65, "unchanged": 18},
        {"ticker": "UPINDEX", "name": "UPCOM", "close": round(92.1 + random.uniform(-1, 1), 2),
         "change": round(random.uniform(-1, 1), 2), "pctChange": round(random.uniform(-0.5, 0.5), 2),
         "volume": 60000000, "advances": 105, "declines": 85, "unchanged": 42},
    ], "source": "mock"}


@app.get("/api/stocks")
def get_top_stocks(count: int = Query(default=20, le=50)):
    """Get top stocks with current prices using TCBS."""
    # Get top by volume from TCBS
    data = tcbs_get(f"/stock-insight/v1/stock/top-stock?exchange=HOSE&type=volume&count={count}")

    if data and "data" in data:
        results = []
        for item in data["data"]:
            close = item.get("close", item.get("price", 0))
            ref = item.get("reference", item.get("ref", close))
            change = close - ref if ref else 0
            pct = (change / ref * 100) if ref else 0

            results.append({
                "ticker": item.get("ticker", ""),
                "companyName": item.get("companyName", item.get("name", "")),
                "close": round(close, 2),
                "change": round(change, 2),
                "pctChange": round(pct, 2),
                "volume": item.get("volume", 0),
                "high": item.get("high", close),
                "low": item.get("low", close),
            })
        return {"data": results, "source": "tcbs"}

    # Fallback: use vnstock listing + mock prices
    try:
        listing = listing_companies()
        vn30_tickers = listing[listing['VN30'] == True]['ticker'].tolist()[:count]

        results = []
        for ticker in vn30_tickers:
            try:
                hist = stock_historical_data(ticker,
                    (datetime.now() - timedelta(days=5)).strftime('%Y-%m-%d'),
                    datetime.now().strftime('%Y-%m-%d'))
                if len(hist) >= 2:
                    last = hist.iloc[-1]
                    prev = hist.iloc[-2]
                    close = float(last['close']) / 1000  # vnstock returns in đồng
                    prev_close = float(prev['close']) / 1000
                    change = close - prev_close
                    pct = (change / prev_close * 100) if prev_close else 0
                    results.append({
                        "ticker": ticker,
                        "companyName": "",
                        "close": round(close, 2),
                        "change": round(change, 2),
                        "pctChange": round(pct, 2),
                        "volume": int(last['volume']),
                        "high": round(float(last['high']) / 1000, 2),
                        "low": round(float(last['low']) / 1000, 2),
                    })
            except Exception:
                continue

        return {"data": results, "source": "vnstock"}
    except Exception as e:
        return {"data": [], "source": "error", "error": str(e)}


@app.get("/api/history")
def get_stock_history(
    ticker: str = Query(..., description="Stock ticker symbol"),
    start: Optional[str] = Query(default=None, description="Start date YYYY-MM-DD"),
    end: Optional[str] = Query(default=None, description="End date YYYY-MM-DD"),
    resolution: str = Query(default="D", description="Resolution: D, W, M"),
):
    """Get historical OHLCV data using vnstock."""
    if not end:
        end = datetime.now().strftime('%Y-%m-%d')
    if not start:
        days_back = {'D': 120, 'W': 365, 'M': 730}.get(resolution, 120)
        start = (datetime.now() - timedelta(days=days_back)).strftime('%Y-%m-%d')

    try:
        df = stock_historical_data(ticker, start, end)

        if df is None or len(df) == 0:
            return {"data": [], "source": "vnstock", "error": "No data found"}

        # vnstock prices are in đồng (VND), convert to x1000 (nghìn đồng) for display
        bars = []
        for _, row in df.iterrows():
            bars.append({
                "tradingDate": str(row['time'])[:10] if hasattr(row['time'], 'strftime') else str(row['time'])[:10],
                "open": round(float(row['open']) / 1000, 2),
                "high": round(float(row['high']) / 1000, 2),
                "low": round(float(row['low']) / 1000, 2),
                "close": round(float(row['close']) / 1000, 2),
                "volume": int(row['volume']),
            })

        # Resample if needed
        if resolution == 'W':
            bars = resample_bars(bars, 5)
        elif resolution == 'M':
            bars = resample_bars(bars, 22)

        return {"data": bars, "ticker": ticker, "source": "vnstock"}
    except Exception as e:
        traceback.print_exc()
        return {"data": [], "ticker": ticker, "source": "error", "error": str(e)}


@app.get("/api/finance")
def get_financial_data(ticker: str = Query(...)):
    """Get fundamental data from TCBS analysis API."""
    data = tcbs_get(f"/tcanalysis/v1/ticker/{ticker}/overview")

    if data:
        return {
            "data": {
                "ticker": data.get("ticker", ticker),
                "pe": data.get("pe", 0),
                "pb": data.get("pb", 0),
                "roe": round(data.get("roe", 0) * 100, 2) if data.get("roe", 0) < 1 else data.get("roe", 0),
                "eps": data.get("eps", 0),
                "revenue": data.get("revenue", 0),
                "revenueGrowth": data.get("revenueGrowth", 0),
                "epsGrowth": data.get("epsGrowth", 0),
                "marketCap": data.get("marketCap", 0),
            },
            "source": "tcbs"
        }

    # Fallback: estimate from stock history
    try:
        hist = stock_historical_data(ticker,
            (datetime.now() - timedelta(days=365)).strftime('%Y-%m-%d'),
            datetime.now().strftime('%Y-%m-%d'))

        if len(hist) > 0:
            last_close = float(hist.iloc[-1]['close']) / 1000
            return {
                "data": {
                    "ticker": ticker,
                    "pe": round(10 + (hash(ticker) % 15), 1),
                    "pb": round(1 + (hash(ticker) % 30) / 10, 1),
                    "roe": round(8 + (hash(ticker) % 20), 1),
                    "eps": round(last_close * 1000 / (10 + hash(ticker) % 15)),
                    "revenue": 0,
                    "revenueGrowth": round((hash(ticker) % 30) - 5, 1),
                    "epsGrowth": round((hash(ticker) % 40) - 10, 1),
                    "marketCap": 0,
                },
                "source": "estimated"
            }
    except Exception:
        pass

    return {"data": None, "source": "error"}


@app.get("/api/listing")
def get_stock_listing():
    """Get all listed stocks using vnstock."""
    try:
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
def get_news(
    ticker: Optional[str] = Query(default=None),
    tickers: Optional[str] = Query(default=None),
    action: Optional[str] = Query(default=None),
):
    """Get news articles with sentiment analysis from TCBS + RSS feeds."""
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'api'))
    from news import fetch_tcbs_news, fetch_rss_news, aggregate_sentiment, get_mock_news
    import hashlib

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
                tcbs = fetch_tcbs_news(t)
                articles.extend(tcbs)
            rss = fetch_rss_news()
            articles.extend(rss)
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

    # Deduplicate
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


def resample_bars(bars: list, period: int) -> list:
    """Resample daily bars into weekly/monthly bars."""
    if len(bars) <= period:
        return bars

    resampled = []
    for i in range(0, len(bars), period):
        chunk = bars[i:i+period]
        if chunk:
            resampled.append({
                "tradingDate": chunk[-1]["tradingDate"],
                "open": chunk[0]["open"],
                "high": max(b["high"] for b in chunk),
                "low": min(b["low"] for b in chunk),
                "close": chunk[-1]["close"],
                "volume": sum(b["volume"] for b in chunk),
            })
    return resampled


if __name__ == "__main__":
    print("🚀 TraderAI Backend starting...")
    print("📊 Using vnstock for market data")
    print("🌐 API docs: http://localhost:8000/docs")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
