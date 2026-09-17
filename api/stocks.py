"""Vercel serverless function: /api/stocks"""
from http.server import BaseHTTPRequestHandler
import json
import math
import threading
import warnings
warnings.filterwarnings('ignore')

from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor

import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _cache import cache_get, cache_set
from _tcbs import tcbs_get
from _vci import price_board as vci_price_board
import _dnse
import _ssi

# Today's top stocks are picked from the WHOLE of HOSE + HNX via SSI's price
# board (one request per exchange), not a fixed basket. UPCoM is left out of
# the ranking: it is dominated by thin, easily-moved names.
RANK_EXCHANGES = ("hose", "hnx")
# Minimum matched value (VND) to count as investable liquidity for the day.
MIN_TRADED_VALUE = 10_000_000_000
# How many of the most-traded stocks get an RVOL computed (one DNSE call each, ~100ms).
RVOL_CANDIDATE_COUNT = 60
RVOL_LOOKBACK_DAYS = 20

# Only used when the live whole-market board is unavailable (SSI down, or
# before the first match of a new session when traded values are still 0).
LIQUID_UNIVERSE = [
    'FPT', 'VNM', 'VIC', 'VHM', 'HPG', 'MWG', 'TCB', 'MSN', 'VCB', 'ACB',
    'SSI', 'VPB', 'STB', 'GAS', 'PLX', 'DGC', 'PNJ', 'REE', 'MBB', 'CTG',
    'BID', 'HDB', 'SHB', 'EIB', 'LPB', 'TPB', 'VJC', 'VRE', 'SAB', 'POW',
    'GVR', 'BCM', 'PDR', 'NVL', 'KDH', 'DXG', 'HSG', 'NKG', 'DPM', 'DCM',
]


def _attach_rvol(candidates: list) -> None:
    """Adds 'rvol' to each candidate in place: today's volume / average of the
    prior RVOL_LOOKBACK_DAYS sessions. A raw most-traded list is dominated by
    always-liquid large caps; RVOL surfaces stocks trading unusually heavily
    *for them* — fresh buying/selling interest."""
    start = (datetime.now() - timedelta(days=RVOL_LOOKBACK_DAYS * 2 + 10)).strftime('%Y-%m-%d')
    end = datetime.now().strftime('%Y-%m-%d')

    def fetch(c: dict):
        try:
            return c['ticker'], _dnse.quote_history(c['ticker'], start, end)
        except Exception:
            return c['ticker'], []

    with ThreadPoolExecutor(max_workers=12) as pool:
        bars_by_ticker = dict(pool.map(fetch, candidates))

    for c in candidates:
        bars = bars_by_ticker.get(c['ticker']) or []
        # Keep today's bar out of the baseline, whether or not DNSE already has it.
        trading_date = c.get('tradingDate') or ''
        today = f"{trading_date[:4]}-{trading_date[4:6]}-{trading_date[6:]}" if len(trading_date) == 8 else end
        history = [b for b in bars if b['tradingDate'] != today][-RVOL_LOOKBACK_DAYS:]
        avg_volume = (sum(b['volume'] for b in history) / len(history)) if history else 0
        if not c.get('volume') and bars:
            c['volume'] = bars[-1]['volume']  # new session not matched yet: use the last session
        c['avgVolume20'] = int(avg_volume)
        c['rvol'] = round(c['volume'] / avg_volume, 2) if avg_volume > 0 else 1.0


def _score(c: dict) -> float:
    """Rank = unusual activity (RVOL, capped so one spike can't dominate) weighted
    by liquidity (log of traded value), with a small tilt toward stocks closing up."""
    rvol = min(c.get('rvol') or 1.0, 4.0)
    liquidity = math.log10(max(c.get('value') or 0, 1e9))  # 9 (1 tỷ) .. ~12.5 (3,000 tỷ)
    momentum = max(min(c.get('pctChange') or 0, 7), -7) / 7   # -1 .. 1
    return round(rvol * (liquidity - 8) * (1 + 0.25 * momentum), 3)


def _rank(candidates: list, count: int) -> list:
    _attach_rvol(candidates)
    for c in candidates:
        c['score'] = _score(c)
    candidates.sort(key=lambda c: c['score'], reverse=True)
    return candidates[:count]


MAX_COUNT = 50
_RANKING_TTL = 30
_ranking_lock = threading.Lock()


def get_top_stocks(count: int = 20) -> dict:
    """Today's top stocks across HOSE + HNX. The page requests this several times
    concurrently on load (table, heatmap, suggestions, council), so the ranking is
    computed once under a lock and served from a short cache for every `count`."""
    count = max(1, min(count, MAX_COUNT))
    with _ranking_lock:
        cached = cache_get("stocks:top")
        if cached is None:
            cached = _compute_top_stocks(MAX_COUNT)
            if cached["data"]:
                cache_set("stocks:top", cached, _RANKING_TTL)
    return {**cached, "data": cached["data"][:count]}


def _compute_top_stocks(count: int) -> dict:
    """source: 'ssi'|'vci'|'tcbs'|'error'."""
    board = _ssi.all_stocks(RANK_EXCHANGES)
    liquid = [s for s in board if (s.get('value') or 0) >= MIN_TRADED_VALUE and s.get('close')]
    if len(liquid) >= 10:
        liquid.sort(key=lambda s: s['value'], reverse=True)
        return {"data": _rank(liquid[:max(RVOL_CANDIDATE_COUNT, count)], count), "source": "ssi",
                "universe": len(board)}

    # Board reachable but session hasn't matched yet: rank the liquid basket on last-session data.
    if board:
        basket = _ssi.price_board(LIQUID_UNIVERSE)
        if basket:
            for s in basket:
                s['value'] = 0
            ranked = _rank(basket, count)
            for s in ranked:
                s['value'] = int(s['volume'] * s['close'] * 1000)
                s['score'] = _score(s)
            ranked.sort(key=lambda c: c['score'], reverse=True)
            return {"data": ranked, "source": "ssi", "universe": len(board)}

    vci_results = vci_price_board(LIQUID_UNIVERSE)
    if vci_results:
        for s in vci_results:
            s['value'] = int(s['volume'] * s['close'] * 1000)
        vci_results.sort(key=lambda r: r['value'], reverse=True)
        return {"data": _rank(vci_results[:RVOL_CANDIDATE_COUNT], count), "source": "vci"}

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


def get_symbols() -> dict:
    """Every listed common stock (HOSE, HNX, UPCoM) for search/autocomplete."""
    rows = _ssi.all_stocks()
    symbols = sorted(
        ({"ticker": r["ticker"], "name": r["companyName"], "exchange": r["exchange"]} for r in rows),
        key=lambda r: r["ticker"],
    )
    return {"data": symbols, "total": len(symbols), "source": "ssi" if symbols else "error"}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import parse_qs, urlparse
        params = parse_qs(urlparse(self.path).query)

        if params.get('action', [None])[0] == 'symbols':
            result = get_symbols()
        else:
            count = int(params.get('count', ['20'])[0])
            result = get_top_stocks(count)

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(result, ensure_ascii=False).encode())
