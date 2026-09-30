"""
Portfolio insights on top of the TCBS snapshot:

- trade journal: TCBS only returns *today's* matched trades, so every sync appends them to
  runtime/tcbs_journal.json; realized P&L, win rate and holding time come from that history.
- benchmark vs VN-Index: beta/correlation per stock and for the portfolio, relative returns.
- sector exposure, analyst targets and dividends per share (Vietcap company profile).
- corporate-action calendar from official disclosures.

Pure functions take pre-fetched data so they are testable offline; fetch_* do the network part.
"""

import math
import os
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import tcbs_account as ta
from portfolio_plan import fee_config

JOURNAL_FILE = os.path.join(ta.RUNTIME_DIR, "tcbs_journal.json")
BENCHMARK_WINDOWS = {"1 tháng": 21, "3 tháng": 63, "6 tháng": 125, "12 tháng": 250}
SECTOR_CAP_PCT = 40
CORP_KEYWORDS = ("cổ tức", "chốt quyền", "ngày đăng ký cuối cùng", "không hưởng quyền", "gdkhq",
                 "đại hội", "đhđcđ", "phát hành", "tăng vốn", "thưởng cổ phiếu", "chia tách", "niêm yết bổ sung")


# ---------- trade journal ----------

TRADE_TAGS = ("Breakout / vượt đỉnh", "Mua hỗ trợ / bắt đáy", "Tin tức / sự kiện", "Cơ bản / định giá",
              "Theo khuyến nghị", "Cảm tính / FOMO", "Cắt lỗ theo kế hoạch", "Chốt lời theo kế hoạch", "Khác")


def load_journal() -> Dict[str, Any]:
    j = ta._read_json(JOURNAL_FILE) or {}
    j.setdefault("trades", {})
    j.setdefault("last_cost", {})
    j.setdefault("notes", {})
    j.setdefault("plans", {})
    return j


def add_plan(plan: Dict[str, Any]) -> Dict[str, Any]:
    """Save a checked trade idea; the next journaled buy of that ticker inherits its reason and note."""
    journal = load_journal()
    if plan.get("reason") and plan["reason"] not in TRADE_TAGS:
        raise ValueError("Nhãn lý do không hợp lệ.")
    pid = f"{plan['date']}:{plan['ticker']}:{len(journal['plans']) + 1}"
    journal["plans"][pid] = {**plan, "used_by": None}
    ta._write_private(JOURNAL_FILE, journal)
    return {"id": pid, **journal["plans"][pid]}


def set_note(key: str, tag: Optional[str], note: str) -> Dict[str, Any]:
    """Attach a reason tag and a free-text note to a journaled trade."""
    journal = load_journal()
    if key not in journal["trades"]:
        raise KeyError("Không tìm thấy giao dịch trong nhật ký.")
    if tag and tag not in TRADE_TAGS:
        raise ValueError("Nhãn lý do không hợp lệ.")
    note = (note or "").strip()[:300]
    if tag or note:
        journal["notes"][key] = {"tag": tag or None, "note": note}
    else:
        journal["notes"].pop(key, None)
    ta._write_private(JOURNAL_FILE, journal)
    return journal["notes"].get(key, {})


def merge_trades(journal: Dict[str, Any], snapshot: Dict[str, Any]) -> int:
    """Add the snapshot's matched trades to the journal; returns how many were new.

    A sell's cost basis is the average cost at that moment: TCBS's cost price (unchanged by a
    sell under the average-cost method) or, when the position is now closed, the last cost seen.
    """
    day = (snapshot.get("synced_at") or datetime.now().isoformat())[:10]
    current_cost: Dict[str, float] = {}
    for acct in snapshot.get("accounts", []):
        for s in ta._rows(acct.get("assets"), "stock"):
            if ta._num(s.get("totalQtty")) > 0 and ta._num(s.get("costPrice")) > 0:
                current_cost[(s.get("symbol") or "").upper()] = ta._vnd(ta._num(s.get("costPrice")))

    added = 0
    for acct in snapshot.get("accounts", []):
        for m in ta._rows(acct.get("matches")):
            ticker = (m.get("symbol") or "").upper()
            key = f"{day}:{m.get('orderId')}:{m.get('tradeId')}"
            if not ticker or key in journal["trades"]:
                continue
            side = "B" if (m.get("side") or "").upper().startswith("B") else "S"
            trade = {"date": day, "time": str(m.get("timeExec") or ""), "ticker": ticker, "side": side,
                     "qty": ta._num(m.get("qtty")), "price": ta._vnd(ta._num(m.get("price")))}
            if side == "S":
                trade["cost_basis"] = current_cost.get(ticker) or journal["last_cost"].get(ticker)
            journal["trades"][key] = trade
            added += 1
            if side == "B" and key not in journal.get("notes", {}):
                _apply_plan(journal, key, trade)
    journal["last_cost"].update(current_cost)
    return added


def _apply_plan(journal: Dict[str, Any], key: str, trade: Dict[str, Any]) -> None:
    """Link a buy to the most recent unused plan for the ticker made within the last 14 days."""
    day = datetime.fromisoformat(trade["date"])
    candidates = [(pid, p) for pid, p in journal.get("plans", {}).items()
                  if p["ticker"] == trade["ticker"] and not p.get("used_by")
                  and 0 <= (day - datetime.fromisoformat(p["date"])).days <= 14]
    if not candidates:
        return
    pid, plan = max(candidates, key=lambda kv: kv[1]["date"])
    plan["used_by"] = key
    journal.setdefault("notes", {})[key] = {"tag": plan.get("reason"), "note": (plan.get("note") or "")[:300],
                                            "plan": {k: plan.get(k) for k in ("price", "stop", "target", "verdict")}}


def update_journal(snapshot: Dict[str, Any]) -> int:
    journal = load_journal()
    added = merge_trades(journal, snapshot)
    journal["updated_at"] = snapshot.get("synced_at")
    ta._write_private(JOURNAL_FILE, journal)
    return added


def journal_stats(journal: Dict[str, Any]) -> Dict[str, Any]:
    """Realized P&L (after sell fee + tax), win rate, profit factor and FIFO holding time."""
    fees = fee_config()
    keep = 1 - fees["sell_fee"] - fees["sell_tax"]
    notes = journal.get("notes", {})
    keyed = sorted(journal.get("trades", {}).items(), key=lambda kv: (kv[1]["date"], kv[1].get("time", "")))
    trades = [t for _, t in keyed]
    last_tag: Dict[str, str] = {}              # ticker -> latest tagged buy's reason
    by_tag: Dict[str, List[float]] = {}
    lots: Dict[str, List[List[Any]]] = {}      # ticker -> FIFO [qty, date] of journaled buys
    per_ticker: Dict[str, Dict[str, float]] = {}
    monthly: Dict[str, float] = {}
    closed: List[Dict[str, Any]] = []
    hold_days: List[Tuple[float, float]] = []   # (days, qty)
    unknown_basis = 0

    for key, t in keyed:
        tag = (notes.get(key) or {}).get("tag")
        if t["side"] == "B":
            lots.setdefault(t["ticker"], []).append([t["qty"], t["date"]])
            if tag:
                last_tag[t["ticker"]] = tag
            continue
        basis = t.get("cost_basis")
        if not basis:
            unknown_basis += 1
            continue
        pnl = t["qty"] * (t["price"] * keep - basis)
        pct = (t["price"] * keep / basis - 1) * 100
        # A sell is judged by why the position was opened, unless the sell itself carries a reason.
        reason = last_tag.get(t["ticker"]) or tag
        if reason:
            by_tag.setdefault(reason, []).append(pct)
        closed.append({"key": key, "date": t["date"], "ticker": t["ticker"], "qty": int(t["qty"]), "price": round(t["price"]),
                       "cost_basis": round(basis), "pnl": round(pnl), "pnl_pct": round(pct, 2), "reason": reason})
        pt = per_ticker.setdefault(t["ticker"], {"ticker": t["ticker"], "pnl": 0.0, "sells": 0})
        pt["pnl"] += pnl
        pt["sells"] += 1
        monthly[t["date"][:7]] = monthly.get(t["date"][:7], 0.0) + pnl
        remaining = t["qty"]
        sell_days: List[Tuple[float, float]] = []
        for lot in lots.get(t["ticker"], []):
            if remaining <= 0:
                break
            take = min(lot[0], remaining)
            if take > 0:
                days = (datetime.fromisoformat(t["date"]) - datetime.fromisoformat(lot[1])).days
                hold_days.append((days, take))
                sell_days.append((days, take))
                lot[0] -= take
                remaining -= take
        if sell_days:
            closed[-1]["hold_days"] = sum(d * q for d, q in sell_days) / sum(q for _, q in sell_days)

    behavior = trading_behavior(trades, closed, fees)
    for c in closed:
        c.pop("hold_days", None)
    wins = [c for c in closed if c["pnl"] > 0]
    losses = [c for c in closed if c["pnl"] <= 0]
    gross_win = sum(c["pnl"] for c in wins)
    gross_loss = -sum(c["pnl"] for c in losses)
    held_qty = sum(q for _, q in hold_days)
    return {
        "since": trades[0]["date"] if trades else None,
        "trade_count": len(trades),
        "buys": sum(1 for t in trades if t["side"] == "B"),
        "sells": sum(1 for t in trades if t["side"] == "S"),
        "realized_pnl": round(gross_win - gross_loss),
        "win_rate_pct": round(len(wins) / len(closed) * 100, 1) if closed else None,
        "avg_win_pct": round(sum(c["pnl_pct"] for c in wins) / len(wins), 2) if wins else None,
        "avg_loss_pct": round(sum(c["pnl_pct"] for c in losses) / len(losses), 2) if losses else None,
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
        "avg_holding_days": round(sum(d * q for d, q in hold_days) / held_qty, 1) if held_qty else None,
        "by_ticker": sorted(({**v, "pnl": round(v["pnl"])} for v in per_ticker.values()), key=lambda x: x["pnl"]),
        "monthly": [{"month": k, "pnl": round(v)} for k, v in sorted(monthly.items())],
        "recent_closed": closed[-10:][::-1],
        "unknown_basis_sells": unknown_basis,
        "by_reason": sorted(({"reason": k, "closed": len(v), "win_rate_pct": round(sum(1 for x in v if x > 0) / len(v) * 100, 1),
                              "avg_pnl_pct": round(sum(v) / len(v), 2)} for k, v in by_tag.items()), key=lambda r: -r["avg_pnl_pct"]),
        "recent_trades": [{"key": k, **{f: t[f] for f in ("date", "ticker", "side", "qty", "price")},
                           "qty": int(t["qty"]), "price": round(t["price"]), **(notes.get(k) or {})} for k, t in keyed[-30:][::-1]],
        "tags": list(TRADE_TAGS),
        "behavior": behavior,
    }


def trading_behavior(trades: List[Dict[str, Any]], closed: List[Dict[str, Any]], fees: Dict[str, float]) -> Dict[str, Any]:
    """Common behavioural leaks, measured from the journal.

    - disposition effect: losers held longer than winners (Shefrin & Statman 1985).
    - overtrading: trades per month and what fees + tax cost relative to gains.
    - revenge trading: buying a ticker back within 5 days of selling it at a loss.
    """
    def avg_days(rows: List[Dict[str, Any]]) -> Optional[float]:
        d = [c["hold_days"] for c in rows if c.get("hold_days") is not None]
        return round(sum(d) / len(d), 1) if d else None

    win_days = avg_days([c for c in closed if c["pnl"] > 0])
    loss_days = avg_days([c for c in closed if c["pnl"] <= 0])
    cost = sum(t["qty"] * t["price"] * (0.001 if t["side"] == "B" else fees["sell_fee"] + fees["sell_tax"]) for t in trades)
    gross_win = sum(c["pnl"] for c in closed if c["pnl"] > 0)
    months = 1.0
    if trades:
        span = (datetime.fromisoformat(trades[-1]["date"]) - datetime.fromisoformat(trades[0]["date"])).days
        months = max(1.0, span / 30.4)
    losing_sells = [(c["ticker"], datetime.fromisoformat(c["date"])) for c in closed if c["pnl"] < 0]
    revenge = sorted({t["ticker"] for t in trades if t["side"] == "B" and any(
        tk == t["ticker"] and 0 <= (datetime.fromisoformat(t["date"]) - d).days <= 5 for tk, d in losing_sells)})
    notes = []
    if win_days is not None and loss_days is not None and loss_days > win_days * 1.5:
        notes.append(f"Bạn giữ mã lỗ trung bình {loss_days} ngày, lâu hơn nhiều so với mã lãi ({win_days} ngày) — dấu hiệu \"gồng lỗ, chốt non\".")
    per_month = round(len(trades) / months, 1)
    if per_month > 20:
        notes.append(f"{per_month} lệnh/tháng — tần suất cao, phí và thuế đang ăn vào lợi nhuận.")
    if gross_win > 0 and cost / gross_win > 0.25:
        notes.append(f"Phí + thuế ≈ {cost / gross_win * 100:.0f}% tổng tiền lãi các lệnh thắng.")
    if revenge:
        notes.append(f"Mua lại ngay sau khi cắt lỗ (≤5 ngày): {', '.join(revenge)} — dễ là giao dịch trả thù.")
    return {"winner_hold_days": win_days, "loser_hold_days": loss_days, "trades_per_month": per_month,
            "fees_paid": round(cost), "fees_vs_gains_pct": round(cost / gross_win * 100, 1) if gross_win > 0 else None,
            "revenge_tickers": revenge, "notes": notes}


# ---------- benchmark ----------

def _log_returns(series: Dict[str, float], dates: List[str]) -> List[float]:
    return [math.log(series[b] / series[a]) for a, b in zip(dates, dates[1:])]


def beta_corr(asset: List[float], bench: List[float]) -> Tuple[Optional[float], Optional[float]]:
    n = min(len(asset), len(bench))
    if n < 30:
        return None, None
    a, b = asset[-n:], bench[-n:]
    ma, mb = sum(a) / n, sum(b) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (n - 1)
    va = sum((x - ma) ** 2 for x in a) / (n - 1)
    vb = sum((y - mb) ** 2 for y in b) / (n - 1)
    if vb <= 0 or va <= 0:
        return None, None
    return round(cov / vb, 2), round(cov / math.sqrt(va * vb), 2)


def benchmark(holdings: List[Dict[str, Any]], market: Dict[str, Dict[str, Any]],
              index_closes: List[Tuple[str, float]], nav: float) -> Dict[str, Any]:
    """Beta/correlation per stock vs VN-Index, and today's portfolio replayed against the index."""
    idx = {d: c for d, c in index_closes if c}
    per_stock = []
    for h in holdings:
        s = {d: c for d, c in market.get(h["ticker"], {}).get("closes") or [] if c}
        dates = sorted(set(s) & set(idx))
        beta, corr = beta_corr(_log_returns(s, dates), _log_returns(idx, dates)) if len(dates) > 30 else (None, None)
        per_stock.append({"ticker": h["ticker"], "beta": beta, "correlation": corr, "weight_pct": h["weight_pct"]})

    betas = [(p["beta"], p["weight_pct"] / 100) for p in per_stock if p["beta"] is not None]
    port_beta = round(sum(b * w for b, w in betas), 2) if betas else None

    # Constant-weight replay of the current holdings (cash flat) vs the index over each window.
    series = {h["ticker"]: {d: c for d, c in market.get(h["ticker"], {}).get("closes") or [] if c} for h in holdings}
    common = sorted(set(idx).intersection(*(set(v) for v in series.values()))) if series else []
    windows = []
    for label, n in BENCHMARK_WINDOWS.items():
        if len(common) <= n:
            continue
        start, end = common[-1 - n], common[-1]
        port = sum(h["market_value"] / nav * (series[h["ticker"]][end] / series[h["ticker"]][start] - 1)
                   for h in holdings) * 100 if nav else 0.0
        index_ret = (idx[end] / idx[start] - 1) * 100
        windows.append({"window": label, "portfolio_pct": round(port, 2), "vnindex_pct": round(index_ret, 2),
                        "excess_pct": round(port - index_ret, 2)})
    return {"portfolio_beta": port_beta, "stocks": per_stock, "windows": windows}


# ---------- sectors, analysts, dividends ----------

def sector_exposure(holdings: List[Dict[str, Any]], companies: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    groups: Dict[str, Dict[str, Any]] = {}
    for h in holdings:
        name = (companies.get(h["ticker"]) or {}).get("sectorVn") or "Chưa phân loại"
        g = groups.setdefault(name, {"sector": name, "weight_pct": 0.0, "tickers": []})
        g["weight_pct"] += h["weight_pct"]
        g["tickers"].append(h["ticker"])
    rows = sorted(({**g, "weight_pct": round(g["weight_pct"], 2)} for g in groups.values()), key=lambda g: -g["weight_pct"])
    flags = [f"Ngành {g['sector']} chiếm {g['weight_pct']}% tài sản ({', '.join(g['tickers'])}) — các mã cùng ngành thường giảm cùng lúc."
             for g in rows if g["weight_pct"] > SECTOR_CAP_PCT and g["sector"] != "Chưa phân loại"]
    return {"sectors": rows, "flags": flags}


def analyst_view(holdings: List[Dict[str, Any]], companies: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    rows, income = [], 0.0
    for h in holdings:
        c = companies.get(h["ticker"]) or {}
        target = c.get("targetPrice") or None
        dps = c.get("dividendPerShareTsr") or None
        if dps:
            income += dps * h["quantity"]
        rows.append({
            "ticker": h["ticker"], "rating": c.get("rating"), "target_price": round(target) if target else None,
            "upside_pct": round((target / h["price"] - 1) * 100, 1) if target and h["price"] else None,
            "vs_cost_pct": round((target / h["avg_cost"] - 1) * 100, 1) if target and h["avg_cost"] else None,
            "dividend_per_share": round(dps) if dps else None,
            "dividend_yield_on_cost_pct": round(dps / h["avg_cost"] * 100, 2) if dps and h["avg_cost"] else None,
        })
    return {"rows": rows, "dividend_income_annual": round(income) if income else None}


def corporate_events(news: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    out = []
    for ticker, items in news.items():
        for n in items:
            title = (n.get("newsTitle") or "").strip()
            low = title.lower()
            if not title or not any(k in low for k in CORP_KEYWORDS):
                continue
            kind = ("CỔ TỨC" if "cổ tức" in low else "CHỐT QUYỀN" if ("đăng ký cuối cùng" in low or "quyền" in low)
                    else "ĐẠI HỘI" if ("đại hội" in low or "đhđcđ" in low) else "PHÁT HÀNH")
            out.append({"ticker": ticker, "date": (n.get("publicDate") or "")[:10], "type": kind, "title": title})
    return sorted(out, key=lambda e: e["date"], reverse=True)[:20]


# ---------- assembly ----------

def build_insights(analysis: Dict[str, Any], market: Dict[str, Dict[str, Any]], index_closes: List[Tuple[str, float]],
                   companies: Dict[str, Dict[str, Any]], news: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    holdings, nav = analysis["holdings"], analysis["summary"]["nav"]
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "benchmark": benchmark(holdings, market, index_closes, nav),
        "sectors": sector_exposure(holdings, companies),
        "analysts": analyst_view(holdings, companies),
        "events": corporate_events(news),
        "journal": journal_stats(load_journal()),
    }


def fetch_insight_data(tickers: List[str]) -> Tuple[List[Tuple[str, float]], Dict[str, Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
    api_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "api"))
    if api_dir not in sys.path:
        sys.path.append(api_dir)  # append: api/agents.py must not shadow the backend agents package
    from datetime import timedelta
    from history import get_history
    import _vci

    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=380)).strftime("%Y-%m-%d")
    bars = (get_history("VNINDEX", start, end) or {}).get("data") or []
    index_closes = [(b.get("tradingDate", ""), float(b["close"])) for b in bars if b.get("close")]
    from concurrent.futures import ThreadPoolExecutor

    from company_cache import cached_profiles
    profiles = cached_profiles(tickers)     # database first; Vietcap only for what it lacks

    def one(t: str) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        info = profiles.get(t)
        if info is None:
            try:
                info = _vci.company_info(t) or {}
            except Exception:
                info = {}
        try:
            items = _vci.company_news(t, days=120, size=20)
        except Exception:
            items = []
        return info, items

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = dict(zip(tickers, pool.map(one, tickers)))
    return index_closes, {t: r[0] for t, r in results.items()}, {t: r[1] for t, r in results.items()}
