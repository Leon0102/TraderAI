"""Vercel serverless function: /api/finance"""
from http.server import BaseHTTPRequestHandler
import json
import warnings
warnings.filterwarnings('ignore')

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import parse_qs, urlparse
        params = parse_qs(urlparse(self.path).query)
        ticker = params.get('ticker', ['FPT'])[0]
        result = None

        try:
            import requests as req
            resp = req.get(f"https://apipubaws.tcbs.com.vn/tcanalysis/v1/ticker/{ticker}/overview", timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                roe = data.get("roe", 0)
                if isinstance(roe, (int, float)) and 0 < roe < 1:
                    roe = round(roe * 100, 2)
                result = {"data": {"ticker": data.get("ticker", ticker),
                    "pe": data.get("pe", 0), "pb": data.get("pb", 0), "roe": roe,
                    "eps": data.get("eps", 0), "revenue": data.get("revenue", 0),
                    "revenueGrowth": data.get("revenueGrowth", 0),
                    "epsGrowth": data.get("epsGrowth", 0),
                    "marketCap": data.get("marketCap", 0)}, "source": "tcbs"}
        except Exception:
            pass

        if not result:
            result = {"data": None, "source": "error"}

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())
