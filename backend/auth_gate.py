"""
Password gate for self-hosting (VPS). Same scheme as the Vercel middleware (middleware.ts):
a session cookie "<expires>.<hmac_sha256(secret, 'session:<expires>')>" signed with AUTH_SECRET.

- APP_PASSWORD + AUTH_SECRET (≥ 32 chars) set: every /api call except /api/auth/* and
  /api/health needs a valid session; nginx asks /api/auth/check before serving pages.
- Neither set: the gate is off (local use). One set without the other: fail closed.
"""

import hashlib
import hmac
import html
import os
import time
from typing import Optional

SESSION_COOKIE = "traderai_session"
SESSION_DAYS = 30
OPEN_PATHS = ("/api/auth/", "/api/health")


def _env():
    return os.environ.get("APP_PASSWORD", ""), os.environ.get("AUTH_SECRET", "")


def mode() -> str:
    """"off" (local), "on" (configured), or "misconfigured" (fail closed)."""
    password, secret = _env()
    if not password and not secret:
        return "off"
    return "on" if password and len(secret) >= 32 else "misconfigured"


def _sign(secret: str, message: str) -> str:
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def create_session(now: Optional[float] = None) -> str:
    _, secret = _env()
    expires = int(((now or time.time()) + SESSION_DAYS * 86_400) * 1000)  # ms, like the TS version
    return f"{expires}.{_sign(secret, f'session:{expires}')}"


def valid_session(token: Optional[str], now: Optional[float] = None) -> bool:
    if mode() == "off":
        return True
    if mode() != "on" or not token or "." not in token:
        return False
    _, secret = _env()
    expires, sig = token.split(".", 1)
    try:
        exp = int(expires)
    except ValueError:
        return False
    if exp < (now or time.time()) * 1000:
        return False
    return hmac.compare_digest(sig, _sign(secret, f"session:{exp}"))


def password_ok(candidate: str) -> bool:
    password, secret = _env()
    # compare HMAC digests so timing does not depend on the input
    return bool(candidate) and hmac.compare_digest(_sign(secret, f"pw:{candidate}"), _sign(secret, f"pw:{password}"))


def is_open_path(path: str) -> bool:
    return any(path.startswith(p) for p in OPEN_PATHS)


def safe_next(value: Optional[str]) -> str:
    return value if value and value.startswith("/") and not value.startswith("//") and not value.startswith("/api/") else "/"


def cookie_header(value: str, max_age: int) -> str:
    secure = "; Secure" if os.environ.get("COOKIE_SECURE", "1") != "0" else ""
    return f"{SESSION_COOKIE}={value}; Path=/; HttpOnly{secure}; SameSite=Lax; Max-Age={max_age}"


def login_page(next_path: str, error: Optional[str] = None) -> str:
    err = f'<div class="error" role="alert">{html.escape(error)}</div>' if error else ""
    return f"""<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Đăng nhập · TraderAI</title>
<style>
:root {{ color-scheme: dark; }} * {{ box-sizing: border-box; }}
body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; font-family: Inter, system-ui, -apple-system, sans-serif; background: #070A11; color: #E9EDF4; }}
.card {{ width: 100%; max-width: 380px; background: #121A28; border: 1px solid rgba(255,255,255,.08); border-radius: 16px; padding: 32px 28px; }}
h1 {{ font-size: 1.4rem; margin: 0 0 6px; }} p {{ margin: 0 0 24px; color: #9AA6B8; font-size: .9rem; }}
label {{ display: block; font-size: .8rem; color: #9AA6B8; margin-bottom: 6px; }}
input {{ width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,.14); background: #070A11; color: #E9EDF4; font-size: 1rem; }}
button {{ margin-top: 16px; width: 100%; padding: 12px; border: 1px solid rgba(255,255,255,.2); border-radius: 10px; cursor: pointer; background: #17202F; color: #E9EDF4; font-weight: 700; font-size: 1rem; }}
.error {{ margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; font-size: .85rem; background: rgba(255,71,87,.12); border: 1px solid rgba(255,71,87,.32); color: #FF6B78; }}
</style></head><body>
<form class="card" method="post" action="/api/auth/login">
<h1>TraderAI</h1><p>Khu vực riêng tư. Vui lòng đăng nhập để tiếp tục.</p>{err}
<input type="hidden" name="next" value="{html.escape(next_path)}">
<label for="password">Mật khẩu</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Đăng nhập</button></form></body></html>"""
