"""
Integration tests for the HTTP layer (FastAPI TestClient): guards, password gate, account and quant
endpoints against temporary storage. No network and no TCBS credentials needed.
Run: python3 backend/test_api.py   (from project root; needs httpx)
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.pop("DATABASE_URL", None)
for _k in ("APP_PASSWORD", "AUTH_SECRET", "ACCOUNT_TRUSTED_NETWORKS", "TELEGRAM_BOT_TOKEN"):
    os.environ.pop(_k, None)

from fastapi.testclient import TestClient  # noqa: E402

import auth_gate  # noqa: E402
import market_db as db  # noqa: E402
import nav_history as nh  # noqa: E402
import personal_rules as pr  # noqa: E402
import server  # noqa: E402
import tcbs_account as ta  # noqa: E402
import weekly_report as wr  # noqa: E402
from test_tcbs_account import SNAPSHOT  # noqa: E402

TMP = tempfile.mkdtemp()
ta.SNAPSHOT_FILE, ta.TOKEN_FILE, ta.LEDGER_FILE = (os.path.join(TMP, n) for n in ("snap.json", "tok.json", "ledger.json"))
nh.HISTORY_FILE, pr.RULES_FILE, wr.REPORTS_DIR = os.path.join(TMP, "nav.json"), os.path.join(TMP, "rules.json"), os.path.join(TMP, "reports")
db.reset_for_tests(os.path.join(TMP, "empty.db"))

LOCAL = TestClient(server.app, client=("127.0.0.1", 50000), base_url="http://localhost")
STRANGER = TestClient(server.app, client=("8.8.8.8", 50000), base_url="http://localhost")


def test_health_and_gate_off_locally():
    r = LOCAL.get("/api/health")
    assert r.status_code == 200 and r.json() == {"ok": True, "auth": "off"}
    assert LOCAL.get("/api/auth/check").status_code == 204, "no password configured: pages are open"


def test_account_guard():
    assert STRANGER.get("/api/account/status").status_code == 403, "a remote client is refused"
    r = LOCAL.get("/api/account/status", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and "evil.example" in r.json()["detail"]
    assert LOCAL.get("/api/account/status", headers={"Origin": "https://frontend.traderai.orb.local"}).status_code == 200
    rebinding = TestClient(server.app, client=("127.0.0.1", 1), base_url="http://evil.example")
    assert rebinding.get("/api/account/status").status_code == 403, "DNS rebinding: unknown Host header"
    assert LOCAL.post("/api/quant/ingest", headers={"Origin": "https://evil.example"}).status_code == 403


def test_account_endpoints_without_and_with_a_snapshot():
    r = LOCAL.get("/api/account/portfolio")
    assert r.status_code == 404 and r.json()["detail"]["needs_login"] is False
    assert LOCAL.post("/api/account/sync").status_code == 401, "no token yet: the UI must ask for the OTP"
    assert LOCAL.post("/api/account/login", json={"otp": "12ab"}).status_code == 400
    ta._write_private(ta.SNAPSHOT_FILE, SNAPSHOT)
    p = LOCAL.get("/api/account/portfolio").json()
    assert p["summary"]["nav"] == 260_000_000 and {h["ticker"] for h in p["holdings"]} == {"FPT", "HPG"}
    assert "0001234567" not in LOCAL.get("/api/account/portfolio").text, "account numbers are masked"


def test_rules_roundtrip_and_validation():
    rules = LOCAL.get("/api/account/rules").json()["rules"]
    assert rules["max_positions"] == 8
    assert LOCAL.post("/api/account/rules", json={"max_positions": 5}).json()["rules"]["max_positions"] == 5
    assert LOCAL.post("/api/account/rules", json={"max_positions": 0}).status_code == 400
    assert LOCAL.post("/api/account/rules", json={"nope": 1}).status_code == 400
    v = LOCAL.get("/api/account/rules").json()["violations"]
    assert any(x["rule"] == "max_weight_pct" for x in v), "FPT is far above the 25% cap in the fixture"


def test_input_validation():
    assert LOCAL.post("/api/account/nav/flow", json={"date": "29/09/2026", "amount": 1}).status_code == 400
    assert LOCAL.post("/api/account/nav/flow", json={"date": "2026-09-29", "amount": 1}).status_code == 200
    assert LOCAL.post("/api/account/pretrade", json={"ticker": "TOOLONGX", "price": 1, "stop": 1}).status_code == 422
    assert LOCAL.post("/api/account/pretrade", json={"ticker": "FPT", "price": -5, "stop": 1}).status_code == 422
    assert LOCAL.get("/api/account/reports/..%2Ftcbs_token").status_code == 404, "no path traversal in report names"
    assert LOCAL.get("/api/account/reports/2026-W40").status_code == 404
    assert LOCAL.get("/api/account/risk?riskPct=99").status_code == 422


def test_quant_endpoints_without_data():
    s = LOCAL.get("/api/quant/status").json()
    assert s["available"] is False and s["engine"] == "sqlite"
    for path in ("/api/quant/screener", "/api/quant/validation", "/api/quant/market", "/api/quant/forward", "/api/quant/stock/FPT"):
        r = LOCAL.get(path)
        assert r.status_code == 404 and "Nạp dữ liệu" in r.json()["detail"]["message"], path
    assert LOCAL.get("/api/quant/screener?grade=Z").status_code == 422
    assert LOCAL.get("/api/quant/stock/NOT%20A%20TICKER").status_code in (400, 404)


def test_finance_falls_back_to_local_database():
    import quant_service
    import routes_market
    real_get_finance, real_local = routes_market.get_finance, quant_service.local_finance
    routes_market.get_finance = lambda t: {"data": None, "source": "error"}
    quant_service.local_finance = lambda t: {"ticker": t, "pe": 12.5} if t == "DMX" else None
    try:
        r = LOCAL.get("/api/finance?ticker=DMX").json()
        assert r == {"data": {"ticker": "DMX", "pe": 12.5}, "source": "local"}
        assert LOCAL.get("/api/finance?ticker=ZZZ").json()["source"] == "error", "no local data either: honest error, not invented numbers"
    finally:
        routes_market.get_finance, quant_service.local_finance = real_get_finance, real_local


def test_council_verdicts_are_logged():
    import council_log
    import routes_agents
    council_log.LOG_FILE = os.path.join(TMP, "council.json")
    routes_agents._log_council("FPT", {"action": "MUA", "sizing": "15%"}, 63_200.0, "heuristic")
    log = council_log.load()
    assert len(log) == 1 and next(iter(log.values()))["ticker"] == "FPT"
    routes_agents._log_council("FPT", None, None)      # a malformed verdict must never break the council


def test_password_gate_end_to_end():
    secret = "s" * 40
    os.environ["APP_PASSWORD"], os.environ["AUTH_SECRET"] = "hunter2", secret
    auth_gate._failures.clear()
    try:
        c = TestClient(server.app, client=("127.0.0.1", 50000), base_url="http://localhost", follow_redirects=False)
        assert c.get("/api/quant/status").status_code == 401
        assert c.get("/api/health").json()["auth"] == "on", "health stays open for container healthchecks"
        assert c.get("/api/auth/check").status_code == 401
        assert c.get("/login").status_code == 200 and "Mật khẩu" in c.get("/login").text
        bad = c.post("/api/auth/login", content="password=nope&next=/", headers={"Content-Type": "application/x-www-form-urlencoded"})
        assert bad.status_code == 401
        ok = c.post("/api/auth/login", content="password=hunter2&next=/%23quant", headers={"Content-Type": "application/x-www-form-urlencoded"})
        assert ok.status_code == 303 and ok.headers["location"] == "/#quant" and "HttpOnly" in ok.headers["set-cookie"]
        cookie = ok.headers["set-cookie"].split(";")[0]
        assert c.get("/api/quant/status", headers={"Cookie": cookie}).status_code == 200
        assert c.get("/api/auth/check", headers={"Cookie": cookie}).status_code == 204
        assert c.get("/api/quant/status", headers={"Cookie": "traderai_session=1.deadbeef"}).status_code == 401
        evil_next = c.post("/api/auth/login", content="password=hunter2&next=//evil.com", headers={"Content-Type": "application/x-www-form-urlencoded"})
        assert evil_next.headers["location"] == "/", "no open redirect"
        # brute force: five wrong passwords lock this client out, even for the right one
        auth_gate._failures.clear()
        for _ in range(auth_gate.MAX_FAILURES):
            c.post("/api/auth/login", content="password=x", headers={"Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "203.0.113.5"})
        locked = c.post("/api/auth/login", content="password=hunter2", headers={"Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "203.0.113.5"})
        assert locked.status_code == 429 and int(locked.headers["retry-after"]) > 0
        other = c.post("/api/auth/login", content="password=hunter2", headers={"Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.2"})
        assert other.status_code == 303, "a different client is not locked out"
        # half-configured: fail closed
        os.environ["AUTH_SECRET"] = "short"
        assert c.get("/api/quant/status").status_code == 503
    finally:
        os.environ.pop("APP_PASSWORD", None)
        os.environ.pop("AUTH_SECRET", None)
        auth_gate._failures.clear()


def main():
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"✓ {name}")
    print("\n✅ All API integration tests passed!")


if __name__ == "__main__":
    main()
