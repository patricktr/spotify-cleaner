// MusicBrainz Web Service v2 — used to enrich artist metadata that Spotify's
// dev-mode API restricts heavily. Free, no auth, but throttled to 1 req/sec
// per IP. We pace at 1.1s between calls to leave headroom.
//
// https://musicbrainz.org/doc/MusicBrainz_API

const MB_BASE = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'spotify-cleaner/0.1 (https://github.com/patricktr/spotify-cleaner)';

export interface MBArtistMatch {
  mb_id: string;
  name: string; // The name MB returned. Compare to the search query to gauge match quality.
  score: number; // Lucene relevance score — kept for diagnostics. NOT a match-quality signal: MB normalizes the top result to 100 even on weak matches, so always validate via name comparison.
  tags: Array<{ count: number; name: string }>;
  country: string | null;
  type: string | null;
  begin_year: number | null;
  ended: boolean | null;
}

let lastCallMs = 0;

async function paceRequest(): Promise<void> {
  const elapsed = Date.now() - lastCallMs;
  if (elapsed < 1100) {
    await new Promise((r) => setTimeout(r, 1100 - elapsed));
  }
  lastCallMs = Date.now();
}

interface RawMBArtist {
  id: string;
  name: string;
  score: number;
  type?: string;
  country?: string;
  tags?: Array<{ count: number; name: string }>;
  'life-span'?: { begin?: string; end?: string; ended?: boolean };
}

/**
 * Searches MusicBrainz for an artist by name. Returns the top match (highest
 * score) or null if no match is returned. Caller decides what to do with
 * low-confidence matches by inspecting `.score`.
 */
export async function searchArtist(name: string): Promise<MBArtistMatch | null> {
  await paceRequest();
  // MusicBrainz Lucene query — escape colons and double-quotes in the name,
  // then wrap. We do a fuzzy search (no quotes around NAME) so misspellings
  // and stylized capitalization still match; score tells us the confidence.
  const safe = name.replace(/[:"\\]/g, ' ').trim();
  if (!safe) return null;
  const q = encodeURIComponent(`artist:${safe}`);
  const url = `${MB_BASE}/artist?query=${q}&limit=1&fmt=json`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.warn('[musicbrainz] fetch failed', { name, error: e instanceof Error ? e.message : String(e) });
    return null;
  }

  if (!res.ok) {
    console.warn('[musicbrainz] non-2xx', { name, status: res.status });
    return null;
  }

  const json = (await res.json()) as { artists?: RawMBArtist[] };
  const top = json.artists?.[0];
  if (!top) return null;

  const beginStr = top['life-span']?.begin;
  const beginYear = beginStr ? parseInt(beginStr.slice(0, 4), 10) : null;

  return {
    mb_id: top.id,
    name: top.name,
    score: top.score,
    tags: top.tags ?? [],
    country: top.country ?? null,
    type: top.type ?? null,
    begin_year: Number.isFinite(beginYear) ? beginYear : null,
    ended: top['life-span']?.ended ?? null,
  };
}

/**
 * Normalize an artist name for comparison: lowercase, strip diacritics,
 * collapse whitespace, drop common punctuation. Used to decide whether a
 * MusicBrainz result actually matches the artist we searched for.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/["'`‘’“”.,!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
