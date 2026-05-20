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

  try {
    console.log('[callback] start', { role: payload.role, displayName: payload.displayName });

    const tokens = await exchangeCodeForTokens(code);
    console.log('[callback] tokens ok', {
      scope: tokens.scope,
      has_refresh: !!tokens.refresh_token,
      expires_in: tokens.expires_in,
    });

    const me = await getMe(tokens.access_token);
    console.log('[callback] me ok', { id: me.id, display_name: me.display_name });

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    const scopes = typeof tokens.scope === 'string' && tokens.scope.length > 0 ? tokens.scope.split(' ') : [];

    await sql`
      INSERT INTO spotify_accounts (
        display_name, role, spotify_user_id,
        refresh_token_encrypted, access_token_encrypted, access_token_expires_at,
        scopes, cleanup_enabled
      )
      VALUES (
        ${payload.displayName}, ${payload.role}, ${me.id},
        ${encrypt(tokens.refresh_token)}, ${encrypt(tokens.access_token)}, ${expiresAt},
        ${scopes}, ${payload.cleanupEnabled}
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
    console.log('[callback] db ok', { spotify_user_id: me.id });

    const response = NextResponse.redirect(new URL('/', req.url));
    response.cookies.delete('spotify_oauth');
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[callback] failed', {
      role: payload.role,
      displayName: payload.displayName,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return new NextResponse(
      `Connect failed for ${payload.displayName} (${payload.role}): ${message}\n\nGo back to https://filter.rousseau.nyc and try again. Check Vercel runtime logs for the full stack.`,
      { status: 500, headers: { 'content-type': 'text/plain' } },
    );
  }
}
