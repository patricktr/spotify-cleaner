import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { pollPlays } from '@/lib/plays';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const accounts = (await sql`
    SELECT id FROM spotify_accounts
    WHERE refresh_token_encrypted IS NOT NULL
  `) as unknown as Array<{ id: string }>;

  const results: Array<unknown> = [];
  for (const a of accounts) {
    try {
      results.push(await pollPlays(a.id));
    } catch (e) {
      results.push({ accountId: a.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ ok: true, count: accounts.length, results });
}
