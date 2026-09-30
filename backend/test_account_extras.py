"""
Offline tests for NAV history, margin, cash calendar, rules, pre-trade checks, trade plans,
behaviour analytics, forecast scoring, advanced construction and alert dedupe.
Run: python3 backend/test_account_extras.py   (from project root)
"""

import copy
import math
import os
import sys
import tempfile
from datetime import date, timedelta

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import forecast_tracking as ft  # noqa: E402
import nav_history as nh  # noqa: E402
import notify  # noqa: E402
import personal_rules as pr  # noqa: E402
import portfolio_advanced as pa  # noqa: E402
import portfolio_insights as pi  # noqa: E402
import pretrade  # noqa: E402
import tcbs_account as ta  # noqa: E402
from test_tcbs_account import SNAPSHOT  # noqa: E402


def _series(start, drift, n=300, vol=0.012, seed=0):
    rng = np.random.default_rng(seed)
    d0 = date(2025, 6, 2)
    px = start * np.exp(np.cumsum(drift + rng.normal(0, vol, n)))
    return [((d0 + timedelta(days=i)).isoformat(), float(p)) for i, p in enumerate(px)]


def test_margin_net_nav_and_call_distance():
    snap = copy.deepcopy(SNAPSHOT)
    snap["accounts"][1]["risk"] = [{"accountNo": "0001234568", "rtt": 60, "outstanding": 20_000_000, "accruedInterest": 0,
                                    "riskPolicy": {"maintenanceMargin": 80, "liquidationMargin": 30}, "riskStatus": {"description": "An toàn"}}]
    a = ta.analyze_snapshot(snap)
    assert a["summary"]["debt"] == 20_000_000 and a["summary"]["nav"] == 260_000_000 - 20_000_000
    m = a["margin"][0]
    assets = 500 * 120_000
    assert m["drop_to_liquidation_pct"] == round((1 - 20e6 / (assets * 0.7)) * 100, 1)
    assert m["drop_to_call_pct"] == 0.0, "already below the 80% maintenance ratio"
    assert any("margin" in f["text"] for f in a["flags"])
    assert "0001234568" not in repr(a)


def test_cash_calendar_t2_skips_weekend():
    snap = copy.deepcopy(SNAPSHOT)
    snap["synced_at"] = "2026-10-01T15:00:00"  # Thursday
    snap["accounts"][0]["matches"]["data"].append({"symbol": "HPG", "side": "S", "qtty": 100, "price": 25000})
    cal = ta.analyze_snapshot(snap)["cash_calendar"]
    sell = next(c for c in cal if c["kind"] == "Tiền bán về")
    assert sell["date"] == "2026-10-05" and sell["amount"] == 2_500_000   # Thu + 2 business days = Mon
    assert any(c["kind"] == "Cổ tức tiền chờ về" for c in cal)


def test_nav_history_twr_ignores_deposits():
    h = {"days": {
        "2026-09-01": {"nav": 100e6, "positions": {"AAA": [1000, 50_000]}},
        "2026-09-02": {"nav": 105e6, "positions": {"AAA": [1000, 55_000]}},     # +5% market move
        "2026-09-03": {"nav": 155e6, "positions": {"AAA": [1000, 55_000]}},     # +50m deposit
        "2026-09-04": {"nav": 150e6, "positions": {"AAA": [1000, 50_000]}},     # −5m market move
    }, "flows": {}}
    m = nh.metrics(h, [("2026-09-01", 1000.0), ("2026-09-04", 1010.0)])
    pts = m["points"]
    assert pts[2]["flow"] == 50_000_000 and pts[2]["flow_estimated"]
    expected = (105 / 100) * (105 / 105) * (150 / 155)
    assert abs(m["stats"]["twr_pct"] - round((expected - 1) * 100, 2)) < 0.01
    assert m["stats"]["vnindex_pct"] == 1.0 and m["stats"]["max_drawdown_pct"] < 0
    h["flows"]["2026-09-03"] = 0.0      # manual override: "that was not a deposit"
    assert nh.metrics(h, [])["points"][2]["flow"] == 0


def test_nav_record_roundtrip():
    with tempfile.TemporaryDirectory() as d:
        nh.HISTORY_FILE = os.path.join(d, "h.json")
        nh.record(ta.analyze_snapshot(SNAPSHOT))
        assert nh.load()["days"]["2026-09-29"]["nav"] == 260_000_000
        nh.set_flow("2026-09-29", 1e6)
        assert nh.load()["flows"]["2026-09-29"] == 1e6
        try:
            nh.set_flow("29/09/2026", 1)
            raise AssertionError("expected ValueError")
        except ValueError:
            pass


def test_personal_rules():
    a = ta.analyze_snapshot(SNAPSHOT)
    a["today_trades"] = [{"ticker": "HPG", "buy_qty": 100}]
    v = pr.evaluate(a, {"FPT": "Công nghệ", "HPG": "Thép"}, {**pr.DEFAULT_RULES, "max_positions": 1})
    rules = {x["rule"] for x in v}
    assert {"max_positions", "max_weight_pct", "max_loss_pct", "max_sector_pct", "no_average_down"} <= rules
    with tempfile.TemporaryDirectory() as d:
        pr.RULES_FILE = os.path.join(d, "r.json")
        assert pr.save_rules({"max_positions": 5})["max_positions"] == 5
        for bad in ({"max_positions": 0}, {"unknown": 1}):
            try:
                pr.save_rules(bad)
                raise AssertionError(f"expected ValueError for {bad}")
            except ValueError:
                pass


def test_pretrade_checks():
    a = ta.analyze_snapshot(SNAPSHOT)
    rules = dict(pr.DEFAULT_RULES)
    closes = {"VNM": _series(60_000, 0.001), "FPT": _series(100_000, 0.0005, seed=1), "HPG": _series(25_000, 0.0, seed=2)}
    ok = pretrade.run_checks(a, rules, "VNM", 60_000, 56_000, 70_000, None, {"sectorVn": "Thực phẩm"}, {}, closes, None, None, [])
    assert ok["sizing"]["shares"] > 0 and ok["sizing"]["risk_pct_nav"] <= 1.0
    names = {c["name"]: c["status"] for c in ok["checks"]}
    assert names["Lợi nhuận / rủi ro"] == "PASS" and names["Tiền mặt"] in ("PASS", "WARN")
    bad = pretrade.run_checks(a, rules, "HPG", 25_000, 24_000, 25_500, 5000, {"sectorVn": "Thép"}, {"HPG": "Thép"}, closes, None, None,
                              [{"newsTitle": "HPG: Thông báo ngày đăng ký cuối cùng trả cổ tức", "publicDate": "2026-09-20"}])
    names = {c["name"]: c["status"] for c in bad["checks"]}
    assert bad["verdict"] == "KHÔNG ĐẠT"
    assert names["Trung bình giá xuống"] == "FAIL" and names["Lợi nhuận / rủi ro"] == "FAIL" and names["Khối lượng"] == "FAIL"
    assert names["Sự kiện"] == "WARN"
    assert pretrade.run_checks(a, rules, "VNM", 60_000, 61_000, None, None, {}, {}, closes, None, None, [])["verdict"] == "KHÔNG ĐẠT"


def test_trade_plan_tags_the_next_buy():
    with tempfile.TemporaryDirectory() as d:
        pi.JOURNAL_FILE = os.path.join(d, "j.json")
        pi.add_plan({"date": "2026-09-28", "ticker": "VNM", "price": 60000, "stop": 56000, "target": 70000,
                     "reason": "Mua hỗ trợ / bắt đáy", "note": "về MA200", "verdict": "ĐẠT"})
        snap = {"synced_at": "2026-09-30T15:00:00", "accounts": [{"accountNo": "1", "assets": {"stock": [{"symbol": "VNM", "totalQtty": 100, "costPrice": 60000}]},
                                                                   "matches": {"data": [{"orderId": "x", "tradeId": "1", "symbol": "VNM", "side": "B", "qtty": 100, "price": 60000}]}}]}
        pi.update_journal(snap)
        j = pi.load_journal()
        note = next(iter(j["notes"].values()))
        assert note["tag"] == "Mua hỗ trợ / bắt đáy" and note["plan"]["verdict"] == "ĐẠT"
        assert next(iter(j["plans"].values()))["used_by"]


def test_behaviour_flags():
    j = {"trades": {}, "last_cost": {}, "notes": {}, "plans": {}}
    snap = lambda day, stock, m: {"synced_at": f"{day}T15:00:00", "accounts": [{"accountNo": "1", "assets": {"stock": stock}, "matches": {"data": m}}]}  # noqa: E731
    pi.merge_trades(j, snap("2026-01-05", [{"symbol": "AAA", "totalQtty": 100, "costPrice": 10000}, {"symbol": "BBB", "totalQtty": 100, "costPrice": 10000}],
                            [{"orderId": "1", "tradeId": "1", "symbol": "AAA", "side": "B", "qtty": 100, "price": 10000},
                             {"orderId": "2", "tradeId": "2", "symbol": "BBB", "side": "B", "qtty": 100, "price": 10000}]))
    pi.merge_trades(j, snap("2026-01-10", [{"symbol": "BBB", "totalQtty": 100, "costPrice": 10000}],
                            [{"orderId": "3", "tradeId": "3", "symbol": "AAA", "side": "S", "qtty": 100, "price": 11000}]))
    pi.merge_trades(j, snap("2026-03-10", [], [{"orderId": "4", "tradeId": "4", "symbol": "BBB", "side": "S", "qtty": 100, "price": 9000}]))
    pi.merge_trades(j, snap("2026-03-12", [{"symbol": "BBB", "totalQtty": 100, "costPrice": 9000}],
                            [{"orderId": "5", "tradeId": "5", "symbol": "BBB", "side": "B", "qtty": 100, "price": 9000}]))
    b = pi.journal_stats(j)["behavior"]
    assert b["winner_hold_days"] == 5.0 and b["loser_hold_days"] == 64.0
    assert b["revenge_tickers"] == ["BBB"]
    assert any("gồng lỗ" in n for n in b["notes"]) and any("trả thù" in n for n in b["notes"])


def test_forecast_scoring():
    log = {"2026-W30:AAA": {"date": "2026-07-20", "ticker": "AAA", "price": 100.0,
                           "band": {"p5": 90, "p25": 97, "p50": 100, "p75": 103, "p95": 110}, "prob_up": 70},
           "2026-W31:AAA": {"date": "2026-07-27", "ticker": "AAA", "price": 100.0,
                           "band": {"p5": 90, "p25": 97, "p50": 100, "p75": 103, "p95": 110}, "prob_up": 70},
           "2026-W39:AAA": {"date": "2026-09-21", "ticker": "AAA", "price": 100.0,
                           "band": {"p5": 90, "p25": 97, "p50": 100, "p75": 103, "p95": 110}, "prob_up": 50}}
    hist = {"AAA": [("2026-08-19", 105.0), ("2026-08-26", 120.0)]}
    s = ft.score(log, hist, today=date(2026, 9, 30))
    assert s["scored"] == 2 and s["pending"] == 1
    assert s["coverage90_pct"] == 50.0 and s["coverage50_pct"] == 0.0
    assert s["brier"] == round((0.7 - 1) ** 2, 4)
    with tempfile.TemporaryDirectory() as d:
        ft.LOG_FILE = os.path.join(d, "l.json")
        f = {"price": 100, "bands": {"1 tháng": {"p5": 1, "p25": 2, "p50": 3, "p75": 4, "p95": 5}}, "prob_up": {"1 tháng": 55}}
        assert ft.log_forecasts({"AAA": f, "BBB": None}, date(2026, 9, 30)) == 1
        assert ft.log_forecasts({"AAA": f}, date(2026, 10, 1)) == 0, "one entry per ticker per ISO week"


def test_correlation_clusters_and_regime():
    base = _series(100, 0.0, seed=3)
    wiggle = np.exp(np.random.default_rng(7).normal(0, 0.003, len(base)))  # same moves plus small independent noise
    twin = [(d, c * w) for (d, c), w in zip(base, wiggle)]
    other = _series(50, 0.0, seed=9)
    c = pa.correlation_clusters(["AAA", "BBB", "CCC"], {"AAA": base, "BBB": twin, "CCC": other})
    assert c["clusters"] == [["AAA", "BBB"]] and c["matrix"][0][1] >= 0.6
    up = [c for _, c in _series(1000, 0.002, n=400, vol=0.008, seed=4)]
    r = pa.market_regime(up, 95)
    assert r["state"] in ("THUẬN LỢI", "TRUNG TÍNH") and r["vs_ma200_pct"] > 0
    down = [c for _, c in _series(1000, -0.003, n=400, vol=0.008, seed=4)]
    assert pa.market_regime(down, 95)["suggested_stock_pct"] <= 65


def test_black_litterman_respects_views_and_cap():
    closes = {t: _series(100, 0.0, seed=s) for t, s in (("AAA", 1), ("BBB", 2), ("CCC", 3), ("DDD", 4), ("EEE", 5))}
    caps = {t: 1.0 for t in closes}
    neutral = pa.black_litterman(list(closes), closes, caps, {}, {})
    bullish = pa.black_litterman(list(closes), closes, caps, {"AAA": 0.4}, {})
    w = lambda r, t: next(x["bl_pct"] for x in r["rows"] if x["ticker"] == t)  # noqa: E731
    assert w(bullish, "AAA") > w(neutral, "AAA")
    assert all(x["bl_pct"] <= 25.05 for x in bullish["rows"]) and abs(sum(x["bl_pct"] for x in bullish["rows"]) - 100) < 0.5


def test_black_litterman_two_names_is_finite():
    closes = {"AAA": _series(100, 0.001, seed=1), "BBB": _series(100, 0.0, seed=2)}
    r = pa.black_litterman(["AAA", "BBB"], closes, {"AAA": 9.0, "BBB": 1.0}, {"AAA": 0.4, "BBB": -0.3}, {})
    ws = [x["bl_pct"] for x in r["rows"]]
    assert all(math.isfinite(w) for w in ws) and abs(sum(ws) - 100) < 0.5 and max(ws) <= 50.05


def test_alternatives_rank_uptrends_and_same_sector():
    holdings = [{"ticker": "AAA", "market_value": 100.0, "pnl_pct": -12}]
    closes = {"AAA": _series(100, -0.002, seed=1), "UP1": _series(50, 0.003, seed=2), "UP2": _series(50, 0.002, seed=3),
              "DN1": _series(50, -0.003, seed=4)}
    comps = {"AAA": {"sectorVn": "Thép"}, "UP1": {"sectorVn": "Thép", "targetPrice": 1e9}, "UP2": {"sectorVn": "Ngân hàng"}, "DN1": {"sectorVn": "Thép"}}
    r = pa.alternatives(holdings, ["AAA"], closes, comps, ["UP1", "UP2", "DN1", "AAA"])
    assert [c["ticker"] for c in r["replacements"][0]["candidates"]] == ["UP1"]
    assert "DN1" not in [x["ticker"] for x in r["diversifiers"]]


def test_alert_dedupe_and_contents():
    a = ta.analyze_snapshot(SNAPSHOT)
    plan = {"positions": [{"ticker": "HPG", "price": 19_000, "stop_loss": 19_700, "target": 26_600, "in_profit_after_costs": False, "gap_to_breakeven_pct": 12}]}
    alerts = notify.collect_alerts(a, plan, {"FPT": {"garch": {"vol_now_annual_pct": 60, "vol_long_run_annual_pct": 30}}},
                                   [{"rule": "min_cash_pct", "text": "Tiền mặt thấp"}], {})
    ids = [x["id"] for x in alerts]
    assert any(i.startswith("stop:HPG") for i in ids) and any(i.startswith("vol:FPT") for i in ids) and any(i.startswith("rule:") for i in ids)
    assert "0001234567" not in repr(alerts) and "260.000.000" not in repr(alerts)
    with tempfile.TemporaryDirectory() as d:
        notify.STATE_FILE = os.path.join(d, "s.json")
        assert len(notify.fresh(alerts)) == len(alerts)
        assert notify.fresh(alerts) == [], "the same alert is sent once per day"
    os.environ.pop("TELEGRAM_BOT_TOKEN", None)
    assert notify.send_telegram("x") == "not configured"


def test_host_and_origin_guard():
    import ipaddress
    import server
    from types import SimpleNamespace
    server._TRUSTED_NETS = [ipaddress.ip_network("172.30.57.0/24")]  # what docker-compose sets
    assert all(server._host_allowed(h) for h in ("localhost", "127.0.0.1", "::1", "frontend.traderai.orb.local", "app.localhost", "LOCALHOST."))
    assert not any(server._host_allowed(h) for h in ("evil.example", "orb.local.evil.com", "notorb.local", "", None, "192.168.1.5"))

    def req(client, host, origin=None):
        headers = {"host": host}
        if origin:
            headers["origin"] = origin
        return SimpleNamespace(client=SimpleNamespace(host=client), headers=headers)

    def blocked(r):
        try:
            server._require_local(r)
            return False
        except Exception:
            return True

    assert not blocked(req("127.0.0.1", "localhost:8000", "http://localhost:5173"))
    assert not blocked(req("172.30.57.4", "frontend.traderai.orb.local", "https://frontend.traderai.orb.local")), "OrbStack domain"
    assert blocked(req("172.30.57.4", "frontend.traderai.orb.local", "https://evil.example")), "foreign page"
    assert blocked(req("172.30.57.4", "evil.example", "http://evil.example")), "DNS rebinding: same-origin but unknown host"
    assert blocked(req("8.8.8.8", "localhost:8000")), "remote client"


def main():
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"✓ {name}")
    print("\n✅ All account extras tests passed!")


if __name__ == "__main__":
    main()
