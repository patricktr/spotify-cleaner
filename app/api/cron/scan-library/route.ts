import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { scanAccount } from '@/lib/scan';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // Scan ALL accounts with tokens — classification is decoupled from the
  // auto-unlike action. Whether to actually unlike is gated per-account inside
  // scanAccount() by cleanup_enabled, so disabling cleanup gives you a pure
  // dry-run that just populates classifications + library_likes.
  //
  // Optional ?account_id=... query param scopes the scan to a single account
  // (useful for manual triggers — Vercel function timeout is 300s, so scanning
  // multiple large libraries in one request can exceed it).
  // One-shot backfill (idempotent): repair tracks whose primary_artist_id
  // landed null at first-insert time. The track INSERT used to never update
  // primary_artist_id on conflict, so a one-time null stuck around forever,
  // showing as "(unknown artist)" on the review page. This UPDATE only touches
  // rows where (a) primary is null AND (b) artist_ids has an entry AND (c) that
  // artist row exists, so it's FK-safe and a no-op after the first run. Cheap
  // enough to leave in the cron path; no Spotify calls involved.
  const backfilled = (await sql`
    UPDATE tracks t
    SET primary_artist_id = t.artist_ids[1]
    WHERE t.primary_artist_id IS NULL
      AND array_length(t.artist_ids, 1) >= 1
      AND EXISTS (SELECT 1 FROM artists a WHERE a.id = t.artist_ids[1])
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  if (backfilled.length > 0) {
    console.log('[scan-library] backfilled primary_artist_id', { count: backfilled.length });
  }

  const accountIdFilter = req.nextUrl.searchParams.get('account_id');
  const accounts = accountIdFilter
    ? ((await sql`
        SELECT id FROM spotify_accounts
        WHERE id = ${accountIdFilter} AND refresh_token_encrypted IS NOT NULL
      `) as unknown as Array<{ id: string }>)
    : ((await sql`
        SELECT id FROM spotify_accounts
        WHERE refresh_token_encrypted IS NOT NULL
      `) as unknown as Array<{ id: string }>);

  const results: Array<unknown> = [];
  for (const a of accounts) {
    try {
      results.push(await scanAccount(a.id));
    } catch (e) {
      results.push({ accountId: a.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ ok: true, count: accounts.length, results });
}
