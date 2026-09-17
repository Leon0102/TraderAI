"""DNSE (Entrade) public chart API — daily OHLCV for stocks and indices.

Fast (~100ms), no API key, and independent of Vietcap, whose trading host
throttles/blocks IPs after bursts of requests.
"""
import time
from datetime import datetime

import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _cache import cache_get, cache_set

CHART_URL = "https://services.entrade.com.vn/chart-api/v2/ohlcs/{kind}"
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
}
# Our app's index naming -> DNSE's
INDEX_SYMBOL_MAP = {
    "VNINDEX": "VNINDEX",
    "VN30": "VN30",
    "HNXINDEX": "HNX",
    "HNX": "HNX",
    "UPINDEX": "UPCOM",
    "UPCOMINDEX": "UPCOM",
    "UPCOM": "UPCOM",
}


def quote_history(symbol: str, start: str, end: str, ttl: float = 120) -> list:
    """Daily bars between start/end (YYYY-MM-DD). Stock prices in thousand VND, indices in points."""
    symbol = symbol.upper()
    is_index = symbol in INDEX_SYMBOL_MAP
    dnse_symbol = INDEX_SYMBOL_MAP.get(symbol, symbol)
    from_ts = int(time.mktime(time.strptime(start, "%Y-%m-%d")))
    to_ts = int(time.mktime(time.strptime(end, "%Y-%m-%d"))) + 86400

    cache_key = f"dnse:{dnse_symbol}:{from_ts}:{to_ts}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        import requests as req
        resp = req.get(
            CHART_URL.format(kind="index" if is_index else "stock"),
            params={"from": from_ts, "to": to_ts, "symbol": dnse_symbol, "resolution": "1D"},
            headers=HEADERS,
            timeout=8,
        )
        if resp.status_code != 200:
            return []
        d = resp.json() or {}
    except Exception:
        return []

    times, opens, highs, lows, closes, vols = (d.get(k) or [] for k in ("t", "o", "h", "l", "c", "v"))
    bars = []
    for i in range(len(times)):
        try:
            bars.append({
                "tradingDate": datetime.fromtimestamp(int(times[i])).strftime("%Y-%m-%d"),
                "open": round(float(opens[i]), 2),
                "high": round(float(highs[i]), 2),
                "low": round(float(lows[i]), 2),
                "close": round(float(closes[i]), 2),
                "volume": int(vols[i]),
            })
        except (IndexError, ValueError, TypeError):
            continue
    return cache_set(cache_key, bars, ttl) if bars else bars
