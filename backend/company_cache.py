"""
Company profiles and traded value from the local market database, so screens do not wait on
Vietcap (its profile endpoint takes 0.5–10 s per ticker). Returns the same keys the Vietcap
profile uses (sectorVn, rating, targetPrice, dividendPerShareTsr, marketCap, viOrganShortName).
Anything missing or stale is left for the caller to fetch live.
"""

from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

MAX_AGE_DAYS = 3


def _db():
    import market_db
    return market_db


def cached_profiles(tickers: List[str]) -> Dict[str, Dict[str, Any]]:
    try:
        rows = {u["ticker"]: u for u in _db().universe()}
    except Exception:
        return {}
    cutoff = (datetime.now() - timedelta(days=MAX_AGE_DAYS)).isoformat()
    out = {}
    for t in tickers:
        u = rows.get(t)
        if not u or not u.get("sector") or (u.get("updated_at") or "") < cutoff:
            continue
        out[t] = {"sectorVn": u["sector"], "rating": u.get("rating"), "targetPrice": u.get("target_price"),
                  "dividendPerShareTsr": u.get("dps"), "marketCap": u.get("market_cap"), "viOrganShortName": u.get("name"),
                  "ticker": t, "_from": "db"}
    return out


def avg_traded_value(ticker: str, sessions: int = 20) -> Optional[float]:
    """Average close × volume (VND) over the last `sessions` sessions, from stored prices."""
    try:
        rows = _db().price_panel([ticker], since=(datetime.now() - timedelta(days=60)).strftime("%Y-%m-%d")).get(ticker, [])
    except Exception:
        return None
    recent = rows[-sessions:]
    if len(recent) < 10:
        return None
    return sum(c * v for _, c, v in recent) / len(recent)
