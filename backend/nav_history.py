"""
Real NAV history from each day's sync: equity curve, time-weighted return (TWR), drawdown,
and the same period's VN-Index — the honest answer to "am I beating the market?".

TWR removes deposits and withdrawals. TCBS's cash statement needs transaction codes we do not
have, so external flows are estimated: flow = ΔNAV − Σ q_prev·(p_now − p_prev), i.e. the part of
the NAV change the previous day's holdings cannot explain. Small residuals (fees, intraday
trades) are treated as noise; the user can override any day's flow by hand.
"""

import os
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import tcbs_account as ta

HISTORY_FILE = os.path.join(ta.RUNTIME_DIR, "tcbs_nav_history.json")
NOISE_PCT = 0.005        # |flow| below 0.5% of NAV counts as noise
NOISE_MIN = 1_000_000    # …or below 1 triệu đồng


def load() -> Dict[str, Any]:
    h = ta._read_json(HISTORY_FILE) or {}
    h.setdefault("days", {})
    h.setdefault("flows", {})   # manual overrides: {date: amount}, + deposit / − withdrawal
    return h


def record(analysis: Dict[str, Any]) -> Dict[str, Any]:
    """Store today's NAV and positions (the last sync of a day wins)."""
    h = load()
    day = (analysis.get("synced_at") or datetime.now().isoformat())[:10]
    s = analysis["summary"]
    h["days"][day] = {"nav": s["nav"], "stock_value": s["stock_value"], "cash": s["cash"], "debt": s.get("debt", 0),
                      "positions": {x["ticker"]: [x["quantity"], x["price"]] for x in analysis["holdings"]}}
    ta._write_private(HISTORY_FILE, h)
    return h["days"][day]


def set_flow(day: str, amount: Optional[float]) -> None:
    datetime.strptime(day, "%Y-%m-%d")  # raises ValueError on a malformed date
    h = load()
    if amount is None:
        h["flows"].pop(day, None)
    else:
        h["flows"][day] = float(amount)
    ta._write_private(HISTORY_FILE, h)


def estimate_flow(prev: Dict[str, Any], cur: Dict[str, Any]) -> float:
    market_pnl = 0.0
    for t, (qty, p_prev) in prev["positions"].items():
        p_now = cur["positions"].get(t, [0, p_prev])[1]  # sold since: its P&L already sits in cash
        market_pnl += qty * (p_now - p_prev)
    flow = cur["nav"] - prev["nav"] - market_pnl
    return 0.0 if abs(flow) < max(NOISE_MIN, NOISE_PCT * prev["nav"]) else flow


def _index_on(index: Dict[str, float], day: str) -> Optional[float]:
    keys = [d for d in index if d <= day]
    return index[max(keys)] if keys else None


def metrics(history: Dict[str, Any], index_closes: List[Tuple[str, float]],
            ledger_flows: Optional[Dict[str, float]] = None, ledger_from: Optional[str] = None,
            ledger_to: Optional[str] = None) -> Dict[str, Any]:
    """`ledger_flows` = exact flows from the TCBS cash statement, trusted between ledger_from and
    ledger_to; manual overrides win; otherwise flows are estimated from the NAV residual."""
    days = sorted(history["days"])
    idx = dict(index_closes)
    if not days:
        return {"points": [], "stats": None}
    points, twr, peak = [], 1.0, 1.0
    max_dd, total_flows = 0.0, 0.0
    base_index = _index_on(idx, days[0])
    for i, d in enumerate(days):
        cur = history["days"][d]
        flow, estimated, source = 0.0, False, "none"
        if i:
            prev = history["days"][days[i - 1]]
            prev_day = days[i - 1]
            if d in history["flows"]:
                flow = history["flows"][d]
            elif ledger_flows is not None and ledger_from and ledger_to and ledger_from <= prev_day and d <= ledger_to:
                # every calendar day since the previous snapshot (weekends, holidays included)
                flow, source = sum(v for k, v in ledger_flows.items() if prev_day < k <= d), "ledger"
            else:
                flow, estimated = estimate_flow(prev, cur), True
            if prev["nav"] > 0:
                twr *= (cur["nav"] - flow) / prev["nav"]
            total_flows += flow
        peak = max(peak, twr)
        dd = twr / peak - 1
        max_dd = min(max_dd, dd)
        iv = _index_on(idx, d)
        points.append({"date": d, "nav": round(cur["nav"]), "flow": round(flow), "flow_estimated": estimated and flow != 0,
                       "flow_source": "manual" if (i and d in history["flows"]) else source if flow else "none",
                       "twr_pct": round((twr - 1) * 100, 2), "drawdown_pct": round(dd * 100, 2),
                       "vnindex_pct": round((iv / base_index - 1) * 100, 2) if iv and base_index else None})
    last = points[-1]
    first_day = datetime.fromisoformat(days[0])
    span = (datetime.fromisoformat(days[-1]) - first_day).days
    return {
        "points": points,
        "stats": {
            "since": days[0], "days_tracked": len(days), "calendar_days": span,
            "twr_pct": last["twr_pct"], "vnindex_pct": last["vnindex_pct"],
            "excess_pct": round(last["twr_pct"] - last["vnindex_pct"], 2) if last["vnindex_pct"] is not None else None,
            "twr_annual_pct": round(((1 + last["twr_pct"] / 100) ** (365 / span) - 1) * 100, 1) if span >= 90 else None,
            "max_drawdown_pct": round(max_dd * 100, 2), "current_drawdown_pct": last["drawdown_pct"],
            "net_flows": round(total_flows), "nav_now": last["nav"],
        },
    }


def attribution(history: Dict[str, Any], sectors: Dict[str, str], price_lookup=None,
                points: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """Where the P&L came from between snapshots: yesterday's holdings × today's price move, per
    ticker and per sector. Whatever the NAV change holds beyond that (dividends, fees, trades
    during the day, interest) is reported as "other", so the parts add up to the real change.

    `price_lookup(ticker, day)` supplies a price for positions closed since the previous snapshot."""
    days = sorted(history["days"])
    by_ticker: Dict[str, float] = {}
    by_sector: Dict[str, float] = {}
    flows = {p["date"]: p["flow"] for p in (points or [])}
    total_price = total_nav_change = 0.0
    for prev_d, d in zip(days, days[1:]):
        prev, cur = history["days"][prev_d], history["days"][d]
        for t, (qty, p_prev) in prev["positions"].items():
            p_now = (cur["positions"].get(t) or [0, None])[1]
            if p_now is None and price_lookup:
                p_now = price_lookup(t, d)
            if not p_now or not p_prev:
                continue
            pnl = qty * (p_now - p_prev)
            by_ticker[t] = by_ticker.get(t, 0.0) + pnl
            sec = sectors.get(t) or "Khác"
            by_sector[sec] = by_sector.get(sec, 0.0) + pnl
            total_price += pnl
        total_nav_change += cur["nav"] - prev["nav"] - flows.get(d, 0.0)
    rows = sorted(({"ticker": t, "pnl": round(v), "sector": sectors.get(t) or "Khác"} for t, v in by_ticker.items()), key=lambda r: r["pnl"])
    return {"since": days[0] if days else None, "days": len(days),
            "by_ticker": rows[::-1], "by_sector": sorted(({"sector": k, "pnl": round(v)} for k, v in by_sector.items()), key=lambda r: -r["pnl"]),
            "price_pnl": round(total_price), "nav_change_ex_flows": round(total_nav_change),
            "other": round(total_nav_change - total_price),
            "other_note": "Cổ tức, phí/thuế, lãi tiền gửi, và lãi/lỗ của các lệnh mua bán trong ngày."}
