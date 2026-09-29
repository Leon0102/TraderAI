"""
Alerts for the auto-sync job: Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env.local)
and a local macOS notification. Each alert is sent at most once per day.

Telegram messages carry tickers, prices and percentages only — never account numbers or
absolute NAV — because they leave this machine.
"""

import os
import subprocess
import sys
from datetime import date
from typing import Any, Dict, List, Optional

import tcbs_account as ta

STATE_FILE = os.path.join(ta.RUNTIME_DIR, "notify_state.json")


def collect_alerts(analysis: Dict[str, Any], plan: Dict[str, Any], forecasts: Dict[str, Any],
                   violations: List[Dict[str, str]], news: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, str]]:
    """(id, text) pairs; the id decides deduplication."""
    out = []
    for p in plan["positions"]:
        t, price = p["ticker"], p["price"]
        if p.get("stop_loss") and price <= p["stop_loss"]:
            out.append({"id": f"stop:{t}:{p['stop_loss']}", "text": f"🔻 {t} {price:,} đ đã chạm stop-loss {p['stop_loss']:,} đ.".replace(",", ".")})
        if p.get("target") and price >= p["target"]:
            out.append({"id": f"target:{t}:{p['target']}", "text": f"🎯 {t} {price:,} đ đã chạm mục tiêu {p['target']:,} đ.".replace(",", ".")})
        if not p["in_profit_after_costs"] and p["gap_to_breakeven_pct"] <= 1:
            out.append({"id": f"breakeven:{t}", "text": f"↩️ {t} chỉ còn cách giá hòa vốn {p['gap_to_breakeven_pct']}%."})
    for t, f in forecasts.items():
        g = (f or {}).get("garch") or {}
        if g.get("vol_long_run_annual_pct") and g["vol_now_annual_pct"] / g["vol_long_run_annual_pct"] >= 1.5:
            out.append({"id": f"vol:{t}", "text": f"⚡ {t}: biến động {g['vol_now_annual_pct']}%/năm, gấp {g['vol_now_annual_pct'] / g['vol_long_run_annual_pct']:.1f} lần bình thường."})
    for f in analysis.get("flags", []):
        if "margin" in f["text"].lower():
            out.append({"id": f"margin:{f['text'][:40]}", "text": "🚨 " + f["text"]})
    for v in violations:
        out.append({"id": f"rule:{v['rule']}:{v['text'][:30]}", "text": "📏 " + v["text"]})
    today = date.today().isoformat()
    for t, items in news.items():
        for n in items:
            title = n.get("newsTitle") or ""
            if (n.get("publicDate") or "")[:10] >= today and any(w in title.lower() for w in ("đăng ký cuối cùng", "cổ tức", "gdkhq")):
                out.append({"id": f"event:{n.get('newsId') or title[:40]}", "text": f"📅 {t}: {title}"})
    return out


def _state() -> Dict[str, str]:
    return ta._read_json(STATE_FILE) or {}


def fresh(alerts: List[Dict[str, str]]) -> List[Dict[str, str]]:
    """Alerts not yet sent today; marks them as sent."""
    today = date.today().isoformat()
    state = {k: v for k, v in _state().items() if v >= today}  # forget older days
    new = [a for a in alerts if state.get(a["id"]) != today]
    for a in new:
        state[a["id"]] = today
    ta._write_private(STATE_FILE, state)
    return new


def send_telegram(text: str) -> Optional[str]:
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        return "not configured"
    import requests
    try:
        r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                          json={"chat_id": chat, "text": text[:4000], "disable_web_page_preview": True}, timeout=10)
        return None if r.ok else f"HTTP {r.status_code}"
    except requests.RequestException as e:
        return e.__class__.__name__


def send_local(title: str, text: str) -> None:
    if sys.platform != "darwin":
        return
    esc = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')  # noqa: E731
    subprocess.run(["osascript", "-e", f'display notification "{esc(text[:200])}" with title "{esc(title)}"'],
                   check=False, capture_output=True, timeout=10)


def deliver(alerts: List[Dict[str, str]], title: str = "TraderAI") -> Dict[str, Any]:
    if not alerts:
        return {"sent": 0}
    body = "\n".join(a["text"] for a in alerts)
    err = send_telegram(f"{title}\n{body}")
    send_local(title, alerts[0]["text"] + (f" (+{len(alerts) - 1} cảnh báo khác)" if len(alerts) > 1 else ""))
    return {"sent": len(alerts), "telegram": err or "ok"}
