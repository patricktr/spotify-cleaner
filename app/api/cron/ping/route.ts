import { sql } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  console.log('[ping] handler start');
  const t0 = Date.now();
  try {
    console.log('[ping] running SELECT 1');
    const rows = (await sql`SELECT 1 AS one, now() AS db_now`) as unknown as Array<{ one: number; db_now: string }>;
    const ms = Date.now() - t0;
    console.log('[ping] SELECT ok', { ms, rows });
    return NextResponse.json({ ok: true, ms, rows });
  } catch (e) {
    const ms = Date.now() - t0;
    console.error('[ping] SELECT failed', { ms, error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { ok: false, ms, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
