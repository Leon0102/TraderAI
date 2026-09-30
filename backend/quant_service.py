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
        f = sc.factors(stmts.get(t, []), panel.get(t, []), today, bool(u.get("is_bank")), u.get("shares"))
        if f:
            raw[t] = f
    graded = sc.grade_universe(raw, {t: (uni.get(t) or {}).get("sector") for t in raw})
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
                     "analyst_target": u.get("target_price"), "rating": u.get("rating")})
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
            "analyst": {"target": u.get("target_price"), "rating": u.get("rating"), "dps": u.get("dps")},
            "evidence": {r["factor"]: r["verdict"] for r in (val or {}).get("results", [])}}


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

