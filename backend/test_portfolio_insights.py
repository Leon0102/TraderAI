"""
Offline tests for portfolio insights (journal, benchmark, sectors, events, DCA).
Run: python3 backend/test_portfolio_insights.py   (from project root)
"""

import math
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import portfolio_insights as pi  # noqa: E402
import portfolio_plan as pp  # noqa: E402
import tcbs_account as ta  # noqa: E402
from test_tcbs_account import SNAPSHOT  # noqa: E402


def _snap(day, stock, matches):
    return {"synced_at": f"{day}T15:00:00", "accounts": [
        {"accountNo": "1", "assets": {"stock": stock}, "matches": {"data": matches}}]}


def test_journal_merge_dedupes_and_records_cost_basis():
    j = {"trades": {}, "last_cost": {}}
    day1 = _snap("2026-09-01", [{"symbol": "HPG", "totalQtty": 1000, "costPrice": 28000}],
                 [{"orderId": "o1", "tradeId": "t1", "symbol": "HPG", "side": "B", "qtty": 1000, "price": 28000}])
    assert pi.merge_trades(j, day1) == 1
    assert pi.merge_trades(j, day1) == 0, "re-syncing the same day adds nothing"
    # Position fully sold on day 2: TCBS no longer lists it, so the last seen cost is the basis.
    day2 = _snap("2026-09-11", [], [{"orderId": "o2", "tradeId": "t2", "symbol": "HPG", "side": "S", "qtty": 1000, "price": 31000}])
    assert pi.merge_trades(j, day2) == 1
    sell = next(t for t in j["trades"].values() if t["side"] == "S")
    assert sell["cost_basis"] == 28000


def test_journal_stats_realized_pnl_and_holding_time():
    j = {"trades": {}, "last_cost": {}}
    pi.merge_trades(j, _snap("2026-09-01", [{"symbol": "HPG", "totalQtty": 1000, "costPrice": 28000},
                                            {"symbol": "FPT", "totalQtty": 100, "costPrice": 100000}],
                             [{"orderId": "a", "tradeId": "1", "symbol": "HPG", "side": "B", "qtty": 1000, "price": 28000}]))
    pi.merge_trades(j, _snap("2026-09-11", [{"symbol": "FPT", "totalQtty": 50, "costPrice": 100000}],
                             [{"orderId": "b", "tradeId": "2", "symbol": "HPG", "side": "S", "qtty": 1000, "price": 31000},
                              {"orderId": "c", "tradeId": "3", "symbol": "FPT", "side": "S", "qtty": 50, "price": 90000}]))
    st = pi.journal_stats(j)
    keep = 0.998
    hpg = 1000 * (31000 * keep - 28000)
    fpt = 50 * (90000 * keep - 100000)
    assert st["realized_pnl"] == round(hpg + fpt)
    assert st["win_rate_pct"] == 50.0
    assert st["profit_factor"] == round(hpg / -fpt, 2)
    assert st["avg_holding_days"] == 10.0, "only HPG has a journaled buy: 10 days"
    assert [x["ticker"] for x in st["by_ticker"]] == ["FPT", "HPG"], "worst first"
    assert st["monthly"] == [{"month": "2026-09", "pnl": round(hpg + fpt)}]


def test_journal_file_roundtrip():
    with tempfile.TemporaryDirectory() as d:
        pi.JOURNAL_FILE = os.path.join(d, "j.json")
        assert pi.update_journal(SNAPSHOT) == 1
        assert pi.update_journal(SNAPSHOT) == 0
        assert pi.load_journal()["last_cost"]["FPT"] > 0


def test_beta_and_correlation():
    bench = [0.01 if i % 3 else -0.012 for i in range(100)]
    beta, corr = pi.beta_corr([2 * r for r in bench], bench)
    assert beta == 2.0 and corr == 1.0
    beta, corr = pi.beta_corr([-r for r in bench], bench)
    assert beta == -1.0 and corr == -1.0
    assert pi.beta_corr([0.01] * 10, [0.01] * 10) == (None, None)


def test_benchmark_windows():
    dates = [f"2025-{1 + i // 28:02d}-{1 + i % 28:02d}" for i in range(260)]
    idx = [(d, 1000 * math.exp(0.001 * i + (0.01 if i % 2 else 0))) for i, d in enumerate(dates)]
    stock = [(d, 50_000 * math.exp(0.002 * i + (0.02 if i % 2 else 0))) for i, d in enumerate(dates)]
    holdings = [{"ticker": "AAA", "market_value": 100.0, "weight_pct": 100.0}]
    b = pi.benchmark(holdings, {"AAA": {"closes": stock}}, idx, nav=100.0)
    assert b["stocks"][0]["beta"] == 2.0 and b["portfolio_beta"] == 2.0
    assert [w["window"] for w in b["windows"]] == list(pi.BENCHMARK_WINDOWS)
    w12 = b["windows"][-1]
    assert w12["portfolio_pct"] > w12["vnindex_pct"] and w12["excess_pct"] > 0


def test_sectors_analysts_events():
    holdings = ta.analyze_snapshot(SNAPSHOT)["holdings"]
    companies = {"FPT": {"sectorVn": "Công nghệ Thông tin", "rating": "BUY", "targetPrice": 150000, "dividendPerShareTsr": 2000},
                 "HPG": {"sectorVn": "Tài nguyên Cơ bản", "targetPrice": None}}
    sec = pi.sector_exposure(holdings, companies)
    assert sec["sectors"][0]["sector"] == "Công nghệ Thông tin"
    assert sec["flags"] and "Công nghệ" in sec["flags"][0]
    av = pi.analyst_view(holdings, companies)
    fpt = next(r for r in av["rows"] if r["ticker"] == "FPT")
    assert fpt["upside_pct"] == 25.0 and fpt["dividend_per_share"] == 2000
    assert av["dividend_income_annual"] == 2000 * 1500
    ev = pi.corporate_events({"FPT": [
        {"newsTitle": "FPT: Thông báo ngày đăng ký cuối cùng trả cổ tức bằng tiền", "publicDate": "2026-09-20T10:00:00"},
        {"newsTitle": "FPT: Nghị quyết HĐQT về nhân sự", "publicDate": "2026-09-21T10:00:00"},
        {"newsTitle": "FPT: Tài liệu họp Đại hội đồng cổ đông", "publicDate": "2026-09-22T10:00:00"}]})
    assert [(e["type"], e["date"]) for e in ev] == [("ĐẠI HỘI", "2026-09-22"), ("CỔ TỨC", "2026-09-20")]


def test_dca_simulation():
    base = pp.dca_simulation(1e8, 0, 12, 20, 0.0003, 0.015)
    analytic = pp.goal_probability(1e8, 20, 12, {"mu": 0.0003, "sigma": 0.015})["probability_pct"]
    assert abs(base["probability_pct"] - analytic) < 3, (base, analytic)
    dca = pp.dca_simulation(1e8, 5e6, 12, 20, 0.0003, 0.015)
    assert dca["contributed"] == 6e7 and dca["target_nav"] == round(1.6e8 * 1.2)
    assert dca["p10"] < dca["p50"] < dca["p90"]
    assert pp.dca_simulation(1e8, 5e6, 12, 20, 0.0003, 0.015) == dca, "seeded -> reproducible"


def main():
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"✓ {name}")
    print("\n✅ All portfolio insights tests passed!")


if __name__ == "__main__":
    main()
