"""Vercel serverless function: /api/stocks"""
from http.server import BaseHTTPRequestHandler
import json
import warnings
warnings.filterwarnings('ignore')

import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _tcbs import tcbs_get


def get_top_stocks(count: int = 20) -> dict:
    """Fetch top stocks by volume from TCBS. Returns {"data": [...], "source": "tcbs"|"error"}."""
    data = tcbs_get(f"/stock-insight/v1/stock/top-stock?exchange=HOSE&type=volume&count={count}")

    if data and "data" in data:
        results = []
        for item in data["data"]:
            cl = item.get("close", item.get("price", 0))
            rf = item.get("reference", item.get("ref", cl))
            ch = cl - rf if rf else 0
            pct = (ch / rf * 100) if rf else 0
            results.append({"ticker": item.get("ticker", ""), "companyName": item.get("companyName", ""),
                "close": round(cl, 2), "change": round(ch, 2), "pctChange": round(pct, 2),
                "volume": item.get("volume", 0), "high": item.get("high", cl), "low": item.get("low", cl)})
        return {"data": results, "source": "tcbs"}

    return {"data": [], "source": "error"}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import parse_qs, urlparse
        params = parse_qs(urlparse(self.path).query)
        count = int(params.get('count', ['20'])[0])

        result = get_top_stocks(count)

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())
