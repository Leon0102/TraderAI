"""Vercel serverless function: /api/market"""
from http.server import BaseHTTPRequestHandler
import json
import warnings
import random
warnings.filterwarnings('ignore')

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        result = None
        try:
            import requests as req
            TCBS = "https://apipubaws.tcbs.com.vn"
            resp = req.get(f"{TCBS}/stock-insight/v1/stock/second-tc-price?tickers=VNINDEX,HNXINDEX,UPINDEX", timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                if "data" in data:
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
                    result = {"data": results, "source": "tcbs"}
        except Exception:
            pass

        if not result:
            result = {"data": [
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

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())
