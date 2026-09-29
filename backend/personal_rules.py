"""
The user's own trading rules, checked on every sync, in the pre-trade checklist and by the
auto-sync notifier. Stored in runtime/tcbs_rules.json.
"""

import os
from typing import Any, Dict, List, Optional

import tcbs_account as ta

RULES_FILE = os.path.join(ta.RUNTIME_DIR, "tcbs_rules.json")
DEFAULT_RULES: Dict[str, Any] = {
    "max_positions": 8,          # hold at most N stocks
    "max_weight_pct": 25.0,      # one stock at most N% of NAV
    "max_sector_pct": 40.0,      # one sector at most N% of NAV
    "min_cash_pct": 10.0,        # keep at least N% cash
    "max_loss_pct": 7.0,         # a position losing more than N% must be cut
    "max_risk_per_trade_pct": 1.0,
    "no_average_down": True,     # never buy more of a losing position
}
_LIMITS = {"max_positions": (1, 50), "max_weight_pct": (1, 100), "max_sector_pct": (1, 100), "min_cash_pct": (0, 100),
           "max_loss_pct": (1, 50), "max_risk_per_trade_pct": (0.1, 10)}


def load_rules() -> Dict[str, Any]:
    return {**DEFAULT_RULES, **(ta._read_json(RULES_FILE) or {})}


def save_rules(update: Dict[str, Any]) -> Dict[str, Any]:
    rules = load_rules()
    for key, value in update.items():
        if key not in DEFAULT_RULES:
            raise ValueError(f"Quy tắc không tồn tại: {key}")
        if key == "no_average_down":
            rules[key] = bool(value)
            continue
        lo, hi = _LIMITS[key]
        v = float(value)
        if not lo <= v <= hi:
            raise ValueError(f"{key} phải trong khoảng {lo}–{hi}")
        rules[key] = int(v) if key == "max_positions" else v
    ta._write_private(RULES_FILE, rules)
    return rules


def evaluate(analysis: Dict[str, Any], sectors: Optional[Dict[str, str]] = None,
             rules: Optional[Dict[str, Any]] = None) -> List[Dict[str, str]]:
    """Violations of the rules by the current portfolio (and today's buys)."""
    r = rules or load_rules()
    holdings, s = analysis["holdings"], analysis["summary"]
    out: List[Dict[str, str]] = []
    if len(holdings) > r["max_positions"]:
        out.append({"rule": "max_positions", "text": f"Đang giữ {len(holdings)} mã, vượt giới hạn {r['max_positions']} mã."})
    for h in holdings:
        if h["weight_pct"] > r["max_weight_pct"]:
            out.append({"rule": "max_weight_pct", "text": f"{h['ticker']} chiếm {h['weight_pct']}% NAV, vượt trần {r['max_weight_pct']:g}%."})
        if h["pnl_pct"] <= -r["max_loss_pct"]:
            out.append({"rule": "max_loss_pct", "text": f"{h['ticker']} lỗ {h['pnl_pct']}%, vượt ngưỡng cắt lỗ -{r['max_loss_pct']:g}% bạn đặt ra."})
    if holdings and s["cash_pct"] < r["min_cash_pct"]:
        out.append({"rule": "min_cash_pct", "text": f"Tiền mặt {s['cash_pct']}%, dưới mức tối thiểu {r['min_cash_pct']:g}%."})
    if sectors:
        by_sector: Dict[str, float] = {}
        for h in holdings:
            name = sectors.get(h["ticker"])
            if name:
                by_sector[name] = by_sector.get(name, 0.0) + h["weight_pct"]
        for name, w in by_sector.items():
            if w > r["max_sector_pct"]:
                out.append({"rule": "max_sector_pct", "text": f"Ngành {name} chiếm {w:.1f}% NAV, vượt trần {r['max_sector_pct']:g}%."})
    if r["no_average_down"]:
        losing = {h["ticker"] for h in holdings if h["pnl_pct"] < 0}
        for t in analysis.get("today_trades", []):
            if t.get("buy_qty") and t["ticker"] in losing:
                out.append({"rule": "no_average_down", "text": f"Hôm nay mua thêm {t['ticker']} trong khi mã này đang lỗ — trái quy tắc không trung bình giá xuống."})
    return out
