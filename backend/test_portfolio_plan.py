"""
Offline tests for the portfolio plan maths.
Run: python3 backend/test_portfolio_plan.py   (from project root)
"""

import math
import os
import sys
from statistics import NormalDist

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import portfolio_plan as pp  # noqa: E402
import tcbs_account as ta  # noqa: E402
from test_tcbs_account import SNAPSHOT  # noqa: E402

FEES = {"sell_fee": 0.001, "sell_tax": 0.001}


def _series(start: float, daily: float, n: int = 260, wobble: float = 0.01):
    """Deterministic closes: trend `daily` plus an alternating ±wobble so volatility is non-zero."""
    out, price = [], start
    for i in range(n):
        price *= math.exp(daily + (wobble if i % 2 else -wobble))
        out.append((f"2025-{1 + i // 28:02d}-{1 + i % 28:02d}", price))
    return out


def test_breakeven_includes_sell_costs():
    assert round(pp.breakeven_price(100_000, FEES)) == 100_200


def test_average_down_hits_target_gap():
    r = pp.average_down(qty=2000, avg_cost=28_000, price=25_000, target_gap=0.05, fees=FEES)
    assert r["shares"] % 100 == 0
    assert r["new_gap_pct"] <= 5.0, r
    # one lot fewer would miss the target: the answer is the minimum
    n = r["shares"] - 100
    new_avg = (2000 * 28_000 + n * 25_000) / (2000 + n)
    assert (new_avg / 0.998 / 25_000 - 1) * 100 > 5.0
    assert pp.average_down(1000, 100_000, 120_000, 0.05, FEES) is None, "already in profit"


def test_hit_probability_properties():
    assert pp.hit_probability(0, 0.001, 0.02, 60) == 1.0
    p60, p250 = pp.hit_probability(0.1, 0.0, 0.02, 60), pp.hit_probability(0.1, 0.0, 0.02, 250)
    assert 0 < p60 < p250 < 1
    # zero drift reduces to the reflection principle: 2·(1 − Φ(a/σ√T))
    expected = 2 * (1 - NormalDist().cdf(0.1 / (0.02 * math.sqrt(60))))
    assert abs(p60 - expected) < 1e-9
    assert pp.hit_probability(0.1, 0.002, 0.02, 60) > p60 > pp.hit_probability(0.1, -0.002, 0.02, 60)


def test_price_bands_and_expected_sessions():
    b = pp.price_bands(100.0, 0.0005, 0.02, 250)
    assert b["p10"] < b["p50"] < b["p90"]
    assert abs(b["p50"] - 100 * math.exp((0.0005 - 0.0002) * 250)) < 1e-9
    assert pp.expected_sessions(0.1, 0.001) == 100
    assert pp.expected_sessions(0.1, -0.001) is None


def test_goal_probability():
    g = pp.goal_probability(1_000_000, 20, 12, {"mu": 0.0, "sigma": 0.015})
    assert 0 < g["probability_pct"] < 50, "zero drift makes +20% less likely than a coin flip"
    assert g["required_annual_pct"] == 20.0
    assert pp.goal_probability(1_000_000, 20, 6, {"mu": 0.0, "sigma": 0.015})["required_annual_pct"] == 44.0


def test_build_plan_end_to_end():
    analysis = ta.analyze_snapshot(SNAPSHOT)
    market = {
        "FPT": {"closes": _series(90_000, 0.001), "dividend_yield": 2.0,
                "tech": {"price": 120_000, "sma20": 115_000, "sma50": 110_000, "rsi14": 60, "low_20d": 112_000, "high_20d": 125_000}},
        "HPG": {"closes": _series(30_000, -0.0005), "dividend_yield": None,
                "tech": {"price": 25_000, "sma20": 26_000, "sma50": 27_000, "rsi14": 35, "low_20d": 24_500, "high_20d": 27_500}},
    }
    plan = pp.build_plan(analysis, market, goal_pct=20, goal_months=12)
    fpt = next(p for p in plan["positions"] if p["ticker"] == "FPT")
    hpg = next(p for p in plan["positions"] if p["ticker"] == "HPG")
    assert fpt["in_profit_after_costs"] and "breakeven_odds" not in fpt
    assert fpt["action"] == "GIỮ, NÂNG STOP" and fpt["stop_loss"] >= fpt["avg_cost"]
    assert hpg["action"] == "CẮT LỖ / HẠ TỶ TRỌNG" and hpg["trend"] == "down"
    assert hpg["gap_to_breakeven_pct"] > 12
    odds = list(hpg["breakeven_odds"].values())
    assert odds == sorted(odds), "longer horizon -> higher odds"
    assert hpg["average_down"]["advisable"] is False and "xu hướng giảm" in hpg["average_down"]["why"]
    assert plan["portfolio"]["model_available"] and plan["portfolio"]["goal"]["probability_pct"] >= 0
    assert plan["portfolio"]["dividend_income_annual"] == round(180_000_000 * 0.02)
    trims = plan["rebalance"]["trims"]
    assert trims and trims[0]["ticker"] == "FPT" and trims[0]["sell_shares"] % 100 == 0
    assert trims[0]["sell_shares"] <= 1300, "never more than the sellable shares"
    assert plan["headline"]["losing_positions"] == 1

    brief = pp.plan_brief(plan)
    assert "HPG" in brief and "1234567" not in brief


def test_build_plan_without_history():
    analysis = ta.analyze_snapshot(SNAPSHOT)
    plan = pp.build_plan(analysis, {})
    assert not plan["portfolio"]["model_available"]
    assert all("scenarios" not in p for p in plan["positions"])
    assert all(p["breakeven"] > 0 for p in plan["positions"])


def main():
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"✓ {name}")
    print("\n✅ All portfolio plan tests passed!")


if __name__ == "__main__":
    main()
