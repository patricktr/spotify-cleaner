import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { exchangeCodeForTokens, getMe } from '@/lib/spotify';
import { encrypt } from '@/lib/crypto';

interface OAuthPayload {
  state: string;
  displayName: string;
  role: 'admin' | 'parent' | 'kid';
  cleanupEnabled: boolean;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get('code');
  const state = params.get('state');
  const errorParam = params.get('error');

  if (errorParam) {
    return new NextResponse(`Spotify OAuth error: ${errorParam}`, { status: 400 });
  }
  if (!code || !state) {
    return new NextResponse('Missing code or state', { status: 400 });
  }

  const cookieValue = req.cookies.get('spotify_oauth')?.value;
  if (!cookieValue) {
    return new NextResponse('Missing OAuth session cookie (expired or stripped)', { status: 400 });
  }

  let payload: OAuthPayload;
  try {
    payload = JSON.parse(Buffer.from(cookieValue, 'base64url').toString('utf8'));
  } catch {
    return new NextResponse('Malformed OAuth cookie', { status: 400 });
  }

  if (payload.state !== state) {
    return new NextResponse('State mismatch', { status: 400 });
  }

  const tokens = await exchangeCodeForTokens(code);
  const me = await getMe(tokens.access_token);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  await sql`
    INSERT INTO spotify_accounts (
      display_name, role, spotify_user_id,
      refresh_token_encrypted, access_token_encrypted, access_token_expires_at,
      scopes, cleanup_enabled
    )
    VALUES (
      ${payload.displayName}, ${payload.role}, ${me.id},
      ${encrypt(tokens.refresh_token)}, ${encrypt(tokens.access_token)}, ${expiresAt},
      ${tokens.scope.split(' ')}, ${payload.cleanupEnabled}
    )
    ON CONFLICT (spotify_user_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      role = EXCLUDED.role,
      refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
      access_token_encrypted = EXCLUDED.access_token_encrypted,
      access_token_expires_at = EXCLUDED.access_token_expires_at,
      scopes = EXCLUDED.scopes,
      cleanup_enabled = EXCLUDED.cleanup_enabled,
      updated_at = now()
  `;

  const response = NextResponse.redirect(new URL('/', req.url));
  response.cookies.delete('spotify_oauth');
  return response;
}
