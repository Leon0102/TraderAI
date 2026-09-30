"""
Offline tests for the market database, scores, validation harness, market views and regression.
Run: python3 backend/test_quant.py   (from project root)
"""

import math
import os
import random
import sys
import tempfile
from datetime import date, timedelta

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.pop("DATABASE_URL", None)  # these tests use SQLite

import market_db as db  # noqa: E402
import scoring as sc  # noqa: E402

TMP = tempfile.mkdtemp()
db.reset_for_tests(os.path.join(TMP, "market.db"))


def _period(year, quarter, pub, bs=None, is_=None, cf=None):
    return {"year": year, "quarter": quarter, "public_date": pub, "bs": bs or {}, "is": is_ or {}, "cf": cf or {}}


def _company(year, ni, assets, cfo, sales, gross, lt, ca, cl, paid, issued=0.0, equity=None, pub_lag_days=80):
    pub = (date(year, 12, 31) + timedelta(days=pub_lag_days)).isoformat()
    return _period(year, 0, pub,
                   bs={"bsa53": assets, "bsa78": equity or assets * 0.5, "bsa1": ca, "bsa55": cl, "bsa71": lt, "bsa80": paid},
                   is_={"isa20": ni, "isa3": sales, "isa5": gross, "isa11": ni * 1.2, "isa8": -ni * 0.1},
                   cf={"cfa18": cfo, "cfa19": -cfo * 0.3, "cfa27": issued})


def test_db_roundtrip_and_point_in_time():
    db.upsert_prices("AAA", [{"d": "2026-01-02", "close": 10_000, "volume": 100}, {"d": "2026-01-03", "close": 10_500, "volume": 200}])
    db.upsert_prices("AAA", [{"d": "2026-01-03", "close": 10_600, "volume": 250}])  # upsert, not duplicate
    assert db.price_panel(["AAA"])["AAA"] == [("2026-01-02", 10_000.0, 100.0), ("2026-01-03", 10_600.0, 250.0)]
    db.upsert_statements("AAA", "BALANCE_SHEET", [{"yearReport": 2025, "lengthReport": 5, "publicDate": "2026-03-20T00:00:00", "bsa53": 1e12, "ticker": "AAA"}])
    got = db.statements(["AAA"])["AAA"][0]
    assert got["quarter"] == 0 and got["public_date"] == "2026-03-20" and got["bs"] == {"bsa53": 1e12}
    db.upsert_universe([{"ticker": "AAA", "exchange": "HOSE", "sector": "Thép", "is_bank": 0}])
    assert db.universe()[0]["sector"] == "Thép"
    db.set_job("x", {"a": 1})
    assert db.get_job("x")["a"] == 1


def test_piotroski_all_pass_and_stock_dividend_is_not_dilution():
    prev = _company(2023, ni=80, assets=1000, cfo=90, sales=900, gross=270, lt=200, ca=500, cl=300, paid=100)
    cur = _company(2024, ni=120, assets=1050, cfo=150, sales=1100, gross=360, lt=150, ca=600, cl=300, paid=130)  # bonus shares, no cash raised
    fs = sc.piotroski([prev, cur], "2025-06-01")
    assert fs["score"] == 9 and fs["tests"] == 9, fs
    cur_raise = _company(2024, ni=120, assets=1050, cfo=150, sales=1100, gross=360, lt=150, ca=600, cl=300, paid=130, issued=50)
    assert sc.piotroski([prev, cur_raise], "2025-06-01")["details"]["Không phát hành thêm cổ phiếu"] is False
    assert sc.piotroski([prev, cur], "2025-01-01") is None, "the 2024 report was not published yet"


def test_factors_ttm_and_grades_with_caps():
    quarters = [_period(2025, q, f"2025-{3 * q + 1:02d}-20", bs={"bsa53": 2e12, "bsa78": 1e12, "bsa80": 1e11}, is_={"isa20": 25e9, "isa3": 250e9, "isa11": 30e9}) for q in (1, 2, 3)]
    quarters.append(_period(2025, 4, "2026-01-25", bs={"bsa53": 2e12, "bsa78": 1e12, "bsa80": 1e11}, is_={"isa20": 25e9, "isa3": 250e9, "isa11": 30e9}))
    prices = [((date(2025, 6, 1) + timedelta(days=i)).isoformat(), 20_000.0, 1e6) for i in range(300)]
    f = sc.factors(quarters, prices, "2026-03-01")
    assert abs(f["market_cap"] - 20_000 * 1e7) < 1
    assert abs(f["earnings_yield"] - 100e9 / 2e11) < 1e-9 and abs(f["book_to_price"] - 1e12 / 2e11) < 1e-9
    raw = {f"T{i}": {"earnings_yield": 0.02 * i, "book_to_price": 0.1 * i, "fscore": 5, "op_profitability": 0.1, "revenue_growth": 0.1,
                     "earnings_growth": 0.1, "liabilities_to_assets": 0.5, "current_ratio": 1.5, "interest_coverage": 5,
                     "momentum_6_1": 0.0, "market_cap": 1e12, "turnover": 0.01} for i in range(1, 11)}
    raw["T10"]["fscore"] = 1  # red flag
    g = sc.grade_universe(raw, {t: "Thép" for t in raw})
    assert g["T9"]["grades"]["value"] == "A" and g["T1"]["grades"]["value"] == "F"
    assert g["T10"]["overall_pct"] <= 59.9 and g["T10"]["caps"], "F-score ≤ 2 caps the overall grade at C"


def test_dcf_basics():
    ann = [_company(y, ni=100e9, assets=1e12, cfo=150e9, sales=1e12 * 1.1 ** (y - 2020), gross=3e11, lt=1e11, ca=5e11, cl=3e11, paid=1e11) for y in (2021, 2022, 2023, 2024)]
    d = sc.dcf(ann, "2025-06-01", price=20_000, shares=1e7, beta=1.2, vol_annual=0.3)
    assert d["applicable"] and d["low"] < d["fair_value"] < d["high"]
    assert d["cost_of_equity_pct"] == round((0.03 + 1.2 * 0.07) * 100, 1) and abs(d["stage1_growth_pct"] - 10.0) < 0.2
    assert sc.dcf(ann, "2025-06-01", 20_000, 1e7, 1.0, 0.3, is_bank=True)["applicable"] is False


def _synthetic_market(n=40, months=30, seed=3):
    """Stocks whose earnings yield truly drives next-month returns; everything else is noise."""
    rng = random.Random(seed)
    tickers = [f"S{i:02d}" for i in range(n)]
    ey = {t: rng.uniform(0.02, 0.2) for t in tickers}
    start = date(2023, 1, 2)
    days = [start + timedelta(days=i) for i in range(int(months * 30.5))]
    days = [d for d in days if d.weekday() < 5]
    for t in tickers:
        price, bars = 10_000.0, []
        for d in days:
            drift = (ey[t] - 0.11) * 0.012  # higher underlying profitability -> higher daily drift
            price *= math.exp(drift + rng.gauss(0, 0.012))
            bars.append({"d": d.isoformat(), "close": price, "volume": 1_000_000})
        db.upsert_prices(t, bars)
        shares = 1e8
        # annual reports: net income consistent with the target earnings yield at the starting price
        periods = [{"yearReport": y, "lengthReport": 5, "publicDate": f"{y + 1}-03-15T00:00:00", "bsa53": 3e12, "bsa78": 1.5e12,
                    "bsa1": 1e12, "bsa55": 6e11, "bsa71": 2e11, "bsa80": shares * 10_000} for y in (2021, 2022, 2023, 2024, 2025)]
        db.upsert_statements(t, "BALANCE_SHEET", periods)
        db.upsert_statements(t, "INCOME_STATEMENT", [{"yearReport": y, "lengthReport": 5, "publicDate": f"{y + 1}-03-15T00:00:00",
                                                      "isa20": ey[t] * 10_000 * shares, "isa3": 2e12, "isa5": 5e11, "isa11": ey[t] * 1.2e12}
                                                     for y in (2021, 2022, 2023, 2024, 2025)])
        db.upsert_statements(t, "CASH_FLOW", [{"yearReport": y, "lengthReport": 5, "publicDate": f"{y + 1}-03-15T00:00:00",
                                               "cfa18": ey[t] * 1.1e12, "cfa19": -1e11, "cfa27": 0} for y in (2021, 2022, 2023, 2024, 2025)])
        db.upsert_universe([{"ticker": t, "exchange": "HOSE", "sector": "Ngành A" if int(t[1:]) % 2 else "Ngành B", "is_bank": 0}])
    idx, price = [], 1000.0
    for d in days:
        price *= math.exp(rng.gauss(0.0002, 0.01))
        idx.append({"d": d.isoformat(), "close": price, "volume": 1})
    db.upsert_prices("VNINDEX", idx)
    return tickers, days[-1]


def test_validation_finds_the_planted_factor():
    import factor_validation as fv
    db.reset_for_tests(os.path.join(TMP, "synthetic.db"))
    _, last = _synthetic_market()
    real_today = fv.date

    class FakeDate(date):
        @classmethod
        def today(cls):
            return last
    fv.date = FakeDate
    try:
        out = fv.run(years=3, min_names=20)
    finally:
        fv.date = real_today
    res = {r["factor"]: r for r in out["results"]}
    assert out["months"] >= 20
    # Operating profitability carries the planted signal without price in the denominator.
    planted = res["op_profitability"]
    assert planted["verdict"] == "CÓ BẰNG CHỨNG" and planted["ic_mean"] > 0.05, planted
    assert res["earnings_yield"]["net_excess"]["mean_pct"] > 0, res["earnings_yield"]
    assert (res["turnover"]["net_excess"]["t"] or 0) < planted["net_excess"]["t"], "a noise factor must not beat the planted one"
    assert db.get_job("factor_series")["series"]["VALUE"], "daily factor returns stored for regression"


def test_market_views_on_synthetic_data():
    import market_views as mv
    panel = db.price_panel()
    b = mv.breadth(panel, days=60)
    assert b["universe"] == 40 and len(b["points"]) == 60
    last = b["latest"]
    assert 0 <= last["pct_above_ma200"] <= 100 and last["advances"] + last["declines"] <= 40
    rot = mv.sector_rotation(panel, {u["ticker"]: u["sector"] for u in db.universe()})
    assert {s["sector"] for s in rot["sectors"]} == {"Ngành A", "Ngành B"}
    assert all(s["quadrant"] in ("DẪN DẮT", "SUY YẾU", "TỤT HẬU", "CẢI THIỆN") for s in rot["sectors"])
    v = mv.valuation_band(panel, db.statements())
    assert v["stats"] and v["stats"]["now"] > 0


def test_regression_recovers_beta():
    import quant_service as q
    rng = np.random.default_rng(1)
    days = [f"2025-{1 + i // 28:02d}-{1 + i % 28:02d}" for i in range(200)]
    mkt = {d: float(rng.normal(0, 0.01)) for d in days}
    smb = {d: float(rng.normal(0, 0.005)) for d in days}
    y = {d: 0.0002 + 0.8 * mkt[d] - 0.5 * smb[d] + float(rng.normal(0, 0.002)) for d in days}
    r = q.regress(y, {"MKT": mkt, "SMB": smb})
    c = r["coefficients"]
    assert abs(c["MKT"]["coef"] - 0.8) < 0.05 and abs(c["SMB"]["coef"] + 0.5) < 0.1 and r["r2"] > 0.9
    assert q.regress({d: 0.0 for d in days[:10]}, {"MKT": mkt}) is None


def main():
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"✓ {name}")
    print("\n✅ All quant tests passed!")


if __name__ == "__main__":
    main()
