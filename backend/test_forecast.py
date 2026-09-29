"""
Offline tests for the forecasting models (GARCH, FHS bootstrap, signals, walk-forward).
Run: python3 backend/test_forecast.py   (from project root)
"""

import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import forecast as fc  # noqa: E402


def _garch_series(n=1500, omega=2e-6, alpha=0.1, beta=0.85, seed=1):
    rng = np.random.default_rng(seed)
    s2, r = omega / (1 - alpha - beta), []
    for _ in range(n):
        x = math.sqrt(s2) * rng.standard_normal()
        r.append(x)
        s2 = omega + alpha * x * x + beta * s2
    return np.array(r)


def test_garch_recovers_parameters():
    p = fc.fit_garch(_garch_series())
    assert abs(p["alpha"] - 0.1) < 0.05 and abs(p["beta"] - 0.85) < 0.07, p
    assert p["alpha"] + p["beta"] < 0.995 and p["omega"] > 0


def test_horizon_variance_matches_recursion():
    p = {"alpha": 0.1, "beta": 0.85, "omega": 1e-5, "long_var": 1e-5 / 0.05}
    s1, total, v = 4e-4, 0.0, 4e-4
    for _ in range(21):
        total += v
        v = p["omega"] + (p["alpha"] + p["beta"]) * v
    assert abs(fc.garch_horizon_var(s1, p, 21) - total) / total < 1e-9


def test_stationary_bootstrap_block_structure():
    idx = fc.stationary_bootstrap_idx(500, 400, 200, np.random.default_rng(3), mean_block=10)
    assert idx.min() >= 0 and idx.max() < 500
    continued = np.mean(idx[:, 1:] == (idx[:, :-1] + 1) % 500)
    assert 0.87 < continued < 0.93, continued  # ≈ 1 − 1/L (+ tiny chance a jump lands on the next index)


def test_first_touch():
    up = np.cumsum(np.full((10, 50), 0.01), axis=1)
    r = fc.first_touch(up, 0.1, 0.1)
    assert r == {"target_first": 1.0, "stop_first": 0.0, "neither": 0.0}
    assert fc.first_touch(-up, 0.1, 0.1)["stop_first"] == 1.0
    assert fc.first_touch(np.zeros((5, 50)), 0.1, 0.1)["neither"] == 1.0


def test_signals_direction():
    rising = np.exp(np.linspace(0, 0.6, 300))
    s = fc.signals(rising, rising)
    assert s["composite"] > 0.35 and s["label"] == "TÍCH CỰC"
    assert fc.signals(rising[::-1], rising[::-1])["composite"] < -0.35


def test_walk_forward_is_calibrated_on_garch_data():
    prices = 50_000 * np.exp(np.cumsum(_garch_series(900, seed=5)))
    v = fc.walk_forward(prices, None, horizon=21, test_sessions=400, step=5)
    assert v["origins"] >= 60
    assert 65 <= v["interval80_coverage_pct"] <= 95, v
    assert v["naive_hit_rate_pct"] >= 50 and v["naive_hit_rate_pct"] >= v["always_up_hit_rate_pct"]


def test_forecast_ticker_output():
    prices = list(40_000 * np.exp(np.cumsum(_garch_series(800, seed=9))))
    r = fc.forecast_ticker(prices, None, {"breakeven": prices[-1] * 1.08, "target": prices[-1] * 1.1, "stop_loss": prices[-1] * 0.93})
    json.dumps(r)  # plain Python types only
    b = r["bands"]["1 tháng"]
    assert b["p5"] < b["p25"] < b["p50"] < b["p75"] < b["p95"]
    assert r["bands"]["6 tháng"]["p95"] - r["bands"]["6 tháng"]["p5"] > b["p95"] - b["p5"], "wider with horizon"
    pb = list(r["prob_breakeven"].values())
    assert pb == sorted(pb)
    t = r["target_vs_stop_3m"]
    assert abs(t["target_first"] + t["stop_first"] + t["neither"] - 100) < 0.2
    assert 0 < r["risk"]["var95_1d_pct"] < r["risk"]["var95_1m_pct"] < r["risk"]["es95_1m_pct"]
    assert fc.forecast_ticker(prices[:100]) is None


def main():
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"✓ {name}")
    print("\n✅ All forecast tests passed!")


if __name__ == "__main__":
    main()
