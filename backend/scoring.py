"""
Stock scores built on point-in-time statements (only reports published by the as-of date):

- Piotroski F-score (Piotroski 2000): nine binary tests; in Vietnam the high-minus-low F-score
  spread was >30%/yr over 2009–19. Banks get the usual adaptation (no current ratio / gross margin;
  net-interest-income and operating-income ratios instead).
- Factor card (Vietnam "VN-4" style: size, earnings/price, turnover, operating profitability) as
  percentiles within the stock's sector.
- A–F grades (Value, Quality, Growth, Health, Momentum-as-context) with red-flag caps.
- Two-stage FCF DCF with CAPM cost of equity (beta bounded 0.8–2.0) and a GARCH-width band.

Pure functions: inputs are market_db-shaped dicts, so everything is testable offline.
"""

import math
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

# VCI statement codes shared by corporates, banks and brokers
F = {"assets": "bsa53", "equity": "bsa78", "cur_assets": "bsa1", "cur_liab": "bsa55", "lt_debt": "bsa71",
     "st_debt": "bsa56", "paid_in": "bsa80", "sales": "isa3", "gross": "isa5", "op_profit": "isa11",
     "net_income": "isa20", "net_income_parent": "isa22", "interest": "isa8", "cfo": "cfa18", "capex": "cfa19",
     "share_issue": "cfa27",
     "bank_nii": "isb27", "bank_toi": "isb38"}
PAR_VALUE = 10_000
LETTERS = ((80, "A"), (60, "B"), (40, "C"), (20, "D"), (0, "F"))
OVERALL_WEIGHTS = {"quality": 0.35, "value": 0.35, "growth": 0.15, "health": 0.15}
MIN_SECTOR_PEERS = 5


def _v(period: Optional[Dict[str, Any]], key: str) -> Optional[float]:
    if not period:
        return None
    code = F[key]
    part = period.get({"b": "bs", "i": "is", "c": "cf"}[code[0]]) or {}
    v = part.get(code)
    return float(v) if isinstance(v, (int, float)) else None


def _div(a: Optional[float], b: Optional[float]) -> Optional[float]:
    return a / b if a is not None and b not in (None, 0) else None


# ---------- point-in-time selection ----------

def annuals_as_of(periods: List[Dict[str, Any]], as_of: str) -> List[Dict[str, Any]]:
    """Annual reports published on or before `as_of`, oldest first."""
    return [p for p in periods if p["quarter"] == 0 and p.get("public_date") and p["public_date"] <= as_of]


def quarters_as_of(periods: List[Dict[str, Any]], as_of: str) -> List[Dict[str, Any]]:
    return [p for p in periods if p["quarter"] > 0 and p.get("public_date") and p["public_date"] <= as_of]


def ttm(periods: List[Dict[str, Any]], as_of: str, key: str, offset: int = 0) -> Optional[float]:
    """Trailing-twelve-month sum of an income/cash-flow item from the last 4 published quarters."""
    q = sorted(quarters_as_of(periods, as_of), key=lambda p: (p["year"], p["quarter"]))
    q = q[:len(q) - offset] if offset else q
    last4 = q[-4:]
    if len(last4) < 4:
        return None
    # the four quarters must be consecutive
    idx = [p["year"] * 4 + p["quarter"] for p in last4]
    if idx != list(range(idx[0], idx[0] + 4)):
        return None
    vals = [_v(p, key) for p in last4]
    return sum(vals) if all(v is not None for v in vals) else None


def latest_balance(periods: List[Dict[str, Any]], as_of: str) -> Optional[Dict[str, Any]]:
    pub = [p for p in periods if p.get("public_date") and p["public_date"] <= as_of and p.get("bs")]
    return max(pub, key=lambda p: (p["year"], p["quarter"] or 5)) if pub else None


# ---------- Piotroski ----------

def piotroski(periods: List[Dict[str, Any]], as_of: str, is_bank: bool = False) -> Optional[Dict[str, Any]]:
    ann = annuals_as_of(periods, as_of)
    if len(ann) < 2:
        return None
    cur, prev = ann[-1], ann[-2]
    ni_c, ni_p = _v(cur, "net_income"), _v(prev, "net_income")
    ta_c, ta_p = _v(cur, "assets"), _v(prev, "assets")
    cfo = _v(cur, "cfo")
    roa_c, roa_p = _div(ni_c, ta_c), _div(ni_p, ta_p)
    tests: Dict[str, Optional[bool]] = {
        "ROA dương": None if roa_c is None else roa_c > 0,
        "Dòng tiền kinh doanh dương": None if cfo is None else cfo > 0,
        "ROA cải thiện": None if roa_c is None or roa_p is None else roa_c > roa_p,
        "Dòng tiền > lợi nhuận": None if cfo is None or ni_c is None else cfo > ni_c,
    }
    # Dilution = cash raised by issuing shares. Paid-in capital alone would also penalise stock
    # dividends and bonus shares, which are routine in Vietnam and do not dilute holders.
    issued, equity_c = _v(cur, "share_issue"), _v(cur, "equity")
    tests["Không phát hành thêm cổ phiếu"] = None if issued is None or not equity_c else issued <= 0.01 * abs(equity_c)
    if is_bank:
        eq_c, eq_p = _div(_v(cur, "equity"), ta_c), _div(_v(prev, "equity"), ta_p)
        tests["Đòn bẩy giảm (vốn/tài sản tăng)"] = None if eq_c is None or eq_p is None else eq_c > eq_p
        nim_c, nim_p = _div(_v(cur, "bank_nii"), ta_c), _div(_v(prev, "bank_nii"), ta_p)
        tests["NII/tài sản tăng"] = None if nim_c is None or nim_p is None else nim_c > nim_p
        toi_c, toi_p = _div(_v(cur, "bank_toi"), ta_c), _div(_v(prev, "bank_toi"), ta_p)
        tests["Thu nhập hoạt động/tài sản tăng"] = None if toi_c is None or toi_p is None else toi_c > toi_p
    else:
        lev_c, lev_p = _div(_v(cur, "lt_debt"), ta_c), _div(_v(prev, "lt_debt"), ta_p)
        tests["Nợ dài hạn/tài sản giảm"] = None if lev_c is None or lev_p is None else lev_c <= lev_p
        cr_c = _div(_v(cur, "cur_assets"), _v(cur, "cur_liab"))
        cr_p = _div(_v(prev, "cur_assets"), _v(prev, "cur_liab"))
        tests["Thanh toán hiện hành tăng"] = None if cr_c is None or cr_p is None else cr_c > cr_p
        gm_c, gm_p = _div(_v(cur, "gross"), _v(cur, "sales")), _div(_v(prev, "gross"), _v(prev, "sales"))
        tests["Biên gộp tăng"] = None if gm_c is None or gm_p is None else gm_c > gm_p
        at_c, at_p = _div(_v(cur, "sales"), ta_c), _div(_v(prev, "sales"), ta_p)
        tests["Vòng quay tài sản tăng"] = None if at_c is None or at_p is None else at_c > at_p
    known = {k: v for k, v in tests.items() if v is not None}
    if len(known) < 6:
        return None
    score = sum(known.values())
    return {"score": score, "tests": len(known), "score_9": round(score / len(known) * 9, 1), "year": cur["year"],
            "details": tests}


# ---------- raw factors ----------

def momentum_6_1(closes: List[float]) -> Optional[float]:
    return closes[-22] / closes[-148] - 1 if len(closes) > 147 and closes[-148] > 0 else None


def factors(periods: List[Dict[str, Any]], prices: List[Tuple[str, float, float]], as_of: str,
            is_bank: bool = False, shares_hint: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """Raw factor values at `as_of` using prices up to that date and reports published by then."""
    px = [p for p in prices if p[0] <= as_of]
    if len(px) < 60:
        return None
    price = px[-1][1]
    bal = latest_balance(periods, as_of)
    paid_in = _v(bal, "paid_in")
    shares = paid_in / PAR_VALUE if paid_in else shares_hint
    if not shares or price <= 0:
        return None
    mcap = price * shares
    ann = annuals_as_of(periods, as_of)
    last_ann = ann[-1] if ann else None
    ni = ttm(periods, as_of, "net_income")
    if ni is None:
        ni = _v(last_ann, "net_income")
    equity = _v(bal, "equity")
    op = ttm(periods, as_of, "op_profit") if not is_bank else ni
    if op is None:
        op = _v(last_ann, "op_profit" if not is_bank else "net_income")
    rev_key = "bank_toi" if is_bank else "sales"
    rev, rev_prev = ttm(periods, as_of, rev_key), ttm(periods, as_of, rev_key, offset=4)
    ni_prev = ttm(periods, as_of, "net_income", offset=4)
    assets = _v(bal, "assets")
    value_252 = [c * v for _, c, v in px[-250:]]
    fs = piotroski(periods, as_of, is_bank)
    closes = [c for _, c, _ in px]
    rets = [math.log(b / a) for a, b in zip(closes[-251:], closes[-250:]) if a > 0 and b > 0]
    vol = (sum((r - sum(rets) / len(rets)) ** 2 for r in rets) / (len(rets) - 1)) ** 0.5 * math.sqrt(250) if len(rets) > 30 else None
    return {
        "price": price, "market_cap": mcap,
        "earnings_yield": _div(ni, mcap), "book_to_price": _div(equity, mcap),
        "op_profitability": _div(op, equity) if equity and equity > 0 else None,
        "turnover": _div(sum(value_252) / len(value_252), mcap) if value_252 else None,
        "revenue_growth": _div(rev - rev_prev, abs(rev_prev)) if rev is not None and rev_prev else None,
        "earnings_growth": _div(ni - ni_prev, abs(ni_prev)) if ni is not None and ni_prev else None,
        "liabilities_to_assets": _div(assets - equity, assets) if assets and equity is not None else None,
        "current_ratio": None if is_bank else _div(_v(bal, "cur_assets"), _v(bal, "cur_liab")),
        "interest_coverage": None if is_bank else _div(op, abs(_v(last_ann, "interest") or 0) or None),
        "fscore": fs["score_9"] if fs else None, "fscore_detail": fs,
        "momentum_6_1": momentum_6_1(closes), "volatility": vol,
    }


# ---------- percentiles & grades ----------

def percentile_ranks(values: Dict[str, Optional[float]], higher_is_better: bool = True) -> Dict[str, float]:
    items = [(k, v) for k, v in values.items() if v is not None and math.isfinite(v)]
    if len(items) < 2:
        return {k: 50.0 for k, _ in items}
    items.sort(key=lambda kv: kv[1], reverse=not higher_is_better)
    n = len(items)
    return {k: round(i / (n - 1) * 100, 1) for i, (k, _) in enumerate(items)}


def letter(pct: Optional[float]) -> Optional[str]:
    if pct is None:
        return None
    return next(l for cut, l in LETTERS if pct >= cut)


GROUPS = {
    "value": [("earnings_yield", True), ("book_to_price", True)],
    "quality": [("fscore", True), ("op_profitability", True)],
    "growth": [("revenue_growth", True), ("earnings_growth", True)],
    "health": [("liabilities_to_assets", False), ("current_ratio", True), ("interest_coverage", True)],
    "momentum": [("momentum_6_1", True)],
}


def grade_universe(raw: Dict[str, Dict[str, Any]], sectors: Dict[str, Optional[str]]) -> Dict[str, Dict[str, Any]]:
    """Sector-relative percentiles -> group grades -> overall grade with red-flag caps."""
    by_sector: Dict[str, List[str]] = {}
    for t in raw:
        by_sector.setdefault(sectors.get(t) or "Khác", []).append(t)
    pct: Dict[str, Dict[str, float]] = {t: {} for t in raw}
    metrics = {m for group in GROUPS.values() for m, _ in group} | {"market_cap", "turnover"}
    for members in by_sector.values():
        peers = members if len(members) >= MIN_SECTOR_PEERS else list(raw)  # thin sectors: compare with everyone
        for m in metrics:
            higher = dict((k, h) for g in GROUPS.values() for k, h in g).get(m, True)
            ranks = percentile_ranks({t: raw[t].get(m) for t in peers}, higher)
            for t in members:
                if t in ranks:
                    pct[t][m] = ranks[t]
    out = {}
    for t, f in raw.items():
        groups = {}
        for g, parts in GROUPS.items():
            vals = [pct[t][m] for m, _ in parts if m in pct[t]]
            groups[g] = round(sum(vals) / len(vals), 1) if vals else None
        weighted = [(groups[g], w) for g, w in OVERALL_WEIGHTS.items() if groups[g] is not None]
        overall = round(sum(v * w for v, w in weighted) / sum(w for _, w in weighted), 1) if weighted else None
        caps = []
        if groups["health"] is not None and groups["health"] < 20:
            caps.append("sức khỏe tài chính yếu nhất ngành")
        if f.get("fscore") is not None and f["fscore"] <= 2:
            caps.append(f"F-score chỉ {f['fscore']}/9")
        if caps and overall is not None:
            overall = min(overall, 59.9)  # cannot rate above C
        out[t] = {"grades": {g: letter(v) for g, v in groups.items()}, "group_pct": groups,
                  "overall_pct": overall, "overall": letter(overall), "caps": caps, "percentiles": pct[t],
                  "sector": sectors.get(t)}
    return out


# ---------- DCF ----------

# Cash-flow DCF is meaningless where operating cash flow is balance-sheet driven or project-lumpy.
DCF_EXCLUDED_SECTORS = ("Ngân hàng", "Bất động sản", "Dịch vụ tài chính", "Bảo hiểm")


def dcf(periods: List[Dict[str, Any]], as_of: str, price: float, shares: float, beta: Optional[float],
        vol_annual: Optional[float], rf: float = 0.03, erp: float = 0.07, is_bank: bool = False,
        sector: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Two-stage levered-FCF DCF (Simply Wall St style) with a Morningstar-style uncertainty band."""
    if is_bank or (sector and sector in DCF_EXCLUDED_SECTORS):
        return {"applicable": False, "reason": f"Không áp dụng DCF dòng tiền cho ngành {sector or 'ngân hàng'} (dòng tiền kinh doanh không phản ánh giá trị)."}
    ann = annuals_as_of(periods, as_of)
    fcfs = []
    for p in ann[-3:]:
        cfo, capex = _v(p, "cfo"), _v(p, "capex")
        if cfo is not None and capex is not None:
            fcfs.append(cfo + capex)  # capex is reported negative
    if len(fcfs) < 2 or not shares or price <= 0:
        return None
    base = sum(fcfs) / len(fcfs)
    if base <= 0:
        return {"applicable": False, "reason": "Dòng tiền tự do trung bình 3 năm âm — DCF không có ý nghĩa."}
    sales = [_v(p, "sales") for p in ann[-4:]]
    growth = [b / a - 1 for a, b in zip(sales, sales[1:]) if a and b and a > 0]
    # Conservative stage-1 growth: the lower of the median yearly growth and the CAGR, and no
    # higher than the latest trailing-twelve-month growth when revenue is shrinking.
    candidates = []
    if growth:
        candidates.append(sorted(growth)[len(growth) // 2])
    if sales[0] and sales[-1] and sales[0] > 0 and sales[-1] > 0 and len(sales) > 1:
        candidates.append((sales[-1] / sales[0]) ** (1 / (len(sales) - 1)) - 1)
    rev, rev_prev = ttm(periods, as_of, "sales"), ttm(periods, as_of, "sales", offset=4)
    if rev is not None and rev_prev:
        candidates.append(rev / rev_prev - 1)
    g1 = min(0.20, max(-0.05, min(candidates))) if candidates else 0.05
    b = min(2.0, max(0.8, beta if beta is not None else 1.0))
    ke = rf + b * erp
    g_term = min(rf, ke - 0.02)
    value, fcf = 0.0, base
    for year in range(1, 6):
        fcf *= 1 + g1 - (g1 - g_term) * (year - 1) / 5  # growth fades linearly towards the terminal rate
        value += fcf / (1 + ke) ** year
    terminal = fcf * (1 + g_term) / (ke - g_term) / (1 + ke) ** 5
    fair = (value + terminal) / shares
    u = min(0.6, max(0.2, (vol_annual or 0.3)))  # uncertainty band width from volatility
    return {"applicable": True, "fair_value": round(fair), "low": round(fair * (1 - u)), "high": round(fair * (1 + u)),
            "discount_pct": round((1 - price / fair) * 100, 1), "cost_of_equity_pct": round(ke * 100, 1),
            "stage1_growth_pct": round(g1 * 100, 1), "terminal_growth_pct": round(g_term * 100, 1), "beta_used": round(b, 2),
            "zone": "DƯỚI GIÁ TRỊ" if price < fair * (1 - u / 2) else "TRÊN GIÁ TRỊ" if price > fair * (1 + u / 2) else "HỢP LÝ",
            "fcf_base": round(base),
            "reliability": "thấp" if abs(1 - price / fair) > 0.6 else "trung bình"}


def as_of_today() -> str:
    return date.today().isoformat()
