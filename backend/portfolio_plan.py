"""
Portfolio plan built on the real TCBS holdings: break-even after fees/tax, odds of getting back
to break-even, growth scenarios, averaging-down maths, per-position actions and rebalancing.

Statistics model: daily log returns over the last ~250 sessions -> drift mu and volatility sigma,
treated as geometric Brownian motion. The historical drift is shrunk halfway to zero because one
year of returns badly overstates what comes next. Everything here is an estimate, not a forecast.

All prices are VND. The pure functions (build_plan and helpers) take pre-fetched market data so
they can be tested offline; fetch_market_data does the network part.
"""

import math
import os
import random
import sys
from datetime import datetime, timedelta
from statistics import NormalDist
from typing import Any, Dict, List, Optional, Tuple

SESSIONS_PER_YEAR = 250
HORIZONS = {"3 tháng": 63, "6 tháng": 125, "12 tháng": 250}
DRIFT_SHRINK = 0.5
LOT = 100
MAX_WEIGHT = 0.25      # single-position cap used for rebalancing
CASH_RESERVE = 0.15    # cash kept aside before suggesting new buys
_N = NormalDist()


def _env_rate(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def fee_config() -> Dict[str, float]:
    """Sell-side costs. TCBS's cost price already includes the buy fee, so only selling costs remain.
    Override per account with TCBS_SELL_FEE / TCBS_SELL_TAX (fractions, e.g. 0.001 = 0.1%)."""
    return {"sell_fee": _env_rate("TCBS_SELL_FEE", 0.001), "sell_tax": _env_rate("TCBS_SELL_TAX", 0.001)}


# ---------- statistics ----------

def return_stats(closes: List[float]) -> Optional[Dict[str, float]]:
    """Daily log-return drift (shrunk) and volatility from closing prices."""
    closes = [c for c in closes if c and c > 0]
    if len(closes) < 40:
        return None
    rets = [math.log(b / a) for a, b in zip(closes, closes[1:])]
    n = len(rets)
    mean = sum(rets) / n
    var = sum((r - mean) ** 2 for r in rets) / (n - 1)
    sigma = math.sqrt(var)
    return {"mu": mean * DRIFT_SHRINK, "sigma": sigma, "mu_raw": mean, "sessions": n}


def hit_probability(gap: float, mu: float, sigma: float, sessions: int) -> float:
    """P(price touches a level `gap` log-units above today within `sessions`), Brownian motion with drift.
    First-passage formula: Φ((μT−a)/σ√T) + e^(2μa/σ²)·Φ((−a−μT)/σ√T)."""
    if gap <= 0:
        return 1.0
    if sigma <= 0:
        return 1.0 if mu * sessions >= gap else 0.0
    sd = sigma * math.sqrt(sessions)
    first = _N.cdf((mu * sessions - gap) / sd)
    expo = 2 * mu * gap / (sigma * sigma)
    second = math.exp(min(expo, 50)) * _N.cdf((-gap - mu * sessions) / sd) if expo > -50 else 0.0
    return max(0.0, min(1.0, first + second))


def price_bands(price: float, mu: float, sigma: float, sessions: int) -> Dict[str, float]:
    """10th / 50th / 90th percentile of the price after `sessions` (log-normal)."""
    drift = (mu - sigma * sigma / 2) * sessions
    sd = sigma * math.sqrt(sessions)
    z = _N.inv_cdf(0.9)
    return {"p10": price * math.exp(drift - z * sd), "p50": price * math.exp(drift), "p90": price * math.exp(drift + z * sd)}


def expected_sessions(gap: float, mu: float) -> Optional[int]:
    """Sessions for the drift alone to cover the gap; None when the trend points the wrong way."""
    if gap <= 0:
        return 0
    return math.ceil(gap / mu) if mu > 0 else None


# ---------- per-position maths ----------

def breakeven_price(avg_cost: float, fees: Dict[str, float]) -> float:
    return avg_cost / (1 - fees["sell_fee"] - fees["sell_tax"])


def average_down(qty: float, avg_cost: float, price: float, target_gap: float, fees: Dict[str, float]) -> Optional[Dict[str, Any]]:
    """Shares to buy at `price` so the new break-even sits only `target_gap` above it.

    new_avg = (q·c + n·p)/(q + n) and break-even = new_avg/(1 − s) = p·(1 + g)
    -> n = q·(c − k)/(k − p) with k = p·(1 + g)·(1 − s).
    """
    keep = 1 - fees["sell_fee"] - fees["sell_tax"]
    k = price * (1 + target_gap) * keep
    if avg_cost <= k:
        return None  # already within the target gap
    if k <= price:
        return None  # target unreachable: fees alone exceed the gap
    n = qty * (avg_cost - k) / (k - price)
    n = math.ceil(n / LOT) * LOT
    new_avg = (qty * avg_cost + n * price) / (qty + n)
    return {"shares": int(n), "cost": round(n * price), "new_avg_cost": round(new_avg),
            "new_breakeven": round(new_avg / keep), "new_gap_pct": round((new_avg / keep / price - 1) * 100, 2)}


def _trend(tech: Dict[str, Any]) -> str:
    price, s20, s50 = tech.get("price"), tech.get("sma20"), tech.get("sma50")
    if not (price and s20 and s50):
        return "unknown"
    if price > s20 > s50:
        return "up"
    if price < s20 < s50:
        return "down"
    return "sideways"


def _round_tick(price: float) -> int:
    """Round to a 100 đ grid: valid on HOSE for prices from 10,000 đ, and on HNX/UPCoM."""
    return int(round(price / 100) * 100)


def position_action(h: Dict[str, Any], tech: Dict[str, Any], weight: float) -> Dict[str, Any]:
    """Rule-based action with stop-loss and target levels for one holding."""
    pnl, price, trend = h["pnl_pct"], h["price"], _trend(tech)
    rsi = tech.get("rsi14")
    low20, high20, high52 = tech.get("low_20d"), tech.get("high_20d"), tech.get("high_52w")
    reasons: List[str] = []

    if pnl <= -7 and trend == "down":
        action, reasons = "CẮT LỖ / HẠ TỶ TRỌNG", [f"lỗ {pnl}% và giá dưới MA20 < MA50 (xu hướng giảm)"]
    elif pnl <= -7:
        action, reasons = "GIỮ CÓ ĐIỀU KIỆN", [f"lỗ {pnl}% nhưng xu hướng chưa giảm rõ — thủng đáy 20 phiên thì cắt"]
    elif pnl >= 20 and rsi is not None and rsi >= 70:
        action, reasons = "CHỐT LỜI 1/3", [f"lãi {pnl}% và RSI {rsi} quá mua"]
    elif pnl > 0 and trend == "up":
        action, reasons = "GIỮ, NÂNG STOP", [f"lãi {pnl}%, xu hướng tăng (giá > MA20 > MA50)"]
    elif trend == "down":
        action, reasons = "THẬN TRỌNG", ["xu hướng giảm — không mua thêm"]
    else:
        action, reasons = "GIỮ", ["chưa có tín hiệu rõ ràng"]
    if weight > MAX_WEIGHT * 100 + 5:
        reasons.append(f"tỷ trọng {weight:.1f}% vượt trần {int(MAX_WEIGHT * 100)}%")

    # Trailing stop: protect profits above cost; otherwise under the 20-session low.
    if pnl > 0 and tech.get("sma20"):
        stop = max(tech["sma20"] * 0.98, h["avg_cost"])
    elif low20:
        stop = low20 * 0.98
    else:
        stop = price * 0.93
    target = next((t for t in (high20, high52) if t and t > price * 1.03), price * 1.1)
    rr = (target - price) / (price - stop) if price > stop else None
    return {"action": action, "reasons": reasons, "trend": trend, "stop_loss": _round_tick(stop),
            "target": _round_tick(target), "risk_reward": round(rr, 2) if rr else None}


# ---------- portfolio model ----------

def portfolio_series(holdings: List[Dict[str, Any]], market: Dict[str, Dict[str, Any]], cash: float) -> Optional[Dict[str, float]]:
    """Drift/vol of today's portfolio replayed over past dates (constant weights, cash at 0%)."""
    nav = sum(h["market_value"] for h in holdings) + cash
    if nav <= 0:
        return None
    series = {}
    for h in holdings:
        rows = market.get(h["ticker"], {}).get("closes") or []
        series[h["ticker"]] = {d: c for d, c in rows}
    common = sorted(set.intersection(*(set(s) for s in series.values()))) if series else []
    if len(common) < 40:
        return None
    rets = []
    for a, b in zip(common, common[1:]):
        r = sum(h["market_value"] / nav * (series[h["ticker"]][b] / series[h["ticker"]][a] - 1) for h in holdings)
        rets.append(math.log1p(r))
    n = len(rets)
    mean = sum(rets) / n
    sigma = math.sqrt(sum((r - mean) ** 2 for r in rets) / (n - 1))
    return {"mu": mean * DRIFT_SHRINK, "sigma": sigma, "sessions": n}


def goal_probability(nav: float, goal_pct: float, months: int, model: Dict[str, float]) -> Dict[str, Any]:
    """Odds that NAV is at least `goal_pct` higher after `months` (no new deposits)."""
    sessions = max(1, round(months * SESSIONS_PER_YEAR / 12))
    target = nav * (1 + goal_pct / 100)
    drift = (model["mu"] - model["sigma"] ** 2 / 2) * sessions
    sd = model["sigma"] * math.sqrt(sessions)
    prob = 1 - _N.cdf((math.log(target / nav) - drift) / sd) if sd > 0 else float(drift >= math.log(target / nav))
    required_annual = ((1 + goal_pct / 100) ** (12 / months) - 1) * 100
    return {"goal_pct": goal_pct, "months": months, "target_nav": round(target),
            "probability_pct": round(prob * 100, 1), "required_annual_pct": round(required_annual, 1)}


def rebalance_plan(holdings: List[Dict[str, Any]], nav: float, cash: float, actions: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Trim positions above the cap, then say how much cash can be deployed and where."""
    trims = []
    freed = 0.0
    for h in holdings:
        excess = h["market_value"] - MAX_WEIGHT * nav
        if excess > 0 and h["price"]:
            shares = min(math.floor(excess / h["price"] / LOT) * LOT, math.floor(h["sellable"] / LOT) * LOT)
            if shares > 0:
                trims.append({"ticker": h["ticker"], "sell_shares": shares, "value": round(shares * h["price"]),
                              "note": f"đưa tỷ trọng về ~{int(MAX_WEIGHT * 100)}%"})
                freed += shares * h["price"]
    deployable = max(0.0, cash + freed - CASH_RESERVE * nav)
    candidates = [h["ticker"] for h in holdings
                  if actions.get(h["ticker"], {}).get("trend") == "up" and h["weight_pct"] < MAX_WEIGHT * 100 - 5]
    return {"trims": trims, "cash_after_trims": round(cash + freed), "reserve": round(CASH_RESERVE * nav),
            "deployable": round(deployable), "add_candidates": candidates}


# ---------- DCA Monte Carlo ----------

def dca_simulation(nav: float, monthly: float, months: int, goal_pct: float, mu_d: float, sigma_d: float,
                   paths: int = 4000, seed: int = 7) -> Dict[str, Any]:
    """Monthly GBM steps with a deposit at each month end. Goal = final NAV ≥ (NAV + deposits)·(1 + goal%).

    Deposits are invested at the portfolio's own risk/return profile. Seeded, so results are stable.
    """
    rng = random.Random(seed)
    steps = 21  # sessions per month
    m_mu = (mu_d - sigma_d * sigma_d / 2) * steps
    m_sd = sigma_d * math.sqrt(steps)
    contributed = monthly * months
    target = (nav + contributed) * (1 + goal_pct / 100)
    finals = []
    for _ in range(paths):
        v = nav
        for _m in range(months):
            v = v * math.exp(m_mu + m_sd * rng.gauss(0, 1)) + monthly
        finals.append(v)
    finals.sort()
    pick = lambda q: finals[min(len(finals) - 1, int(q * len(finals)))]  # noqa: E731
    return {
        "monthly": round(monthly), "months": months, "contributed": round(contributed), "target_nav": round(target),
        "probability_pct": round(sum(1 for f in finals if f >= target) / paths * 100, 1),
        "p10": round(pick(0.1)), "p50": round(pick(0.5)), "p90": round(pick(0.9)),
        "median_profit": round(pick(0.5) - nav - contributed),
    }


# ---------- assembly ----------

def build_plan(analysis: Dict[str, Any], market: Dict[str, Dict[str, Any]],
               goal_pct: float = 20.0, goal_months: int = 12, monthly: float = 0.0) -> Dict[str, Any]:
    fees = fee_config()
    holdings = analysis["holdings"]
    cash = analysis["summary"]["cash"]
    nav = analysis["summary"]["nav"]
    positions, actions = [], {}
    dividend_income = 0.0
    dividend_known = False

    for h in holdings:
        m = market.get(h["ticker"], {})
        tech = m.get("tech") or {}
        stats = return_stats([c for _, c in m.get("closes") or []])
        be = breakeven_price(h["avg_cost"], fees) if h["avg_cost"] else 0.0
        gap = math.log(be / h["price"]) if be and h["price"] else 0.0
        entry: Dict[str, Any] = {
            "ticker": h["ticker"], "quantity": h["quantity"], "avg_cost": h["avg_cost"], "price": h["price"],
            "pnl_pct": h["pnl_pct"], "weight_pct": h["weight_pct"],
            "breakeven": round(be), "gap_to_breakeven_pct": round((math.exp(gap) - 1) * 100, 2) if gap > 0 else 0.0,
            "in_profit_after_costs": gap <= 0,
        }
        if stats:
            mu, sigma = stats["mu"], stats["sigma"]
            entry["volatility_annual_pct"] = round(sigma * math.sqrt(SESSIONS_PER_YEAR) * 100, 1)
            entry["drift_annual_pct"] = round((math.exp(mu * SESSIONS_PER_YEAR) - 1) * 100, 1)
            if gap > 0:
                entry["breakeven_odds"] = {k: round(hit_probability(gap, mu, sigma, s) * 100, 1) for k, s in HORIZONS.items()}
                entry["breakeven_sessions_by_trend"] = expected_sessions(gap, mu)
                entry["average_down"] = average_down(h["quantity"], h["avg_cost"], h["price"], 0.05, fees)
            entry["scenarios"] = {k: {b: round(v) for b, v in price_bands(h["price"], mu, sigma, s).items()}
                                  for k, s in HORIZONS.items()}
        act = position_action(h, tech, h["weight_pct"]) if h["price"] else {}
        actions[h["ticker"]] = act
        entry.update(act)
        avg = entry.get("average_down")
        if avg:
            new_weight = (h["market_value"] + avg["cost"]) / nav * 100 if nav else 0
            ok = act.get("trend") != "down" and new_weight <= MAX_WEIGHT * 100 and avg["cost"] <= cash
            avg["new_weight_pct"] = round(new_weight, 1)
            avg["advisable"] = ok
            avg["why"] = ("khả thi: xu hướng không giảm, đủ tiền, tỷ trọng mới trong trần" if ok else
                          "không nên: " + ", ".join(x for x, bad in (
                              ("xu hướng giảm (bắt dao rơi)", act.get("trend") == "down"),
                              (f"tỷ trọng mới {new_weight:.0f}% vượt trần", new_weight > MAX_WEIGHT * 100),
                              ("không đủ tiền mặt", avg["cost"] > cash)) if bad))
        dy = m.get("dividend_yield")
        if dy:
            dividend_known = True
            dividend_income += h["market_value"] * dy / 100
            entry["dividend_yield_pct"] = dy
        positions.append(entry)

    model = portfolio_series(holdings, market, cash) if holdings else None
    portfolio: Dict[str, Any] = {"nav": nav, "model_available": bool(model)}
    if model:
        portfolio["volatility_annual_pct"] = round(model["sigma"] * math.sqrt(SESSIONS_PER_YEAR) * 100, 1)
        portfolio["drift_annual_pct"] = round((math.exp(model["mu"] * SESSIONS_PER_YEAR) - 1) * 100, 1)
        portfolio["scenarios"] = {k: {b: round(v) for b, v in price_bands(nav, model["mu"], model["sigma"], s).items()}
                                  for k, s in HORIZONS.items()}
        portfolio["goal"] = goal_probability(nav, goal_pct, goal_months, model)
        if monthly > 0:
            portfolio["dca"] = dca_simulation(nav, monthly, goal_months, goal_pct, model["mu"], model["sigma"])
    if dividend_known:
        portfolio["dividend_income_annual"] = round(dividend_income)

    losing = [p for p in positions if not p["in_profit_after_costs"]]
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "assumptions": {
            "sell_fee_pct": fees["sell_fee"] * 100, "sell_tax_pct": fees["sell_tax"] * 100,
            "drift_shrink": DRIFT_SHRINK, "max_weight_pct": MAX_WEIGHT * 100, "cash_reserve_pct": CASH_RESERVE * 100,
        },
        "positions": positions,
        "portfolio": portfolio,
        "rebalance": rebalance_plan(holdings, nav, cash, actions),
        "headline": {
            "losing_positions": len(losing),
            "capital_to_recover": round(sum((p["breakeven"] - p["price"]) * p["quantity"] for p in losing)),
        },
    }


def plan_brief(plan: Dict[str, Any]) -> str:
    """LLM context: percentages, prices and probabilities only (no account ids or absolute wealth)."""
    lines = ["Kế hoạch định lượng cho từng mã (mã | tỷ trọng % | lãi/lỗ % | cần tăng để hòa vốn % | "
             "xác suất hòa vốn 3/6/12 tháng | xu hướng | hành động quy tắc | stop | target):"]
    for p in plan["positions"]:
        odds = p.get("breakeven_odds")
        odds_txt = "/".join(f"{v}%" for v in odds.values()) if odds else "đã có lãi sau phí"
        lines.append(f"- {p['ticker']} | {p['weight_pct']}% | {p['pnl_pct']}% | {p['gap_to_breakeven_pct']}% | {odds_txt} | "
                     f"{p.get('trend', 'N/A')} | {p.get('action', 'N/A')} | {p.get('stop_loss', 0):,} | {p.get('target', 0):,}")
    pf = plan["portfolio"]
    if pf.get("goal"):
        g = pf["goal"]
        lines.append(f"Mục tiêu +{g['goal_pct']}% trong {g['months']} tháng: xác suất ước tính {g['probability_pct']}%, "
                     f"cần lợi nhuận {g['required_annual_pct']}%/năm. Biến động danh mục {pf['volatility_annual_pct']}%/năm.")
    rb = plan["rebalance"]
    if rb["trims"]:
        lines.append("Đề xuất giảm tỷ trọng: " + ", ".join(f"{t['ticker']} bán {t['sell_shares']} cp" for t in rb["trims"]))
    if rb["add_candidates"]:
        lines.append("Mã trong danh mục đang uptrend, còn dư địa tỷ trọng: " + ", ".join(rb["add_candidates"]))
    return "\n".join(lines)


# ---------- network ----------

def fetch_market_data(tickers: List[str]) -> Dict[str, Dict[str, Any]]:
    """~1 year of daily closes (VND), technical indicators and dividend yield per ticker."""
    api_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "api"))
    if api_dir not in sys.path:
        sys.path.append(api_dir)  # append: api/agents.py must not shadow the backend agents package
    from agents.tools import calculate_indicators, _to_vnd  # before api/: its agents.py shadows the package
    from history import get_history
    from finance import get_finance

    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=380)).strftime("%Y-%m-%d")
    out: Dict[str, Dict[str, Any]] = {}
    for t in tickers:
        bars = []
        try:
            bars = (get_history(t, start, end) or {}).get("data") or []
        except Exception:
            pass
        closes: List[Tuple[str, float]] = [(b.get("tradingDate", ""), _to_vnd(float(b["close"])))
                                           for b in bars if b.get("close")]
        dy = None
        try:
            dy = ((get_finance(t) or {}).get("data") or {}).get("dividendYield") or None  # 0 means unknown
        except Exception:
            pass
        out[t] = {"closes": closes, "tech": calculate_indicators(bars) if bars else {}, "dividend_yield": dy}
    return out
