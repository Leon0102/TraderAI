"""
Risk tools for the real portfolio:

- position sizing: shares so a stop-out costs at most `risk_pct` of NAV, with a volatility
  (GARCH ATR-style) stop when no stop level is given.
- risk parity: current risk contributions vs equal-risk-contribution (ERC) weights,
  from the sample covariance of daily returns (Maillard, Roncalli & Teïletche 2010).
- stress tests: replay real crashes (2022 bear market, April 2025 tariff shock) on each
  holding's actual prices, plus hypothetical VN-Index drops scaled by beta.
- volatility spike alerts: GARCH vol now vs its long-run level.
- rule backtest: do the app's own rules (−7% stop, take 1/3 at +20%, trailing stop)
  actually beat buy-and-hold on these stocks? Entries every week over 3 years, fees included.

numpy only; pure functions take pre-fetched closes so they are testable offline.
"""

import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from portfolio_plan import LOT, fee_config

STRESS_WINDOWS = {
    "Sập 2022 (VN-Index -40%)": ("2022-01-06", "2022-11-15"),
    "Sốc thuế quan 4/2025 (-18%)": ("2025-03-25", "2025-04-09"),
}
HYPOTHETICAL_DROPS = (-10, -20, -30)
VOL_SPIKE_RATIO = 1.5
BACKTEST_HOLD = 120      # sessions an entry is held at most (~6 months)
BACKTEST_STEP = 5        # a new entry every week
BUY_FEE = 0.001


# ---------- position sizing ----------

def position_size(nav: float, price: float, stop: float, risk_pct: float, max_weight: float = 0.25,
                  cash: Optional[float] = None) -> Dict[str, Any]:
    """Shares so that (price − stop) × shares ≤ risk_pct·NAV, capped by weight and cash, in lots of 100."""
    if price <= 0 or stop <= 0 or stop >= price or nav <= 0:
        return {"shares": 0, "reason": "stop phải thấp hơn giá mua"}
    by_risk = risk_pct / 100 * nav / (price - stop)
    by_weight = max_weight * nav / price
    caps = {"rủi ro": by_risk, "tỷ trọng tối đa": by_weight}
    if cash is not None:
        caps["tiền mặt"] = cash / (price * (1 + BUY_FEE))
    binding = min(caps, key=caps.get)
    shares = int(math.floor(caps[binding] / LOT) * LOT)
    return {"shares": shares, "value": round(shares * price), "risk_amount": round(shares * (price - stop)),
            "risk_pct_nav": round(shares * (price - stop) / nav * 100, 2), "weight_pct": round(shares * price / nav * 100, 1),
            "limited_by": binding, "stop": round(stop)}


def vol_stop(price: float, daily_sigma: float, k: float = 2.0, horizon: int = 10) -> float:
    """Stop k standard deviations of a `horizon`-session move below the price."""
    return price * math.exp(-k * daily_sigma * math.sqrt(horizon))


# ---------- risk parity ----------

def aligned_returns(closes: Dict[str, List[Tuple[str, float]]], tickers: List[str], sessions: int = 250) -> Optional[np.ndarray]:
    series = [{d: c for d, c in closes.get(t, []) if c} for t in tickers]
    if not series or any(len(s) < 60 for s in series):
        return None
    common = sorted(set.intersection(*(set(s) for s in series)))[-(sessions + 1):]
    if len(common) < 60:
        return None
    px = np.array([[s[d] for s in series] for d in common])
    return np.diff(np.log(px), axis=0)


def risk_contributions(weights: np.ndarray, cov: np.ndarray) -> np.ndarray:
    """Share of portfolio variance from each asset: w_i (Σw)_i / wᵀΣw."""
    port = float(weights @ cov @ weights)
    return weights * (cov @ weights) / port if port > 0 else np.zeros_like(weights)


def erc_weights(cov: np.ndarray, iters: int = 500) -> np.ndarray:
    """Equal risk contribution via the fixed point w_i ∝ 1 / (Σw)_i (converges for positive-definite Σ)."""
    n = cov.shape[0]
    w = np.full(n, 1.0 / n)
    for _ in range(iters):
        marginal = cov @ w
        new = 1.0 / np.maximum(marginal, 1e-18)
        new /= new.sum()
        w = 0.5 * w + 0.5 * new
    return w / w.sum()


def risk_parity(holdings: List[Dict[str, Any]], closes: Dict[str, List[Tuple[str, float]]]) -> Optional[Dict[str, Any]]:
    tickers = [h["ticker"] for h in holdings]
    if len(tickers) < 2:
        return None
    rets = aligned_returns(closes, tickers)
    if rets is None:
        return None
    cov = np.cov(rets, rowvar=False)
    value = np.array([h["market_value"] for h in holdings], dtype=float)
    w_now = value / value.sum()
    rc_now = risk_contributions(w_now, cov)
    w_erc = erc_weights(cov)
    vol = lambda w: math.sqrt(float(w @ cov @ w) * 250) * 100  # noqa: E731
    return {
        "rows": [{"ticker": t, "weight_pct": round(float(w_now[i]) * 100, 1), "risk_share_pct": round(float(rc_now[i]) * 100, 1),
                  "erc_weight_pct": round(float(w_erc[i]) * 100, 1),
                  "vol_annual_pct": round(math.sqrt(float(cov[i, i]) * 250) * 100, 1)} for i, t in enumerate(tickers)],
        "vol_now_pct": round(vol(w_now), 1),
        "vol_erc_pct": round(vol(w_erc), 1),
        "note": "Tỷ trọng trong phần cổ phiếu (không gồm tiền mặt).",
    }


# ---------- stress tests ----------

def _close_on_or_before(series: Dict[str, float], day: str) -> Optional[float]:
    keys = [d for d in series if d <= day]
    return series[max(keys)] if keys else None


def stress_test(holdings: List[Dict[str, Any]], closes: Dict[str, List[Tuple[str, float]]],
                index: List[Tuple[str, float]], betas: Dict[str, Optional[float]], nav: float) -> List[Dict[str, Any]]:
    """Portfolio loss if each crash happened again to today's holdings (cash unchanged)."""
    idx = dict(index)
    out = []
    for label, (start, end) in STRESS_WINDOWS.items():
        i0, i1 = _close_on_or_before(idx, start), _close_on_or_before(idx, end)
        if not i0 or not i1:
            continue
        index_move = i1 / i0 - 1
        loss, rows = 0.0, []
        for h in holdings:
            s = dict(closes.get(h["ticker"], []))
            p0, p1 = _close_on_or_before(s, start), _close_on_or_before(s, end)
            if p0 and p1 and min(s) <= start:
                move, source = p1 / p0 - 1, "thực tế"
            else:  # listed later: estimate from beta
                move, source = (betas.get(h["ticker"]) or 1.0) * index_move, "ước tính theo beta"
            loss += h["market_value"] * move
            rows.append({"ticker": h["ticker"], "move_pct": round(move * 100, 1), "source": source})
        out.append({"scenario": label, "vnindex_pct": round(index_move * 100, 1), "portfolio_pct": round(loss / nav * 100, 1) if nav else 0.0,
                    "loss": round(loss), "rows": rows})
    for drop in HYPOTHETICAL_DROPS:
        loss = sum(h["market_value"] * (betas.get(h["ticker"]) or 1.0) * drop / 100 for h in holdings)
        out.append({"scenario": f"VN-Index {drop}% (theo beta)", "vnindex_pct": float(drop),
                    "portfolio_pct": round(loss / nav * 100, 1) if nav else 0.0, "loss": round(loss), "rows": []})
    return out


# ---------- volatility spikes ----------

def vol_spikes(forecasts: Dict[str, Any]) -> List[Dict[str, Any]]:
    out = []
    for t, f in forecasts.items():
        if not f:
            continue
        now, lr = f["garch"]["vol_now_annual_pct"], f["garch"]["vol_long_run_annual_pct"]
        if lr and now / lr >= VOL_SPIKE_RATIO:
            out.append({"ticker": t, "ratio": round(now / lr, 2),
                        "text": f"{t}: biến động hiện tại {now}%/năm, gấp {now / lr:.1f} lần mức thường ({lr}%) — thu hẹp vị thế hoặc nới stop theo biến động."})
    return out


# ---------- rule backtest ----------

def _simulate_entry(px: np.ndarray, start: int, rule: str, keep: float) -> float:
    """Return of one entry at px[start] (after buy fee, sell fee+tax) under an exit rule."""
    entry = px[start] * (1 + BUY_FEE)
    end = min(start + BACKTEST_HOLD, len(px) - 1)
    if rule == "hold":
        return px[end] * keep / entry - 1
    position, realised, peak = 1.0, 0.0, px[start]
    took_profit = False
    for t in range(start + 1, end + 1):
        p = px[t]
        peak = max(peak, p)
        if p <= px[start] * 0.93:                       # hard stop −7%
            return realised + position * (p * keep / entry) - 1
        if rule == "full" and not took_profit and p >= px[start] * 1.2:
            realised += position / 3 * (p * keep / entry)  # take 1/3 at +20%
            position *= 2 / 3
            took_profit = True
        if rule == "full" and took_profit and p <= max(px[start], peak * 0.9):
            return realised + position * (p * keep / entry) - 1   # trailing: 10% off peak, never below cost
    return realised + position * (px[end] * keep / entry) - 1


def backtest_rules(closes: List[float]) -> Optional[Dict[str, Any]]:
    """Weekly entries over the history; compare buy-and-hold with the app's exit rules."""
    px = np.asarray([c for c in closes if c and c > 0], dtype=float)
    if len(px) < BACKTEST_HOLD + 60:
        return None
    fees = fee_config()
    keep = 1 - fees["sell_fee"] - fees["sell_tax"]
    starts = range(0, len(px) - BACKTEST_HOLD, BACKTEST_STEP)
    labels = {"hold": "Giữ 6 tháng", "stop": "Cắt lỗ -7%", "full": "Cắt lỗ -7% + chốt 1/3 ở +20% + trailing"}
    out = {}
    for rule in labels:
        r = np.array([_simulate_entry(px, s, rule, keep) for s in starts])
        out[rule] = {"label": labels[rule], "entries": len(r), "avg_return_pct": round(float(r.mean()) * 100, 2),
                     "median_return_pct": round(float(np.median(r)) * 100, 2), "win_rate_pct": round(float(np.mean(r > 0)) * 100, 1),
                     "worst_pct": round(float(r.min()) * 100, 1), "p10_pct": round(float(np.percentile(r, 10)) * 100, 1)}
    best = max(out, key=lambda k: out[k]["avg_return_pct"])
    return {"rules": list(out.values()), "best": out[best]["label"]}


# ---------- assembly ----------

def build_risk(analysis: Dict[str, Any], plan: Dict[str, Any], closes: Dict[str, List[Tuple[str, float]]],
               forecasts: Dict[str, Any], betas: Dict[str, Optional[float]], risk_pct: float = 1.0) -> Dict[str, Any]:
    nav, cash = analysis["summary"]["nav"], analysis["summary"]["cash"]
    holdings = analysis["holdings"]
    sizing = []
    for p in plan["positions"]:
        f = forecasts.get(p["ticker"]) or {}
        stop = p.get("stop_loss") if p.get("stop_loss") and p["stop_loss"] < p["price"] else None
        if not stop and f:
            daily = f["garch"]["vol_now_annual_pct"] / 100 / math.sqrt(250)
            stop = vol_stop(p["price"], daily)
        size = position_size(nav, p["price"], stop or p["price"] * 0.93, risk_pct)
        current_risk = p["quantity"] * max(0.0, p["price"] - (stop or p["price"] * 0.93))
        sizing.append({"ticker": p["ticker"], "held": p["quantity"], "suggested": size["shares"], "stop": size.get("stop"),
                       "current_risk_pct_nav": round(current_risk / nav * 100, 2) if nav else 0.0,
                       "delta": size["shares"] - p["quantity"], "limited_by": size.get("limited_by")})
    index = closes.get("VNINDEX", [])
    backtests = {t: backtest_rules([c for _, c in closes.get(t, [])][-760:]) for t in [h["ticker"] for h in holdings]}
    return {
        "risk_pct": risk_pct,
        "sizing": sizing,
        "risk_parity": risk_parity(holdings, closes),
        "stress": stress_test(holdings, closes, index, betas, nav),
        "vol_spikes": vol_spikes(forecasts),
        "backtests": backtests,
    }


def fetch_dated_history(tickers: List[str], years: int = 5) -> Dict[str, List[Tuple[str, float]]]:
    import os
    import sys
    from datetime import datetime, timedelta

    api_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "api"))
    if api_dir not in sys.path:
        sys.path.append(api_dir)  # append: api/agents.py must not shadow the backend agents package
    from history import get_history

    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=365 * years + 30)).strftime("%Y-%m-%d")
    out: Dict[str, List[Tuple[str, float]]] = {}
    for t in tickers:
        try:
            bars = (get_history(t, start, end) or {}).get("data") or []
        except Exception:
            bars = []
        scale = (lambda c: c) if t == "VNINDEX" else (lambda c: c * 1000 if 0 < c < 1000 else c)
        out[t] = [(b.get("tradingDate", ""), scale(float(b["close"]))) for b in bars if b.get("close")]
    return out
