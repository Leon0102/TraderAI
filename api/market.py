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

# TCBS's Cloudflare bot challenge blocks direct calls from our datacenter IP.
# VCI (a different provider) has been verified to still work from there, so
# it's tried first; TCBS direct, then mock data, remain as fallbacks.
INDEX_SYMBOLS = {"VNINDEX": "VN-Index", "HNXINDEX": "HNX-Index", "UPCOMINDEX": "UPCOM"}


def _get_market_overview_vci() -> list:
    results = []
    start = (datetime.now() - timedelta(days=10)).strftime('%Y-%m-%d')
    end = datetime.now().strftime('%Y-%m-%d')
    for symbol, name in INDEX_SYMBOLS.items():
        try:
            bars = quote_history(symbol, start, end)
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


def get_market_overview() -> dict:
    """VN-Index / HNX-Index / UPCOM snapshot. source is 'vci'/'tcbs' for real data, 'mock' for demo fallback."""
    vci_results = _get_market_overview_vci()
    if vci_results:
        return {"data": vci_results, "source": "vci"}

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

    vci_bars = quote_history(
        'VNINDEX',
        (datetime.now() - timedelta(days=150)).strftime('%Y-%m-%d'),
        datetime.now().strftime('%Y-%m-%d'),
    )
    if vci_bars:
        result["vnindexHistory"] = vci_bars
        result["source"] = "vci"
    else:
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

    # Mock fallback for sectors
    if not result["sectors"]:
        mock_sectors = [
            "Ngân hàng", "Bất động sản", "Chứng khoán", "Thép",
            "Thực phẩm", "Dầu khí", "CNTT", "Bán lẻ",
            "Điện", "Xây dựng", "Hóa chất", "Dệt may"
        ]
        result["sectors"] = [
            {"name": s, "change": round(random.uniform(-3, 3), 2),
             "volume": random.randint(10000000, 200000000),
             "advances": random.randint(3, 20),
             "declines": random.randint(3, 15),
             "marketCap": random.randint(50000, 500000)}
            for s in mock_sectors
        ]

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
