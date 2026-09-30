"""
Ingest the market into market_db:

  prices      every listed ticker (HOSE/HNX/UPCoM), ~5 years daily, incremental afterwards
  universe    exchange/name for all; sector, shares, analyst target, dividend for liquid names
  statements  8 years + quarters of BS/IS/CF with publish dates (point in time), weekly refresh
  flows       today's foreign buy/sell per ticker from the SSI board (history accumulates daily)

  python backend/market_ingest.py            # full/incremental run
  python backend/market_ingest.py --quick    # prices + flows only

Liquid = average traded value over the last 20 sessions ≥ 1 tỷ đồng; fundamentals are only
fetched for those names (thin UPCoM tickers have unreliable statements and cannot be traded).
"""

import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from typing import Any, Callable, Dict, List

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
API_DIR = os.path.abspath(os.path.join(HERE, "..", "api"))
if API_DIR not in sys.path:
    sys.path.append(API_DIR)  # append: api/agents.py must not shadow the backend agents package

import market_db as db  # noqa: E402

YEARS = 5
LIQUID_VALUE = 1_000_000_000
STATEMENT_REFRESH_DAYS = 7
SECTIONS = ("BALANCE_SHEET", "INCOME_STATEMENT", "CASH_FLOW")
WORKERS = 8


def _vnd(p: float) -> float:
    return p * 1000 if 0 < p < 1000 else p


def _parallel(fn: Callable[[str], Any], items: List[str]) -> List[Any]:
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        return list(pool.map(fn, items))


def ingest_universe() -> List[Dict[str, Any]]:
    from stocks import get_symbols
    rows = [r for r in (get_symbols() or {}).get("data", []) if r.get("ticker") and r.get("exchange") in ("HOSE", "HNX", "UPCOM")]
    db.upsert_universe([{"ticker": r["ticker"], "exchange": r["exchange"], "name": r.get("name")} for r in rows])
    return rows


def ingest_prices(tickers: List[str]) -> Dict[str, int]:
    from history import get_history
    end = date.today().isoformat()
    full_start = (date.today() - timedelta(days=365 * YEARS + 20)).isoformat()

    def one(t: str) -> int:
        last = db.last_price_date(t)
        start = (datetime.fromisoformat(last).date() - timedelta(days=7)).isoformat() if last else full_start
        try:
            bars = (get_history(t, start, end) or {}).get("data") or []
        except Exception:
            return -1
        scale = (lambda v: v) if t == "VNINDEX" else _vnd
        return db.upsert_prices(t, [{"d": b.get("tradingDate", "")[:10], "open": scale(float(b.get("open") or 0)),
                                     "high": scale(float(b.get("high") or 0)), "low": scale(float(b.get("low") or 0)),
                                     "close": scale(float(b["close"])), "volume": float(b.get("volume") or 0)}
                                    for b in bars if b.get("close") and b.get("tradingDate")])

    results = _parallel(one, tickers)
    return {"tickers": len(tickers), "rows": sum(r for r in results if r > 0), "failed": sum(1 for r in results if r < 0)}


def liquid_tickers(min_value: float = LIQUID_VALUE) -> List[str]:
    since = (date.today() - timedelta(days=45)).isoformat()
    out = []
    for t, rows in db.price_panel(since=since).items():
        if t == "VNINDEX" or len(rows) < 10:
            continue
        recent = rows[-20:]
        if sum(c * v for _, c, v in recent) / len(recent) >= min_value:
            out.append(t)
    return sorted(out)


def ingest_companies(tickers: List[str]) -> int:
    import _vci

    def one(t: str) -> Dict[str, Any]:
        try:
            c = _vci.company_info(t) or {}
        except Exception:
            c = {}
        return c

    now = datetime.now().isoformat(timespec="seconds")
    rows = []
    for t, c in zip(tickers, _parallel(one, tickers)):
        if not c:
            continue
        rows.append({"ticker": t, "sector": c.get("sectorVn"), "shares": c.get("issueShare") or c.get("numberOfSharesMktCap"),
                     "market_cap": c.get("marketCap"), "rating": c.get("rating"), "target_price": c.get("targetPrice"),
                     "dps": c.get("dividendPerShareTsr"), "is_bank": 1 if c.get("isBank") else 0, "updated_at": now})
    db.upsert_universe(rows)
    db.record_targets(date.today().isoformat(), rows)  # analyst revisions build up day by day
    return len(rows)


def ingest_statements(tickers: List[str], force: bool = False) -> Dict[str, int]:
    import _vci
    last = db.get_job("statements") or {}
    fresh = set(last.get("done", [])) if not force and last.get("updated_at", "") >= (datetime.now() - timedelta(days=STATEMENT_REFRESH_DAYS)).isoformat() else set()
    todo = [t for t in tickers if t not in fresh]

    def one(t: str) -> int:
        n = 0
        for sec in SECTIONS:
            d = _vci._vci_get(f"{_vci.IQ_URL}/v1/company/{t}/financial-statement", params={"section": sec}, ttl=3600)
            data = (d or {}).get("data") or {}
            periods = (data.get("years") or []) + (data.get("quarters") or [])
            if periods:
                n += db.upsert_statements(t, sec, periods)
        return n

    results = _parallel(one, todo)
    done = sorted(fresh | {t for t, n in zip(todo, results) if n > 0})
    db.set_job("statements", {"done": done})
    return {"fetched": len(todo), "with_data": sum(1 for n in results if n > 0), "total_covered": len(done)}


def ingest_flows(tickers: List[str]) -> int:
    import _ssi
    rows = []
    for i in range(0, len(tickers), 300):
        for r in _ssi.price_board(tickers[i:i + 300]) or []:
            rows.append({"ticker": r.get("ticker"), "close": _vnd(float(r.get("close") or 0)), "volume": r.get("volume"),
                         "value": r.get("value"), "foreign_buy_vol": r.get("foreignBuyVolume"),
                         "foreign_sell_vol": r.get("foreignSellVolume"), "foreign_net_vol": r.get("foreignNetVolume")})
    return db.upsert_flows(date.today().isoformat(), rows)


def run(quick: bool = False, log: Callable[[str], None] = print) -> Dict[str, Any]:
    started = datetime.now()
    db.set_job("ingest", {"state": "running", "started_at": started.isoformat(timespec="seconds")})
    try:
        uni = ingest_universe()
        tickers = [r["ticker"] for r in uni]
        log(f"universe: {len(tickers)} tickers")
        prices = ingest_prices(tickers + ["VNINDEX"])
        log(f"prices: {prices}")
        flows = ingest_flows(tickers)
        log(f"flows: {flows} rows today")
        info: Dict[str, Any] = {"universe": len(tickers), "prices": prices, "flows": flows}
        if not quick:
            liquid = liquid_tickers()
            log(f"liquid: {len(liquid)} tickers")
            info["companies"] = ingest_companies(liquid)
            log(f"companies: {info['companies']}")
            info["statements"] = ingest_statements(liquid)
            log(f"statements: {info['statements']}")
            info["liquid"] = len(liquid)
        info.update({"state": "done", "seconds": round((datetime.now() - started).total_seconds()), "counts": db.counts()})
        db.set_job("ingest", info)
        return info
    except Exception as e:
        db.set_job("ingest", {"state": "failed", "error": repr(e)[:300]})
        raise


if __name__ == "__main__":
    sys.path.insert(0, HERE)
    import tcbs_account
    tcbs_account._load_env()
    print(run(quick="--quick" in sys.argv))
