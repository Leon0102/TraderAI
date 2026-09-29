"""
Keep score of our own forecasts: every week the 1-month forecast for each holding is logged,
and once a month has passed it is checked against the real price.

- 90% band (P5–P95) should contain ~90% of outcomes, the 50% band (P25–P75) ~50%.
- Brier score of P(up): 0 is perfect, 0.25 is a coin flip; lower is better.
"""

import os
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import tcbs_account as ta

LOG_FILE = os.path.join(ta.RUNTIME_DIR, "forecast_log.json")
HORIZON_DAYS = 30  # "1 tháng" ≈ 21 sessions ≈ 30 calendar days


def load_log() -> Dict[str, Any]:
    return ta._read_json(LOG_FILE) or {}


def log_forecasts(forecasts: Dict[str, Any], today: Optional[date] = None) -> int:
    """Record this week's 1-month forecast per ticker (the first one of the week is kept)."""
    today = today or date.today()
    y, w, _ = today.isocalendar()
    log = load_log()
    added = 0
    for ticker, f in forecasts.items():
        if not f:
            continue
        key = f"{y}-W{w:02d}:{ticker}"
        if key in log:
            continue
        log[key] = {"date": today.isoformat(), "ticker": ticker, "price": f["price"],
                    "band": f["bands"]["1 tháng"], "prob_up": f["prob_up"]["1 tháng"]}
        added += 1
    if added:
        ta._write_private(LOG_FILE, log)
    return added


def _close_on_or_after(series: List[Tuple[str, float]], day: str) -> Optional[Tuple[str, float]]:
    for d, c in series:
        if d >= day:
            return d, c
    return None


def score(log: Dict[str, Any], history: Dict[str, List[Tuple[str, float]]], today: Optional[date] = None) -> Dict[str, Any]:
    today = today or date.today()
    rows = []
    for entry in sorted(log.values(), key=lambda e: e["date"]):
        due = (datetime.fromisoformat(entry["date"]).date() + timedelta(days=HORIZON_DAYS)).isoformat()
        if due > today.isoformat():
            continue
        hit = _close_on_or_after(sorted(history.get(entry["ticker"], [])), due)
        if not hit:
            continue
        realised = hit[1]
        b = entry["band"]
        up = realised > entry["price"]
        rows.append({"date": entry["date"], "ticker": entry["ticker"], "price": entry["price"], "realised": round(realised),
                     "in90": b["p5"] <= realised <= b["p95"], "in50": b["p25"] <= realised <= b["p75"],
                     "prob_up": entry["prob_up"], "went_up": up,
                     "brier": round((entry["prob_up"] / 100 - (1.0 if up else 0.0)) ** 2, 4)})
    pending = sum(1 for e in log.values()
                  if (datetime.fromisoformat(e["date"]).date() + timedelta(days=HORIZON_DAYS)) > today)
    if not rows:
        return {"scored": 0, "pending": pending, "rows": []}
    n = len(rows)
    brier = sum(r["brier"] for r in rows) / n
    return {
        "scored": n, "pending": pending,
        "coverage90_pct": round(sum(r["in90"] for r in rows) / n * 100, 1),
        "coverage50_pct": round(sum(r["in50"] for r in rows) / n * 100, 1),
        "brier": round(brier, 4),
        "verdict": ("Xác suất tăng/giảm tốt hơn tung đồng xu." if brier < 0.24 else
                    "Xác suất tăng/giảm chỉ ngang tung đồng xu — chỉ tin phần vùng giá." if brier <= 0.26 else
                    "Xác suất tăng/giảm kém hơn tung đồng xu — đừng dùng để đoán hướng."),
        "rows": rows[-20:][::-1],
    }
