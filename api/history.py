"""Vercel serverless function: /api/history"""
from http.server import BaseHTTPRequestHandler
import json
import warnings
import time
from datetime import datetime, timedelta
warnings.filterwarnings('ignore')

import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _tcbs import tcbs_get


def get_history(ticker: str, start: str, end: str) -> dict:
    """OHLCV bars for a ticker. Tries vnstock first, falls back to TCBS. source: 'vnstock'|'tcbs'|'empty'."""
    bars = []

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
            if bars:
                return {"data": bars, "ticker": ticker, "source": "vnstock"}
    except Exception:
        pass

    to_ts = int(time.mktime(datetime.strptime(end, '%Y-%m-%d').timetuple()))
    from_ts = int(time.mktime(datetime.strptime(start, '%Y-%m-%d').timetuple()))
    data = tcbs_get(
        f"/stock-insight/v1/stock/bars-long-term?ticker={ticker}&type=stock&resolution=D&from={from_ts}&to={to_ts}",
        ttl=300,
    )
    if data:
        for bar in (data.get('data') or []):
            bars.append({"tradingDate": bar.get('tradingDate', ''),
                "open": bar.get('open', 0), "high": bar.get('high', 0),
                "low": bar.get('low', 0), "close": bar.get('close', 0),
                "volume": bar.get('volume', 0)})

    return {"data": bars, "ticker": ticker, "source": "tcbs" if bars else "empty"}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import parse_qs, urlparse
        params = parse_qs(urlparse(self.path).query)
        ticker = params.get('ticker', ['FPT'])[0]
        end = params.get('end', [datetime.now().strftime('%Y-%m-%d')])[0]
        start = params.get('start', [(datetime.now() - timedelta(days=120)).strftime('%Y-%m-%d')])[0]

        result = get_history(ticker, start, end)

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())
