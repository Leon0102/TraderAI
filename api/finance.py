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
                net_margin = data.get("netMargin", 0)
                if isinstance(net_margin, (int, float)) and 0 < net_margin < 1:
                    net_margin = round(net_margin * 100, 2)
                eps_growth = data.get("epsGrowth", 0)
                if isinstance(eps_growth, (int, float)) and abs(eps_growth) < 5:
                    eps_growth = round(eps_growth * 100, 2)
                rev_growth = data.get("revenueGrowth", 0)
                if isinstance(rev_growth, (int, float)) and abs(rev_growth) < 5:
                    rev_growth = round(rev_growth * 100, 2)
                result = {"data": {"ticker": data.get("ticker", ticker),
                    "pe": data.get("pe", 0), "pb": data.get("pb", 0), "roe": roe,
                    "eps": data.get("eps", 0), "revenue": data.get("revenue", 0),
                    "revenueGrowth": rev_growth,
                    "epsGrowth": eps_growth,
                    "marketCap": data.get("marketCap", 0),
                    "dividendYield": data.get("dividendYield", data.get("dividend", 0)),
                    "debtOnEquity": data.get("debtOnEquity", data.get("debtToEquity", 0)),
                    "netMargin": net_margin,
                    "freeCashFlow": data.get("freeCashFlow", data.get("fcf", 0)),
                    "totalAssets": data.get("totalAssets", data.get("asset", 0)),
                    "interestCoverage": data.get("interestCoverage", 0),
                    "currentRatio": data.get("currentRatio", 0),
                    "industry": data.get("industry", data.get("industryEn", ""))
                    }, "source": "tcbs"}
        except Exception:
            pass

        if not result:
            result = {"data": None, "source": "error"}

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())
