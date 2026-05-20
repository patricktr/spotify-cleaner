import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getAuthorizeUrl } from '@/lib/spotify';

const VALID_ROLES = ['admin', 'parent', 'kid'] as const;

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const displayName = (params.get('display_name') ?? '').trim();
  const role = params.get('role') ?? 'parent';
  const cleanupEnabled = params.get('cleanup_enabled') === 'true';

  if (!displayName) {
    return new NextResponse('display_name is required', { status: 400 });
  }
  if (!VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
    return new NextResponse(`Invalid role; expected one of: ${VALID_ROLES.join(', ')}`, { status: 400 });
  }

  const state = randomBytes(16).toString('base64url');
  const payload = JSON.stringify({ state, displayName, role, cleanupEnabled });
  const cookieValue = Buffer.from(payload).toString('base64url');

  const response = NextResponse.redirect(getAuthorizeUrl(state));
  response.cookies.set('spotify_oauth', cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });
  return response;
}
