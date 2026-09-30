"""
Telegram bot for quick questions from the phone: /nav /holdings /rules /help.

Reads only what is already stored (latest snapshot, NAV history, rules): no TCBS call and no
LLM. Answers carry percentages and tickers only, never account numbers, names or absolute NAV,
because messages leave this machine. Only the chat in TELEGRAM_CHAT_ID is answered.
"""

import os
import threading
import time
from typing import Any, Callable, Dict, Optional

import nav_history
import personal_rules
import storage
import tcbs_account as ta

OFFSET_FILE = os.path.join(storage.RUNTIME_DIR, "telegram_offset.json")
HELP = ("Lệnh:\n/nav — lợi nhuận thật (TWR) so với VN-Index, sụt giảm, tỷ trọng tiền mặt\n"
        "/holdings — tỷ trọng và lãi/lỗ % từng mã\n/rules — vi phạm quy tắc cá nhân\n/help — trợ giúp")


def _snapshot_analysis() -> Optional[Dict[str, Any]]:
    snap = ta.load_snapshot()
    return ta.analyze_snapshot(snap) if snap else None


def handle(text: str) -> str:
    cmd = (text or "").strip().split()[0].split("@")[0].lower() if (text or "").strip() else ""
    if cmd in ("/start", "/help", ""):
        return HELP
    a = _snapshot_analysis()
    if not a:
        return "Chưa có dữ liệu tài khoản: mở TraderAI, nhập OTP và đồng bộ trước."
    stamp = f"(dữ liệu lúc {a['synced_at'][:16].replace('T', ' ')})"
    if cmd == "/nav":
        h = nav_history.load()
        led = ta.load_ledger()
        m = nav_history.metrics(h, [], ta.ledger_flows(led), led.get("covered_from"), led.get("covered_to"))["stats"]
        if not m:
            return f"Chưa có lịch sử NAV. Tiền mặt {a['summary']['cash_pct']}% tài sản. {stamp}"
        vn = f" · VN-Index {m['vnindex_pct']:+.2f}%" if m["vnindex_pct"] is not None else ""
        return (f"Lợi nhuận thật (TWR) từ {m['since']}: {m['twr_pct']:+.2f}%{vn}\n"
                f"Sụt giảm hiện tại {m['current_drawdown_pct']:.2f}% (tối đa {m['max_drawdown_pct']:.2f}%)\n"
                f"Tiền mặt {a['summary']['cash_pct']}% · lãi/lỗ chưa thực hiện {a['summary']['unrealized_pnl_pct']:+.2f}%\n{stamp}")
    if cmd == "/holdings":
        if not a["holdings"]:
            return f"Không có cổ phiếu nào. {stamp}"
        lines = [f"{h['ticker']}: {h['weight_pct']:.1f}% tài sản, {h['pnl_pct']:+.1f}%" for h in a["holdings"]]
        return "\n".join(lines) + f"\n{stamp}"
    if cmd == "/rules":
        v = personal_rules.evaluate(a)
        return ("\n".join(f"• {x['text']}" for x in v) if v else "Danh mục tuân thủ mọi quy tắc.") + f"\n{stamp}"
    return "Không hiểu lệnh này.\n" + HELP


def _api(method: str, params: Dict[str, Any], timeout: int = 35) -> Optional[Dict[str, Any]]:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        return None
    import requests
    try:
        r = requests.post(f"https://api.telegram.org/bot{token}/{method}", json=params, timeout=timeout)
        return r.json() if r.ok else None
    except requests.RequestException:
        return None


def poll_once(api: Callable[..., Optional[Dict[str, Any]]] = _api, long_poll: int = 0) -> int:
    """Answer new messages from the authorised chat. Returns how many were answered."""
    chat = str(os.environ.get("TELEGRAM_CHAT_ID", ""))
    if not chat:
        return 0
    off = (storage.read(OFFSET_FILE) or {}).get("offset", 0)
    resp = api("getUpdates", {"offset": off, "timeout": long_poll, "allowed_updates": ["message"]}, long_poll + 10)
    answered = 0
    for upd in (resp or {}).get("result", []):
        off = max(off, upd["update_id"] + 1)
        msg = upd.get("message") or {}
        if str((msg.get("chat") or {}).get("id")) != chat:
            continue                       # strangers get no reply at all
        api("sendMessage", {"chat_id": chat, "text": handle(msg.get("text", "")), "disable_web_page_preview": True})
        answered += 1
    if resp and resp.get("result"):
        storage.write(OFFSET_FILE, {"offset": off})
    return answered


def start_in_background() -> Optional[threading.Thread]:
    if not (os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID")):
        return None

    def loop():
        while True:
            try:
                poll_once(long_poll=25)
            except Exception as e:  # keep the bot alive
                print(f"telegram bot error: {e!r}", flush=True)
                time.sleep(15)
    t = threading.Thread(target=loop, daemon=True, name="telegram-bot")
    t.start()
    return t
