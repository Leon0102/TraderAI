"""Password gate (middleware) and login/logout endpoints for self-hosting; see auth_gate.py."""

import asyncio
from urllib.parse import parse_qs

from fastapi import APIRouter, Request as _Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

import auth_gate

router = APIRouter()


async def password_gate(request: _Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and not auth_gate.is_open_path(path):
        if auth_gate.mode() == "misconfigured":
            return JSONResponse({"detail": "APP_PASSWORD / AUTH_SECRET (≥ 32 ký tự) cấu hình chưa đủ."}, status_code=503)
        if not auth_gate.valid_session(request.cookies.get(auth_gate.SESSION_COOKIE)):
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


@router.get("/api/health")
def api_health():
    return {"ok": True, "auth": auth_gate.mode()}


@router.get("/api/auth/check")
def api_auth_check(request: _Request):
    """nginx auth_request target: 204 when the page may be served, 401 otherwise."""
    if auth_gate.mode() == "misconfigured":
        return Response(status_code=503)
    ok = auth_gate.valid_session(request.cookies.get(auth_gate.SESSION_COOKIE))
    return Response(status_code=204 if ok else 401)


@router.get("/login")
@router.get("/api/auth/login")
def api_auth_login_page(request: _Request, next: str = "/"):
    if auth_gate.mode() == "off" or auth_gate.valid_session(request.cookies.get(auth_gate.SESSION_COOKIE)):
        return RedirectResponse(auth_gate.safe_next(next), status_code=303)
    return HTMLResponse(auth_gate.login_page(auth_gate.safe_next(next)), headers={"Cache-Control": "no-store"})


@router.post("/api/auth/login")
async def api_auth_login(request: _Request):
    form = parse_qs((await request.body()).decode("utf-8", "replace"))
    password = (form.get("password") or [""])[0]
    next_path = auth_gate.safe_next((form.get("next") or ["/"])[0])
    key = auth_gate.client_key(request.headers.get("x-forwarded-for"), request.client.host if request.client else "")
    wait = auth_gate.retry_after(key) if auth_gate.mode() == "on" else 0
    if wait:
        return HTMLResponse(auth_gate.login_page(next_path, f"Sai mật khẩu quá nhiều lần. Thử lại sau {wait // 60 + 1} phút."),
                            status_code=429, headers={"Retry-After": str(wait)})
    if auth_gate.mode() == "on" and auth_gate.password_ok(password):
        auth_gate.clear_failures(key)
        resp = RedirectResponse(next_path, status_code=303)
        resp.headers["Set-Cookie"] = auth_gate.cookie_header(auth_gate.create_session(), auth_gate.SESSION_DAYS * 86_400)
        return resp
    auth_gate.record_failure(key)
    await asyncio.sleep(0.8)  # slow down guessing
    return HTMLResponse(auth_gate.login_page(next_path, "Mật khẩu không đúng."), status_code=401)


@router.get("/api/auth/logout")
def api_auth_logout():
    resp = RedirectResponse("/login", status_code=303)
    resp.headers["Set-Cookie"] = auth_gate.cookie_header("", 0)
    return resp
