"""
Market database: daily prices for the whole exchange, point-in-time financial statements,
company profiles and daily foreign-flow snapshots.

Postgres when DATABASE_URL is set (Docker), otherwise SQLite at runtime/market.db. SQL is
written once with "?" placeholders and an upsert both engines accept (ON CONFLICT … DO UPDATE).
"""

import json
import os
import sqlite3
import threading
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import storage

SQLITE_PATH = os.path.join(storage.RUNTIME_DIR, "market.db")
_lock = threading.Lock()
_ready = False

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS prices (
        ticker TEXT NOT NULL, d TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL, volume REAL,
        PRIMARY KEY (ticker, d))""",
    "CREATE INDEX IF NOT EXISTS prices_d ON prices (d)",
    """CREATE TABLE IF NOT EXISTS universe (
        ticker TEXT PRIMARY KEY, exchange TEXT, name TEXT, sector TEXT, shares REAL, market_cap REAL,
        rating TEXT, target_price REAL, dps REAL, is_bank INTEGER, updated_at TEXT)""",
    """CREATE TABLE IF NOT EXISTS statements (
        ticker TEXT NOT NULL, year INTEGER NOT NULL, quarter INTEGER NOT NULL, section TEXT NOT NULL,
        public_date TEXT, data TEXT NOT NULL, PRIMARY KEY (ticker, year, quarter, section))""",
    """CREATE TABLE IF NOT EXISTS flows (
        ticker TEXT NOT NULL, d TEXT NOT NULL, close REAL, volume REAL, value REAL,
        foreign_buy_vol REAL, foreign_sell_vol REAL, foreign_net_vol REAL, PRIMARY KEY (ticker, d))""",
    """CREATE TABLE IF NOT EXISTS jobs (name TEXT PRIMARY KEY, updated_at TEXT, info TEXT)""",
]


def is_postgres() -> bool:
    return storage.using_database()


class _Conn:
    """Tiny adapter so callers use "?" placeholders on both engines."""

    def __init__(self):
        if is_postgres():
            import psycopg
            self.raw = psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)
            self.pg = True
        else:
            os.makedirs(os.path.dirname(SQLITE_PATH), exist_ok=True)
            self.raw = sqlite3.connect(SQLITE_PATH, timeout=30)
            self.raw.execute("PRAGMA journal_mode=WAL")
            self.pg = False

    def _sql(self, sql: str) -> str:
        return sql.replace("?", "%s") if self.pg else sql

    def execute(self, sql: str, params: Sequence[Any] = ()) -> List[Tuple]:
        cur = self.raw.cursor()
        cur.execute(self._sql(sql), tuple(params))
        rows = cur.fetchall() if cur.description else []
        if not self.pg:
            self.raw.commit()
        return rows

    def executemany(self, sql: str, rows: Iterable[Sequence[Any]]) -> None:
        rows = [tuple(r) for r in rows]
        if not rows:
            return
        cur = self.raw.cursor()
        cur.executemany(self._sql(sql), rows)
        if not self.pg:
            self.raw.commit()

    def close(self) -> None:
        self.raw.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def connect() -> _Conn:
    global _ready
    conn = _Conn()
    if not _ready:
        with _lock:
            for stmt in SCHEMA:
                conn.execute(stmt)
            _ready = True
    return conn


def reset_for_tests(path: str) -> None:
    """Point SQLite at a scratch file (tests only)."""
    global SQLITE_PATH, _ready
    SQLITE_PATH, _ready = path, False


# ---------- writes ----------

def upsert_prices(ticker: str, bars: List[Dict[str, Any]]) -> int:
    rows = [(ticker, b["d"], b.get("open"), b.get("high"), b.get("low"), b["close"], b.get("volume")) for b in bars if b.get("close")]
    with connect() as c:
        c.executemany("INSERT INTO prices (ticker, d, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?) "
                      "ON CONFLICT (ticker, d) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low, "
                      "close = excluded.close, volume = excluded.volume", rows)
    return len(rows)


def upsert_universe(rows: List[Dict[str, Any]]) -> None:
    cols = ("ticker", "exchange", "name", "sector", "shares", "market_cap", "rating", "target_price", "dps", "is_bank", "updated_at")
    with connect() as c:
        for r in rows:
            present = [k for k in cols if k in r]
            sets = ", ".join(f"{k} = excluded.{k}" for k in present if k != "ticker")
            c.execute(f"INSERT INTO universe ({', '.join(present)}) VALUES ({', '.join('?' * len(present))}) "
                      f"ON CONFLICT (ticker) DO UPDATE SET {sets}", [r[k] for k in present])


def upsert_statements(ticker: str, section: str, periods: List[Dict[str, Any]]) -> int:
    rows = []
    for p in periods:
        year = p.get("yearReport")
        if not year:
            continue
        quarter = int(p.get("lengthReport") or 5)
        quarter = 0 if quarter >= 5 else quarter  # VCI: lengthReport 5 = full year, 1–4 = quarter
        data = {k: v for k, v in p.items() if isinstance(v, (int, float)) and k[:3] in ("isa", "isb", "iss", "bsa", "bsb", "bss", "cfa", "cfb", "cfs")}
        rows.append((ticker, int(year), quarter, section, (p.get("publicDate") or "")[:10] or None, json.dumps(data)))
    with connect() as c:
        c.executemany("INSERT INTO statements (ticker, year, quarter, section, public_date, data) VALUES (?, ?, ?, ?, ?, ?) "
                      "ON CONFLICT (ticker, year, quarter, section) DO UPDATE SET public_date = excluded.public_date, data = excluded.data", rows)
    return len(rows)


def upsert_flows(day: str, rows: List[Dict[str, Any]]) -> int:
    vals = [(r["ticker"], day, r.get("close"), r.get("volume"), r.get("value"), r.get("foreign_buy_vol"),
             r.get("foreign_sell_vol"), r.get("foreign_net_vol")) for r in rows if r.get("ticker")]
    with connect() as c:
        c.executemany("INSERT INTO flows (ticker, d, close, volume, value, foreign_buy_vol, foreign_sell_vol, foreign_net_vol) "
                      "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ticker, d) DO UPDATE SET close = excluded.close, "
                      "volume = excluded.volume, value = excluded.value, foreign_buy_vol = excluded.foreign_buy_vol, "
                      "foreign_sell_vol = excluded.foreign_sell_vol, foreign_net_vol = excluded.foreign_net_vol", vals)
    return len(vals)


def set_job(name: str, info: Dict[str, Any]) -> None:
    from datetime import datetime
    with connect() as c:
        c.execute("INSERT INTO jobs (name, updated_at, info) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET "
                  "updated_at = excluded.updated_at, info = excluded.info",
                  (name, datetime.now().isoformat(timespec="seconds"), json.dumps(info, ensure_ascii=False)))


def get_job(name: str) -> Optional[Dict[str, Any]]:
    with connect() as c:
        rows = c.execute("SELECT updated_at, info FROM jobs WHERE name = ?", (name,))
    if not rows:
        return None
    return {"updated_at": rows[0][0], **json.loads(rows[0][1] or "{}")}


# ---------- reads ----------

def last_price_date(ticker: str) -> Optional[str]:
    with connect() as c:
        rows = c.execute("SELECT MAX(d) FROM prices WHERE ticker = ?", (ticker,))
    return rows[0][0] if rows and rows[0][0] else None


def price_panel(tickers: Optional[List[str]] = None, since: Optional[str] = None) -> Dict[str, List[Tuple[str, float, float]]]:
    """{ticker: [(date, close, volume)]} sorted by date."""
    sql = "SELECT ticker, d, close, volume FROM prices WHERE 1 = 1"
    params: List[Any] = []
    if since:
        sql += " AND d >= ?"
        params.append(since)
    if tickers:
        sql += f" AND ticker IN ({', '.join('?' * len(tickers))})"
        params += tickers
    sql += " ORDER BY ticker, d"
    out: Dict[str, List[Tuple[str, float, float]]] = {}
    with connect() as c:
        for t, d, close, vol in c.execute(sql, params):
            out.setdefault(t, []).append((d, float(close), float(vol or 0)))
    return out


def universe(active_only: bool = False) -> List[Dict[str, Any]]:
    cols = ("ticker", "exchange", "name", "sector", "shares", "market_cap", "rating", "target_price", "dps", "is_bank", "updated_at")
    with connect() as c:
        rows = c.execute(f"SELECT {', '.join(cols)} FROM universe ORDER BY ticker")
    out = [dict(zip(cols, r)) for r in rows]
    return [u for u in out if u["sector"]] if active_only else out


def statements(tickers: Optional[List[str]] = None) -> Dict[str, List[Dict[str, Any]]]:
    """{ticker: [{year, quarter, public_date, bs, is, cf}]} merged per period, oldest first."""
    sql = "SELECT ticker, year, quarter, section, public_date, data FROM statements"
    params: List[Any] = []
    if tickers:
        sql += f" WHERE ticker IN ({', '.join('?' * len(tickers))})"
        params = list(tickers)
    merged: Dict[Tuple[str, int, int], Dict[str, Any]] = {}
    with connect() as c:
        for t, y, q, sec, pub, data in c.execute(sql, params):
            m = merged.setdefault((t, y, q), {"year": y, "quarter": q, "public_date": pub})
            m[{"BALANCE_SHEET": "bs", "INCOME_STATEMENT": "is", "CASH_FLOW": "cf"}[sec]] = json.loads(data)
            if pub and (not m["public_date"] or pub > m["public_date"]):
                m["public_date"] = pub
    out: Dict[str, List[Dict[str, Any]]] = {}
    for (t, y, q), m in sorted(merged.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2])):
        out.setdefault(t, []).append(m)
    return out


def flows(since: str) -> Dict[str, List[Tuple[str, float, float]]]:
    """{ticker: [(date, foreign_net_value, traded_value)]}."""
    out: Dict[str, List[Tuple[str, float, float]]] = {}
    with connect() as c:
        for t, d, close, net, value in c.execute(
                "SELECT ticker, d, close, foreign_net_vol, value FROM flows WHERE d >= ? ORDER BY ticker, d", (since,)):
            px = float(close or 0)
            px = px * 1000 if 0 < px < 1000 else px
            out.setdefault(t, []).append((d, float(net or 0) * px, float(value or 0)))
    return out


def counts() -> Dict[str, int]:
    with connect() as c:
        return {t: int(c.execute(f"SELECT COUNT(*) FROM {t}")[0][0]) for t in ("prices", "universe", "statements", "flows")}
