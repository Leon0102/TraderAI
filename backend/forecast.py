"""
Quantitative forecasts for held stocks — chosen for what the evidence says actually works:

1. Volatility: GARCH(1,1) with variance targeting (Bollerslev 1986). Volatility clusters and is
   forecastable; GARCH(1,1) is among the best-fitting models for VN-Index volatility.
2. Price distribution: Filtered Historical Simulation (Barone-Adesi et al.) — GARCH-standardised
   residuals resampled with the stationary bootstrap (Politis & Romano 1994), then re-scaled by
   simulated GARCH variance. Keeps fat tails, skew and volatility clustering that a normal model loses.
3. Direction signals with empirical support in Vietnam: 6-month time-series momentum (skip the last
   month), trend vs MA200, 1-week reversal, and the VN-Index regime. Return direction is barely
   predictable (ML/LSTM rarely beats "always long" out of sample), so signals only tilt the drift a little.
4. Walk-forward validation: every forecast is re-fitted on past data only and scored on what
   happened next — interval coverage for the risk model, hit rate vs "always up" for the signal.

numpy only (no scipy): the GARCH likelihood is maximised on a vectorised (alpha, beta) grid.
"""

import math
from typing import Any, Dict, List, Optional

import numpy as np

HORIZONS = {"1 tuần": 5, "1 tháng": 21, "3 tháng": 63, "6 tháng": 125}
PATHS = 3000
MEAN_BLOCK = 10          # stationary bootstrap mean block length (sessions)
DRIFT_SHRINK = 0.5       # same shrink as portfolio_plan: one year of drift overstates the future
SIGNAL_TILT = 0.10       # max annual drift added/removed by a full-strength signal (±10%/yr)
_ALPHAS = np.linspace(0.01, 0.25, 25)
_BETAS = np.linspace(0.60, 0.985, 40)


# ---------- GARCH(1,1) ----------

def fit_garch(returns: np.ndarray) -> Dict[str, float]:
    """Gaussian QMLE with variance targeting: omega = var·(1 − alpha − beta). Grid search, vectorised."""
    r = returns - returns.mean()
    var = float(r.var())
    a, b = np.meshgrid(_ALPHAS, _BETAS, indexing="ij")
    ok = (a + b) < 0.995
    a, b = a[ok], b[ok]
    omega = var * (1 - a - b)
    sig2 = np.full(a.shape, var)
    ll = np.zeros(a.shape)
    for x in r:
        ll -= np.log(sig2) + x * x / sig2
        sig2 = omega + a * x * x + b * sig2
    i = int(np.argmax(ll))
    alpha, beta = float(a[i]), float(b[i])
    return {"alpha": alpha, "beta": beta, "omega": var * (1 - alpha - beta), "long_var": var}


def garch_filter(returns: np.ndarray, p: Dict[str, float]) -> np.ndarray:
    """Conditional variances sigma²_t (for t = 0..n, the last one is tomorrow's forecast)."""
    r = returns - returns.mean()
    out = np.empty(len(r) + 1)
    out[0] = p["long_var"]
    for t, x in enumerate(r):
        out[t + 1] = p["omega"] + p["alpha"] * x * x + p["beta"] * out[t]
    return out


def garch_horizon_var(next_var: float, p: Dict[str, float], h: int) -> float:
    """Variance of the h-session sum of returns: Σ_k [LR + φ^(k−1)(σ²₁ − LR)]."""
    phi = p["alpha"] + p["beta"]
    lr = p["long_var"]
    if abs(1 - phi) < 1e-9:
        return next_var * h
    return lr * h + (next_var - lr) * (1 - phi ** h) / (1 - phi)


# ---------- stationary bootstrap FHS ----------

def stationary_bootstrap_idx(n: int, length: int, paths: int, rng: np.random.Generator, mean_block: int = MEAN_BLOCK) -> np.ndarray:
    """Politis–Romano indices: continue the current block with prob 1 − 1/L, else jump to a random start."""
    idx = np.empty((paths, length), dtype=np.int64)
    idx[:, 0] = rng.integers(0, n, paths)
    jump = rng.random((paths, length)) < 1.0 / mean_block
    starts = rng.integers(0, n, (paths, length))
    for t in range(1, length):
        idx[:, t] = np.where(jump[:, t], starts[:, t], (idx[:, t - 1] + 1) % n)
    return idx


def simulate_fhs(returns: np.ndarray, p: Dict[str, float], mu_daily: float, length: int,
                 paths: int = PATHS, seed: int = 11) -> np.ndarray:
    """Cumulative log-return paths (paths × length) under GARCH-filtered historical simulation."""
    rng = np.random.default_rng(seed)
    sig2 = garch_filter(returns, p)
    z = (returns - returns.mean()) / np.sqrt(sig2[:-1])
    z = (z - z.mean()) / z.std()
    idx = stationary_bootstrap_idx(len(z), length, paths, rng)
    s2 = np.full(paths, sig2[-1])
    cum = np.empty((paths, length))
    acc = np.zeros(paths)
    for t in range(length):
        eps = np.sqrt(s2) * z[idx[:, t]]
        acc = acc + mu_daily - s2 / 2 + eps
        cum[:, t] = acc
        s2 = p["omega"] + p["alpha"] * eps * eps + p["beta"] * s2
    return cum


def first_touch(cum: np.ndarray, up: float, down: float) -> Dict[str, float]:
    """Share of paths that hit +up (log) before −down, the reverse, or neither."""
    hit_up = cum >= up
    hit_dn = cum <= -down
    n_len = cum.shape[1]
    t_up = np.where(hit_up.any(1), hit_up.argmax(1), n_len)
    t_dn = np.where(hit_dn.any(1), hit_dn.argmax(1), n_len)
    return {"target_first": float(np.mean(t_up < t_dn)), "stop_first": float(np.mean(t_dn < t_up)),
            "neither": float(np.mean((t_up == n_len) & (t_dn == n_len)))}


# ---------- signals ----------

def signals(closes: np.ndarray, index_closes: Optional[np.ndarray]) -> Dict[str, Any]:
    """Evidence-based direction signals, each in [−1, 1], and a weighted composite."""
    out: Dict[str, Any] = {}
    n = len(closes)
    if n > 147:  # 6-month momentum skipping the latest month (Jegadeesh–Titman style 6-1)
        mom = closes[-22] / closes[-148] - 1
        out["momentum_6m"] = {"value_pct": round(float(mom) * 100, 1), "score": float(np.clip(mom / 0.3, -1, 1))}
    if n >= 200:
        ma200 = closes[-200:].mean()
        gap = closes[-1] / ma200 - 1
        out["trend_ma200"] = {"value_pct": round(float(gap) * 100, 1), "score": float(np.clip(gap / 0.15, -1, 1))}
    if n > 60:  # 1-week reversal: a sharp 5-day move tends to partially retrace
        r = np.diff(np.log(closes[-61:]))
        wk = float(np.log(closes[-1] / closes[-6]))
        zscore = wk / (r.std() * math.sqrt(5)) if r.std() > 0 else 0.0
        out["reversal_1w"] = {"value_pct": round((math.exp(wk) - 1) * 100, 1), "score": float(np.clip(-zscore / 2, -1, 1))}
    if index_closes is not None and len(index_closes) >= 200:
        gap = index_closes[-1] / index_closes[-200:].mean() - 1
        out["market_regime"] = {"value_pct": round(float(gap) * 100, 1), "score": float(np.clip(gap / 0.1, -1, 1))}
    weights = {"momentum_6m": 0.35, "trend_ma200": 0.3, "reversal_1w": 0.1, "market_regime": 0.25}
    used = {k: w for k, w in weights.items() if k in out}
    composite = sum(out[k]["score"] * w for k, w in used.items()) / sum(used.values()) if used else 0.0
    label = ("TÍCH CỰC" if composite > 0.35 else "HƠI TÍCH CỰC" if composite > 0.1
             else "TIÊU CỰC" if composite < -0.35 else "HƠI TIÊU CỰC" if composite < -0.1 else "TRUNG TÍNH")
    return {"components": out, "composite": round(float(composite), 3), "label": label}


# ---------- walk-forward validation ----------

def walk_forward(closes: np.ndarray, index_closes: Optional[np.ndarray], horizon: int = 21,
                 test_sessions: int = 250, step: int = 5, min_train: int = 250) -> Optional[Dict[str, Any]]:
    """Refit on data up to each origin, forecast `horizon` sessions ahead, score against reality.

    - coverage: share of realised returns inside the 80% GARCH interval (well calibrated ≈ 80%).
    - hit rate: sign(signal) vs sign(realised return), compared with the naive rule of always
      calling the more frequent direction (in a falling year "always down" is the bar to beat).
    """
    logp = np.log(closes)
    n = len(closes)
    start = max(min_train, n - test_sessions - horizon)
    origins = list(range(start, n - horizon, step))
    if len(origins) < 10:
        return None
    z80 = 1.2815515655446004
    inside = hits = ups = signalled = 0
    for o in origins:
        rets = np.diff(logp[max(0, o - 750):o + 1])
        p = fit_garch(rets)
        sd = math.sqrt(garch_horizon_var(float(garch_filter(rets, p)[-1]), p, horizon))
        realised = logp[o + horizon] - logp[o]
        inside += bool(abs(realised) <= z80 * sd)
        ups += bool(realised > 0)
        idx = None
        if index_closes is not None:
            cut = len(index_closes) - (n - 1 - o)
            idx = index_closes[:cut] if cut > 200 else None
        s = signals(closes[:o + 1], idx)["composite"]
        if abs(s) > 0.1:
            signalled += 1
            hits += bool((s > 0) == (realised > 0))
    total = len(origins)
    return {
        "origins": total, "horizon_sessions": horizon,
        "interval80_coverage_pct": round(inside / total * 100, 1),
        "signal_hit_rate_pct": round(hits / signalled * 100, 1) if signalled else None,
        "signal_calls": signalled,
        "always_up_hit_rate_pct": round(ups / total * 100, 1),
        "naive_hit_rate_pct": round(max(ups, total - ups) / total * 100, 1),
    }


# ---------- per-ticker assembly ----------

def forecast_ticker(closes: List[float], index_closes: Optional[List[float]] = None,
                    levels: Optional[Dict[str, float]] = None, validate: bool = True) -> Optional[Dict[str, Any]]:
    """Forecast one stock from daily closes (VND). `levels` may carry breakeven / stop_loss / target."""
    px = np.asarray([c for c in closes if c and c > 0], dtype=float)
    if len(px) < 260:
        return None
    idx = np.asarray(index_closes, dtype=float) if index_closes else None
    rets = np.diff(np.log(px[-751:]))
    p = fit_garch(rets)
    sig2 = garch_filter(rets, p)
    sig = signals(px, idx)
    # Drift: shrunk historical mean plus a small, capped tilt from the composite signal.
    mu = float(rets[-250:].mean()) * DRIFT_SHRINK + sig["composite"] * SIGNAL_TILT / 250
    price = float(px[-1])
    longest = max(HORIZONS.values())
    cum = simulate_fhs(rets, p, mu, longest)

    bands = {}
    for label, h in HORIZONS.items():
        q = np.percentile(price * np.exp(cum[:, h - 1]), [5, 25, 50, 75, 95])
        bands[label] = {k: round(float(v)) for k, v in zip(("p5", "p25", "p50", "p75", "p95"), q)}
    one_day = cum[:, 0]
    month = cum[:, 20]
    var95_1d = -float(np.percentile(one_day, 5))
    var95_1m = -float(np.percentile(month, 5))
    es95_1m = -float(month[month <= -var95_1m].mean())

    result: Dict[str, Any] = {
        "price": round(price),
        "garch": {"alpha": round(p["alpha"], 3), "beta": round(p["beta"], 3), "persistence": round(p["alpha"] + p["beta"], 3),
                  "vol_now_annual_pct": round(math.sqrt(sig2[-1] * 250) * 100, 1),
                  "vol_long_run_annual_pct": round(math.sqrt(p["long_var"] * 250) * 100, 1)},
        "signals": sig,
        "expected_return_annual_pct": round((math.exp(mu * 250) - 1) * 100, 1),
        "bands": bands,
        "prob_up": {label: round(float(np.mean(cum[:, h - 1] > 0)) * 100, 1) for label, h in HORIZONS.items()},
        "risk": {"var95_1d_pct": round((1 - math.exp(-var95_1d)) * 100, 2), "var95_1m_pct": round((1 - math.exp(-var95_1m)) * 100, 2),
                 "es95_1m_pct": round((1 - math.exp(-es95_1m)) * 100, 2)},
    }
    lv = levels or {}
    if lv.get("breakeven") and lv["breakeven"] > price:
        need = math.log(lv["breakeven"] / price)
        result["prob_breakeven"] = {label: round(float(np.mean(cum[:, :h].max(1) >= need)) * 100, 1) for label, h in HORIZONS.items()}
    if lv.get("target") and lv.get("stop_loss") and lv["target"] > price > lv["stop_loss"]:
        ft = first_touch(cum[:, :63], math.log(lv["target"] / price), math.log(price / lv["stop_loss"]))
        result["target_vs_stop_3m"] = {k: round(v * 100, 1) for k, v in ft.items()}
    if validate:
        result["validation"] = walk_forward(px, idx)
    return result


def fetch_long_history(tickers: List[str], years: int = 3) -> Dict[str, List[float]]:
    import os
    import sys
    from datetime import datetime, timedelta

    api_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "api"))
    if api_dir not in sys.path:
        sys.path.append(api_dir)  # append: api/agents.py must not shadow the backend agents package
    from history import get_history

    def _to_vnd(price: float) -> float:  # VCI/DNSE quote stocks in thousand VND
        return price * 1000 if 0 < price < 1000 else price

    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=365 * years + 30)).strftime("%Y-%m-%d")
    out: Dict[str, List[float]] = {}
    for t in tickers:
        try:
            bars = (get_history(t, start, end) or {}).get("data") or []
        except Exception:
            bars = []
        out[t] = [_to_vnd(float(b["close"])) if t != "VNINDEX" else float(b["close"]) for b in bars if b.get("close")]
    return out
