import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import middleware, { SESSION_COOKIE, createSessionToken, isValidSession } from './middleware';

const SECRET = 'x'.repeat(40);
const BASE = 'https://trader.example.com';

function login(password: string, next = '/') {
  const body = new URLSearchParams({ password, next });
  return middleware(new Request(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }));
}

describe('auth middleware', () => {
  beforeEach(() => {
    vi.stubEnv('APP_PASSWORD', 'correct horse');
    vi.stubEnv('AUTH_SECRET', SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails closed when env vars are missing', async () => {
    vi.stubEnv('APP_PASSWORD', '');
    const res = await middleware(new Request(`${BASE}/`));
    expect(res.status).toBe(503);
  });

  it('redirects pages to /login and rejects API calls without a session', async () => {
    const page = await middleware(new Request(`${BASE}/?tab=chart`));
    expect(page.status).toBe(303);
    expect(page.headers.get('Location')).toBe('/login?next=%2F%3Ftab%3Dchart');

    const api = await middleware(new Request(`${BASE}/api/stocks`));
    expect(api.status).toBe(401);
  });

  it('rejects a wrong password without setting a cookie', async () => {
    const res = await login('wrong'); // includes the deliberate ~800ms anti-guessing delay
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('logs in with the right password and the cookie grants access', async () => {
    const res = await login('correct horse', '/#chart');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/#chart');
    const cookie = res.headers.get('Set-Cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);

    const token = cookie.split(';')[0];
    const api = await middleware(new Request(`${BASE}/api/stocks`, { headers: { cookie: token } }));
    expect(api.status).not.toBe(401);
    expect(api.headers.get('x-middleware-next')).toBe('1');
  });

  it('does not allow open redirects after login', async () => {
    const res = await login('correct horse', '//evil.example.com');
    expect(res.headers.get('Location')).toBe('/');
  });

  it('rejects forged, tampered and expired session tokens', async () => {
    const token = await createSessionToken(SECRET);
    expect(await isValidSession(token, SECRET)).toBe(true);
    expect(await isValidSession(token, 'y'.repeat(40))).toBe(false);
    const [expires, sig] = token.split('.');
    expect(await isValidSession(`${Number(expires) + 1}.${sig}`, SECRET)).toBe(false);
    const expired = await createSessionToken(SECRET, Date.now() - 31 * 86_400_000);
    expect(await isValidSession(expired, SECRET)).toBe(false);

    const res = await middleware(new Request(`${BASE}/api/stocks`, { headers: { cookie: `${SESSION_COOKIE}=123.abc` } }));
    expect(res.status).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const res = await middleware(new Request(`${BASE}/api/auth/logout`));
    expect(res.headers.get('Location')).toBe('/login');
    expect(res.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);
  });
});
