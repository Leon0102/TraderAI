"""SSI iBoard public price board — a live snapshot of every security on an exchange.

Why: it returns the whole market (HOSE ~400, HNX ~300, UPCoM ~800 symbols) in
one request per exchange, which lets us rank *today's* most traded stocks
instead of scanning a fixed basket. No API key, just browser-like headers.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _cache import cache_get, cache_set

BOARD_URL = "https://iboard-query.ssi.com.vn/stock/exchange/{exchange}"
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://iboard.ssi.com.vn",
    "Referer": "https://iboard.ssi.com.vn/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
}
EXCHANGES = ("hose", "hnx", "upcom")
EXCHANGE_LABELS = {"hose": "HOSE", "hnx": "HNX", "upcom": "UPCOM"}


def exchange_board(exchange: str, ttl: float = 20) -> list:
    """Raw SSI rows for one exchange (cached briefly — the page asks for it many times on load)."""
    cache_key = f"ssi:board:{exchange}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached
    try:
        import requests as req
        resp = req.get(BOARD_URL.format(exchange=exchange), headers=HEADERS, timeout=10)
        if resp.status_code == 200:
            rows = (resp.json() or {}).get("data") or []
            if rows:
                return cache_set(cache_key, rows, ttl)
    except Exception:
        pass
    return []


def _is_common_stock(row: dict) -> bool:
    symbol = row.get("stockSymbol") or ""
    return row.get("stockType") == "s" and len(symbol) == 3 and symbol.isalpha() and not row.get("permaHalt")


def normalize(row: dict) -> dict:
    """Same shape as _vci.price_board rows: prices in thousand VND, ceiling/floor/refPrice in VND."""
    ref = float(row.get("refPrice") or row.get("priorClosePrice") or 0)
    close = float(row.get("matchedPrice") or 0) or ref
    buy_f = int(row.get("buyForeignQtty") or 0)
    sell_f = int(row.get("sellForeignQtty") or 0)
    exchange = row.get("exchange") or ""
    return {
        "ticker": row.get("stockSymbol", ""),
        "companyName": row.get("companyNameVi") or row.get("clientName") or "",
        "close": round(close / 1000, 2),
        "change": round((close - ref) / 1000, 2),
        "pctChange": round((close - ref) / ref * 100, 2) if ref else 0,
        "volume": int(row.get("nmTotalTradedQty") or 0),
        "value": int(row.get("nmTotalTradedValue") or 0),
        "high": round(float(row.get("highest") or close) / 1000, 2),
        "low": round(float(row.get("lowest") or close) / 1000, 2),
        "foreignBuyVolume": buy_f,
        "foreignSellVolume": sell_f,
        "foreignNetVolume": buy_f - sell_f,
        "board": EXCHANGE_LABELS.get(exchange, exchange.upper()),
        "exchange": EXCHANGE_LABELS.get(exchange, exchange.upper()),
        "ceiling": row.get("ceiling"),
        "floor": row.get("floor"),
        "refPrice": row.get("refPrice"),
        "tradingDate": row.get("tradingDate", ""),
    }


def all_stocks(exchanges=EXCHANGES) -> list:
    """Normalized rows for every common stock on the given exchanges."""
    rows = []
    for ex in exchanges:
        rows.extend(normalize(r) for r in exchange_board(ex) if _is_common_stock(r))
    return rows


def price_board(symbols: list) -> list:
    """Normalized rows for specific symbols, looked up across all exchanges."""
    wanted = {s.upper() for s in symbols}
    found = {}
    for ex in EXCHANGES:
        for r in exchange_board(ex):
            sym = r.get("stockSymbol")
            if sym in wanted and sym not in found:
                found[sym] = normalize(r)
        if len(found) == len(wanted):
            break
    return [found[s.upper()] for s in symbols if s.upper() in found]
