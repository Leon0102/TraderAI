"""
Does each score actually pick better stocks? Monthly walk-forward test on our own data.

Every month-end: take the stocks that were liquid *then* (20-session average value ≥ 1 tỷ),
compute each factor with prices up to that day and reports published by then, split into
quintiles, and hold for one month. Vietnam has no practical short selling, so the headline is
**top quintile minus the equal-weight average of the names the factor ranks, net of costs** (0.3% per full
turnover: ~0.1% fee each way + 0.1% sales tax). Also reported: top-minus-bottom spread,
rank IC and hit rate.

Caveat printed in the UI: statements exist only for names liquid today (survivorship bias,
flatters fundamental factors); price-only factors use every listed ticker.

Daily returns of the long-short portfolios are kept as factor series for portfolio regression.
"""

import math
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple

import market_db as db
import scoring as sc

COST_PER_TURNOVER = 0.003
LIQUID_VALUE = 1_000_000_000
# factor -> (label, higher-is-better, needs statements)
FACTORS = {
    "overall": ("Điểm tổng hợp A–F", True, True),
    "value_combo": ("Giá trị kết hợp (E/P + B/P)", True, True),
    "fscore": ("Piotroski F-score", True, True),
    "earnings_yield": ("Lợi nhuận/giá (E/P)", True, True),
    "book_to_price": ("Giá trị sổ sách/giá (B/P)", True, True),
    "op_profitability": ("Lợi nhuận hoạt động/vốn", True, True),
    "size": ("Vốn hóa nhỏ", False, True),
    "turnover": ("Thanh khoản thấp (turnover)", False, False),
    "momentum_6_1": ("Momentum 6-1 tháng", True, False),
}
FACTOR_SERIES = {"SMB": "size", "VALUE": "earnings_yield", "QUALITY": "fscore", "TURN": "turnover", "MOM": "momentum_6_1"}
# Long-only model portfolios: the N best names by a score, equal weight, rebalanced monthly.
STRATEGIES = {"overall": "Top 10 theo điểm tổng hợp", "value_combo": "Top 10 theo giá trị kết hợp"}
STRATEGY_SIZE = 10


def _rank_pct(values: Dict[str, Optional[float]]) -> Dict[str, float]:
    items = sorted(((t, v) for t, v in values.items() if v is not None and math.isfinite(v)), key=lambda kv: kv[1])
    n = len(items)
    return {t: i / (n - 1) for i, (t, _) in enumerate(items)} if n > 1 else {}


def _curve_stats(rets: List[float]) -> Dict[str, Optional[float]]:
    if len(rets) < 3:
        return {"cagr_pct": None, "vol_pct": None, "sharpe": None, "max_dd_pct": None, "total_pct": None}
    eq, peak, dd = 1.0, 1.0, 0.0
    for r in rets:
        eq *= 1 + r
        peak = max(peak, eq)
        dd = min(dd, eq / peak - 1)
    mean = sum(rets) / len(rets)
    sd = math.sqrt(sum((r - mean) ** 2 for r in rets) / (len(rets) - 1))
    return {"cagr_pct": round((eq ** (12 / len(rets)) - 1) * 100, 1), "vol_pct": round(sd * math.sqrt(12) * 100, 1),
            "sharpe": round(mean / sd * math.sqrt(12), 2) if sd > 0 else None, "max_dd_pct": round(dd * 100, 1),
            "total_pct": round((eq - 1) * 100, 1)}


def month_ends(dates: List[str]) -> List[str]:
    out = []
    for a, b in zip(dates, dates[1:]):
        if a[:7] != b[:7]:
            out.append(a)
    return out


def _spearman(x: List[float], y: List[float]) -> Optional[float]:
    n = len(x)
    if n < 10:
        return None
    rank = lambda v: {i: r for r, i in enumerate(sorted(range(n), key=lambda k: v[k]))}  # noqa: E731
    rx, ry = rank(x), rank(y)
    mx = my = (n - 1) / 2
    cov = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    var = sum((rx[i] - mx) ** 2 for i in range(n))
    return cov / var if var else None


def _stats(xs: List[float]) -> Dict[str, Optional[float]]:
    n = len(xs)
    if n < 3:
        return {"mean_pct": None, "t": None, "hit_pct": None, "annual_pct": None}
    mean = sum(xs) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in xs) / (n - 1))
    return {"mean_pct": round(mean * 100, 2), "t": round(mean / (sd / math.sqrt(n)), 2) if sd > 0 else None,
            "hit_pct": round(sum(1 for x in xs if x > 0) / n * 100, 1), "annual_pct": round(((1 + mean) ** 12 - 1) * 100, 1)}


def verdict(net: Dict[str, Optional[float]]) -> str:
    t, m = net.get("t"), net.get("mean_pct")
    if t is None or m is None:
        return "CHƯA ĐỦ DỮ LIỆU"
    if m < 0 and t <= -1:
        return "NGƯỢC CHIỀU"
    if t >= 2:
        return "CÓ BẰNG CHỨNG"
    if t >= 1:
        return "YẾU"
    return "KHÔNG HIỆU QUẢ"


def run(years: int = 4, min_names: int = 25) -> Dict[str, Any]:
    since = (date.today() - timedelta(days=365 * years + 400)).isoformat()
    panel = db.price_panel(since=since)
    panel.pop("VNINDEX", None)
    uni = {u["ticker"]: u for u in db.universe()}
    stmts = db.statements()
    series = {t: dict((d, c) for d, c, _ in rows) for t, rows in panel.items()}
    values = {t: dict((d, c * v) for d, c, v in rows) for t, rows in panel.items()}
    all_dates = sorted({d for rows in panel.values() for d, _, _ in rows})
    ends = [d for d in month_ends(all_dates) if d >= (date.today() - timedelta(days=365 * years)).isoformat()]
    date_idx = {d: i for i, d in enumerate(all_dates)}

    monthly: Dict[str, Dict[str, List[float]]] = {f: {"top_excess": [], "spread": [], "ic": [], "net": [], "vs_market": []} for f in FACTORS}
    strat: Dict[str, List[Dict[str, Any]]] = {k: [] for k in STRATEGIES}
    prev_picks: Dict[str, set] = {k: set() for k in STRATEGIES}
    ew_market: List[Dict[str, Any]] = []
    vn_market: List[Dict[str, Any]] = []
    index_px = dict((d, c) for d, c, _ in db.price_panel(["VNINDEX"], since=since).get("VNINDEX", []))
    prev_top: Dict[str, set] = {f: set() for f in FACTORS}
    members: List[Tuple[str, str, Dict[str, Tuple[set, set]]]] = []  # (start, end, factor -> (long, short))
    eligible_counts = []

    for m0, m1 in zip(ends, ends[1:]):
        i0 = date_idx[m0]
        window = all_dates[max(0, i0 - 19):i0 + 1]
        eligible = []
        for t, s in series.items():
            if m0 not in s or m1 not in s:
                continue
            vals = [values[t][d] for d in window if d in values[t]]
            if len(vals) >= 15 and sum(vals) / len(vals) >= LIQUID_VALUE:
                eligible.append(t)
        if len(eligible) < min_names:
            continue
        eligible_counts.append(len(eligible))
        fwd = {t: series[t][m1] / series[t][m0] - 1 for t in eligible}
        market = sum(fwd.values()) / len(fwd)
        raw: Dict[str, Dict[str, Any]] = {}
        for t in eligible:
            rows = [r for r in panel[t] if r[0] <= m0]
            u = uni.get(t) or {}
            f = sc.factors(stmts.get(t, []), rows, m0, bool(u.get("is_bank")), None) if t in stmts else None
            closes = [c for _, c, _ in rows]
            vals = [c * v for _, c, v in rows[-250:]]
            raw[t] = f or {}
            raw[t]["momentum_6_1"] = sc.momentum_6_1(closes)
            if f is None:
                raw[t]["turnover"] = None  # needs market cap (shares) -> only for names with statements
            if f:
                raw[t]["size"] = f["market_cap"]
        graded = sc.grade_universe({t: r for t, r in raw.items() if r.get("fscore") is not None or r.get("earnings_yield") is not None},
                                   {t: (uni.get(t) or {}).get("sector") for t in raw})
        for t, g in graded.items():
            raw[t]["overall"] = g["overall_pct"]
        ep_rank = _rank_pct({t: raw[t].get("earnings_yield") for t in raw})
        bp_rank = _rank_pct({t: raw[t].get("book_to_price") for t in raw})
        for t in raw:
            if t in ep_rank and t in bp_rank:
                raw[t]["value_combo"] = (ep_rank[t] + bp_rank[t]) / 2
        # model portfolios
        for key in STRATEGIES:
            ranked = sorted(((t, raw[t].get(key)) for t in eligible if raw[t].get(key) is not None), key=lambda kv: -kv[1])
            picks = [t for t, _ in ranked[:STRATEGY_SIZE]]
            if len(picks) < STRATEGY_SIZE:
                continue
            churn = 1.0 if not prev_picks[key] else len(set(picks) - prev_picks[key]) / len(picks)
            prev_picks[key] = set(picks)
            strat[key].append({"month": m1, "ret": sum(fwd[t] for t in picks) / len(picks) - churn * COST_PER_TURNOVER, "picks": picks})
        ew_market.append({"month": m1, "ret": market})
        if index_px.get(m0) and index_px.get(m1):
            vn_market.append({"month": m1, "ret": index_px[m1] / index_px[m0] - 1})
        split: Dict[str, Tuple[set, set]] = {}
        for fac, (_, higher, _) in FACTORS.items():
            pairs = [(t, raw[t].get(fac)) for t in eligible if raw[t].get(fac) is not None and math.isfinite(raw[t][fac])]
            if len(pairs) < min_names:
                continue
            pairs.sort(key=lambda kv: kv[1], reverse=higher)
            q = len(pairs) // 5
            top, bottom = {t for t, _ in pairs[:q]}, {t for t, _ in pairs[-q:]}
            top_ret = sum(fwd[t] for t in top) / len(top)
            bot_ret = sum(fwd[t] for t in bottom) / len(bottom)
            # Benchmark = the names this factor could rank. Fundamental factors only see stocks
            # that have statements (liquid today = survivors); comparing them with the whole
            # market would credit survivorship to the factor.
            bench = sum(fwd[t] for t, _ in pairs) / len(pairs)
            churn = 1.0 if not prev_top[fac] else len(top - prev_top[fac]) / len(top)
            prev_top[fac] = top
            monthly[fac]["top_excess"].append(top_ret - bench)
            monthly[fac]["net"].append(top_ret - bench - churn * COST_PER_TURNOVER)
            monthly[fac].setdefault("vs_market", []).append(top_ret - market)
            monthly[fac]["spread"].append(top_ret - bot_ret)
            ic = _spearman([v if higher else -v for _, v in pairs], [fwd[t] for t, _ in pairs])
            if ic is not None:
                monthly[fac]["ic"].append(ic)
            split[fac] = (top, bottom)
        members.append((m0, m1, split))

    results = []
    for fac, (label, higher, needs_fs) in FACTORS.items():
        mm = monthly[fac]
        net = _stats(mm["net"])
        results.append({"factor": fac, "label": label, "months": len(mm["net"]), "uses_statements": needs_fs,
                        "net_excess": net, "gross_excess": _stats(mm["top_excess"]), "long_short": _stats(mm["spread"]),
                        "vs_all_market": _stats(mm.get("vs_market", [])),
                        "ic_mean": round(sum(mm["ic"]) / len(mm["ic"]), 3) if mm["ic"] else None, "verdict": verdict(net)})

    # Daily long-short factor returns (members fixed for each month) for portfolio regression.
    factor_daily: Dict[str, Dict[str, float]] = {k: {} for k in FACTOR_SERIES}
    for m0, m1, split in members:
        days = [d for d in all_dates if m0 < d <= m1]
        for name, fac in FACTOR_SERIES.items():
            if fac not in split:
                continue
            longs, shorts = split[fac]
            for d_prev, d in zip([m0] + days[:-1], days):
                def avg(ts):
                    rs = [series[t][d] / series[t][d_prev] - 1 for t in ts if d in series[t] and d_prev in series[t]]
                    return sum(rs) / len(rs) if rs else 0.0
                factor_daily[name][d] = round(avg(longs) - avg(shorts), 6)
    out = {"results": results, "months": len(members), "avg_eligible": round(sum(eligible_counts) / len(eligible_counts)) if eligible_counts else 0,
           "from": ends[0] if ends else None, "to": ends[-1] if ends else None, "cost_per_turnover_pct": COST_PER_TURNOVER * 100,
           "caveat": "Chỉ có BCTC cho các mã đang thanh khoản hôm nay (thiên lệch sống sót) — kết quả của yếu tố cơ bản có thể đẹp hơn thực tế."}
    months_all = [m["month"] for m in ew_market]
    out["strategies"] = {
        "size": STRATEGY_SIZE,
        "benchmarks": {"vnindex": {"label": "VN-Index", "stats": _curve_stats([m["ret"] for m in vn_market]), "monthly": vn_market},
                       "equal_weight": {"label": "Trung bình mã thanh khoản", "stats": _curve_stats([m["ret"] for m in ew_market]), "monthly": ew_market}},
        "models": {k: {"label": label, "stats": _curve_stats([m["ret"] for m in strat[k]]),
                       "monthly": [{"month": m["month"], "ret": round(m["ret"], 5)} for m in strat[k]],
                       "latest_picks": strat[k][-1]["picks"] if strat[k] else [],
                       "beat_vnindex_pct": round(sum(1 for a, b in zip(strat[k], vn_market) if a["ret"] > b["ret"]) / len(strat[k]) * 100, 1) if strat[k] and vn_market else None}
                   for k, label in STRATEGIES.items()},
        "months": months_all,
        "note": "Mua đều 10 mã điểm cao nhất vào cuối mỗi tháng, giữ 1 tháng, đã trừ phí 0,3% trên phần danh mục thay đổi. Không tính cổ tức (thiệt cho danh mục giá trị) và vẫn có thiên lệch sống sót.",
    }
    db.set_job("validation", out)
    db.set_job("factor_series", {"series": factor_daily})
    return out


if __name__ == "__main__":
    import json
    r = run()
    for x in r["results"]:
        print(f"{x['label']:32} {x['verdict']:16} net {x['net_excess']}  L/S {x['long_short']['mean_pct']}%  IC {x['ic_mean']}  n={x['months']}")
    print(json.dumps({k: v for k, v in r.items() if k != "results"}, ensure_ascii=False))
