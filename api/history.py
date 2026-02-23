"""Vercel serverless function: /api/history"""
from http.server import BaseHTTPRequestHandler
import json
import warnings
from datetime import datetime, timedelta
warnings.filterwarnings('ignore')

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import parse_qs, urlparse
        params = parse_qs(urlparse(self.path).query)
        ticker = params.get('ticker', ['FPT'])[0]
        end = params.get('end', [datetime.now().strftime('%Y-%m-%d')])[0]
        start = params.get('start', [(datetime.now() - timedelta(days=120)).strftime('%Y-%m-%d')])[0]

        bars = []

        # Try vnstock first
        try:
            from vnstock import stock_historical_data
            df = stock_historical_data(ticker, start, end)
            if df is not None and len(df) > 0:
                for _, row in df.iterrows():
                    bars.append({
                        "tradingDate": str(row['time'])[:10],
                        "open": round(float(row['open']) / 1000, 2),
                        "high": round(float(row['high']) / 1000, 2),
                        "low": round(float(row['low']) / 1000, 2),
                        "close": round(float(row['close']) / 1000, 2),
                        "volume": int(row['volume']),
                    })
        except Exception:
            pass

        # Fallback: TCBS API
        if not bars:
            try:
                import requests as req, time
                to_ts = int(time.mktime(datetime.strptime(end, '%Y-%m-%d').timetuple()))
                from_ts = int(time.mktime(datetime.strptime(start, '%Y-%m-%d').timetuple()))
                url = f"https://apipubaws.tcbs.com.vn/stock-insight/v1/stock/bars-long-term?ticker={ticker}&type=stock&resolution=D&from={from_ts}&to={to_ts}"
                resp = req.get(url, timeout=10)
                if resp.status_code == 200:
                    data = resp.json()
                    for bar in (data.get('data') or []):
                        bars.append({"tradingDate": bar.get('tradingDate', ''),
                            "open": bar.get('open', 0), "high": bar.get('high', 0),
                            "low": bar.get('low', 0), "close": bar.get('close', 0),
                            "volume": bar.get('volume', 0)})
            except Exception:
                pass

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps({"data": bars, "ticker": ticker, "source": "vnstock" if bars else "empty"}).encode())
