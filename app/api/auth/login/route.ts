import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

const COOKIE_NAME = 'admin_session';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function computeExpectedToken(): string | null {
  const password = process.env.ADMIN_PASSWORD;
  const encKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!password || !encKey) return null;
  return createHash('sha256').update(password + encKey).digest('base64url');
}

function isSafeNext(next: unknown): next is string {
  if (typeof next !== 'string' || next.length === 0) return false;
  // Only allow same-origin paths.
  if (!next.startsWith('/')) return false;
  if (next.startsWith('//')) return false;
  return true;
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const password = form.get('password');
  const nextParam = form.get('next');
  const next = isSafeNext(nextParam) ? nextParam : '/';

  const expected = computeExpectedToken();
  const submitted = process.env.ADMIN_PASSWORD;

  if (!expected || !submitted) {
    return new NextResponse('Server is missing ADMIN_PASSWORD or TOKEN_ENCRYPTION_KEY.', {
      status: 500,
    });
  }

  if (typeof password !== 'string' || password !== submitted) {
    const redirectUrl = new URL('/login', req.url);
    redirectUrl.searchParams.set('error', 'invalid');
    if (next !== '/') redirectUrl.searchParams.set('next', next);
    return NextResponse.redirect(redirectUrl, { status: 303 });
  }

  const response = NextResponse.redirect(new URL(next, req.url), { status: 303 });
  response.cookies.set(COOKIE_NAME, expected, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
