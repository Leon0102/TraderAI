"""Vercel serverless function: /api/stocks"""
from http.server import BaseHTTPRequestHandler
import json
import warnings
warnings.filterwarnings('ignore')

from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _tcbs import tcbs_get
from _vci import price_board, quote_history

# TCBS's Cloudflare bot challenge blocks our datacenter IP; VCI (a different
# provider) has been verified to still work. It has no "top volume" screener
# on the free tier, so we price-board a fixed basket of liquid HOSE tickers
# ourselves and rank by traded volume.
LIQUID_UNIVERSE = [
    'FPT', 'VNM', 'VIC', 'VHM', 'HPG', 'MWG', 'TCB', 'MSN', 'VCB', 'ACB',
    'SSI', 'VPB', 'STB', 'GAS', 'PLX', 'DGC', 'PNJ', 'REE', 'MBB', 'CTG',
    'BID', 'HDB', 'SHB', 'EIB', 'LPB', 'TPB', 'VJC', 'VRE', 'SAB', 'POW',
    'GVR', 'BCM', 'PDR', 'NVL', 'KDH', 'DXG', 'HSG', 'NKG', 'DPM', 'DCM',
]

# How many raw-top-volume candidates to compute RVOL for. Each one costs an
# extra history call, so this trades off ranking quality vs. request latency.
RVOL_CANDIDATE_COUNT = 15
RVOL_LOOKBACK_DAYS = 20


def _attach_rvol(candidates: list) -> None:
    """Mutates each candidate dict in place, adding an 'rvol' field: today's
    volume divided by the average of the prior RVOL_LOOKBACK_DAYS days.
    A raw top-volume list is dominated by a handful of always-liquid large
    caps; RVOL instead surfaces stocks trading unusually heavily *for them*,
    which is a much stronger signal of fresh buying/selling interest.
    """
    start = (datetime.now() - timedelta(days=RVOL_LOOKBACK_DAYS * 2)).strftime('%Y-%m-%d')
    end = datetime.now().strftime('%Y-%m-%d')

    def fetch(ticker: str):
        try:
            bars = quote_history(ticker, start, end)
            return ticker, bars
        except Exception:
            return ticker, []

    with ThreadPoolExecutor(max_workers=len(candidates)) as pool:
        futures = [pool.submit(fetch, c['ticker']) for c in candidates]
        bars_by_ticker = dict(f.result() for f in as_completed(futures))

    for c in candidates:
        bars = bars_by_ticker.get(c['ticker']) or []
        # Exclude the most recent bar (today) from the baseline average.
        history = bars[-(RVOL_LOOKBACK_DAYS + 1):-1] if len(bars) > 1 else []
        avg_volume = (sum(b['volume'] for b in history) / len(history)) if history else 0
        c['rvol'] = round(c['volume'] / avg_volume, 2) if avg_volume > 0 else 1.0


def get_top_stocks(count: int = 20) -> dict:
    """Top stocks by relative volume (RVOL). Tries VCI first, falls back to TCBS. source: 'vci'|'tcbs'|'error'."""
    vci_results = price_board(LIQUID_UNIVERSE)
    if vci_results:
        vci_results.sort(key=lambda r: r['volume'], reverse=True)
        # RVOL needs one extra history call per candidate, so it's capped
        # regardless of `count` to keep request latency in check. The rest
        # of the requested rows stay ranked by raw volume (rvol defaults to
        # a neutral 1.0 for them, set below).
        rvol_candidates = vci_results[:RVOL_CANDIDATE_COUNT]
        _attach_rvol(rvol_candidates)
        rvol_candidates.sort(key=lambda r: r['rvol'], reverse=True)

        rest = vci_results[RVOL_CANDIDATE_COUNT:]
        for r in rest:
            r['rvol'] = 1.0
        return {"data": (rvol_candidates + rest)[:count], "source": "vci"}

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
