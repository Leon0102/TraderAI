// Vercel Routing Middleware — gates the entire site (pages + /api/*) behind a
// password login. Runs at the platform edge before the CDN cache, so it can't
// be bypassed by viewing page source or calling /api/* directly.
//
// Required Vercel environment variables (never commit them — this repo is public):
//   APP_PASSWORD  the login password
//   AUTH_SECRET   random string (>= 32 chars) used to sign session cookies;
//                 changing it logs out every session
import { next } from '@vercel/functions';

export const SESSION_COOKIE = 'traderai_session';
const SESSION_DAYS = 30;
const LOGIN_PATH = '/login';
const LOGIN_API = '/api/auth/login';
const LOGOUT_API = '/api/auth/logout';

const encoder = new TextEncoder();

function getEnv() {
  // `process` is injected by Vercel at runtime but is not part of the browser
  // TypeScript configuration used by this project.
  const env = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const password = env?.APP_PASSWORD ?? '';
  const secret = env?.AUTH_SECRET ?? '';
  return { password, secret, configured: password.length > 0 && secret.length >= 32 };
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Compare via HMAC digests so the check takes the same time whatever the input length. */
async function passwordMatches(input: string, expected: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([hmacHex(secret, `pw:${input}`), hmacHex(secret, `pw:${expected}`)]);
  return timingSafeEqual(a, b);
}

export async function createSessionToken(secret: string, now = Date.now()): Promise<string> {
  const expires = now + SESSION_DAYS * 86_400_000;
  return `${expires}.${await hmacHex(secret, `session:${expires}`)}`;
}

export async function isValidSession(token: string | undefined, secret: string, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const [expires, sig] = token.split('.');
  const expiresAt = Number(expires);
  if (!sig || !Number.isFinite(expiresAt) || expiresAt < now) return false;
  return timingSafeEqual(sig, await hmacHex(secret, `session:${expiresAt}`));
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Only allow same-site relative redirects after login (no open redirect). */
function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/api/') ? value : '/';
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', ...extraHeaders } });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function loginPage(nextPath: string, error?: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Đăng nhập · TraderAI</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    font-family: Inter, system-ui, -apple-system, sans-serif; background: #0a0e17; color: #e5e7eb; }
  .card { width: 100%; max-width: 380px; background: #1a2236; border: 1px solid rgba(255,255,255,.08);
    border-radius: 16px; padding: 32px 28px; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
  .brand { font-size: 1.4rem; font-weight: 800; margin: 0 0 6px; }
  .brand span { color: #818cf8; }
  p { margin: 0 0 24px; color: #9ca3af; font-size: .9rem; }
  label { display: block; font-size: .8rem; color: #9ca3af; margin-bottom: 6px; }
  input { width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,.12);
    background: #111827; color: #e5e7eb; font-size: 1rem; }
  input:focus { outline: 2px solid #6366f1; outline-offset: 1px; border-color: transparent; }
  button { margin-top: 16px; width: 100%; padding: 12px; border: 0; border-radius: 10px; cursor: pointer;
    background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; font-weight: 700; font-size: 1rem; }
  .error { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; font-size: .85rem;
    background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.3); color: #f87171; }
</style>
</head>
<body>
  <form class="card" method="post" action="${LOGIN_API}">
    <h1 class="brand">📈 Trader<span>AI</span></h1>
    <p>Khu vực riêng tư. Vui lòng đăng nhập để tiếp tục.</p>
    ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
    <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
    <label for="password">Mật khẩu</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
    <button type="submit">Đăng nhập</button>
  </form>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

export default async function middleware(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { password, secret, configured } = getEnv();

  if (!configured) {
    // Fail closed: never serve the app without a configured password.
    return new Response('TraderAI: APP_PASSWORD / AUTH_SECRET chưa được cấu hình trên Vercel.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  if (url.pathname === LOGIN_API && request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    const input = String(form?.get('password') ?? '');
    const nextPath = safeNext(String(form?.get('next') ?? '/'));
    if (input && (await passwordMatches(input, password, secret))) {
      const token = await createSessionToken(secret);
      return redirect(nextPath, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86_400) });
    }
    await new Promise(resolve => setTimeout(resolve, 800)); // slow down guessing
    return loginPage(nextPath, 'Mật khẩu không đúng.', 401);
  }

  if (url.pathname === LOGOUT_API) {
    return redirect(LOGIN_PATH, { 'Set-Cookie': sessionCookie('', 0) });
  }

  const authenticated = await isValidSession(readCookie(request, SESSION_COOKIE), secret);

  if (url.pathname === LOGIN_PATH) {
    return authenticated ? redirect(safeNext(url.searchParams.get('next'))) : loginPage(safeNext(url.searchParams.get('next')));
  }

  if (authenticated) return next();

  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ detail: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  return redirect(`${LOGIN_PATH}?next=${encodeURIComponent(url.pathname + url.search)}`);
}

export const config = {
  matcher: ['/((?!favicon.ico).*)'],
};
