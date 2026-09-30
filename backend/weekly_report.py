"""
Weekly portfolio report (Markdown), saved to runtime/reports/<ISO year>-W<week>.md.

Built from the same analysis/plan/insights/forecast/risk dicts the UI shows, so the report and
the app never disagree. Account numbers never appear (the analysis already masks them).
"""

import os
import re
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

import storage
import tcbs_account as ta

REPORTS_DIR = os.path.join(ta.RUNTIME_DIR, "reports")
_NAME = re.compile(r"^\d{4}-W\d{2}$")


def week_id(d: Optional[date] = None) -> str:
    y, w, _ = (d or date.today()).isocalendar()
    return f"{y}-W{w:02d}"


def _vnd(v: Optional[float]) -> str:
    return "—" if v is None else _int(v) + " đ"


def _int(v: float) -> str:
    return f"{round(v):,}".replace(",", ".")


def _pct(v: Optional[float], signed: bool = True) -> str:
    if v is None:
        return "—"
    return f"{'+' if signed and v > 0 else ''}{v:.2f}%"


def _table(headers: List[str], rows: List[List[str]]) -> str:
    if not rows:
        return "_Không có dữ liệu._\n"
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out) + "\n"


def build_report(analysis: Dict[str, Any], plan: Dict[str, Any], insights: Optional[Dict[str, Any]] = None,
                 forecasts: Optional[Dict[str, Any]] = None, risk: Optional[Dict[str, Any]] = None,
                 today: Optional[date] = None) -> str:
    today = today or date.today()
    monday = today - timedelta(days=today.weekday())
    s = analysis["summary"]
    lines = [f"# Báo cáo danh mục tuần {week_id(today)}",
             f"_Từ {monday:%d/%m} đến {today:%d/%m/%Y} · dữ liệu TCBS đồng bộ lúc {analysis.get('synced_at') or '—'}_\n",
             "## Tổng quan",
             f"- **NAV:** {_vnd(s['nav'])} · cổ phiếu {_vnd(s['stock_value'])} · tiền mặt {_vnd(s['cash'])} ({s['cash_pct']}%)",
             f"- **Lãi/lỗ chưa thực hiện:** {_vnd(s['unrealized_pnl'])} ({_pct(s['unrealized_pnl_pct'])})"]
    pf = plan.get("portfolio", {})
    if pf.get("goal"):
        g = pf["goal"]
        lines.append(f"- **Mục tiêu +{g['goal_pct']}% trong {g['months']} tháng:** xác suất ước tính {g['probability_pct']}%")
    if insights:
        j = insights["journal"]
        week_closed = [c for c in j.get("recent_closed", []) if c["date"] >= monday.isoformat()]
        if week_closed:
            lines.append(f"- **Chốt trong tuần:** {len(week_closed)} lệnh, lãi/lỗ {_vnd(sum(c['pnl'] for c in week_closed))}")
        if j.get("trade_count"):
            lines.append(f"- **Từ khi ghi nhật ký:** lãi/lỗ đã chốt {_vnd(j['realized_pnl'])}, tỷ lệ thắng {j.get('win_rate_pct') or '—'}%")
        w1 = next((w for w in insights["benchmark"]["windows"] if w["window"] == "1 tháng"), None)
        if w1:
            lines.append(f"- **1 tháng qua:** danh mục {_pct(w1['portfolio_pct'])} vs VN-Index {_pct(w1['vnindex_pct'])}")
    lines.append("")

    lines.append("## Vị thế & hành động đề xuất")
    rows = []
    for p in plan["positions"]:
        f = (forecasts or {}).get(p["ticker"]) or {}
        rows.append([p["ticker"], f"{p['weight_pct']}%", _pct(p["pnl_pct"]), p.get("action", "—"),
                     _vnd(p.get("stop_loss")), _vnd(p.get("target")),
                     (f.get("signals") or {}).get("label", "—")])
    lines.append(_table(["Mã", "Tỷ trọng", "Lãi/lỗ", "Hành động", "Stop", "Mục tiêu", "Tín hiệu"], rows))

    flags = [f["text"] for f in analysis.get("flags", [])]
    if insights:
        flags += insights["sectors"].get("flags", [])
    if risk:
        flags += [v["text"] for v in risk.get("vol_spikes", [])]
    if flags:
        lines.append("## Cảnh báo")
        lines += [f"- {t}" for t in flags]
        lines.append("")

    if risk:
        lines.append("## Rủi ro")
        stress = [[x["scenario"], _pct(x["vnindex_pct"]), _pct(x["portfolio_pct"]), _vnd(x["loss"])] for x in risk.get("stress", [])]
        lines.append(_table(["Kịch bản", "VN-Index", "Danh mục", "Lãi/lỗ"], stress))
        sizing = [[z["ticker"], _int(z["held"]), _int(z["suggested"]), f"{z['current_risk_pct_nav']}%"]
                  for z in risk.get("sizing", []) if z["suggested"] != z["held"]]
        if sizing:
            lines.append(f"Khối lượng theo quy tắc rủi ro {risk['risk_pct']}% NAV mỗi lệnh:\n")
            lines.append(_table(["Mã", "Đang giữ", "Đề xuất", "Rủi ro hiện tại/NAV"], sizing))
        lines.append("")

    if insights and insights.get("events"):
        recent = [e for e in insights["events"] if e["date"] >= (today - timedelta(days=14)).isoformat()]
        if recent:
            lines.append("## Sự kiện doanh nghiệp 2 tuần gần đây")
            lines += [f"- {e['date']} · **{e['ticker']}** · {e['type']}: {e['title']}" for e in recent]
            lines.append("")

    rb = plan.get("rebalance", {})
    todo = [f"Bán {_int(t['sell_shares'])} cp {t['ticker']} ({t['note']})" for t in rb.get("trims", [])]
    todo += [f"{p['ticker']}: {p['action'].lower()}" for p in plan["positions"] if p.get("action") in ("CẮT LỖ / HẠ TỶ TRỌNG", "CHỐT LỜI 1/3")]
    if todo:
        lines.append("## Việc cần làm tuần tới")
        lines += [f"- [ ] {t}" for t in todo]
        lines.append("")
    lines.append("_Ước tính thống kê từ dữ liệu quá khứ, không phải khuyến nghị đầu tư._")
    return "\n".join(lines) + "\n"


def save_report(markdown: str, today: Optional[date] = None) -> str:
    name = week_id(today)
    storage.write(os.path.join(REPORTS_DIR, f"{name}.md"), {"markdown": markdown})
    return name


def list_reports() -> List[Dict[str, Any]]:
    return [{"name": fn[:-3], "updated_at": ts} for fn, ts in storage.list_prefix(REPORTS_DIR)
            if fn.endswith(".md") and _NAME.match(fn[:-3])]


def read_report(name: str) -> Optional[str]:
    if not _NAME.match(name or ""):  # never let a request path escape the reports folder
        return None
    doc = storage.read(os.path.join(REPORTS_DIR, f"{name}.md"))
    return doc.get("markdown") if isinstance(doc, dict) else None
