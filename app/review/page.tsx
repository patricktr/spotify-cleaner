import { revalidatePath } from 'next/cache';
import { sql } from '@/lib/db';
import { getAccountWithToken, unlikeTracks } from '@/lib/spotify-client';

export const dynamic = 'force-dynamic';

interface ReviewRow {
  account_id: string;
  account_name: string;
  track_id: string;
  track_name: string;
  artist_name: string | null;
  artist_followers: number | null;
  track_popularity: number | null;
  release_date: Date | null;
  preview_url: string | null;
  verdict: string;
  confidence: number;
  signals: Record<string, unknown> | null;
  liked_at: Date;
}

function formatFollowers(n: number | null): string {
  if (n === null || n === undefined) return '?';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? m.toFixed(1) : m.toFixed(2)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return n.toLocaleString('en-US');
}

function getReasoning(signals: Record<string, unknown> | null): string | null {
  if (!signals || typeof signals !== 'object') return null;
  const r = (signals as Record<string, unknown>).llm_reasoning;
  if (typeof r === 'string' && r.trim().length > 0) return r;
  return null;
}

async function keepTrack(formData: FormData) {
  'use server';
  const accountId = formData.get('account_id');
  const trackId = formData.get('track_id');
  if (typeof accountId !== 'string' || typeof trackId !== 'string') return;
  await sql`
    INSERT INTO reviews (track_id, account_id, decision)
    VALUES (${trackId}, ${accountId}, 'keep')
  `;
  revalidatePath('/review');
}

async function unlikeTrack(formData: FormData) {
  'use server';
  const accountId = formData.get('account_id');
  const trackId = formData.get('track_id');
  if (typeof accountId !== 'string' || typeof trackId !== 'string') return;

  // a) Record the review decision
  await sql`
    INSERT INTO reviews (track_id, account_id, decision)
    VALUES (${trackId}, ${accountId}, 'unlike')
  `;

  // b) Latest classification id (nullable)
  const classRows = (await sql`
    SELECT id FROM classifications
    WHERE track_id = ${trackId}
    ORDER BY created_at DESC
    LIMIT 1
  `) as unknown as Array<{ id: number }>;
  const classificationId = classRows[0]?.id ?? null;

  // c) Prior liked_at from the active library_likes row (nullable)
  const likeRows = (await sql`
    SELECT liked_at FROM library_likes
    WHERE account_id = ${accountId}
      AND track_id = ${trackId}
      AND removed_at IS NULL
    ORDER BY first_seen_at DESC
    LIMIT 1
  `) as unknown as Array<{ liked_at: Date }>;
  const priorLikedAt = likeRows[0]?.liked_at ?? null;

  // d) Attempt the Spotify unlike, but don't block the review record on failure
  try {
    const account = await getAccountWithToken(accountId);
    await unlikeTracks(account.access_token, [trackId]);
  } catch (e) {
    console.error('Spotify unlike failed', e);
    // Continue — record the review decision either way
  }

  // e) Audit row
  await sql`
    INSERT INTO actions (account_id, track_id, action, classification_id, prior_liked_at)
    VALUES (${accountId}, ${trackId}, 'unlike', ${classificationId}, ${priorLikedAt})
  `;

  // f) Mark library_likes removed by cleaner
  await sql`
    UPDATE library_likes
    SET removed_at = now(), removed_by = 'cleaner'
    WHERE account_id = ${accountId}
      AND track_id = ${trackId}
      AND removed_at IS NULL
  `;

  // g) Refresh views
  revalidatePath('/review');
  revalidatePath('/');
}

export default async function ReviewPage() {
  const rows = (await sql`
    SELECT
      account_id, account_name, track_id, track_name, artist_name,
      artist_followers, track_popularity, release_date, preview_url,
      verdict, confidence, signals, liked_at
    FROM review_queue
    ORDER BY confidence ASC
  `) as unknown as ReviewRow[];

  const count = rows.length;

  return (
    <section className="section">
      <div className="section-header">
        <h2>
          {count === 0
            ? 'All caught up.'
            : `${count} ${count === 1 ? 'track' : 'tracks'} awaiting review`}
        </h2>
      </div>

      {count === 0 ? (
        <div className="card">
          <p className="review-empty">Nothing in the review queue right now.</p>
        </div>
      ) : (
        <div className="card">
          <ul className="review-list">
            {rows.map((r) => {
              const reasoning = getReasoning(r.signals);
              const popularity =
                typeof r.track_popularity === 'number' ? r.track_popularity : null;
              return (
                <li key={`${r.account_id}-${r.track_id}`} className="review-row">
                  <div className="review-meta">
                    <div>
                      <strong>{r.track_name}</strong>
                    </div>
                    <div className="muted">{r.artist_name ?? 'Unknown artist'}</div>
                    <div>
                      <span className="badge">{r.account_name}</span>
                    </div>
                    <div className="review-stats">
                      ~{formatFollowers(r.artist_followers)} followers
                      {popularity !== null && <> &middot; popularity {popularity}</>}
                    </div>
                    {reasoning && (
                      <p className="review-reasoning">{reasoning}</p>
                    )}
                    {r.preview_url ? (
                      <audio
                        controls
                        preload="none"
                        src={r.preview_url}
                      />
                    ) : (
                      <span className="muted">(no preview)</span>
                    )}
                  </div>
                  <div className="review-actions">
                    <form action={keepTrack}>
                      <input type="hidden" name="account_id" value={r.account_id} />
                      <input type="hidden" name="track_id" value={r.track_id} />
                      <button type="submit" className="btn btn-authentic">
                        Authentic
                      </button>
                    </form>
                    <form action={unlikeTrack}>
                      <input type="hidden" name="account_id" value={r.account_id} />
                      <input type="hidden" name="track_id" value={r.track_id} />
                      <button type="submit" className="btn btn-brain-rot">
                        Brain rot
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
