import { NextRequest, NextResponse } from 'next/server';

// Edge-runtime safe: must use Web Crypto, not node:crypto.

const COOKIE_NAME = 'admin_session';

// Allowlisted paths that skip the password gate.
// Order doesn't matter; checked individually.
const ALLOWED_EXACT = new Set<string>([
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/spotify/callback',
]);

const ALLOWED_PREFIX: readonly string[] = [
  '/api/cron/',
  '/_next/',
];

const ALLOWED_FILE_RE = /\.(?:ico|png|jpg|jpeg|gif|svg|webp|avif|css|js|map|txt|xml|woff|woff2|ttf|otf)$/i;

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa is available in the Edge runtime.
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function computeExpectedToken(): Promise<string | null> {
  const password = process.env.ADMIN_PASSWORD;
  const encKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!password || !encKey) return null;
  const input = new TextEncoder().encode(password + encKey);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return bytesToBase64Url(new Uint8Array(digest));
}

// Cache the expected token once per module instance.
let expectedTokenPromise: Promise<string | null> | null = null;
function getExpectedToken(): Promise<string | null> {
  if (!expectedTokenPromise) {
    expectedTokenPromise = computeExpectedToken();
  }
  return expectedTokenPromise;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAllowed(pathname: string): boolean {
  if (ALLOWED_EXACT.has(pathname)) return true;
  for (const prefix of ALLOWED_PREFIX) {
    if (pathname.startsWith(prefix)) return true;
  }
  if (pathname === '/favicon.ico') return true;
  if (ALLOWED_FILE_RE.test(pathname)) return true;
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (isAllowed(pathname)) {
    return NextResponse.next();
  }

  const expected = await getExpectedToken();
  if (expected) {
    const cookie = req.cookies.get(COOKIE_NAME)?.value;
    if (cookie && constantTimeEqual(cookie, expected)) {
      return NextResponse.next();
    }
  }

  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('next', pathname + (search || ''));
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Match all paths; the handler itself does the allowlist filtering.
  // Exclude Next.js internals at the matcher level too, as a small perf win.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
