"""
TCBS Open API — read-only access to the user's own brokerage account.

Local-only by design: the API key can place orders and move cash at TCBS, so it never goes
into the Vercel functions in api/*.py. Only GET endpoints are wrapped here; nothing in this
module can change anything at TCBS.

Auth: API key (TCBS_API_KEY env var, or key.txt at the project root) + an OTP from the TCBS app
-> JWT valid for up to 8h. The token endpoint is limited to 10 calls/day, so the JWT is cached
in runtime/ (gitignored) and reused until it expires.

CLI (from project root):
  python3 backend/tcbs_account.py login --otp 123456
  python3 backend/tcbs_account.py sync
  python3 backend/tcbs_account.py status
"""

import base64
import json
import os
import sys
import time
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

import storage

BASE_URL = "https://openapi.tcbs.com.vn"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME_DIR = os.path.join(ROOT, "runtime")
TOKEN_FILE = os.path.join(RUNTIME_DIR, "tcbs_token.json")
SNAPSHOT_FILE = os.path.join(RUNTIME_DIR, "tcbs_snapshot.json")
KEY_FILE = os.path.join(ROOT, "key.txt")
TOKEN_TTL_FALLBACK = 8 * 3600
# Profile blocks requested: only what is needed to find sub-accounts, no personal details.
PROFILE_FIELDS = "basicInfo,bankSubAccounts"
# Keys holding personal data that must never be stored in the snapshot or sent to an LLM.
PII_KEYS = {"fullName", "fullNameNoAccent", "custodyID", "custodyCode", "personalInfo",
            "personalBasicInfo", "bankAccounts", "accountName", "email", "phoneNumber",
            "identityCard", "rmRefInfo", "systemUserInfo", "code105C", "tcbsId"}


class TcbsError(Exception):
    def __init__(self, message: str, needs_login: bool = False):
        super().__init__(message)
        self.needs_login = needs_login


# ---------- credentials & token cache ----------

def load_api_key() -> Optional[str]:
    key = os.environ.get("TCBS_API_KEY", "").strip()
    if key:
        return key
    if os.path.isfile(KEY_FILE):
        with open(KEY_FILE, encoding="utf-8") as f:
            return f.read().strip() or None
    return None


def _jwt_claims(token: str) -> Dict[str, Any]:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}


def _write_private(path: str, data: Any) -> None:
    """Persist a document: Postgres when DATABASE_URL is set, else a 0600 JSON file."""
    storage.write(path, data)


def _read_json(path: str) -> Optional[Dict[str, Any]]:
    return storage.read(path)


def load_token() -> Optional[Dict[str, Any]]:
    """Cached token if still valid (with a 2-minute safety margin)."""
    cached = _read_json(TOKEN_FILE)
    if not cached or not cached.get("token"):
        return None
    if cached.get("expires_at", 0) - 120 <= time.time():
        return None
    return cached


def clear_token() -> None:
    storage.delete(TOKEN_FILE)


def login(otp: str) -> Dict[str, Any]:
    """Exchange API key + OTP for a JWT. Counts against TCBS's 10/day limit."""
    api_key = load_api_key()
    if not api_key:
        raise TcbsError("Chưa cấu hình TCBS API key (biến môi trường TCBS_API_KEY hoặc file key.txt).")
    otp = (otp or "").strip()
    if not otp.isdigit() or not 4 <= len(otp) <= 8:
        raise TcbsError("OTP không hợp lệ.")
    import requests

    try:
        resp = requests.post(f"{BASE_URL}/gaia/v1/oauth2/openapi/token",
                             json={"apiKey": api_key, "otp": otp}, timeout=15)
    except requests.RequestException as e:
        raise TcbsError(f"Không kết nối được TCBS: {e.__class__.__name__}")
    if resp.status_code != 200:
        hint = ""
        if resp.status_code >= 500:
            # A bad key gets 400 "User not found"; a 5xx means the key matched an account and TCBS
            # failed later — in practice an expired/wrong iOTP or a key not enabled for Open API.
            hint = (" — Key đã được TCBS nhận ra; lỗi thường do mã iOTP hết hạn/sai (lấy mã mới và nhập ngay trong vài giây) "
                    "hoặc key chưa được kích hoạt Open API (kiểm tra/tạo lại key trong TCInvest). Mỗi lần thử tính vào giới hạn 10 lần/ngày.")
        elif "User not found" in _error_text(resp):
            hint = " — TCBS không nhận ra API key: kiểm tra lại key.txt hoặc tạo key mới trong TCInvest."
        raise TcbsError(f"TCBS từ chối đăng nhập (HTTP {resp.status_code}): {_error_text(resp)}{hint}")
    token = (resp.json() or {}).get("token")
    if not token:
        raise TcbsError("TCBS không trả về token.")
    claims = _jwt_claims(token)
    exp = claims.get("exp")
    expires_at = float(exp) if isinstance(exp, (int, float)) else time.time() + TOKEN_TTL_FALLBACK
    cached = {"token": token, "expires_at": expires_at, "obtained_at": time.time(),
              "custody_code": _custody_from_claims(claims)}
    _write_private(TOKEN_FILE, cached)
    return cached


def _custody_from_claims(claims: Dict[str, Any]) -> Optional[str]:
    for k in ("custodyCode", "custodyID", "custodyId", "custody_code", "sub", "username"):
        v = claims.get(k)
        if isinstance(v, str) and v.upper().startswith("105C"):
            return v.upper()
    return None


def _error_text(resp) -> str:
    try:
        body = resp.json()
        for k in ("message", "error_description", "error", "msg"):
            if isinstance(body, dict) and body.get(k):
                return str(body[k])[:200]
    except ValueError:
        pass
    return (resp.text or "")[:200]


# ---------- read-only API ----------

def _get(path: str, token: str, params: Optional[Dict[str, Any]] = None) -> Any:
    import requests

    try:
        resp = requests.get(f"{BASE_URL}{path}", params=params, timeout=15,
                            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    except requests.RequestException as e:
        raise TcbsError(f"Không kết nối được TCBS: {e.__class__.__name__}")
    if resp.status_code == 401:
        clear_token()
        raise TcbsError("Phiên TCBS đã hết hạn, cần nhập OTP mới.", needs_login=True)
    if resp.status_code != 200:
        raise TcbsError(f"TCBS lỗi HTTP {resp.status_code} tại {path.split('/')[1]}: {_error_text(resp)}")
    return resp.json()


def strip_pii(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: strip_pii(v) for k, v in obj.items() if k not in PII_KEYS}
    if isinstance(obj, list):
        return [strip_pii(v) for v in obj]
    return obj


def sync(custody_code: Optional[str] = None) -> Dict[str, Any]:
    """Pull sub-accounts, holdings, cash, orders and matches; save a PII-free snapshot."""
    cached = load_token()
    if not cached:
        raise TcbsError("Chưa đăng nhập TCBS hoặc token đã hết hạn, cần nhập OTP.", needs_login=True)
    token = cached["token"]
    custody = (custody_code or os.environ.get("TCBS_CUSTODY_CODE") or cached.get("custody_code") or "").strip().upper()

    override = [a.strip() for a in os.environ.get("TCBS_ACCOUNT_NOS", "").split(",") if a.strip()]
    if override:
        sub_accounts = [{"accountNo": a, "accountType": "NORMAL"} for a in override]
    else:
        if not custody:
            raise TcbsError("Thiếu số lưu ký (105C…). Đặt TCBS_CUSTODY_CODE trong .env.local.")
        profile = _get(f"/eros/v2/get-profile/by-username/{custody}", token, {"fields": PROFILE_FIELDS})
        sub_accounts = [
            {"accountNo": s.get("accountNo"), "accountType": s.get("accountType"),
             "status": s.get("status"), "isDefault": s.get("isDefault")}
            for s in (profile or {}).get("bankSubAccounts") or [] if s.get("accountNo")
        ]
    # Derivative sub-accounts use a different API family; stock endpoints reject them.
    stock_accounts = [s for s in sub_accounts if (s.get("accountType") or "").upper() != "DERIVATIVE"]
    if not stock_accounts:
        raise TcbsError("Không tìm thấy tiểu khoản cổ phiếu nào.")

    accounts, errors = [], []
    for sub in stock_accounts:
        acct = sub["accountNo"]
        entry: Dict[str, Any] = {"accountNo": acct, "accountType": sub.get("accountType")}
        for name, path in (("assets", f"/aion/v1/accounts/{acct}/se"),
                           ("cash", f"/aion/v1/accounts/{acct}/cashInvestments"),
                           ("orders", f"/aion/v1/accounts/{acct}/orders"),
                           ("matches", f"/aion/v1/accounts/{acct}/matching-details")):
            try:
                entry[name] = strip_pii(_get(path, token))
            except TcbsError as e:
                if e.needs_login:
                    raise
                errors.append(f"{mask_account(acct)} {name}: {e}")
        if (sub.get("accountType") or "").upper() == "MARGIN":
            try:  # 4.11: Rtt, principal/interest debt and the maintenance/liquidation thresholds
                entry["risk"] = strip_pii(_get(f"/hydros/v1/account/{acct}/risk", token))
            except TcbsError as e:
                if e.needs_login:
                    raise
                errors.append(f"{mask_account(acct)} risk: {e}")
        accounts.append(entry)

    snapshot = {"synced_at": datetime.now().isoformat(timespec="seconds"), "accounts": accounts, "errors": errors}
    _write_private(SNAPSHOT_FILE, snapshot)
    # TCBS only exposes today's matches, so keep a running journal for realized P&L.
    from portfolio_insights import update_journal
    from nav_history import record as record_nav
    for label, step in (("journal", lambda: update_journal(snapshot)),
                        ("nav history", lambda: record_nav(analyze_snapshot(snapshot)))):
        try:
            step()
        except Exception as e:  # bonuses; never fail the sync over them
            snapshot["errors"].append(f"{label}: {e.__class__.__name__}")
    return snapshot


def load_snapshot() -> Optional[Dict[str, Any]]:
    return _read_json(SNAPSHOT_FILE)


def status() -> Dict[str, Any]:
    cached = load_token()
    snap = load_snapshot()
    return {
        "configured": bool(load_api_key()),
        "logged_in": bool(cached),
        "token_expires_at": datetime.fromtimestamp(cached["expires_at"]).isoformat(timespec="minutes") if cached else None,
        "last_sync": snap.get("synced_at") if snap else None,
    }


# ---------- analytics (pure, operates on a snapshot) ----------

def mask_account(acct: Optional[str]) -> str:
    acct = acct or ""
    return f"•••{acct[-3:]}" if len(acct) > 3 else "•••"


def _num(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _vnd(price: float) -> float:
    """TCBS asset prices are in VND; guard against a payload quoted in thousands."""
    return price * 1000 if 0 < price < 1000 else price


def _rows(payload: Any, key: str = "data") -> List[Dict[str, Any]]:
    if isinstance(payload, dict):
        rows = payload.get(key)
        return rows if isinstance(rows, list) else []
    return payload if isinstance(payload, list) else []


def add_business_days(day: date, n: int) -> date:
    """T+n settlement, skipping weekends (exchange holidays are not modelled)."""
    while n > 0:
        day += timedelta(days=1)
        if day.weekday() < 5:
            n -= 1
    return day


def margin_summary(acct: Dict[str, Any], assets: float) -> Optional[Dict[str, Any]]:
    """Rtt and how far prices can fall (uniformly) before the maintenance / liquidation ratios."""
    rows = _rows(acct.get("risk")) or ([acct["risk"]] if isinstance(acct.get("risk"), dict) else [])
    if not rows:
        return None
    r = rows[0]
    debt = _num(r.get("outstanding")) + _num(r.get("accruedInterest")) + _num(r.get("totalFeeDebt"))
    policy = r.get("riskPolicy") or {}
    out: Dict[str, Any] = {
        "account": mask_account(acct.get("accountNo")), "rtt_pct": _num(r.get("rtt")), "debt": round(debt),
        "due": round(_num(r.get("dueAmount"))), "overdue": round(_num(r.get("overdueAmount"))),
        "status": (r.get("riskStatus") or {}).get("description") or (r.get("riskStatus") or {}).get("code"),
        "maintenance_pct": _num(policy.get("maintenanceMargin")) or None,
        "liquidation_pct": _num(policy.get("liquidationMargin")) or None,
    }
    # Rtt = (A − D)/A. A uniform drop x reaches ratio m when 1 − x = D / (A·(1 − m)).
    for key, ratio in (("drop_to_call_pct", out["maintenance_pct"]), ("drop_to_liquidation_pct", out["liquidation_pct"])):
        if debt > 0 and assets > 0 and ratio and ratio < 100:
            out[key] = round(max(0.0, 1 - debt / (assets * (1 - ratio / 100))) * 100, 1)
    return out


def analyze_snapshot(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """Merge every sub-account into one portfolio view: positions, cash, concentration, risk flags."""
    positions: Dict[str, Dict[str, Any]] = {}
    cash_total = withdrawable = pending_buy = cash_dividend = 0.0
    trades: Dict[str, Dict[str, float]] = {}
    order_status: Dict[str, int] = {}
    accounts_out = []
    margins: List[Dict[str, Any]] = []
    debt_total = 0.0
    cash_calendar: List[Dict[str, Any]] = []
    try:
        trade_day = datetime.fromisoformat(snapshot.get("synced_at") or "").date()
    except ValueError:
        trade_day = date.today()

    for acct in snapshot.get("accounts", []):
        acct_value = 0.0
        for s in _rows(acct.get("assets"), "stock"):
            qty = _num(s.get("totalQtty"))
            if qty <= 0:
                continue
            sym = (s.get("symbol") or "").upper()
            p = positions.setdefault(sym, {"ticker": sym, "quantity": 0.0, "cost_value": 0.0, "market_value": 0.0,
                                           "sellable": 0.0, "pending": 0.0, "price": 0.0})
            price, cost = _vnd(_num(s.get("currentPrice"))), _vnd(_num(s.get("costPrice")))
            p["quantity"] += qty
            p["cost_value"] += qty * cost
            p["market_value"] += qty * price
            p["sellable"] += _num(s.get("availableTrading"))
            p["pending"] += _num(s.get("waitForTrade")) + _num(s.get("stockDividend"))
            p["price"] = price
            acct_value += qty * price
        acct_cash = 0.0
        for c in _rows(acct.get("cash")):
            acct_cash += _num(c.get("balance"))
            withdrawable += _num(c.get("avlWithdraw"))
            pending_buy += _num(c.get("buyingAmount"))
            cash_dividend += _num(c.get("cashDevident"))
        cash_total += acct_cash
        for m in _rows(acct.get("matches")):
            sym = (m.get("symbol") or "").upper()
            side = "buy" if (m.get("side") or "").upper().startswith("B") else "sell"
            t = trades.setdefault(sym, {"ticker": sym, "buy_qty": 0.0, "buy_value": 0.0, "sell_qty": 0.0, "sell_value": 0.0})
            qty, price = _num(m.get("qtty")), _vnd(_num(m.get("price")))
            t[f"{side}_qty"] += qty
            t[f"{side}_value"] += qty * price
            settle = add_business_days(trade_day, 2).isoformat()
            cash_calendar.append({"date": settle, "ticker": sym, "kind": "Tiền bán về" if side == "sell" else "Cổ phiếu mua về",
                                  "amount": round(qty * price) if side == "sell" else None, "quantity": int(qty)})
        for o in _rows(acct.get("orders")):
            st = str(o.get("status") or "UNKNOWN")
            order_status[st] = order_status.get(st, 0) + 1
        m = margin_summary(acct, acct_value + acct_cash)
        if m:
            margins.append(m)
            debt_total += m["debt"]
        accounts_out.append({"account": mask_account(acct.get("accountNo")), "type": acct.get("accountType"),
                             "stock_value": round(acct_value), "cash": round(acct_cash), "debt": m["debt"] if m else 0})

    stock_value = sum(p["market_value"] for p in positions.values())
    cost_value = sum(p["cost_value"] for p in positions.values())
    nav = stock_value + cash_total - debt_total  # net asset value: margin debt belongs to TCBS
    holdings = []
    for p in sorted(positions.values(), key=lambda x: -x["market_value"]):
        pnl = p["market_value"] - p["cost_value"]
        holdings.append({
            "ticker": p["ticker"],
            "quantity": int(p["quantity"]),
            "sellable": int(p["sellable"]),
            "pending": int(p["pending"]),
            "avg_cost": round(p["cost_value"] / p["quantity"]) if p["quantity"] else 0,
            "price": round(p["price"]),
            "market_value": round(p["market_value"]),
            "pnl": round(pnl),
            "pnl_pct": round(pnl / p["cost_value"] * 100, 2) if p["cost_value"] else 0.0,
            "weight_pct": round(p["market_value"] / nav * 100, 2) if nav else 0.0,
        })

    weights = [h["weight_pct"] / 100 for h in holdings]
    stock_weights = [h["market_value"] / stock_value for h in holdings] if stock_value else []
    concentration = {
        "positions": len(holdings),
        "top1_pct": round(weights[0] * 100, 2) if weights else 0.0,
        "top3_pct": round(sum(weights[:3]) * 100, 2),
        # Effective number of positions = 1 / HHI of stock weights.
        "effective_positions": round(1 / sum(w * w for w in stock_weights), 2) if stock_weights else 0.0,
    }
    cash_pct = round(cash_total / nav * 100, 2) if nav else 0.0

    flags = []
    if holdings and concentration["top1_pct"] > 30:
        flags.append({"level": "high", "text": f"{holdings[0]['ticker']} chiếm {concentration['top1_pct']}% tài sản — rủi ro tập trung cao (>30%)."})
    for h in holdings:
        if h["pnl_pct"] <= -7:
            flags.append({"level": "high", "text": f"{h['ticker']} lỗ {h['pnl_pct']}% — đã vượt ngưỡng cắt lỗ -7%."})
        elif h["pnl_pct"] >= 20:
            flags.append({"level": "info", "text": f"{h['ticker']} lãi {h['pnl_pct']}% — cân nhắc chốt lời một phần / nâng stop-loss."})
    if nav and len(holdings) > 10:
        flags.append({"level": "medium", "text": f"Nắm {len(holdings)} mã — danh mục phân tán quá mỏng, khó theo dõi."})
    if nav and stock_value and cash_pct < 5:
        flags.append({"level": "medium", "text": f"Tiền mặt chỉ {cash_pct}% — thiếu dư địa bắt đáy / xử lý rủi ro."})
    if nav and cash_pct > 60:
        flags.append({"level": "info", "text": f"Tiền mặt {cash_pct}% — phần lớn vốn đang nhàn rỗi."})
    for m in margins:
        drop = m.get("drop_to_call_pct")
        if m["debt"] > 0 and drop is not None and drop < 15:
            flags.append({"level": "high", "text": f"Tiểu khoản margin {m['account']}: giá giảm thêm {drop}% là chạm ngưỡng call ({m['maintenance_pct']}%). Rtt hiện {m['rtt_pct']}%."})
        if m["overdue"] > 0:
            flags.append({"level": "high", "text": f"Tiểu khoản margin {m['account']} có nợ quá hạn {round(m['overdue']):,} đ.".replace(",", ".")})
    if cash_dividend > 0:
        cash_calendar.append({"date": None, "ticker": None, "kind": "Cổ tức tiền chờ về", "amount": round(cash_dividend), "quantity": None})

    return {
        "synced_at": snapshot.get("synced_at"),
        "summary": {
            "nav": round(nav), "stock_value": round(stock_value), "cost_value": round(cost_value),
            "unrealized_pnl": round(stock_value - cost_value),
            "unrealized_pnl_pct": round((stock_value - cost_value) / cost_value * 100, 2) if cost_value else 0.0,
            "cash": round(cash_total), "cash_pct": cash_pct, "withdrawable": round(withdrawable),
            "pending_buy": round(pending_buy), "cash_dividend_pending": round(cash_dividend),
            "debt": round(debt_total), "gross_assets": round(stock_value + cash_total),
        },
        "margin": margins,
        "cash_calendar": sorted(cash_calendar, key=lambda c: c["date"] or "9999"),
        "holdings": holdings,
        "concentration": concentration,
        "flags": flags,
        "today_trades": [{k: (round(v) if isinstance(v, float) else v) for k, v in t.items()} for t in trades.values()],
        "order_status": order_status,
        "accounts": accounts_out,
        "errors": snapshot.get("errors", []),
    }


def llm_portfolio_brief(analysis: Dict[str, Any]) -> str:
    """Portfolio description for an LLM: percentages and prices only — no account ids, names or absolute wealth."""
    s, c = analysis["summary"], analysis["concentration"]
    lines = [
        f"Số mã nắm giữ: {c['positions']}. Tỷ trọng tiền mặt: {s['cash_pct']}%. "
        f"Lãi/lỗ chưa thực hiện toàn danh mục: {s['unrealized_pnl_pct']}%.",
        f"Mã lớn nhất chiếm {c['top1_pct']}%, top 3 chiếm {c['top3_pct']}%, số vị thế hiệu dụng {c['effective_positions']}.",
        "Chi tiết vị thế (mã | tỷ trọng % tài sản | giá vốn đ | giá hiện tại đ | lãi/lỗ %):",
    ]
    for h in analysis["holdings"]:
        lines.append(f"- {h['ticker']} | {h['weight_pct']}% | {h['avg_cost']:,} | {h['price']:,} | {h['pnl_pct']}%")
    if analysis["flags"]:
        lines.append("Cảnh báo tự động: " + " ".join(f["text"] for f in analysis["flags"]))
    return "\n".join(lines)


def heuristic_review(analysis: Dict[str, Any]) -> str:
    s, c = analysis["summary"], analysis["concentration"]
    if not analysis["holdings"]:
        return "Tài khoản chưa nắm giữ cổ phiếu nào. Toàn bộ tài sản đang ở dạng tiền mặt."
    parts = [
        f"TỔNG QUAN: {c['positions']} mã, tiền mặt {s['cash_pct']}%, lãi/lỗ chưa thực hiện {s['unrealized_pnl_pct']}%.",
        f"PHÂN BỔ: mã lớn nhất {c['top1_pct']}%, top 3 {c['top3_pct']}%, tương đương ~{c['effective_positions']} vị thế cân bằng.",
    ]
    losers = [h for h in analysis["holdings"] if h["pnl_pct"] <= -7]
    winners = [h for h in analysis["holdings"] if h["pnl_pct"] >= 20]
    actions = []
    if losers:
        actions.append("Xem xét cắt lỗ/hạ tỷ trọng: " + ", ".join(f"{h['ticker']} ({h['pnl_pct']}%)" for h in losers) + ".")
    if winners:
        actions.append("Bảo vệ lợi nhuận (chốt một phần hoặc nâng stop-loss): " + ", ".join(h["ticker"] for h in winners) + ".")
    if c["top1_pct"] > 30:
        actions.append(f"Giảm tỷ trọng {analysis['holdings'][0]['ticker']} về dưới 25-30%.")
    if s["cash_pct"] < 5:
        actions.append("Giữ tối thiểu 10-20% tiền mặt dự phòng.")
    parts.append("HÀNH ĐỘNG ĐỀ XUẤT: " + (" ".join(actions) if actions else "Danh mục cân đối, tiếp tục theo dõi kỷ luật stop-loss."))
    return "\n".join(parts)


# ---------- CLI ----------

def _main(argv: List[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="TCBS Open API (read-only)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_login = sub.add_parser("login", help="đổi API key + OTP lấy token (tối đa 10 lần/ngày)")
    p_login.add_argument("--otp", required=True)
    p_sync = sub.add_parser("sync", help="tải danh mục, tiền, lệnh về runtime/tcbs_snapshot.json")
    p_sync.add_argument("--custody", help="số lưu ký 105C… (mặc định: TCBS_CUSTODY_CODE)")
    sub.add_parser("status")
    sub.add_parser("report", help="in phân tích từ snapshot gần nhất")
    args = parser.parse_args(argv)

    try:
        if args.cmd == "login":
            t = login(args.otp)
            print(f"Đăng nhập thành công, token hết hạn lúc {datetime.fromtimestamp(t['expires_at']):%H:%M %d/%m}.")
        elif args.cmd == "sync":
            snap = sync(args.custody)
            print(f"Đã đồng bộ {len(snap['accounts'])} tiểu khoản lúc {snap['synced_at']}.")
            for e in snap["errors"]:
                print(f"  ! {e}")
        elif args.cmd == "status":
            print(json.dumps(status(), ensure_ascii=False, indent=2))
        elif args.cmd == "report":
            snap = load_snapshot()
            if not snap:
                print("Chưa có snapshot, chạy `sync` trước.")
                return 1
            print(json.dumps(analyze_snapshot(snap), ensure_ascii=False, indent=2))
    except TcbsError as e:
        print(f"Lỗi: {e}", file=sys.stderr)
        return 1
    return 0


def _load_env() -> None:
    """Same files as server.py's loader, so TCBS_CUSTODY_CODE in backend/.env works from the CLI."""
    for path in (os.path.join(ROOT, "backend", ".env"), os.path.join(ROOT, ".env"), os.path.join(ROOT, ".env.local")):
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


if __name__ == "__main__":
    _load_env()
    sys.exit(_main(sys.argv[1:]))
