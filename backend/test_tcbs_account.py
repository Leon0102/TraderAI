"""
Offline tests for the TCBS account module (no network, no real credentials).
Run: python3 backend/test_tcbs_account.py   (from project root)
"""

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tcbs_account as ta  # noqa: E402

SNAPSHOT = {
    "synced_at": "2026-09-29T10:00:00",
    "errors": [],
    "accounts": [
        {
            "accountNo": "0001234567",
            "accountType": "NORMAL",
            "assets": {"object": "se", "accountNo": "0001234567", "stock": [
                {"symbol": "FPT", "totalQtty": 1000, "availableTrading": 800, "waitForTrade": 200,
                 "stockDividend": 0, "currentPrice": "120000", "costPrice": "100000"},
                {"symbol": "HPG", "totalQtty": 2000, "availableTrading": 2000, "waitForTrade": 0,
                 "stockDividend": 0, "currentPrice": 25000, "costPrice": 28000},
                {"symbol": "OLD", "totalQtty": 0, "currentPrice": 1, "costPrice": 1},
            ]},
            "cash": {"data": [{"balance": 30000000, "avlWithdraw": 20000000, "buyingAmount": 0, "cashDevident": 500000}]},
            "orders": {"data": [{"orderId": "1", "symbol": "FPT", "status": "MATCHED"},
                                {"orderId": "2", "symbol": "HPG", "status": "CANCELLED"}]},
            "matches": {"data": [{"symbol": "FPT", "side": "B", "qtty": 200, "price": 119000}]},
        },
        {
            "accountNo": "0001234568",
            "accountType": "MARGIN",
            # quoted in thousand VND on purpose: must be normalized
            "assets": {"stock": [{"symbol": "FPT", "totalQtty": 500, "availableTrading": 500,
                                  "currentPrice": 120, "costPrice": 110}]},
            "cash": {"data": [{"balance": 0}]},
        },
    ],
}


def test_analyze_merges_subaccounts_and_normalizes_prices():
    a = ta.analyze_snapshot(SNAPSHOT)
    fpt = next(h for h in a["holdings"] if h["ticker"] == "FPT")
    assert fpt["quantity"] == 1500
    assert fpt["market_value"] == 1500 * 120000
    assert fpt["avg_cost"] == round((1000 * 100000 + 500 * 110000) / 1500)
    assert fpt["sellable"] == 1300 and fpt["pending"] == 200
    assert all(h["ticker"] != "OLD" for h in a["holdings"]), "zero-quantity rows are dropped"
    s = a["summary"]
    assert s["stock_value"] == 180_000_000 + 50_000_000
    assert s["nav"] == 230_000_000 + 30_000_000
    assert s["cash_dividend_pending"] == 500000
    assert a["holdings"][0]["ticker"] == "FPT", "sorted by market value"
    assert abs(sum(h["weight_pct"] for h in a["holdings"]) + s["cash_pct"] - 100) < 0.05


def test_flags_concentration_and_stop_loss():
    a = ta.analyze_snapshot(SNAPSHOT)
    texts = " ".join(f["text"] for f in a["flags"])
    assert "FPT chiếm" in texts          # ~69% of NAV
    assert "HPG lỗ" in texts             # -10.7%
    assert "FPT lãi" not in texts        # +16%, below the 20% take-profit flag


def test_trades_orders_and_masking():
    a = ta.analyze_snapshot(SNAPSHOT)
    assert a["today_trades"] == [{"ticker": "FPT", "buy_qty": 200, "buy_value": 23_800_000, "sell_qty": 0, "sell_value": 0}]
    assert a["order_status"] == {"MATCHED": 1, "CANCELLED": 1}
    assert [x["account"] for x in a["accounts"]] == ["•••567", "•••568"]
    assert "0001234567" not in repr(a)


def test_llm_brief_has_no_identifiers_or_absolute_wealth():
    brief = ta.llm_portfolio_brief(ta.analyze_snapshot(SNAPSHOT))
    assert "FPT" in brief and "HPG" in brief
    assert "1234567" not in brief and "260,000,000" not in brief and "30,000,000" not in brief


def test_strip_pii_is_recursive():
    raw = {"accountNo": "1", "fullName": "X", "stock": [{"symbol": "FPT", "custodyID": "105C1"}],
           "personalInfo": {"email": "a@b"}}
    assert ta.strip_pii(raw) == {"accountNo": "1", "stock": [{"symbol": "FPT"}]}


def test_empty_portfolio():
    a = ta.analyze_snapshot({"accounts": [{"accountNo": "9", "assets": {"stock": []}, "cash": {"data": [{"balance": 1000}]}}]})
    assert a["holdings"] == [] and a["summary"]["cash_pct"] == 100
    assert "chưa nắm giữ" in ta.heuristic_review(a)


def test_token_cache_expiry():
    with tempfile.TemporaryDirectory() as d:
        ta.RUNTIME_DIR, ta.TOKEN_FILE = d, os.path.join(d, "t.json")
        ta._write_private(ta.TOKEN_FILE, {"token": "x", "expires_at": time.time() + 3600})
        assert ta.load_token()["token"] == "x"
        assert oct(os.stat(ta.TOKEN_FILE).st_mode & 0o777) == "0o600"
        ta._write_private(ta.TOKEN_FILE, {"token": "x", "expires_at": time.time() + 60})
        assert ta.load_token() is None, "tokens inside the 2-minute margin count as expired"


def test_login_rejects_bad_otp_without_network():
    os.environ["TCBS_API_KEY"] = "dummy"
    try:
        ta.login("12ab")
        raise AssertionError("expected TcbsError")
    except ta.TcbsError as e:
        assert "OTP" in str(e)
    finally:
        del os.environ["TCBS_API_KEY"]


def main():
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"✓ {name}")
    print("\n✅ All TCBS account tests passed!")


if __name__ == "__main__":
    main()
