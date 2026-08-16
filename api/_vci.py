"""Direct calls to Vietcap (VCI)'s public trading API, replicating the subset
of the `vnstock` package we need without installing it.

Why: TCBS's public API now blocks datacenter IPs behind a Cloudflare bot
challenge (verified from both this sandbox and Vercel's runtime). VCI is an
entirely different provider (trading.vietcap.com.vn / iq.vietcap.com.vn) that
is NOT blocked and needs no API key — just browser-like headers. The
`vnstock` PyPI package hits these same endpoints internally, but its
dependency tree (matplotlib, pillow, pydantic, vnai...) pushed our Vercel
serverless function bundle past the 225MB size limit and broke deployment.
Calling the endpoints directly with `requests` keeps the bundle small.

Endpoints and payload shapes were reverse-engineered from vnstock 4.0.6's
vnstock/explorer/vci/{quote,trading,financial}.py.
"""
import time
from typing import Optional

import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _cache import cache_get, cache_set

TRADING_URL = "https://trading.vietcap.com.vn/api/"
IQ_URL = "https://iq.vietcap.com.vn/api/iq-insight-service"

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,vi-VN;q=0.8,vi;q=0.7",
    "Content-Type": "application/json",
    "DNT": "1",
    "Referer": "https://trading.vietcap.com.vn/",
    "Origin": "https://trading.vietcap.com.vn/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
}

# VCI's index tickers don't match TCBS's; map our app's naming to VCI's.
INDEX_SYMBOL_MAP = {
    "VNINDEX": "VNINDEX",
    "HNXINDEX": "HNXIndex",
    "UPINDEX": "HNXUpcomIndex",
    "UPCOMINDEX": "HNXUpcomIndex",
}


def _vci_post(path: str, payload: dict, ttl: float = 0) -> Optional[dict]:
    cache_key = f"vci:post:{path}:{payload}"
    if ttl:
        cached = cache_get(cache_key)
        if cached is not None:
            return cached
    try:
        import requests as req
        resp = req.post(f"{TRADING_URL}{path}", headers=HEADERS, json=payload, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            return cache_set(cache_key, data, ttl) if ttl else data
    except Exception:
        pass
    return None


def _vci_get(url: str, params: Optional[dict] = None, ttl: float = 0) -> Optional[dict]:
    cache_key = f"vci:get:{url}:{params}"
    if ttl:
        cached = cache_get(cache_key)
        if cached is not None:
            return cached
    try:
        import requests as req
        resp = req.get(url, headers=HEADERS, params=params, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            return cache_set(cache_key, data, ttl) if ttl else data
    except Exception:
        pass
    return None


def quote_history(symbol: str, start: str, end: str) -> list:
    """Daily OHLCV bars for a stock or index ticker between start/end (YYYY-MM-DD)."""
    is_index = symbol in INDEX_SYMBOL_MAP
    vci_symbol = INDEX_SYMBOL_MAP.get(symbol, symbol)
    # Indices are unitless point values; only real stock prices (in VND) get
    # scaled down to the "nghìn đồng" (thousand VND) unit used elsewhere.
    scale = 1 if is_index else 1000
    end_ts = int(time.mktime(time.strptime(end, "%Y-%m-%d"))) + 86400
    start_ts = int(time.mktime(time.strptime(start, "%Y-%m-%d")))
    days = max(1, (end_ts - start_ts) // 86400)
    count_back = int(days * 1.6) + 5  # business days are ~5/7 of calendar days

    data = _vci_post("chart/OHLCChart/gap-chart", {
        "timeFrame": "ONE_DAY",
        "symbols": [vci_symbol],
        "to": end_ts,
        "countBack": count_back,
    })
    if not data or not isinstance(data, list) or not data[0]:
        return []

    d = data[0]
    times, opens, highs, lows, closes, vols = d.get('t', []), d.get('o', []), d.get('h', []), d.get('l', []), d.get('c', []), d.get('v', [])
    bars = []
    for i in range(len(times)):
        try:
            bars.append({
                "tradingDate": time.strftime("%Y-%m-%d", time.localtime(int(times[i]))),
                "open": round(float(opens[i]) / scale, 2),
                "high": round(float(highs[i]) / scale, 2),
                "low": round(float(lows[i]) / scale, 2),
                "close": round(float(closes[i]) / scale, 2),
                "volume": int(vols[i]),
            })
        except (IndexError, ValueError, TypeError):
            continue
    return bars


def price_board(symbols: list) -> list:
    """Real-time-ish price board (last match price, volume, high/low, ref price) for a list of tickers."""
    data = _vci_post("price/symbols/getList", {"symbols": symbols})
    if not data or not isinstance(data, list):
        return []

    results = []
    for item in data:
        try:
            listing = item.get("listingInfo") or {}
            match = item.get("matchPrice") or {}
            close = float(match.get("matchPrice") or 0) / 1000
            ref = float(match.get("referencePrice") or listing.get("refPrice") or close * 1000) / 1000
            results.append({
                "ticker": listing.get("symbol") or listing.get("ticker") or "",
                "companyName": listing.get("organShortName") or listing.get("organName") or "",
                "close": round(close, 2),
                "change": round(close - ref, 2),
                "pctChange": round((close - ref) / ref * 100, 2) if ref else 0,
                "volume": int(match.get("accumulatedVolume") or 0),
                "high": round(float(match.get("highest") or close * 1000) / 1000, 2),
                "low": round(float(match.get("lowest") or close * 1000) / 1000, 2),
            })
        except (ValueError, TypeError):
            continue
    return results


def financial_ratio(symbol: str) -> Optional[dict]:
    """Latest trailing-twelve-month financial ratios (P/E, P/B, ROE, D/E, ...) for a ticker."""
    data = _vci_get(f"{IQ_URL}/v1/company/{symbol}/statistics-financial", ttl=300)
    if not data:
        return None
    periods = data.get("data")
    if not periods or not isinstance(periods, list):
        return None
    return periods[-1]


def income_statement_years(symbol: str) -> list:
    """Last few fiscal years of income-statement line items (coded field names isaN)."""
    data = _vci_get(f"{IQ_URL}/v1/company/{symbol}/financial-statement",
                     params={"section": "INCOME_STATEMENT"}, ttl=300)
    if not data:
        return []
    years = (data.get("data") or {}).get("years")
    return years if isinstance(years, list) else []
