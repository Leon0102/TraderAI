"""
Quant layer on top of market_db: current grades for the liquid universe (screener), one-stock
factor cards with F-score and DCF, portfolio factor regression, and the ingest/validate pipeline.
Results are cached in memory for a few minutes; the ingest job refreshes them.
"""

import threading
import time
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

import numpy as np

import market_db as db
import market_ingest
import scoring as sc

_cache: Dict[str, Any] = {}
_TTL = 600
_job_lock = threading.Lock()


def _cached(key: str, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]
    value = fn()
    _cache[key] = (time.time(), value)
    return value


def invalidate() -> None:
    _cache.clear()


def warm() -> None:
    """Compute the scores in a background thread so the first screen does not wait ~15 s."""
    def job():
        try:
            if available():
                scores()
        except Exception as e:  # cache warming is best effort
            print(f"quant warm-up skipped: {e!r}", flush=True)
    threading.Thread(target=job, daemon=True, name="quant-warm").start()


def available() -> bool:
    try:
        return db.counts()["prices"] > 0
    except Exception:
        return False


# ---------- universe scores ----------

def _compute_scores() -> Dict[str, Any]:
    today = sc.as_of_today()
    uni = {u["ticker"]: u for u in db.universe()}
    liquid = market_ingest.liquid_tickers()
    stmts = db.statements(liquid)
    panel = db.price_panel(liquid, since=(date.today() - timedelta(days=420)).isoformat())
    raw = {}
    for t in liquid:
        u = uni.get(t) or {}
        f = sc.factors(stmts.get(t, []), panel.get(t, []), today, bool(u.get("is_bank")), u.get("shares"), min_prices=5)
        if f:
            raw[t] = f
    graded = sc.grade_universe(raw, {t: (uni.get(t) or {}).get("sector") for t in raw})
    revisions_all = {t: revisions(t) for t in graded}
    rows = []
    for t, g in graded.items():
        f, u = raw[t], uni.get(t) or {}
        rows.append({"ticker": t, "name": u.get("name"), "exchange": u.get("exchange"), "sector": u.get("sector"),
                     "price": round(f["price"]), "market_cap": round(f["market_cap"]), "overall": g["overall"], "overall_pct": g["overall_pct"],
                     "grades": g["grades"], "caps": g["caps"], "fscore": f["fscore"],
                     "pe": round(1 / f["earnings_yield"], 1) if f.get("earnings_yield") and f["earnings_yield"] > 0 else None,
                     "pb": round(1 / f["book_to_price"], 2) if f.get("book_to_price") and f["book_to_price"] > 0 else None,
                     "roe_op": round(f["op_profitability"] * 100, 1) if f.get("op_profitability") is not None else None,
                     "momentum_6_1_pct": round(f["momentum_6_1"] * 100, 1) if f.get("momentum_6_1") is not None else None,
                     "analyst_target": u.get("target_price"), "rating": u.get("rating"),
                     "target_change_90d_pct": (revisions_all.get(t) or {}).get("change_90d_pct")})
    rows.sort(key=lambda r: -(r["overall_pct"] or -1))
    return {"as_of": today, "rows": rows, "raw": raw, "graded": graded, "universe": uni, "stmts": stmts}


def scores() -> Dict[str, Any]:
    return _cached("scores", _compute_scores)


def screener(sector: Optional[str] = None, grade: Optional[str] = None, limit: int = 100) -> Dict[str, Any]:
    s = scores()
    rows = [r for r in s["rows"] if (not sector or r["sector"] == sector) and (not grade or (r["overall"] or "") <= grade)]
    sectors = sorted({r["sector"] for r in s["rows"] if r["sector"]})
    return {"as_of": s["as_of"], "count": len(rows), "rows": rows[:limit], "sectors": sectors}


def stock_card(ticker: str, beta: Optional[float] = None) -> Optional[Dict[str, Any]]:
    s = scores()
    t = ticker.upper()
    if t not in s["raw"]:
        return None
    f, g, u = s["raw"][t], s["graded"][t], s["universe"].get(t) or {}
    shares = f["market_cap"] / f["price"] if f["price"] else None
    valuation = sc.dcf(s["stmts"].get(t, []), s["as_of"], f["price"], shares, beta, f.get("volatility"),
                       is_bank=bool(u.get("is_bank")), sector=u.get("sector"))
    val = validation_summary()
    pretty = {k: (round(v, 4) if isinstance(v, float) else v) for k, v in f.items() if k != "fscore_detail"}
    return {"ticker": t, "name": u.get("name"), "sector": u.get("sector"), "as_of": s["as_of"], "overall": g["overall"],
            "overall_pct": g["overall_pct"], "grades": g["grades"], "group_pct": g["group_pct"], "caps": g["caps"],
            "percentiles": g["percentiles"], "factors": pretty, "fscore": f.get("fscore_detail"), "dcf": valuation,
            "analyst": {"target": u.get("target_price"), "rating": u.get("rating"), "dps": u.get("dps"), "revisions": revisions(t)},
            "grade_history": [{"d": r["d"], "overall_pct": r["overall_pct"], "overall": r["overall"]} for r in db.grade_history(t)][-120:],
            "evidence": {r["factor"]: r["verdict"] for r in (val or {}).get("results", [])}}


GRADE_ORDER = "ABCDF"


def revisions(ticker: str) -> Optional[Dict[str, Any]]:
    """Analyst target-price change over ~30 and ~90 days from the stored daily snapshots."""
    hist = db.target_history(ticker)
    if len(hist) < 2:
        return {"days": len(hist), "change_30d_pct": None, "change_90d_pct": None, "history": hist[-60:]} if hist else None
    last_d, last_p, _ = hist[-1]

    def change(days: int) -> Optional[float]:
        cutoff = (date.fromisoformat(last_d) - timedelta(days=days)).isoformat()
        older = [p for d, p, _ in hist if d <= cutoff]
        return round((last_p / older[-1] - 1) * 100, 1) if older and older[-1] else None
    return {"days": len(hist), "change_30d_pct": change(30), "change_90d_pct": change(90), "since": hist[0][0], "history": hist[-60:]}


def grade_drops(tickers: List[str]) -> List[Dict[str, Any]]:
    """Holdings whose overall grade fell versus the previous snapshot."""
    out = []
    for t in tickers:
        h = [r for r in db.grade_history(t) if r["overall"]]
        if len(h) >= 2 and GRADE_ORDER.index(h[-1]["overall"]) > GRADE_ORDER.index(h[-2]["overall"]):
            out.append({"ticker": t, "from": h[-2]["overall"], "to": h[-1]["overall"], "since": h[-2]["d"], "on": h[-1]["d"]})
    return out


def snapshot_grades() -> int:
    rows = scores()["rows"]
    db.record_grades(sc.as_of_today(), rows)
    return len(rows)


def brief_for_llm(ticker: str) -> Optional[str]:
    """Structured quant context for the AI council (no free text, no account data)."""
    c = stock_card(ticker)
    if not c:
        return None
    f = c["factors"]
    fs = c["fscore"] or {}
    parts = [f"Điểm định lượng (so với ngành {c['sector']}): tổng {c['overall']} ({c['overall_pct']} điểm %).",
             "Nhóm: " + ", ".join(f"{k} {v or '—'}" for k, v in c["grades"].items()) + ".",
             f"F-score {fs.get('score_9', '—')}/9; E/P {f.get('earnings_yield')}; B/P {f.get('book_to_price')}; "
             f"tăng trưởng doanh thu {f.get('revenue_growth')}; nợ/tài sản {f.get('liabilities_to_assets')}."]
    if c["caps"]:
        parts.append("Cờ đỏ hạ bậc: " + "; ".join(c["caps"]) + ".")
    d = c.get("dcf") or {}
    if d.get("applicable"):
        parts.append(f"DCF: giá trị hợp lý ~{d['fair_value']:,} đ (vùng {d['low']:,}–{d['high']:,}), {d['zone'].lower()}.".replace(",", "."))
    results = (validation_summary() or {}).get("results", [])
    if results:
        parts.append("Kiểm định walk-forward trên TTCK VN (nhóm 20% tốt nhất so với trung bình, sau phí): "
                     + "; ".join(f"{r['label']}: {r['verdict'].lower()}" for r in results) + ".")
    return " ".join(parts)


def local_finance(ticker: str) -> Optional[Dict[str, Any]]:
    """/api/finance-shaped fundamentals computed from stored statements (same fields as the Vietcap path)."""
    s = scores()
    t = ticker.upper()
    f = s["raw"].get(t)
    if not f:
        return None
    u = s["universe"].get(t) or {}
    pct = lambda v: round(v * 100, 2) if v is not None else 0  # noqa: E731
    l2a = f.get("liabilities_to_assets")
    ey, bp = f.get("earnings_yield"), f.get("book_to_price")
    return {"ticker": t, "pe": round(1 / ey, 2) if ey and ey > 0 else 0, "pb": round(1 / bp, 2) if bp and bp > 0 else 0,
            "roe": pct(f.get("roe")), "eps": round(f["eps"], 2) if f.get("eps") is not None else 0, "revenue": 0,
            "revenueGrowth": pct(f.get("revenue_growth")), "epsGrowth": pct(f.get("earnings_growth")),
            "marketCap": round(f["market_cap"] / 1e9, 2),
            "dividendYield": round((u.get("dps") or 0) / f["price"] * 100, 2) if f["price"] else 0,
            "debtOnEquity": round(l2a / (1 - l2a), 2) if l2a is not None and l2a < 1 else 0,
            "netMargin": pct(f.get("net_margin")), "freeCashFlow": 0, "totalAssets": 0,
            "interestCoverage": round(f["interest_coverage"], 2) if f.get("interest_coverage") is not None else 0,
            "currentRatio": round(f["current_ratio"], 2) if f.get("current_ratio") is not None else 0,
            "industry": u.get("sector") or ""}


# ---------- forward test of the model portfolios ----------

MODELS = {"overall": "Top 10 theo điểm tổng hợp", "value_combo": "Top 10 theo giá trị kết hợp"}
PICKS = 10
COST = 0.003


def model_picks() -> Dict[str, List[Dict[str, Any]]]:
    """Today's picks for each model, exactly as the backtest defines them."""
    import factor_validation as fv
    s = scores()
    raw, graded = s["raw"], s["graded"]
    usable = {t: f for t, f in raw.items() if f.get("volatility") is not None}    # enough price history
    ep, bp = fv._rank_pct({t: f.get("earnings_yield") for t, f in usable.items()}), fv._rank_pct({t: f.get("book_to_price") for t, f in usable.items()})
    scoring = {"overall": {t: graded[t]["overall_pct"] for t in usable if graded.get(t, {}).get("overall_pct") is not None},
               "value_combo": {t: (ep[t] + bp[t]) / 2 for t in usable if t in ep and t in bp}}
    return {m: [{"ticker": t, "price": usable[t]["price"], "score": round(v, 3)}
                for t, v in sorted(sc_.items(), key=lambda kv: -kv[1])[:PICKS]] for m, sc_ in scoring.items()}


def record_forward(today: Optional[date] = None) -> Dict[str, Any]:
    """Freeze this month's picks (once per month) — the honest, out-of-sample record."""
    today = today or date.today()
    month = today.strftime("%Y-%m")
    # Entry is the last close we actually have — label it with that session's date, not the calendar
    # day the job ran (the market may not have closed yet).
    entry_date = min(today.isoformat(), db.last_price_date("VNINDEX") or today.isoformat())
    saved = {}
    picks = None
    for model in MODELS:
        if db.has_picks(month, model):
            continue
        picks = picks or model_picks()
        db.save_picks(month, model, entry_date, picks[model])
        saved[model] = [p["ticker"] for p in picks[model]]
    return {"month": month, "saved": saved}


def forward_status(today: Optional[date] = None) -> Dict[str, Any]:
    """Return of each frozen month: entry → next entry (or today), equal weight, net of turnover costs, vs VN-Index."""
    today = today or date.today()
    recorded = db.forward_picks()
    tickers = sorted({p["ticker"] for months in recorded.values() for ps in months.values() for p in ps})
    panel = db.price_panel(tickers + ["VNINDEX"], since=(today - timedelta(days=400)).isoformat())
    last_px = {t: rows[-1] for t, rows in panel.items() if rows}

    def px_on(t: str, day: str) -> Optional[float]:
        rows = [c for d, c, _ in panel.get(t, []) if d <= day]
        return rows[-1] if rows else None

    out = {}
    for model, months in recorded.items():
        keys = sorted(months)
        rows, prev = [], set()
        for i, m in enumerate(keys):
            ps = months[m]
            start = ps[0]["entry_date"]
            end = months[keys[i + 1]][0]["entry_date"] if i + 1 < len(keys) else (last_px["VNINDEX"][0] if "VNINDEX" in last_px else start)
            rets = []
            for p in ps:
                now = px_on(p["ticker"], end)
                if now and p["entry_price"]:
                    rets.append(now / p["entry_price"] - 1)
            if not rets:
                continue
            names = {p["ticker"] for p in ps}
            churn = 1.0 if not prev else len(names - prev) / len(names)
            prev = names
            if end <= start:            # no session after entry yet: nothing to measure
                rows.append({"month": m, "start": start, "end": end, "open": True, "picks": [p["ticker"] for p in ps],
                             "ret_pct": None, "vnindex_pct": None, "excess_pct": None, "waiting": True})
                continue
            i0, i1 = px_on("VNINDEX", start), px_on("VNINDEX", end)
            ret = sum(rets) / len(rets) - churn * COST
            vn = (i1 / i0 - 1) if i0 and i1 else None
            rows.append({"month": m, "start": start, "end": end, "open": i + 1 == len(keys), "picks": [p["ticker"] for p in ps],
                         "ret_pct": round(ret * 100, 2), "vnindex_pct": round(vn * 100, 2) if vn is not None else None,
                         "excess_pct": round((ret - vn) * 100, 2) if vn is not None else None})
        eq = vn_eq = 1.0
        for r in rows:
            if r["ret_pct"] is None:
                continue
            eq *= 1 + r["ret_pct"] / 100
            vn_eq *= 1 + (r["vnindex_pct"] or 0) / 100
        out[model] = {"label": MODELS.get(model, model), "months": rows, "cumulative_pct": round((eq - 1) * 100, 2) if rows else None,
                      "vnindex_cumulative_pct": round((vn_eq - 1) * 100, 2) if rows else None,
                      "live_days": (today - date.fromisoformat(rows[0]["start"])).days if rows else 0}
    snaps = db.universe_snapshot_days()
    return {"models": out, "universe_snapshot_days": len(snaps), "first_snapshot": snaps[0] if snaps else None,
            "note": "Danh mục được chốt ngay lúc nạp dữ liệu đầu tháng (giá đóng cửa hôm đó) và không bao giờ sửa lại — đây là kết quả ngoài mẫu thật, không phải backtest."}


# ---------- validation ----------

def validation_summary() -> Optional[Dict[str, Any]]:
    return db.get_job("validation")


# ---------- portfolio factor regression ----------

def regress(y: Dict[str, float], factors: Dict[str, Dict[str, float]], min_obs: int = 60) -> Optional[Dict[str, Any]]:
    """OLS of daily returns on factor returns: alpha, betas, t-stats, R²."""
    names = [k for k, s in factors.items() if s]
    dates = sorted(set(y).intersection(*(set(factors[k]) for k in names))) if names else []
    if len(dates) < min_obs:
        return None
    Y = np.array([y[d] for d in dates])
    X = np.column_stack([np.ones(len(dates))] + [[factors[k][d] for d in dates] for k in names])
    coef, *_ = np.linalg.lstsq(X, Y, rcond=None)
    resid = Y - X @ coef
    dof = len(Y) - X.shape[1]
    s2 = float(resid @ resid) / dof
    cov = s2 * np.linalg.inv(X.T @ X)
    se = np.sqrt(np.diag(cov))
    r2 = 1 - float(resid @ resid) / float(((Y - Y.mean()) ** 2).sum())
    labels = ["alpha"] + names
    out = {n: {"coef": round(float(c), 4), "t": round(float(c / e), 2) if e > 0 else None} for n, c, e in zip(labels, coef, se)}
    out["alpha"]["annual_pct"] = round(((1 + coef[0]) ** 250 - 1) * 100, 1)
    return {"coefficients": out, "r2": round(r2, 3), "observations": len(dates), "from": dates[0], "to": dates[-1]}


FACTOR_LABELS = {"MKT": "Thị trường (VN-Index)", "SMB": "Vốn hóa nhỏ", "VALUE": "Giá trị (E/P)", "QUALITY": "Chất lượng (F-score)",
                 "TURN": "Thanh khoản thấp", "MOM": "Momentum"}


def factor_returns() -> Dict[str, Dict[str, float]]:
    series = (db.get_job("factor_series") or {}).get("series") or {}
    idx = db.price_panel(["VNINDEX"]).get("VNINDEX", [])
    mkt = {b[0]: b[1] / a[1] - 1 for a, b in zip(idx, idx[1:])}
    return {"MKT": mkt, **series}


def portfolio_regression(holdings: List[Dict[str, Any]], nav_points: List[Dict[str, Any]]) -> Dict[str, Any]:
    fac = factor_returns()
    out: Dict[str, Any] = {"labels": FACTOR_LABELS}
    tickers = [h["ticker"] for h in holdings]
    panel = db.price_panel(tickers, since=(date.today() - timedelta(days=400)).isoformat())
    total = sum(h["market_value"] for h in holdings) or 1.0
    closes = {t: dict((d, c) for d, c, _ in panel.get(t, [])) for t in tickers}
    dates = sorted(set.intersection(*(set(c) for c in closes.values()))) if closes and all(closes.values()) else []
    replay = {}
    for a, b in zip(dates, dates[1:]):
        replay[b] = sum(h["market_value"] / total * (closes[h["ticker"]][b] / closes[h["ticker"]][a] - 1) for h in holdings)
    out["replay"] = regress(replay, fac)
    nav = {}
    pts = sorted(nav_points, key=lambda p: p["date"])
    for a, b in zip(pts, pts[1:]):
        nav[b["date"]] = (1 + b["twr_pct"] / 100) / (1 + a["twr_pct"] / 100) - 1
    out["actual"] = regress(nav, fac, min_obs=40)
    out["note"] = ("'Tỷ trọng hiện tại' mô phỏng danh mục hôm nay trong 1 năm qua; 'NAV thật' dùng lợi nhuận TWR thực tế "
                   "(cần ≥ 40 phiên). Alpha ≈ 0 và R² cao nghĩa là lợi nhuận đến từ việc nghiêng về các yếu tố, không phải kỹ năng chọn mã.")
    return out


# ---------- pipeline ----------

def run_pipeline(quick: bool = False) -> Dict[str, Any]:
    """Ingest -> validate -> refresh caches. One run at a time."""
    if not _job_lock.acquire(blocking=False):
        return {"state": "busy"}
    try:
        info = market_ingest.run(quick=quick)
        if not quick:
            import factor_validation
            factor_validation.run()
        invalidate()
        warm()
        if not quick:
            info["grades_snapshot"] = snapshot_grades()
            info["forward"] = record_forward()
            db.set_job("ingest", info)      # market_ingest saved it before these steps ran
        return info
    finally:
        _job_lock.release()


def status() -> Dict[str, Any]:
    try:
        counts = db.counts()
    except Exception as e:
        return {"available": False, "error": repr(e)[:200]}
    v = validation_summary() or {}
    return {"available": counts["prices"] > 0, "counts": counts, "ingest": db.get_job("ingest"),
            "validation_at": v.get("updated_at"), "engine": "postgres" if db.is_postgres() else "sqlite",
            "running": _job_lock.locked()}

