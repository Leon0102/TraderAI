"""Vercel serverless function: /api/market"""
from http.server import BaseHTTPRequestHandler
import json
import warnings
import random
import time
from datetime import datetime, timedelta
warnings.filterwarnings('ignore')

import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _tcbs import tcbs_get
from _vci import quote_history
import _dnse
import _ssi

# Provider order: DNSE (fast, not throttled), VCI, TCBS (Cloudflare-blocked on
# datacenter IPs), then mock data as the last resort.
INDEX_SYMBOLS = {"VNINDEX": "VN-Index", "HNXINDEX": "HNX-Index", "UPCOMINDEX": "UPCOM"}


def _get_market_overview_bars(fetch) -> list:
    results = []
    start = (datetime.now() - timedelta(days=10)).strftime('%Y-%m-%d')
    end = datetime.now().strftime('%Y-%m-%d')
    for symbol, name in INDEX_SYMBOLS.items():
        try:
            bars = fetch(symbol, start, end)
            if not bars:
                continue
            last = bars[-1]
            prev_close = bars[-2]['close'] if len(bars) >= 2 else last['close']
            close = last['close']
            change = close - prev_close
            pct = (change / prev_close * 100) if prev_close else 0
            results.append({
                "ticker": "UPINDEX" if symbol == "UPCOMINDEX" else symbol, "name": name,
                "close": round(close, 2), "change": round(change, 2), "pctChange": round(pct, 2),
                "volume": last['volume'], "advances": 0, "declines": 0, "unchanged": 0,
            })
        except Exception:
            continue
    return results


def _attach_breadth(results: list) -> None:
    """Fill advances/declines/unchanged per index from SSI's whole-exchange price board."""
    exchange_for_index = {"VNINDEX": "hose", "HNXINDEX": "hnx", "UPINDEX": "upcom"}
    for row in results:
        ex = exchange_for_index.get(row["ticker"])
        stocks = _ssi.all_stocks((ex,)) if ex else []
        traded = [s for s in stocks if s["volume"] > 0]
        if traded:
            row["advances"] = sum(1 for s in traded if s["change"] > 0)
            row["declines"] = sum(1 for s in traded if s["change"] < 0)
            row["unchanged"] = len(traded) - row["advances"] - row["declines"]


def get_market_overview() -> dict:
    """VN-Index / HNX-Index / UPCOM snapshot. source is 'vci'/'tcbs' for real data, 'mock' for demo fallback."""
    for source, fetch in (("dnse", _dnse.quote_history), ("vci", quote_history)):
        results = _get_market_overview_bars(fetch)
        if results:
            _attach_breadth(results)
            return {"data": results, "source": source}

    data = tcbs_get("/stock-insight/v1/stock/second-tc-price?tickers=VNINDEX,HNXINDEX,UPINDEX")

    if data and "data" in data:
        name_map = {"VNINDEX": "VN-Index", "HNXINDEX": "HNX-Index", "UPINDEX": "UPCOM"}
        results = []
        for item in data["data"]:
            t = item.get("ticker", "")
            cp = item.get("close", item.get("price", 0))
            rp = item.get("reference", item.get("ref", cp))
            ch = cp - rp if rp else 0
            pct = (ch / rp * 100) if rp else 0
            results.append({"ticker": t, "name": name_map.get(t, t),
                "close": round(cp, 2), "change": round(ch, 2), "pctChange": round(pct, 2),
                "volume": item.get("volume", 0), "advances": item.get("advances", 0),
                "declines": item.get("declines", 0), "unchanged": item.get("unchanged", 0)})
        if results:
            return {"data": results, "source": "tcbs"}

    return {"data": [
        {"ticker": "VNINDEX", "name": "VN-Index", "close": round(1248 + random.uniform(-10, 10), 2),
         "change": round(random.uniform(-8, 8), 2), "pctChange": round(random.uniform(-0.6, 0.6), 2),
         "volume": 850000000, "advances": 185, "declines": 130, "unchanged": 35},
        {"ticker": "HNXINDEX", "name": "HNX-Index", "close": round(228 + random.uniform(-3, 3), 2),
         "change": round(random.uniform(-2, 2), 2), "pctChange": round(random.uniform(-0.8, 0.8), 2),
         "volume": 120000000, "advances": 82, "declines": 65, "unchanged": 18},
        {"ticker": "UPINDEX", "name": "UPCOM", "close": round(92 + random.uniform(-1, 1), 2),
         "change": round(random.uniform(-1, 1), 2), "pctChange": round(random.uniform(-0.5, 0.5), 2),
         "volume": 60000000, "advances": 105, "declines": 85, "unchanged": 42},
    ], "source": "mock"}


def get_market_analysis() -> dict:
    """VN-Index historical bars + sector performance for market regime analysis."""
    result = {"vnindexHistory": [], "sectors": [], "source": "mock"}

    start = (datetime.now() - timedelta(days=150)).strftime('%Y-%m-%d')
    end = datetime.now().strftime('%Y-%m-%d')
    for source, fetch in (("dnse", _dnse.quote_history), ("vci", quote_history)):
        bars = fetch('VNINDEX', start, end)
        if bars:
            result["vnindexHistory"] = bars
            result["source"] = source
            break
    if not result["vnindexHistory"]:
        to_ts = int(time.time())
        from_ts = int((datetime.now() - timedelta(days=150)).timestamp())
        hist_data = tcbs_get(
            f"/stock-insight/v1/stock/bars-long-term?ticker=VNINDEX&type=index&resolution=D&from={from_ts}&to={to_ts}",
            ttl=300,
        )
        if hist_data:
            bars = []
            for bar in (hist_data.get('data') or []):
                bars.append({
                    "tradingDate": bar.get("tradingDate", ""),
                    "open": bar.get("open", 0),
                    "high": bar.get("high", 0),
                    "low": bar.get("low", 0),
                    "close": bar.get("close", 0),
                    "volume": bar.get("volume", 0)
                })
            if bars:
                result["vnindexHistory"] = bars
                result["source"] = "tcbs"

    sector_data = tcbs_get("/stock-insight/v2/stock/industry-summary", ttl=300)
    if sector_data:
        sectors = []
        for item in (sector_data if isinstance(sector_data, list) else sector_data.get('data', [])):
            sectors.append({
                "name": item.get("industry", item.get("name", "")),
                "change": item.get("change", item.get("changePercent", 0)),
                "volume": item.get("volume", 0),
                "advances": item.get("advances", 0),
                "declines": item.get("declines", 0),
                "marketCap": item.get("marketCap", 0)
            })
        if sectors:
            result["sectors"] = sectors

    # Mock fallback for VN-Index history
    if not result["vnindexHistory"]:
        base = 1200
        bars = []
        for i in range(100):
            d = datetime.now() - timedelta(days=100 - i)
            change = random.uniform(-15, 16)
            o = base
            c = base + change
            h = max(o, c) + random.uniform(0, 8)
            lo = min(o, c) - random.uniform(0, 8)
            bars.append({
                "tradingDate": d.strftime("%Y-%m-%d"),
                "open": round(o, 2), "high": round(h, 2),
                "low": round(lo, 2), "close": round(c, 2),
                "volume": random.randint(500000000, 1200000000)
            })
            base = c
        result["vnindexHistory"] = bars

    # No real sector feed is reachable without TCBS: return none rather than
    # random numbers, which would silently skew the market-health score.
    return result


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import parse_qs, urlparse
        params = parse_qs(urlparse(self.path).query)
        action = params.get('action', ['overview'])[0]

        result = get_market_analysis() if action == 'analysis' else get_market_overview()

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())
