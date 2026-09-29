"""
Portfolio construction helpers:

- correlation clusters: holdings that move together are really one bet.
- market regime: VN-Index trend (MA200) and GARCH volatility -> suggested stock exposure.
  Trend filters mainly cut drawdowns rather than add return (Faber 2007; Moskowitz et al. 2012).
- Black–Litterman weights (He & Litterman 1999): market-cap equilibrium blended with analyst
  target prices as views, so weights stay sane instead of Markowitz's corner solutions.
- alternatives: replacements for weak holdings (same sector) and diversifiers, ranked by
  6-month momentum, trend, low correlation with the portfolio and analyst upside.

numpy only; pure functions take pre-fetched data.
"""

import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

import forecast as fc

# Static VN30 basket used as the candidate universe (plus the day's most liquid names).
VN30 = ["ACB", "BCM", "BID", "BVH", "CTG", "FPT", "GAS", "GVR", "HDB", "HPG", "LPB", "MBB", "MSN", "MWG", "PLX",
        "SAB", "SHB", "SSB", "SSI", "STB", "TCB", "TPB", "VCB", "VHM", "VIB", "VIC", "VJC", "VNM", "VPB", "VRE"]
CLUSTER_CORR = 0.6
BL_DELTA = 2.5     # risk aversion
BL_TAU = 0.05
MAX_WEIGHT = 0.25


def _aligned(closes: Dict[str, List[Tuple[str, float]]], tickers: List[str], sessions: int = 250) -> Optional[np.ndarray]:
    series = [{d: c for d, c in closes.get(t, []) if c} for t in tickers]
    if not series or any(len(s) < 60 for s in series):
        return None
    common = sorted(set.intersection(*(set(s) for s in series)))[-(sessions + 1):]
    if len(common) < 60:
        return None
    px = np.array([[s[d] for s in series] for d in common])
    return np.diff(np.log(px), axis=0)


# ---------- correlation clusters ----------

def correlation_clusters(tickers: List[str], closes: Dict[str, List[Tuple[str, float]]]) -> Optional[Dict[str, Any]]:
    if len(tickers) < 2:
        return None
    rets = _aligned(closes, tickers)
    if rets is None:
        return None
    corr = np.corrcoef(rets, rowvar=False)
    parent = list(range(len(tickers)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(tickers)):
        for j in range(i + 1, len(tickers)):
            if corr[i, j] >= CLUSTER_CORR:
                parent[find(i)] = find(j)
    groups: Dict[int, List[str]] = {}
    for i, t in enumerate(tickers):
        groups.setdefault(find(i), []).append(t)
    clusters = [g for g in groups.values() if len(g) > 1]
    off = corr[~np.eye(len(tickers), dtype=bool)]
    return {
        "tickers": tickers,
        "matrix": [[round(float(v), 2) for v in row] for row in corr],
        "avg_correlation": round(float(off.mean()), 2),
        "clusters": clusters,
        "notes": [f"{', '.join(g)} có tương quan ≥ {CLUSTER_CORR} — thực chất là cùng một khoản cược." for g in clusters],
    }


# ---------- market regime ----------

def market_regime(index_closes: List[float], stock_pct: float) -> Optional[Dict[str, Any]]:
    px = np.asarray([c for c in index_closes if c], dtype=float)
    if len(px) < 260:
        return None
    ma200 = float(px[-200:].mean())
    rets = np.diff(np.log(px[-751:]))
    p = fc.fit_garch(rets)
    vol_now = math.sqrt(float(fc.garch_filter(rets, p)[-1]) * 250) * 100
    vol_lr = math.sqrt(p["long_var"] * 250) * 100
    above = px[-1] > ma200
    calm = vol_now <= vol_lr * 1.2
    if above and calm:
        state, target = "THUẬN LỢI", 90
    elif above or calm:
        state, target = "TRUNG TÍNH", 65
    else:
        state, target = "PHÒNG THỦ", 40
    gap = stock_pct - target
    advice = ("Tỷ trọng cổ phiếu phù hợp với trạng thái thị trường." if abs(gap) <= 10 else
              f"Cân nhắc hạ tỷ trọng cổ phiếu khoảng {gap:.0f} điểm % (về ~{target}%)." if gap > 0 else
              f"Còn dư địa tăng tỷ trọng cổ phiếu khoảng {-gap:.0f} điểm % nếu có cơ hội tốt.")
    return {"state": state, "vnindex": round(float(px[-1]), 2), "ma200": round(ma200, 2),
            "vs_ma200_pct": round((px[-1] / ma200 - 1) * 100, 1), "vol_now_pct": round(vol_now, 1), "vol_long_run_pct": round(vol_lr, 1),
            "suggested_stock_pct": target, "current_stock_pct": round(stock_pct, 1), "advice": advice,
            "evidence": "Lọc theo xu hướng (MA200) chủ yếu giúp giảm mức sụt giảm sâu, không làm tăng lợi nhuận dài hạn."}


# ---------- Black–Litterman ----------

def black_litterman(tickers: List[str], closes: Dict[str, List[Tuple[str, float]]], caps: Dict[str, float],
                    views: Dict[str, float], current: Dict[str, float]) -> Optional[Dict[str, Any]]:
    """`views`: expected 1-year return per ticker (fraction). Returns long-only weights capped at 25%."""
    if len(tickers) < 2:
        return None
    rets = _aligned(closes, tickers)
    if rets is None:
        return None
    sigma = np.cov(rets, rowvar=False) * 250
    cap = np.array([max(caps.get(t) or 0.0, 0.0) for t in tickers])
    w_mkt = cap / cap.sum() if cap.sum() > 0 else np.full(len(tickers), 1 / len(tickers))
    pi = BL_DELTA * sigma @ w_mkt
    idx = [i for i, t in enumerate(tickers) if t in views]
    if idx:
        P = np.zeros((len(idx), len(tickers)))
        for r, i in enumerate(idx):
            P[r, i] = 1.0
        q = np.array([views[tickers[i]] for i in idx])
        omega = np.diag(np.diag(BL_TAU * P @ sigma @ P.T))
        ts_inv = np.linalg.inv(BL_TAU * sigma)
        om_inv = np.linalg.inv(omega)
        mu = np.linalg.solve(ts_inv + P.T @ om_inv @ P, ts_inv @ pi + P.T @ om_inv @ q)
    else:
        mu = pi
    w = np.linalg.solve(BL_DELTA * sigma, mu)
    w = np.clip(w, 0, None)
    if w.sum() <= 0:
        w = w_mkt.copy()
    w = w / w.sum()
    cap_w = max(MAX_WEIGHT, 1 / len(tickers))  # with few names a 25% cap is infeasible
    for _ in range(50):  # cap each name, redistribute the excess to the rest
        over = w > cap_w + 1e-12
        if not over.any() or over.all():
            break
        excess = float((w[over] - cap_w).sum())
        w[over] = cap_w
        rest = w[~over]
        w[~over] += excess * (rest / rest.sum() if rest.sum() > 0 else np.full(rest.shape, 1 / rest.size))
    return {"rows": [{"ticker": t, "current_pct": round(current.get(t, 0.0) * 100, 1), "bl_pct": round(float(w[i]) * 100, 1),
                      "prior_return_pct": round(float(pi[i]) * 100, 1), "posterior_return_pct": round(float(mu[i]) * 100, 1),
                      "view_pct": round(views[t] * 100, 1) if t in views else None} for i, t in enumerate(tickers)],
            "note": "Tỷ trọng trong phần cổ phiếu. Điểm xuất phát là vốn hóa thị trường; quan điểm là giá mục tiêu của nhà phân tích (giới hạn -30%…+40%)."}


def analyst_views(companies: Dict[str, Dict[str, Any]], prices: Dict[str, float]) -> Dict[str, float]:
    out = {}
    for t, c in companies.items():
        target, price = (c or {}).get("targetPrice"), prices.get(t)
        if target and price:
            out[t] = float(np.clip(target / price - 1, -0.3, 0.4))
    return out


# ---------- alternatives ----------

def _momentum_trend(px: np.ndarray) -> Tuple[Optional[float], Optional[float]]:
    mom = float(px[-22] / px[-148] - 1) if len(px) > 147 else None
    trend = float(px[-1] / px[-200:].mean() - 1) if len(px) >= 200 else None
    return mom, trend


def alternatives(holdings: List[Dict[str, Any]], weak: List[str], closes: Dict[str, List[Tuple[str, float]]],
                 companies: Dict[str, Dict[str, Any]], universe: List[str]) -> Dict[str, Any]:
    held = {h["ticker"] for h in holdings}
    # Portfolio daily returns (current weights) for correlation with candidates.
    series = {h["ticker"]: dict(closes.get(h["ticker"], [])) for h in holdings}
    total = sum(h["market_value"] for h in holdings) or 1.0
    common = sorted(set.intersection(*(set(s) for s in series.values()))) if series else []
    port = {}
    for a, b in zip(common, common[1:]):
        port[b] = sum(h["market_value"] / total * math.log(series[h["ticker"]][b] / series[h["ticker"]][a]) for h in holdings)
    scored = []
    for t in universe:
        if t in held:
            continue
        rows = closes.get(t) or []
        if len(rows) < 200:
            continue
        px = np.asarray([c for _, c in rows], dtype=float)
        mom, trend = _momentum_trend(px)
        if mom is None or trend is None:
            continue
        cand = dict(rows)
        dates = sorted(set(cand) & set(port))[-250:]
        corr = None
        if len(dates) > 60:
            a = np.diff(np.log([cand[d] for d in dates]))
            b = np.array([port[d] for d in dates[1:]])
            corr = float(np.corrcoef(a, b)[0, 1])
        c = companies.get(t) or {}
        upside = (c.get("targetPrice") / px[-1] - 1) if c.get("targetPrice") else None
        score = (0.35 * np.clip(mom / 0.3, -1, 1) + 0.3 * np.clip(trend / 0.15, -1, 1)
                 + 0.25 * (1 - (corr if corr is not None else 0.5)) + 0.1 * (np.clip(upside / 0.3, -1, 1) if upside is not None else 0))
        scored.append({"ticker": t, "sector": c.get("sectorVn"), "name": c.get("viOrganShortName") or c.get("viOrganName"),
                       "price": round(float(px[-1])), "momentum_6m_pct": round(mom * 100, 1), "vs_ma200_pct": round(trend * 100, 1),
                       "corr_with_portfolio": round(corr, 2) if corr is not None else None,
                       "analyst_upside_pct": round(upside * 100, 1) if upside is not None else None,
                       "rating": c.get("rating"), "score": round(float(score), 3)})
    scored.sort(key=lambda x: -x["score"])
    positive = [x for x in scored if x["momentum_6m_pct"] > 0 and x["vs_ma200_pct"] > 0]
    replacements = []
    for t in weak:
        sector = (companies.get(t) or {}).get("sectorVn")
        same = [x for x in positive if sector and x["sector"] == sector][:3]
        replacements.append({"ticker": t, "sector": sector, "candidates": same})
    diversifiers = sorted([x for x in positive if x["corr_with_portfolio"] is not None],
                          key=lambda x: (x["corr_with_portfolio"], -x["score"]))[:5]
    return {"universe_size": len(scored), "replacements": replacements, "diversifiers": diversifiers, "top": scored[:8],
            "note": "Tập ứng viên: VN30 + 50 mã thanh khoản cao nhất phiên gần nhất. Điểm = momentum 6 tháng, xu hướng MA200, tương quan thấp với danh mục, upside nhà phân tích."}


def fetch_universe(extra: List[str]) -> List[str]:
    import os
    import sys

    api_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "api"))
    if api_dir not in sys.path:
        sys.path.append(api_dir)
    liquid: List[str] = []
    try:
        from stocks import get_top_stocks
        liquid = [r["ticker"] for r in (get_top_stocks(50) or {}).get("data", []) if r.get("ticker")]
    except Exception:
        pass
    seen, out = set(), []
    for t in VN30 + liquid + extra:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out
