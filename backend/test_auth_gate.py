"""
Offline tests for the self-hosting password gate.
Run: python3 backend/test_auth_gate.py   (from project root)
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import auth_gate as ag  # noqa: E402

SECRET = "x" * 40


def _env(password="", secret=""):
    os.environ["APP_PASSWORD"], os.environ["AUTH_SECRET"] = password, secret


def test_modes():
    _env()
    assert ag.mode() == "off" and ag.valid_session(None), "local: gate off"
    _env("pw", "short")
    assert ag.mode() == "misconfigured" and not ag.valid_session("1.2")
    _env("pw", SECRET)
    assert ag.mode() == "on"


def test_sessions_and_password():
    _env("s3cret", SECRET)
    token = ag.create_session()
    assert ag.valid_session(token)
    assert not ag.valid_session(token[:-1] + ("0" if token[-1] != "0" else "1")), "tampered signature"
    assert not ag.valid_session(ag.create_session(now=time.time() - 31 * 86_400)), "expired"
    assert not ag.valid_session("garbage") and not ag.valid_session(None)
    assert ag.password_ok("s3cret") and not ag.password_ok("wrong") and not ag.password_ok("")
    _env("s3cret", "y" * 40)
    assert not ag.valid_session(token), "rotating AUTH_SECRET logs everyone out"


def test_same_format_as_vercel_middleware():
    """Token = '<expires ms>.<hex hmac_sha256(secret, "session:<expires>")>' as in middleware.ts."""
    import hashlib
    import hmac
    _env("pw", SECRET)
    exp = int((time.time() + 3600) * 1000)
    token = f"{exp}.{hmac.new(SECRET.encode(), f'session:{exp}'.encode(), hashlib.sha256).hexdigest()}"
    assert ag.valid_session(token)


def test_paths_and_redirects():
    assert ag.is_open_path("/api/auth/login") and ag.is_open_path("/api/health") and not ag.is_open_path("/api/account/status")
    assert ag.safe_next("/#portfolio") == "/#portfolio"
    for bad in ("//evil.com", "https://evil.com", "/api/account/status", None, ""):
        assert ag.safe_next(bad) == "/"
    assert "Secure" in ag.cookie_header("v", 10)
    os.environ["COOKIE_SECURE"] = "0"
    assert "Secure" not in ag.cookie_header("v", 10)
    del os.environ["COOKIE_SECURE"]
    assert "&lt;script&gt;" in ag.login_page("/", "<script>")


def test_rate_limiter():
    ag._failures.clear()
    t0 = 1_000_000.0
    key = ag.client_key("6.6.6.6, 203.0.113.9", "172.30.57.2")
    assert key == "203.0.113.9", "the client cannot forge the address our proxy appended"
    assert ag.client_key(None, "127.0.0.1") == "127.0.0.1"
    for i in range(ag.MAX_FAILURES - 1):
        ag.record_failure(key, t0 + i)
    assert ag.retry_after(key, t0 + 10) == 0, "still allowed below the limit"
    ag.record_failure(key, t0 + 10)
    wait = ag.retry_after(key, t0 + 20)
    assert 0 < wait <= ag.WINDOW_SECONDS
    assert ag.retry_after("198.51.100.1", t0 + 20) == 0, "another client is unaffected"
    assert ag.retry_after(key, t0 + ag.WINDOW_SECONDS + 20) == 0, "the window expires"
    ag.clear_failures(key)
    assert ag.retry_after(key, t0 + 20) == 0
    ag._failures.clear()
    for i in range(ag.MAX_FAILURES_TOTAL):
        ag.record_failure(f"10.0.0.{i}", t0 + i)     # one attempt each: a distributed guess
    assert ag.retry_after("192.0.2.77", t0 + 40) > 0, "global cap blocks new clients too"
    ag._failures.clear()


def main():
    saved = {k: os.environ.get(k) for k in ("APP_PASSWORD", "AUTH_SECRET")}
    try:
        for name, fn in list(globals().items()):
            if name.startswith("test_"):
                fn()
                print(f"✓ {name}")
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
    print("\n✅ All auth gate tests passed!")


if __name__ == "__main__":
    main()
