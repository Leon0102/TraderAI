"""
Track record of the AI council: every final verdict is logged with the price on the day, and once
`HORIZON_DAYS` have passed it is compared with what the stock (and VN-Index) really did.

Buy calls should beat the index, sell calls should lag it; "observe" is not scored on direction.
Small samples say nothing, and the UI says so.
"""

import os
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import storage

LOG_FILE = os.path.join(storage.RUNTIME_DIR, "council_log.json")
HORIZON_DAYS = 28
MIN_SAMPLE = 20


def log_verdict(ticker: str, structured: Dict[str, Any], price: Optional[float], engine: Optional[str] = None,
                today: Optional[date] = None) -> None:
    """One entry per ticker per day (the latest run wins)."""
    day = (today or date.today()).isoformat()
    log = storage.read(LOG_FILE) or {}
    log[f"{day}:{ticker.upper()}"] = {"date": day, "ticker": ticker.upper(), "action": structured.get("action"),
                                      "price": price, "sizing": structured.get("sizing"), "risk": structured.get("risk_level"),
                                      "engine": (engine or "")[:40]}
    storage.write(LOG_FILE, log)


def load() -> Dict[str, Any]:
    return storage.read(LOG_FILE) or {}


def _close_on_or_after(rows: List[Tuple[str, float, float]], day: str) -> Optional[Tuple[str, float]]:
    for d, c, _ in rows:
        if d >= day:
            return d, c
    return None


def _close_on_or_before(rows: List[Tuple[str, float, float]], day: str) -> Optional[float]:
    prev = [c for d, c, _ in rows if d <= day]
    return prev[-1] if prev else None


def score(log: Dict[str, Any], panel: Dict[str, List[Tuple[str, float, float]]], today: Optional[date] = None) -> Dict[str, Any]:
    today = today or date.today()
    index = panel.get("VNINDEX", [])
    rows, pending = [], 0
    for e in sorted(log.values(), key=lambda x: x["date"]):
        due = (datetime.fromisoformat(e["date"]).date() + timedelta(days=HORIZON_DAYS)).isoformat()
        if due > today.isoformat():
            pending += 1
            continue
        px = panel.get(e["ticker"], [])
        start = _close_on_or_before(px, e["date"])
        end = _close_on_or_after(px, due)
        i0, i1 = _close_on_or_before(index, e["date"]), _close_on_or_after(index, due)
        if not (start and end and i0 and i1):
            continue
        ret, idx_ret = end[1] / start - 1, i1[1] / i0 - 1
        rows.append({"date": e["date"], "ticker": e["ticker"], "action": e["action"], "ret_pct": round(ret * 100, 2),
                     "excess_pct": round((ret - idx_ret) * 100, 2)})
    by_action = {}
    for a in ("MUA", "QUAN SÁT", "BÁN"):
        rs = [r for r in rows if r["action"] == a]
        if not rs:
            continue
        want_up = a == "MUA"
        by_action[a] = {"n": len(rs), "avg_ret_pct": round(sum(r["ret_pct"] for r in rs) / len(rs), 2),
                        "avg_excess_pct": round(sum(r["excess_pct"] for r in rs) / len(rs), 2),
                        "right_pct": None if a == "QUAN SÁT" else round(sum(1 for r in rs if (r["excess_pct"] > 0) == want_up) / len(rs) * 100, 1)}
    scored = len(rows)
    verdict = ("Chưa đủ mẫu để kết luận (cần ít nhất %d phán quyết đã có kết quả)." % MIN_SAMPLE) if scored < MIN_SAMPLE else None
    if verdict is None and "MUA" in by_action:
        b = by_action["MUA"]
        verdict = ("Khuyến nghị MUA thắng VN-Index trung bình %+.1f%%/%d ngày." % (b["avg_excess_pct"], HORIZON_DAYS)
                   if b["avg_excess_pct"] > 0 else "Khuyến nghị MUA chưa thắng VN-Index — đừng coi phán quyết là tín hiệu độc lập.")
    return {"horizon_days": HORIZON_DAYS, "logged": len(log), "scored": scored, "pending": pending, "by_action": by_action,
            "verdict": verdict, "recent": rows[-15:][::-1]}
