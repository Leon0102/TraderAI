"""
Offline tests for risk tools (sizing, risk parity, stress tests, rule backtest) and the weekly report.
Run: python3 backend/test_risk_tools.py   (from project root)
"""

import os
import sys
import tempfile
from datetime import date, timedelta

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import portfolio_insights as pi  # noqa: E402
import portfolio_plan as pp  # noqa: E402
import risk_tools as rt  # noqa: E402
import tcbs_account as ta  # noqa: E402
import weekly_report as wr  # noqa: E402
from test_tcbs_account import SNAPSHOT  # noqa: E402


def _dates(n, start=date(2021, 10, 1)):
    return [(start + timedelta(days=i)).isoformat() for i in range(n)]


def test_position_size_caps():
    r = rt.position_size(nav=1e9, price=50_000, stop=46_500, risk_pct=1)
    assert r["shares"] == 2800 and r["limited_by"] == "rủi ro"      # 10,000,000 / 3,500 = 2857 -> 2800
    assert r["risk_pct_nav"] <= 1.0
    r = rt.position_size(nav=1e8, price=50_000, stop=49_900, risk_pct=1)
    assert r["limited_by"] == "tỷ trọng tối đa" and r["weight_pct"] <= 25
    r = rt.position_size(nav=1e9, price=50_000, stop=46_500, risk_pct=1, cash=20_000_000)
    assert r["limited_by"] == "tiền mặt" and r["value"] <= 20_000_000
    assert rt.position_size(1e9, 50_000, 51_000, 1)["shares"] == 0


def test_erc_equalises_risk():
    cov = np.array([[0.04, 0.006, 0.0], [0.006, 0.01, 0.002], [0.0, 0.002, 0.0225]]) / 250
    w = rt.erc_weights(cov)
    rc = rt.risk_contributions(w, cov)
    assert abs(w.sum() - 1) < 1e-9 and abs(rc.sum() - 1) < 1e-9
    assert np.allclose(rc, 1 / 3, atol=1e-3), rc
    assert w[1] > w[2] > w[0], "lowest-vol asset gets the most weight"


def test_risk_parity_from_prices():
    rng = np.random.default_rng(0)
    d = _dates(300)
    closes = {t: list(zip(d, 20_000 * np.exp(np.cumsum(rng.normal(0, s, 300))))) for t, s in (("AAA", 0.03), ("BBB", 0.01))}
    holdings = [{"ticker": "AAA", "market_value": 50.0}, {"ticker": "BBB", "market_value": 50.0}]
    r = rt.risk_parity(holdings, closes)
    aaa = r["rows"][0]
    assert aaa["risk_share_pct"] > 80 and aaa["erc_weight_pct"] < 35
    assert r["vol_erc_pct"] < r["vol_now_pct"]


def test_stress_uses_real_moves_then_beta():
    idx = [("2022-01-06", 1500.0), ("2022-11-15", 900.0), ("2025-03-25", 1300.0), ("2025-04-09", 1100.0)]
    closes = {"OLD": [("2021-12-01", 10_000.0), ("2022-01-06", 10_000.0), ("2022-11-15", 5_000.0), ("2025-03-25", 8_000.0), ("2025-04-09", 7_000.0)],
              "NEW": [("2024-01-02", 20_000.0), ("2025-03-25", 20_000.0), ("2025-04-09", 18_000.0)]}
    holdings = [{"ticker": "OLD", "market_value": 60.0}, {"ticker": "NEW", "market_value": 40.0}]
    out = rt.stress_test(holdings, closes, idx, {"OLD": 1.2, "NEW": 0.5}, nav=100.0)
    crash = out[0]
    assert crash["vnindex_pct"] == -40.0
    old, new = crash["rows"]
    assert old["move_pct"] == -50.0 and old["source"] == "thực tế"
    assert new["source"] == "ước tính theo beta" and new["move_pct"] == -20.0
    assert crash["portfolio_pct"] == -38.0
    assert out[1]["rows"][1]["source"] == "thực tế"
    hypo = [x for x in out if x["scenario"].startswith("VN-Index -20")][0]
    assert hypo["portfolio_pct"] == round((60 * 1.2 + 40 * 0.5) * -0.2, 1)


def test_backtest_rules_behaviour():
    falling = list(50_000 * np.exp(np.linspace(0, -0.8, 400)))
    b = {r["label"]: r for r in rt.backtest_rules(falling)["rules"]}
    assert b["Cắt lỗ -7%"]["avg_return_pct"] > b["Giữ 6 tháng"]["avg_return_pct"]
    assert b["Cắt lỗ -7%"]["worst_pct"] > -9, "stop caps each loss near -7% plus costs"
    rising = list(50_000 * np.exp(np.linspace(0, 1.5, 400)))
    b = {r["label"]: r for r in rt.backtest_rules(rising)["rules"]}
    assert b["Giữ 6 tháng"]["avg_return_pct"] >= b["Cắt lỗ -7% + chốt 1/3 ở +20% + trailing"]["avg_return_pct"]
    assert rt.backtest_rules(falling[:100]) is None


def test_vol_spikes():
    f = {"AAA": {"garch": {"vol_now_annual_pct": 60, "vol_long_run_annual_pct": 30}},
         "BBB": {"garch": {"vol_now_annual_pct": 30, "vol_long_run_annual_pct": 28}}, "CCC": None}
    s = rt.vol_spikes(f)
    assert [x["ticker"] for x in s] == ["AAA"] and s[0]["ratio"] == 2.0


def test_weekly_report_and_names():
    analysis = ta.analyze_snapshot(SNAPSHOT)
    plan = pp.build_plan(analysis, {})
    md = wr.build_report(analysis, plan, today=date(2026, 10, 2))
    assert md.startswith("# Báo cáo danh mục tuần 2026-W40")
    assert "FPT" in md and "0001234567" not in md
    assert "| Mã | Tỷ trọng |" in md
    with tempfile.TemporaryDirectory() as d:
        wr.REPORTS_DIR = d
        name = wr.save_report(md, date(2026, 10, 2))
        assert name == "2026-W40" and wr.read_report(name) == md
        assert [r["name"] for r in wr.list_reports()] == ["2026-W40"]
        assert wr.read_report("../tcbs_token") is None and wr.read_report("2026-W40/../x") is None


def test_journal_notes_and_reason_stats():
    with tempfile.TemporaryDirectory() as d:
        pi.JOURNAL_FILE = os.path.join(d, "j.json")
        j = {"trades": {}, "last_cost": {}, "notes": {}}
        snap = lambda day, stock, m: {"synced_at": f"{day}T15:00:00", "accounts": [{"accountNo": "1", "assets": {"stock": stock}, "matches": {"data": m}}]}  # noqa: E731
        pi.merge_trades(j, snap("2026-09-01", [{"symbol": "AAA", "totalQtty": 100, "costPrice": 10_000}], [{"orderId": "b", "tradeId": "1", "symbol": "AAA", "side": "B", "qtty": 100, "price": 10_000}]))
        pi.merge_trades(j, snap("2026-09-10", [], [{"orderId": "s", "tradeId": "2", "symbol": "AAA", "side": "S", "qtty": 100, "price": 12_000}]))
        ta._write_private(pi.JOURNAL_FILE, j)
        buy_key = next(k for k, t in j["trades"].items() if t["side"] == "B")
        assert pi.set_note(buy_key, "Breakout / vượt đỉnh", "vượt nền 3 tháng")["tag"] == "Breakout / vượt đỉnh"
        try:
            pi.set_note(buy_key, "không có", "")
            raise AssertionError("expected ValueError")
        except ValueError:
            pass
        st = pi.journal_stats(pi.load_journal())
        assert st["by_reason"][0]["reason"] == "Breakout / vượt đỉnh" and st["by_reason"][0]["win_rate_pct"] == 100.0
        assert st["recent_closed"][0]["reason"] == "Breakout / vượt đỉnh"
        assert any(t["key"] == buy_key and t.get("note") == "vượt nền 3 tháng" for t in st["recent_trades"])
        pi.set_note(buy_key, None, "")
        assert buy_key not in pi.load_journal()["notes"]


def main():
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"✓ {name}")
    print("\n✅ All risk tools & report tests passed!")


if __name__ == "__main__":
    main()
