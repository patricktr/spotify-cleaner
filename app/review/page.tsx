import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

// =============================================================================
// Types
// =============================================================================

type Verdict = 'authentic' | 'brain_rot' | 'borderline';
type SortKey = 'conf_asc' | 'conf_desc' | 'recent' | 'alpha';
type ReviewDecision = 'keep' | 'unlike' | 'protect' | 'always_unlike';
type ReviewFilter = 'all' | 'marked' | 'unmarked';

interface AccountOption {
  id: string;
  display_name: string;
}

interface ClassificationSignals {
  heuristics?: unknown;
  llm_reasoning?: unknown;
  llm_model?: unknown;
  heuristics_only?: unknown;
  note?: unknown;
}

interface ClassificationRow {
  account_id: string;
  account_name: string;
  track_id: string;
  track_name: string;
  artist_name: string | null;
  liked_at: Date;
  verdict: Verdict;
  confidence: number;
  signals: ClassificationSignals | null;
  classifier_version: string;
  classified_at: Date;
  review_decision: ReviewDecision | null;
}

// =============================================================================
// Server actions
//
// Critical: these write only to the `reviews` table. They do NOT call the
// Spotify unlike API. The cleanup cron is the only place that talks to Spotify.
// =============================================================================

async function markAuthentic(formData: FormData) {
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

async function markBrainRot(formData: FormData) {
  'use server';
  const accountId = formData.get('account_id');
  const trackId = formData.get('track_id');
  if (typeof accountId !== 'string' || typeof trackId !== 'string') return;
  await sql`
    INSERT INTO reviews (track_id, account_id, decision)
    VALUES (${trackId}, ${accountId}, 'unlike')
  `;
  revalidatePath('/review');
}

async function clearReview(formData: FormData) {
  'use server';
  const accountId = formData.get('account_id');
  const trackId = formData.get('track_id');
  if (typeof accountId !== 'string' || typeof trackId !== 'string') return;
  await sql`
    DELETE FROM reviews
    WHERE track_id = ${trackId}
      AND (account_id = ${accountId} OR account_id IS NULL)
  `;
  revalidatePath('/review');
}

// =============================================================================
// Filter parsing
// =============================================================================

const ALL_VERDICTS: Verdict[] = ['authentic', 'brain_rot', 'borderline'];

function parseAccount(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // Accept only UUID-shaped strings to avoid SQL surprises (parameterized anyway,
  // but keeps the filter chip state sane).
  if (!/^[0-9a-f-]{32,40}$/i.test(raw)) return null;
  return raw;
}

function parseVerdicts(raw: string | string[] | undefined): Verdict[] {
  if (typeof raw !== 'string' || raw.length === 0) return ALL_VERDICTS;
  const tokens = raw.split(',').map((s) => s.trim());
  const matched = tokens.filter((t): t is Verdict =>
    ALL_VERDICTS.includes(t as Verdict),
  );
  if (matched.length === 0) return ALL_VERDICTS;
  return matched;
}

function parseSort(raw: string | string[] | undefined): SortKey {
  if (raw === 'conf_desc' || raw === 'recent' || raw === 'alpha') return raw;
  return 'conf_asc';
}

function parseReview(raw: string | string[] | undefined): ReviewFilter {
  if (raw === 'marked' || raw === 'unmarked') return raw;
  return 'all';
}

// Build a URL string for filter links, mutating one param at a time.
function buildUrl(params: {
  account: string | null;
  verdicts: Verdict[];
  sort: SortKey;
  review: ReviewFilter;
}): string {
  const search = new URLSearchParams();
  if (params.account) search.set('account', params.account);
  if (params.verdicts.length !== ALL_VERDICTS.length) {
    // Preserve canonical ordering for stable URLs
    const ordered = ALL_VERDICTS.filter((v) => params.verdicts.includes(v));
    search.set('verdict', ordered.join(','));
  }
  if (params.sort !== 'conf_asc') search.set('sort', params.sort);
  if (params.review !== 'all') search.set('review', params.review);
  const qs = search.toString();
  return qs ? `/review?${qs}` : '/review';
}

// =============================================================================
// Signals rendering
// =============================================================================

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

interface RenderedSignals {
  heuristics: string | null;
  llmReasoning: string | null;
  heuristicsOnlyNote: string | null;
}

function renderSignals(signals: ClassificationSignals | null): RenderedSignals {
  if (!signals || typeof signals !== 'object') {
    return { heuristics: null, llmReasoning: null, heuristicsOnlyNote: null };
  }
  let heuristics: string | null = null;
  if (Array.isArray(signals.heuristics)) {
    const items = signals.heuristics.filter(
      (h): h is string => typeof h === 'string',
    );
    if (items.length > 0) heuristics = truncate(items.join(', '), 140);
  }
  let llmReasoning: string | null = null;
  if (typeof signals.llm_reasoning === 'string') {
    const r = signals.llm_reasoning.trim();
    if (r.length > 0) llmReasoning = truncate(r, 220);
  }
  let heuristicsOnlyNote: string | null = null;
  if (signals.heuristics_only === true && typeof signals.note === 'string') {
    heuristicsOnlyNote = signals.note;
  }
  return { heuristics, llmReasoning, heuristicsOnlyNote };
}

// =============================================================================
// Page
// =============================================================================

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReviewPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const account = parseAccount(params.account);
  const verdicts = parseVerdicts(params.verdict);
  const sort = parseSort(params.sort);
  const review = parseReview(params.review);

  // -- Accounts for the filter dropdown -------------------------------------
  const accountRows = (await sql`
    SELECT id, display_name
    FROM spotify_accounts
    ORDER BY created_at ASC
  `) as unknown as AccountOption[];

  // -- Main query -----------------------------------------------------------
  //
  // DISTINCT ON to pick the latest classification per track; the LATERAL view
  // pulls the latest review per (track, account) including reviews with NULL
  // account_id (applies to all accounts).
  //
  // We pass arrays/values via tagged template; Neon's `sql` handles parameter
  // binding. The verdict filter uses ANY(<array>); the account filter is
  // optional and applied with a CASE-style guard.
  const accountFilter = account ?? null;
  const verdictArray = verdicts;
  const reviewFilter = review;

  let orderClause: string;
  switch (sort) {
    case 'conf_desc':
      orderClause = 'confidence DESC NULLS LAST, classified_at DESC';
      break;
    case 'recent':
      orderClause = 'classified_at DESC';
      break;
    case 'alpha':
      orderClause = 'lower(track_name) ASC, lower(account_name) ASC';
      break;
    case 'conf_asc':
    default:
      orderClause = 'confidence ASC NULLS FIRST, classified_at DESC';
  }

  // We can't use Neon's tagged template to splice raw ORDER BY safely, so we
  // build the query as a string and pass parameters positionally via .query()
  // -- but Neon's `neon()` http client only exposes the tagged-template API.
  // Workaround: branch on sort to inline a fixed ORDER BY string we control,
  // then use the tagged template for value parameters.
  let rawRows: unknown[];
  if (sort === 'conf_desc') {
    rawRows = await sql`
      WITH latest_class AS (
        SELECT DISTINCT ON (track_id) track_id, verdict, confidence, signals,
          classifier_version, created_at AS classified_at
        FROM classifications
        ORDER BY track_id, created_at DESC
      ),
      latest_review AS (
        SELECT DISTINCT ON (track_id, COALESCE(account_id::text, '*'))
          track_id, account_id, decision, reviewed_at
        FROM reviews
        ORDER BY track_id, COALESCE(account_id::text, '*'), reviewed_at DESC
      )
      SELECT
        ll.account_id,
        sa.display_name AS account_name,
        t.id AS track_id,
        t.name AS track_name,
        a.name AS artist_name,
        ll.liked_at,
        lc.verdict,
        lc.confidence,
        lc.signals,
        lc.classifier_version,
        lc.classified_at,
        lr_specific.decision AS specific_decision,
        lr_global.decision   AS global_decision
      FROM library_likes ll
        JOIN spotify_accounts sa ON sa.id = ll.account_id
        JOIN tracks t ON t.id = ll.track_id
        LEFT JOIN artists a ON a.id = t.primary_artist_id
        JOIN latest_class lc ON lc.track_id = t.id
        LEFT JOIN latest_review lr_specific
          ON lr_specific.track_id = t.id AND lr_specific.account_id = ll.account_id
        LEFT JOIN latest_review lr_global
          ON lr_global.track_id = t.id AND lr_global.account_id IS NULL
      WHERE ll.removed_at IS NULL
        AND (${accountFilter}::uuid IS NULL OR ll.account_id = ${accountFilter}::uuid)
        AND lc.verdict = ANY(${verdictArray}::text[])
        AND (
          ${reviewFilter}::text = 'all'
          OR (${reviewFilter}::text = 'marked'
              AND (lr_specific.decision IS NOT NULL OR lr_global.decision IS NOT NULL))
          OR (${reviewFilter}::text = 'unmarked'
              AND lr_specific.decision IS NULL AND lr_global.decision IS NULL)
        )
      ORDER BY lc.confidence DESC NULLS LAST, lc.classified_at DESC
    `;
  } else if (sort === 'recent') {
    rawRows = await sql`
      WITH latest_class AS (
        SELECT DISTINCT ON (track_id) track_id, verdict, confidence, signals,
          classifier_version, created_at AS classified_at
        FROM classifications
        ORDER BY track_id, created_at DESC
      ),
      latest_review AS (
        SELECT DISTINCT ON (track_id, COALESCE(account_id::text, '*'))
          track_id, account_id, decision, reviewed_at
        FROM reviews
        ORDER BY track_id, COALESCE(account_id::text, '*'), reviewed_at DESC
      )
      SELECT
        ll.account_id,
        sa.display_name AS account_name,
        t.id AS track_id,
        t.name AS track_name,
        a.name AS artist_name,
        ll.liked_at,
        lc.verdict,
        lc.confidence,
        lc.signals,
        lc.classifier_version,
        lc.classified_at,
        lr_specific.decision AS specific_decision,
        lr_global.decision   AS global_decision
      FROM library_likes ll
        JOIN spotify_accounts sa ON sa.id = ll.account_id
        JOIN tracks t ON t.id = ll.track_id
        LEFT JOIN artists a ON a.id = t.primary_artist_id
        JOIN latest_class lc ON lc.track_id = t.id
        LEFT JOIN latest_review lr_specific
          ON lr_specific.track_id = t.id AND lr_specific.account_id = ll.account_id
        LEFT JOIN latest_review lr_global
          ON lr_global.track_id = t.id AND lr_global.account_id IS NULL
      WHERE ll.removed_at IS NULL
        AND (${accountFilter}::uuid IS NULL OR ll.account_id = ${accountFilter}::uuid)
        AND lc.verdict = ANY(${verdictArray}::text[])
        AND (
          ${reviewFilter}::text = 'all'
          OR (${reviewFilter}::text = 'marked'
              AND (lr_specific.decision IS NOT NULL OR lr_global.decision IS NOT NULL))
          OR (${reviewFilter}::text = 'unmarked'
              AND lr_specific.decision IS NULL AND lr_global.decision IS NULL)
        )
      ORDER BY lc.classified_at DESC
    `;
  } else if (sort === 'alpha') {
    rawRows = await sql`
      WITH latest_class AS (
        SELECT DISTINCT ON (track_id) track_id, verdict, confidence, signals,
          classifier_version, created_at AS classified_at
        FROM classifications
        ORDER BY track_id, created_at DESC
      ),
      latest_review AS (
        SELECT DISTINCT ON (track_id, COALESCE(account_id::text, '*'))
          track_id, account_id, decision, reviewed_at
        FROM reviews
        ORDER BY track_id, COALESCE(account_id::text, '*'), reviewed_at DESC
      )
      SELECT
        ll.account_id,
        sa.display_name AS account_name,
        t.id AS track_id,
        t.name AS track_name,
        a.name AS artist_name,
        ll.liked_at,
        lc.verdict,
        lc.confidence,
        lc.signals,
        lc.classifier_version,
        lc.classified_at,
        lr_specific.decision AS specific_decision,
        lr_global.decision   AS global_decision
      FROM library_likes ll
        JOIN spotify_accounts sa ON sa.id = ll.account_id
        JOIN tracks t ON t.id = ll.track_id
        LEFT JOIN artists a ON a.id = t.primary_artist_id
        JOIN latest_class lc ON lc.track_id = t.id
        LEFT JOIN latest_review lr_specific
          ON lr_specific.track_id = t.id AND lr_specific.account_id = ll.account_id
        LEFT JOIN latest_review lr_global
          ON lr_global.track_id = t.id AND lr_global.account_id IS NULL
      WHERE ll.removed_at IS NULL
        AND (${accountFilter}::uuid IS NULL OR ll.account_id = ${accountFilter}::uuid)
        AND lc.verdict = ANY(${verdictArray}::text[])
        AND (
          ${reviewFilter}::text = 'all'
          OR (${reviewFilter}::text = 'marked'
              AND (lr_specific.decision IS NOT NULL OR lr_global.decision IS NOT NULL))
          OR (${reviewFilter}::text = 'unmarked'
              AND lr_specific.decision IS NULL AND lr_global.decision IS NULL)
        )
      ORDER BY lower(t.name) ASC, lower(sa.display_name) ASC
    `;
  } else {
    // conf_asc (default)
    rawRows = await sql`
      WITH latest_class AS (
        SELECT DISTINCT ON (track_id) track_id, verdict, confidence, signals,
          classifier_version, created_at AS classified_at
        FROM classifications
        ORDER BY track_id, created_at DESC
      ),
      latest_review AS (
        SELECT DISTINCT ON (track_id, COALESCE(account_id::text, '*'))
          track_id, account_id, decision, reviewed_at
        FROM reviews
        ORDER BY track_id, COALESCE(account_id::text, '*'), reviewed_at DESC
      )
      SELECT
        ll.account_id,
        sa.display_name AS account_name,
        t.id AS track_id,
        t.name AS track_name,
        a.name AS artist_name,
        ll.liked_at,
        lc.verdict,
        lc.confidence,
        lc.signals,
        lc.classifier_version,
        lc.classified_at,
        lr_specific.decision AS specific_decision,
        lr_global.decision   AS global_decision
      FROM library_likes ll
        JOIN spotify_accounts sa ON sa.id = ll.account_id
        JOIN tracks t ON t.id = ll.track_id
        LEFT JOIN artists a ON a.id = t.primary_artist_id
        JOIN latest_class lc ON lc.track_id = t.id
        LEFT JOIN latest_review lr_specific
          ON lr_specific.track_id = t.id AND lr_specific.account_id = ll.account_id
        LEFT JOIN latest_review lr_global
          ON lr_global.track_id = t.id AND lr_global.account_id IS NULL
      WHERE ll.removed_at IS NULL
        AND (${accountFilter}::uuid IS NULL OR ll.account_id = ${accountFilter}::uuid)
        AND lc.verdict = ANY(${verdictArray}::text[])
        AND (
          ${reviewFilter}::text = 'all'
          OR (${reviewFilter}::text = 'marked'
              AND (lr_specific.decision IS NOT NULL OR lr_global.decision IS NOT NULL))
          OR (${reviewFilter}::text = 'unmarked'
              AND lr_specific.decision IS NULL AND lr_global.decision IS NULL)
        )
      ORDER BY lc.confidence ASC NULLS FIRST, lc.classified_at DESC
    `;
  }
  // The unused orderClause kept the branch structure tidy; suppress lint by referencing it.
  void orderClause;

  // Normalize: collapse the two review-decision columns into one (specific
  // override wins; global review fills in otherwise).
  const rows: ClassificationRow[] = (rawRows as Array<
    Omit<ClassificationRow, 'review_decision'> & {
      specific_decision: ReviewDecision | null;
      global_decision: ReviewDecision | null;
    }
  >).map((r) => ({
    account_id: r.account_id,
    account_name: r.account_name,
    track_id: r.track_id,
    track_name: r.track_name,
    artist_name: r.artist_name,
    liked_at: r.liked_at,
    verdict: r.verdict,
    confidence: r.confidence,
    signals: r.signals,
    classifier_version: r.classifier_version,
    classified_at: r.classified_at,
    review_decision: r.specific_decision ?? r.global_decision ?? null,
  }));

  const counts = {
    total: rows.length,
    authentic: rows.filter((r) => r.verdict === 'authentic').length,
    borderline: rows.filter((r) => r.verdict === 'borderline').length,
    brain_rot: rows.filter((r) => r.verdict === 'brain_rot').length,
  };

  // -- Build URLs for filter chips/dropdowns --------------------------------
  const accountUrlFor = (id: string | null) =>
    buildUrl({ account: id, verdicts, sort, review });

  const verdictUrlFor = (target: 'all' | Verdict) => {
    if (target === 'all') {
      return buildUrl({ account, verdicts: ALL_VERDICTS, sort, review });
    }
    return buildUrl({ account, verdicts: [target], sort, review });
  };

  const sortUrlFor = (s: SortKey) => buildUrl({ account, verdicts, sort: s, review });

  const reviewUrlFor = (r: ReviewFilter) => buildUrl({ account, verdicts, sort, review: r });

  const isAllVerdicts = verdicts.length === ALL_VERDICTS.length;

  return (
    <section className="section">
      <div className="section-header">
        <h2>Review classifications</h2>
      </div>

      <div className="card">
        {/* Filter bar */}
        <div className="filters-bar">
          <div className="filter-group">
            <span className="filter-label">Account</span>
            <div className="chip-row">
              <Link
                className={`chip ${account === null ? 'chip-active' : ''}`}
                href={accountUrlFor(null)}
                prefetch={false}
              >
                All
              </Link>
              {accountRows.map((a) => (
                <Link
                  key={a.id}
                  className={`chip ${account === a.id ? 'chip-active' : ''}`}
                  href={accountUrlFor(a.id)}
                  prefetch={false}
                >
                  {a.display_name}
                </Link>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <span className="filter-label">Verdict</span>
            <div className="chip-row">
              <Link
                className={`chip ${isAllVerdicts ? 'chip-active' : ''}`}
                href={verdictUrlFor('all')}
                prefetch={false}
              >
                All
              </Link>
              <Link
                className={`chip ${
                  !isAllVerdicts && verdicts.length === 1 && verdicts[0] === 'authentic'
                    ? 'chip-active'
                    : ''
                }`}
                href={verdictUrlFor('authentic')}
                prefetch={false}
              >
                Authentic
              </Link>
              <Link
                className={`chip ${
                  !isAllVerdicts && verdicts.length === 1 && verdicts[0] === 'borderline'
                    ? 'chip-active'
                    : ''
                }`}
                href={verdictUrlFor('borderline')}
                prefetch={false}
              >
                Borderline
              </Link>
              <Link
                className={`chip ${
                  !isAllVerdicts && verdicts.length === 1 && verdicts[0] === 'brain_rot'
                    ? 'chip-active'
                    : ''
                }`}
                href={verdictUrlFor('brain_rot')}
                prefetch={false}
              >
                Brain rot
              </Link>
            </div>
          </div>

          <div className="filter-group">
            <span className="filter-label">Review</span>
            <div className="chip-row">
              <Link
                className={`chip ${review === 'all' ? 'chip-active' : ''}`}
                href={reviewUrlFor('all')}
                prefetch={false}
              >
                All
              </Link>
              <Link
                className={`chip ${review === 'unmarked' ? 'chip-active' : ''}`}
                href={reviewUrlFor('unmarked')}
                prefetch={false}
              >
                Unmarked
              </Link>
              <Link
                className={`chip ${review === 'marked' ? 'chip-active' : ''}`}
                href={reviewUrlFor('marked')}
                prefetch={false}
              >
                Marked
              </Link>
            </div>
          </div>

          <div className="filter-group">
            <span className="filter-label">Sort</span>
            <div className="chip-row">
              <Link
                className={`chip ${sort === 'conf_asc' ? 'chip-active' : ''}`}
                href={sortUrlFor('conf_asc')}
                prefetch={false}
              >
                Confidence ↑
              </Link>
              <Link
                className={`chip ${sort === 'conf_desc' ? 'chip-active' : ''}`}
                href={sortUrlFor('conf_desc')}
                prefetch={false}
              >
                Confidence ↓
              </Link>
              <Link
                className={`chip ${sort === 'recent' ? 'chip-active' : ''}`}
                href={sortUrlFor('recent')}
                prefetch={false}
              >
                Most recent
              </Link>
              <Link
                className={`chip ${sort === 'alpha' ? 'chip-active' : ''}`}
                href={sortUrlFor('alpha')}
                prefetch={false}
              >
                A → Z
              </Link>
            </div>
          </div>
        </div>

        <p className="review-summary">
          {counts.total} {counts.total === 1 ? 'track' : 'tracks'} ·{' '}
          {counts.authentic} authentic · {counts.borderline} borderline ·{' '}
          {counts.brain_rot} brain rot
        </p>
      </div>

      <div className="card">
        {rows.length === 0 ? (
          <p className="review-empty">
            No classifications match the current filters.
          </p>
        ) : (
          <ul className="classification-list">
            {rows.map((r) => {
              const rendered = renderSignals(r.signals);
              const review = r.review_decision;
              const verdictClass =
                r.verdict === 'authentic'
                  ? 'verdict-authentic'
                  : r.verdict === 'brain_rot'
                    ? 'verdict-brain-rot'
                    : 'verdict-borderline';
              const verdictLabel =
                r.verdict === 'brain_rot' ? 'brain rot' : r.verdict;
              return (
                <li
                  key={`${r.account_id}-${r.track_id}`}
                  className="classification-row"
                >
                  <div className="classification-meta">
                    <div className="classification-headline">
                      <a
                        href={`https://open.spotify.com/track/${r.track_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="track-link"
                        title="Open in Spotify"
                      >
                        <strong>{r.track_name}</strong>
                      </a>
                      <span className="muted">
                        {r.artist_name ?? (
                          <em className="muted">(unknown artist)</em>
                        )}
                      </span>
                    </div>
                    <div className="classification-badges">
                      <span className="badge">{r.account_name}</span>
                      <span className={`badge ${verdictClass}`}>
                        {verdictLabel}
                      </span>
                      <span className="badge badge-confidence">
                        {r.confidence.toFixed(2)}
                      </span>
                      {review === 'keep' && (
                        <span className="badge badge-review badge-review-keep">
                          marked: keep
                        </span>
                      )}
                      {review === 'protect' && (
                        <span className="badge badge-review badge-review-keep">
                          marked: protect
                        </span>
                      )}
                      {review === 'unlike' && (
                        <span className="badge badge-review badge-review-unlike">
                          marked: brain rot
                        </span>
                      )}
                      {review === 'always_unlike' && (
                        <span className="badge badge-review badge-review-unlike">
                          marked: always unlike
                        </span>
                      )}
                    </div>
                    {rendered.heuristics && (
                      <p className="signals">{rendered.heuristics}</p>
                    )}
                    {rendered.llmReasoning && (
                      <p className="signals signals-llm">
                        {rendered.llmReasoning}
                      </p>
                    )}
                    {rendered.heuristicsOnlyNote && (
                      <p className="signals signals-note">
                        {rendered.heuristicsOnlyNote}
                      </p>
                    )}
                  </div>
                  <div className="classification-actions">
                    <form action={markAuthentic}>
                      <input
                        type="hidden"
                        name="account_id"
                        value={r.account_id}
                      />
                      <input
                        type="hidden"
                        name="track_id"
                        value={r.track_id}
                      />
                      <button
                        type="submit"
                        className="btn btn-sm btn-authentic"
                      >
                        Authentic
                      </button>
                    </form>
                    <form action={markBrainRot}>
                      <input
                        type="hidden"
                        name="account_id"
                        value={r.account_id}
                      />
                      <input
                        type="hidden"
                        name="track_id"
                        value={r.track_id}
                      />
                      <button
                        type="submit"
                        className="btn btn-sm btn-brain-rot"
                      >
                        Brain rot
                      </button>
                    </form>
                    {review !== null && (
                      <form action={clearReview}>
                        <input
                          type="hidden"
                          name="account_id"
                          value={r.account_id}
                        />
                        <input
                          type="hidden"
                          name="track_id"
                          value={r.track_id}
                        />
                        <button
                          type="submit"
                          className="btn btn-sm btn-clear"
                        >
                          Clear
                        </button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
