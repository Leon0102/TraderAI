"""Vercel serverless function: /api/stocks"""
from http.server import BaseHTTPRequestHandler
import json
import warnings
warnings.filterwarnings('ignore')

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import parse_qs, urlparse
        params = parse_qs(urlparse(self.path).query)
        count = int(params.get('count', ['20'])[0])
        result = None

        try:
            import requests as req
            resp = req.get(f"https://apipubaws.tcbs.com.vn/stock-insight/v1/stock/top-stock?exchange=HOSE&type=volume&count={count}", timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                if "data" in data:
                    results = []
                    for item in data["data"]:
                        cl = item.get("close", item.get("price", 0))
                        rf = item.get("reference", item.get("ref", cl))
                        ch = cl - rf if rf else 0
                        pct = (ch / rf * 100) if rf else 0
                        results.append({"ticker": item.get("ticker", ""), "companyName": item.get("companyName", ""),
                            "close": round(cl, 2), "change": round(ch, 2), "pctChange": round(pct, 2),
                            "volume": item.get("volume", 0), "high": item.get("high", cl), "low": item.get("low", cl)})
                    result = {"data": results, "source": "tcbs"}
        except Exception:
            pass

        if not result:
            result = {"data": [], "source": "error"}

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())
