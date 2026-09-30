"""
Pre-trade checklist: before buying, check the order against sizing, reward/risk, concentration,
cash, the user's own rules, trend, market regime, volatility, correlation and upcoming events.

Each check is PASS / WARN / FAIL with a reason; any FAIL -> "KHÔNG ĐẠT", 3+ WARN -> "CÂN NHẮC".
"""

import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

import risk_tools as rt

LIQUIDITY_TARGET = 0.05     # order ≤ 5% of average daily traded value
LIQUIDITY_FAIL = 0.15       # above this the order itself moves the price
LOW_LIQUIDITY = 2_000_000_000
EVENT_WORDS = ("đăng ký cuối cùng", "không hưởng quyền", "gdkhq", "cổ tức", "chốt quyền")


def _n(v: float) -> str:
    """Vietnamese thousands separator (12.500.000)."""
    return f"{round(v):,}".replace(",", ".")


def _check(status: str, name: str, text: str) -> Dict[str, str]:
    return {"status": status, "name": name, "text": text}


def run_checks(analysis: Dict[str, Any], rules: Dict[str, Any], ticker: str, price: float, stop: float,
               target: Optional[float], quantity: Optional[int], company: Dict[str, Any],
               sectors: Dict[str, str], closes: Dict[str, List[Tuple[str, float]]], forecast: Optional[Dict[str, Any]],
               regime: Optional[Dict[str, Any]], news: List[Dict[str, Any]],
               adv_value: Optional[float] = None) -> Dict[str, Any]:
    s = analysis["summary"]
    nav, cash = s["nav"], s["cash"]
    holdings = {h["ticker"]: h for h in analysis["holdings"]}
    checks: List[Dict[str, str]] = []

    if stop <= 0 or stop >= price:
        checks.append(_check("FAIL", "Stop-loss", "Stop phải thấp hơn giá mua."))
        return {"verdict": "KHÔNG ĐẠT", "checks": checks, "sizing": None}
    stop_pct = (1 - stop / price) * 100
    checks.append(_check("PASS" if stop_pct <= 10 else "WARN", "Stop-loss",
                         f"Stop cách giá mua {stop_pct:.1f}%" + ("" if stop_pct <= 10 else " — khá xa, khối lượng sẽ nhỏ.")))

    size = rt.position_size(nav, price, stop, rules["max_risk_per_trade_pct"], rules["max_weight_pct"] / 100, cash)
    qty = quantity or size["shares"]
    liq_cap = int(math.floor(LIQUIDITY_TARGET * adv_value / price / 100) * 100) if adv_value else None
    if not quantity and liq_cap is not None and qty > liq_cap:
        qty = liq_cap                       # never size a new position beyond what the market can absorb
        size = {**size, "shares": qty, "value": round(qty * price), "limited_by": "thanh khoản"}
    risk_pct = qty * (price - stop) / nav * 100 if nav else 0
    if quantity:
        status = "PASS" if risk_pct <= rules["max_risk_per_trade_pct"] * 1.05 else "FAIL"
        checks.append(_check(status, "Khối lượng", f"{_n(qty)} cp → rủi ro {risk_pct:.2f}% NAV (quy tắc {rules['max_risk_per_trade_pct']:g}%). "
                                                   f"Khối lượng tối đa theo quy tắc: {_n(size['shares'])} cp."))
    else:
        checks.append(_check("PASS" if size["shares"] > 0 else "FAIL", "Khối lượng",
                             f"Đề xuất {_n(size['shares'])} cp (~{_n(size.get('value', 0))} đ), bị giới hạn bởi {size.get('limited_by')}."))

    tgt = target or ((company.get("targetPrice") or 0) or None)
    if tgt and tgt > price:
        rr = (tgt - price) / (price - stop)
        src = "" if target else " (giá mục tiêu của nhà phân tích)"
        checks.append(_check("PASS" if rr >= 1.5 else "FAIL" if rr < 1 else "WARN", "Lợi nhuận / rủi ro",
                             f"R:R = {rr:.2f}{src}; nên ≥ 1.5."))
    else:
        checks.append(_check("WARN", "Lợi nhuận / rủi ro", "Chưa có giá mục tiêu hợp lệ để tính R:R."))

    if adv_value:
        share = qty * price / adv_value
        status = "PASS" if share <= LIQUIDITY_TARGET else "WARN" if share <= LIQUIDITY_FAIL else "FAIL"
        checks.append(_check(status, "Thanh khoản",
                             f"Lệnh {_n(qty * price)} đ = {share * 100:.1f}% giá trị giao dịch bình quân 20 phiên ({_n(adv_value)} đ/phiên). "
                             f"Nên ≤ {int(LIQUIDITY_TARGET * 100)}% (~{_n(liq_cap or 0)} cp); trên {int(LIQUIDITY_FAIL * 100)}% khó vào/thoát lệnh mà không đẩy giá."))
        if adv_value < LOW_LIQUIDITY:
            checks.append(_check("WARN", "Mã kém thanh khoản", f"Giá trị giao dịch bình quân chỉ {_n(adv_value)} đ/phiên (< {_n(LOW_LIQUIDITY)} đ)."))
    else:
        checks.append(_check("WARN", "Thanh khoản", "Chưa có dữ liệu giao dịch của mã này (nạp dữ liệu ở mục Định lượng) — hãy tự kiểm tra khối lượng khớp thường ngày."))

    held = holdings.get(ticker)
    new_value = (held["market_value"] if held else 0) + qty * price
    weight = new_value / nav * 100 if nav else 0
    checks.append(_check("PASS" if weight <= rules["max_weight_pct"] else "FAIL", "Tỷ trọng mã",
                         f"Sau lệnh {ticker} chiếm {weight:.1f}% NAV (trần {rules['max_weight_pct']:g}%)."))

    sector = company.get("sectorVn")
    if sector:
        sector_w = sum(h["weight_pct"] for t, h in holdings.items() if sectors.get(t) == sector and t != ticker) + weight
        checks.append(_check("PASS" if sector_w <= rules["max_sector_pct"] else "FAIL", "Tỷ trọng ngành",
                             f"Ngành {sector} sẽ chiếm {sector_w:.1f}% NAV (trần {rules['max_sector_pct']:g}%)."))

    cost = qty * price * 1.001
    cash_after = (cash - cost) / nav * 100 if nav else 0
    checks.append(_check("FAIL" if cost > cash else "WARN" if cash_after < rules["min_cash_pct"] else "PASS", "Tiền mặt",
                         f"Cần {_n(cost)} đ; tiền mặt còn lại {cash_after:.1f}% NAV (tối thiểu {rules['min_cash_pct']:g}%)."))

    n_after = len(holdings) + (0 if held else 1)
    checks.append(_check("PASS" if n_after <= rules["max_positions"] else "FAIL", "Số mã",
                         f"Sau lệnh giữ {n_after} mã (tối đa {rules['max_positions']})."))

    if held and held["pnl_pct"] < 0 and rules["no_average_down"]:
        checks.append(_check("FAIL", "Trung bình giá xuống", f"{ticker} đang lỗ {held['pnl_pct']}% — quy tắc của bạn cấm mua thêm."))

    if forecast:
        sig = forecast["signals"]
        comp = sig["components"]
        trend_txt = ", ".join(f"{k.replace('_', ' ')} {v['value_pct']:+}%" for k, v in comp.items() if k in ("momentum_6m", "trend_ma200"))
        checks.append(_check("PASS" if sig["composite"] > 0.1 else "WARN", "Xu hướng", f"Tín hiệu {sig['label'].lower()} ({trend_txt})."))
        g = forecast["garch"]
        if g["vol_long_run_annual_pct"] and g["vol_now_annual_pct"] / g["vol_long_run_annual_pct"] >= rt.VOL_SPIKE_RATIO:
            checks.append(_check("WARN", "Biến động", f"Biến động hiện {g['vol_now_annual_pct']}%/năm, gấp {g['vol_now_annual_pct'] / g['vol_long_run_annual_pct']:.1f} lần bình thường."))
        ts = forecast.get("target_vs_stop_3m")
        if ts:
            checks.append(_check("PASS" if ts["target_first"] >= ts["stop_first"] else "WARN", "Mô phỏng 3 tháng",
                                 f"Chạm mục tiêu trước: {ts['target_first']}% · chạm stop trước: {ts['stop_first']}%."))
    if regime:
        checks.append(_check("WARN" if regime["state"] == "PHÒNG THỦ" else "PASS", "Thị trường",
                             f"Trạng thái {regime['state'].lower()} (VN-Index {regime['vs_ma200_pct']:+}% so với MA200)."))

    mine = dict(closes.get(ticker, []))
    worst: Optional[Tuple[str, float]] = None
    for t in holdings:
        other = dict(closes.get(t, []))
        dates = sorted(set(mine) & set(other))[-250:]
        if t == ticker or len(dates) < 60:
            continue
        a = np.diff(np.log([mine[d] for d in dates]))
        b = np.diff(np.log([other[d] for d in dates]))
        c = float(np.corrcoef(a, b)[0, 1])
        if worst is None or c > worst[1]:
            worst = (t, c)
    if worst:
        checks.append(_check("WARN" if worst[1] >= 0.7 else "PASS", "Tương quan",
                             f"Tương quan cao nhất với {worst[0]}: {worst[1]:.2f}" + (" — gần như cùng một khoản cược." if worst[1] >= 0.7 else ".")))

    recent = [n for n in news if any(w in (n.get("newsTitle") or "").lower() for w in EVENT_WORDS)][:2]
    for n in recent:
        checks.append(_check("WARN", "Sự kiện", f"{(n.get('publicDate') or '')[:10]}: {n.get('newsTitle')} — kiểm tra ngày GDKHQ trước khi mua."))

    fails = sum(c["status"] == "FAIL" for c in checks)
    warns = sum(c["status"] == "WARN" for c in checks)
    verdict = "KHÔNG ĐẠT" if fails else "CÂN NHẮC" if warns >= 3 else "ĐẠT"
    return {"verdict": verdict, "checks": checks, "fails": fails, "warns": warns,
            "sizing": {**size, "chosen_shares": qty, "risk_pct_nav": round(risk_pct, 2)}}


def price_ok(price: float) -> bool:
    return math.isfinite(price) and price > 0
