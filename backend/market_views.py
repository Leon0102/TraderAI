"""
Market-wide views computed from market_db:

- breadth: % of liquid stocks above MA50 / MA200, advance–decline line, 52-week new highs minus
  new lows. Breadth predicts returns in many markets but the effect fades within 2–3 months, so
  it is shown as a regime gauge, not a timing signal.
- sector rotation (RRG-style): weekly RS-Ratio / RS-Momentum of equal-weight ICB sector indices
  versus VN-Index. JdK's exact formula is proprietary; this is the common 100-centred approximation.
- foreign flows: rolling 5/20-session foreign net value as % of traded value (history builds up
  from the daily snapshots the ingest job stores).
- valuation: aggregate trailing P/E of the covered universe by month, with mean ±1σ/±2σ bands.
  One-year returns barely correlate with valuation; the band is a 3–5-year context gauge.
"""

import math
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple

import market_db as db
import scoring as sc

LIQUID_VALUE = 1_000_000_000


def _sma(xs: List[float], n: int) -> Optional[float]:
    return sum(xs[-n:]) / n if len(xs) >= n else None


def _ema(xs: List[float], n: int) -> List[float]:
    k, out = 2 / (n + 1), []
    for x in xs:
        out.append(x if not out else x * k + out[-1] * (1 - k))
    return out


def breadth(panel: Dict[str, List[Tuple[str, float, float]]], days: int = 250) -> Dict[str, Any]:
    closes = {t: [(d, c) for d, c, _ in rows] for t, rows in panel.items() if t != "VNINDEX"}
    liquid = {t for t, rows in panel.items() if t != "VNINDEX" and len(rows) >= 20
              and sum(c * v for _, c, v in rows[-20:]) / 20 >= LIQUID_VALUE}
    all_dates = sorted({d for rows in closes.values() for d, _ in rows})[-days:]
    idx = {t: {d: i for i, (d, _) in enumerate(rows)} for t, rows in closes.items() if t in liquid}
    points, ad_line = [], 0
    for d in all_dates:
        above50 = above200 = n50 = n200 = adv = dec = highs = lows = 0
        for t in liquid:
            i = idx[t].get(d)
            if i is None or i == 0:
                continue
            series = closes[t]
            c = series[i][1]
            prev = series[i - 1][1]
            adv += c > prev
            dec += c < prev
            window = [x for _, x in series[max(0, i - 199):i + 1]]
            if len(window) >= 50:
                n50 += 1
                above50 += c > sum(window[-50:]) / 50
            if len(window) >= 200:
                n200 += 1
                above200 += c > sum(window) / 200
            year = [x for _, x in series[max(0, i - 249):i + 1]]
            if len(year) >= 200:
                highs += c >= max(year)
                lows += c <= min(year)
        ad_line += adv - dec
        points.append({"date": d, "pct_above_ma50": round(above50 / n50 * 100, 1) if n50 else None,
                       "pct_above_ma200": round(above200 / n200 * 100, 1) if n200 else None,
                       "advances": adv, "declines": dec, "ad_line": ad_line, "new_highs": highs, "new_lows": lows})
    last = points[-1] if points else {}
    ma200 = last.get("pct_above_ma200")
    state = None if ma200 is None else ("RỘNG (khỏe)" if ma200 >= 60 else "HẸP (yếu)" if ma200 <= 30 else "TRUNG TÍNH")
    return {"universe": len(liquid), "points": points, "latest": last, "state": state}


def _weekly(series: List[Tuple[str, float]]) -> List[Tuple[str, float]]:
    """Last close of each ISO week."""
    out: Dict[Tuple[int, int], Tuple[str, float]] = {}
    for d, c in series:
        y, w, _ = date.fromisoformat(d).isocalendar()
        out[(y, w)] = (d, c)
    return [out[k] for k in sorted(out)]


def sector_rotation(panel: Dict[str, List[Tuple[str, float, float]]], sectors: Dict[str, str], tail: int = 5) -> Dict[str, Any]:
    index = dict((d, c) for d, c, _ in panel.get("VNINDEX", []))
    members: Dict[str, List[str]] = {}
    for t, s in sectors.items():
        if s and t in panel:
            members.setdefault(s, []).append(t)
    out = []
    for sector, tickers in members.items():
        if len(tickers) < 3:
            continue
        dates = sorted({d for t in tickers for d, _, _ in panel[t]} & set(index))
        level, lvl, prev = [], 100.0, None
        closes = {t: dict((d, c) for d, c, _ in panel[t]) for t in tickers}
        for d in dates:  # equal-weight sector index from daily returns
            if prev is not None:
                rs = [closes[t][d] / closes[t][prev] - 1 for t in tickers if d in closes[t] and prev in closes[t]]
                if rs:
                    lvl *= 1 + sum(rs) / len(rs)
            level.append((d, lvl))
            prev = d
        weekly = _weekly([(d, v / index[d]) for d, v in level])
        if len(weekly) < 30:
            continue
        rs = [v for _, v in weekly]
        ratio = [100 * r / m for r, m in zip(rs, _ema(rs, 10))]
        mom = [100 * a / b for a, b in zip(ratio, _ema(ratio, 5))]
        pts = [{"date": weekly[i][0], "rs_ratio": round(ratio[i], 2), "rs_momentum": round(mom[i], 2)} for i in range(len(weekly) - tail, len(weekly))]
        x, y = pts[-1]["rs_ratio"], pts[-1]["rs_momentum"]
        quadrant = ("DẪN DẮT" if x >= 100 and y >= 100 else "SUY YẾU" if x >= 100 else "TỤT HẬU" if y < 100 else "CẢI THIỆN")
        ret_4w = (weekly[-1][1] / weekly[-5][1] - 1) * 100 if len(weekly) > 5 else None
        out.append({"sector": sector, "stocks": len(tickers), "tail": pts, "quadrant": quadrant,
                    "relative_4w_pct": round(ret_4w, 2) if ret_4w is not None else None})
    out.sort(key=lambda s: (-s["tail"][-1]["rs_ratio"]))
    return {"sectors": out, "note": "Xấp xỉ RRG: RS-Ratio = 100 × RS / EMA10 tuần(RS), RS-Momentum = 100 × Ratio / EMA5 tuần(Ratio)."}


def foreign_flows(since_days: int = 60) -> Dict[str, Any]:
    since = (date.today() - timedelta(days=since_days)).isoformat()
    rows = db.flows(since)
    by_day: Dict[str, List[float]] = {}
    per_ticker = []
    for t, pts in rows.items():
        for d, net, value in pts:
            agg = by_day.setdefault(d, [0.0, 0.0])
            agg[0] += net
            agg[1] += value
        last5, last20 = pts[-5:], pts[-20:]
        v5 = sum(v for _, _, v in last5)
        v20 = sum(v for _, _, v in last20)
        per_ticker.append({"ticker": t, "net_5d": round(sum(n for _, n, _ in last5)), "net_20d": round(sum(n for _, n, _ in last20)),
                           "net_5d_pct_value": round(sum(n for _, n, _ in last5) / v5 * 100, 2) if v5 else None,
                           "net_20d_pct_value": round(sum(n for _, n, _ in last20) / v20 * 100, 2) if v20 else None,
                           "days": len(pts)})
    days = sorted(by_day)
    market = [{"date": d, "net": round(by_day[d][0]), "value": round(by_day[d][1])} for d in days]
    per_ticker.sort(key=lambda r: r["net_20d"])
    return {"days_available": len(days), "market": market, "top_sell": per_ticker[:10], "top_buy": per_ticker[::-1][:10],
            "note": "Lịch sử khối ngoại tích lũy từ ảnh chụp bảng giá mỗi ngày job nạp dữ liệu chạy."}


def valuation_band(panel: Dict[str, List[Tuple[str, float, float]]], stmts: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    """Monthly aggregate trailing P/E = Σ market cap / Σ net income (point-in-time)."""
    ends = sorted({d for rows in panel.values() for d, _, _ in rows})
    months = [a for a, b in zip(ends, ends[1:]) if a[:7] != b[:7]] + ends[-1:]
    closes = {t: dict((d, c) for d, c, _ in rows) for t, rows in panel.items() if t in stmts}
    points = []
    for m in months:
        caps = earnings = 0.0
        n = 0
        for t, periods in stmts.items():
            c = closes.get(t, {}).get(m)
            if not c:
                continue
            bal = sc.latest_balance(periods, m)
            paid = sc._v(bal, "paid_in")
            ni = sc.ttm(periods, m, "net_income")
            if ni is None:  # no four consecutive quarters: fall back to the latest published annual report
                ann = sc.annuals_as_of(periods, m)
                ni = sc._v(ann[-1], "net_income") if ann else None
            if not paid or ni is None:
                continue
            caps += c * paid / sc.PAR_VALUE
            earnings += ni
            n += 1
        if n >= 30 and earnings > 0:
            points.append({"date": m, "pe": round(caps / earnings, 2), "stocks": n})
    if len(points) < 6:
        return {"points": points, "stats": None}
    pes = [p["pe"] for p in points]
    mean = sum(pes) / len(pes)
    sd = math.sqrt(sum((x - mean) ** 2 for x in pes) / (len(pes) - 1))
    now = pes[-1]
    pct = sum(1 for x in pes if x <= now) / len(pes) * 100
    return {"points": points, "stats": {"mean": round(mean, 2), "sd": round(sd, 2), "now": now, "z": round((now - mean) / sd, 2) if sd else None,
                                        "percentile": round(pct, 1), "earnings_yield_pct": round(100 / now, 2)},
            "note": "P/E tổng hợp của các mã có BCTC (lợi nhuận 4 quý gần nhất đã công bố). Định giá gần như không dự báo được lợi nhuận 1 năm; chỉ dùng làm bối cảnh 3–5 năm."}


def all_views() -> Dict[str, Any]:
    since = (date.today() - timedelta(days=365 * 2 + 60)).isoformat()
    panel = db.price_panel(since=since)
    uni = db.universe()
    sectors = {u["ticker"]: u["sector"] for u in uni if u["sector"]}
    stmts = db.statements(list(sectors))
    full = db.price_panel(list(sectors), since=(date.today() - timedelta(days=365 * 5 + 30)).isoformat())
    return {"breadth": breadth(panel), "rotation": sector_rotation(panel, sectors), "flows": foreign_flows(),
            "valuation": valuation_band(full, stmts), "ingest": db.get_job("ingest")}
