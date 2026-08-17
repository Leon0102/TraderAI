// Vercel Routing Middleware — gates the entire site (pages + /api/*) behind
// HTTP Basic Auth. Runs at the platform edge before the CDN cache, so it
// can't be bypassed by viewing page source or calling /api/* directly.
import { next } from '@vercel/functions';

const SITE_PASSWORD = '01022001';

function unauthorized(): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="TraderAI"' },
  });
}

export default function middleware(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Basic ')) {
    try {
      const decoded = atob(authHeader.slice('Basic '.length));
      const password = decoded.split(':').slice(1).join(':');
      if (password === SITE_PASSWORD) {
        return next();
      }
    } catch {
      // fall through to unauthorized
    }
  }
  return unauthorized();
}

export const config = {
  matcher: ['/((?!favicon.ico).*)'],
};
