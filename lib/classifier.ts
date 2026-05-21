import Anthropic from '@anthropic-ai/sdk';
import type { SpotifyTrack } from './spotify-client';
import { normalizeName } from './musicbrainz';

export type Verdict = 'authentic' | 'brain_rot' | 'borderline';

// What we know about an artist after scan's enrichment pass. Both Spotify and
// MusicBrainz fields are nullable — Spotify's dev-mode API rate-limits the
// /artists endpoint hard, and MusicBrainz may simply not have an entry for
// an obscure / AI-generated artist (which is itself a signal).
export interface EnrichedArtist {
  id: string;
  name: string;
  // Spotify (null when /artists fetch failed/blocked)
  followers: number | null;
  popularity: number | null;
  genres: string[];
  spotify_fetched: boolean;
  // MusicBrainz (mb_id null when no match found; mb_fetched=true means we tried)
  mb_id: string | null;
  mb_name: string | null; // the artist name MB returned (used to validate the match)
  mb_score: number | null; // Lucene relevance, normalized — kept only for diagnostics, NOT used by heuristics
  mb_tags: Array<{ count: number; name: string }> | null;
  mb_country: string | null;
  mb_type: string | null;
  mb_begin_year: number | null;
  mb_fetched: boolean;
}

export interface ClassificationResult {
  verdict: Verdict;
  confidence: number;
  signals: {
    heuristics?: string[];
    llm_reasoning?: string;
    llm_model?: string;
    heuristics_only?: boolean;
    note?: string;
  };
}

// v3: drops mb_score (Lucene normalizes top result to 100, so it was a
// no-op gate) and adds normalized-name-match validation on MB results.
// The DB's unique (track_id, classifier_version) lets historical rows
// coexist; the review_queue view picks the latest by created_at.
export const CLASSIFIER_VERSION = 'heuristics-v3.1+claude-opus-4-7';
export const CLASSIFIER_VERSION_HEURISTICS_ONLY = 'heuristics-v3.1';
export const AUTO_UNLIKE_THRESHOLD = parseFloat(process.env.AUTO_UNLIKE_THRESHOLD ?? '0.7');

export function isLlmEnabled(): boolean {
  const key = process.env.ANTHROPIC_API_KEY;
  if (typeof key !== 'string' || key.length === 0) return false;
  if (process.env.LLM_CLASSIFIER_ENABLED === 'false') return false;
  return true;
}

const TOILET_HUMOR_RE =
  /\b(poop(?:ers?|y|ed|ing)?|poo|fart(?:s|ing|ed)?|tushy|pee[\s-]?pee|booger|wee[\s-]?wee|tinkle|toot|toots|stinky)\b/i;

const BRAIN_ROT_GENRES = new Set([
  'phonk',
  'sigma',
  'skibidi',
  'gachi',
  'brainrot',
  'brain rot',
  'rage rap',
  'tiktok rap',
]);

function matchBrainRotTags(tags: Array<{ name: string }>): string[] {
  return tags.filter((t) => BRAIN_ROT_GENRES.has(t.name.toLowerCase())).map((t) => t.name);
}

/**
 * True iff MB returned a row AND the name it returned matches (normalized)
 * the artist name we searched for. mb_score alone is meaningless — see the
 * EnrichedArtist field comment. A name match is the real signal.
 */
function mbNameMatches(a: EnrichedArtist): boolean {
  if (!a.mb_id || !a.mb_name) return false;
  return normalizeName(a.name) === normalizeName(a.mb_name);
}

/**
 * Indicates we tried MB and the returned row (if any) doesn't match the
 * artist name we asked about. Useful as a negative signal: a low-follower
 * Spotify artist who isn't cataloged in MB is a strong AI-slop tell.
 */
function mbAttemptedAndMissed(a: EnrichedArtist): boolean {
  return a.mb_fetched && !mbNameMatches(a);
}

function hardHeuristics(
  track: SpotifyTrack,
  primary: EnrichedArtist | undefined,
): ClassificationResult | null {
  const signals: string[] = [];
  const currentYear = new Date().getFullYear();

  // === STRONG BRAIN-ROT SIGNALS ===

  // Toilet humor — title-only, always works
  if (TOILET_HUMOR_RE.test(track.name)) {
    signals.push(`toilet_humor_title: "${track.name}"`);
    return { verdict: 'brain_rot', confidence: 0.95, signals: { heuristics: signals } };
  }

  // Spotify genre in brain-rot list
  if (primary?.genres && primary.genres.length > 0) {
    const matching = primary.genres.filter((g) => BRAIN_ROT_GENRES.has(g.toLowerCase()));
    if (matching.length > 0) {
      signals.push(`brain_rot_spotify_genre: ${matching.join(', ')}`);
      return { verdict: 'brain_rot', confidence: 0.9, signals: { heuristics: signals } };
    }
  }

  // MusicBrainz tag in brain-rot list
  if (primary?.mb_tags && primary.mb_tags.length > 0) {
    const matching = matchBrainRotTags(primary.mb_tags);
    if (matching.length > 0) {
      signals.push(`brain_rot_mb_tag: ${matching.join(', ')}`);
      return { verdict: 'brain_rot', confidence: 0.88, signals: { heuristics: signals } };
    }
  }

  // === STRONG AUTHENTIC SIGNALS ===

  // Mega-artist (Spotify followers > 5M)
  if (primary?.followers != null && primary.followers > 5_000_000) {
    signals.push(`mega_artist_spotify: followers=${primary.followers}`);
    return { verdict: 'authentic', confidence: 0.92, signals: { heuristics: signals } };
  }

  // Established artist: MB has a name match AND a cataloged life-span AND
  // they've been around 5+ years. Tag count adds confidence.
  if (primary && mbNameMatches(primary) && primary.mb_begin_year != null) {
    const yearsActive = currentYear - primary.mb_begin_year;
    const tagCount = primary.mb_tags?.length ?? 0;
    if (yearsActive >= 5) {
      const confidence = tagCount >= 5 ? 0.9 : 0.8;
      signals.push(
        `established_artist: name_match, begin_year=${primary.mb_begin_year}, years_active=${yearsActive}, tags=${tagCount}, type=${primary.mb_type ?? 'n/a'}`,
      );
      return { verdict: 'authentic', confidence, signals: { heuristics: signals } };
    }
  }

  // High track popularity (always missing in dev mode but kept for extended quota)
  if (track.popularity != null && track.popularity >= 70) {
    signals.push(`high_track_popularity: ${track.popularity}`);
    return { verdict: 'authentic', confidence: 0.9, signals: { heuristics: signals } };
  }

  // === MEDIUM CONFIDENCE SIGNALS ===

  // AI-slop pattern: tiny Spotify followers + recent release. Strongest when
  // MusicBrainz also can't find the artist by name.
  if (primary?.followers != null && primary.followers < 5000) {
    const released = track.album.release_date ? new Date(track.album.release_date) : null;
    if (released) {
      const ageMonths = (Date.now() - released.getTime()) / (1000 * 60 * 60 * 24 * 30);
      if (ageMonths < 12) {
        if (primary && mbAttemptedAndMissed(primary)) {
          signals.push(
            `ai_slop_strong: followers=${primary.followers}, age_mo=${ageMonths.toFixed(1)}, no_mb_name_match`,
          );
          return { verdict: 'brain_rot', confidence: 0.9, signals: { heuristics: signals } };
        }
        signals.push(`ai_slop_partial: followers=${primary.followers}, age_mo=${ageMonths.toFixed(1)}`);
        return { verdict: 'brain_rot', confidence: 0.75, signals: { heuristics: signals } };
      }
    }
  }

  // Cataloged in MB with a name match (but no begin_year). Weaker than
  // established_artist — could be a real but obscure artist (Bryant Oden,
  // Captainsparklez, Tobuscus etc.). Lean cautiously authentic.
  if (primary && mbNameMatches(primary)) {
    const tagCount = primary.mb_tags?.length ?? 0;
    const hasBeginYear = primary.mb_begin_year != null;
    const typeIsPersonOrGroup = primary.mb_type === 'Person' || primary.mb_type === 'Group';
    // Build a tiered confidence based on cataloging quality
    if (typeIsPersonOrGroup && tagCount >= 1) {
      signals.push(`cataloged_artist: name_match, type=${primary.mb_type}, tags=${tagCount}, begin_year=${hasBeginYear ? primary.mb_begin_year : 'unknown'}`);
      return { verdict: 'authentic', confidence: 0.65, signals: { heuristics: signals } };
    }
    // Name matches but minimal supporting info — borderline-leaning. Let it
    // fall through and become a real borderline (or hit LLM if enabled).
    signals.push(`weak_mb_match: name_match, type=${primary.mb_type ?? 'n/a'}, tags=${tagCount}, no_begin_year`);
    // Don't return — fall through to borderline below.
  }

  // Spotify followers known to be low AND MB couldn't match the name —
  // strong suspicion of an obscure-to-the-point-of-not-real artist.
  if (
    primary &&
    mbAttemptedAndMissed(primary) &&
    primary.followers != null &&
    primary.followers < 50_000
  ) {
    signals.push(`obscure_no_mb_match: spotify_followers=${primary.followers}`);
    return { verdict: 'brain_rot', confidence: 0.7, signals: { heuristics: signals } };
  }

  return null; // requires LLM (when enabled) or stays borderline
}

const SYSTEM_PROMPT = `You are a music quality classifier for a family's Spotify library.

Classify a track as "authentic", "brain_rot", or "borderline".

DEFINITIONS:
- "brain_rot": Dopamine-optimized algorithmic bait. AI-generated slop. Low-effort viral kid content. Tracks designed to game recommendation algorithms (e.g., "Poopers the Penguin"-style novelties from anonymous artists with a few hundred listeners; phonk/sigma/skibidi-tier algorithmic bait targeting children).
- "authentic": Music made by humans with intent. ANY song that has charted on the Billboard Hot 100 in any era is authentic by definition. Classical music (Mozart, Bach, etc.) is always authentic. Comedy/novelty by real artists with real careers (Weird Al Yankovic) is authentic. Quality varies — that's not the question. The question is real artist making music vs. algorithmic bait.
- "borderline": Genuinely unsure. Use sparingly.

ANCHOR EXAMPLES (always authentic, regardless of taste): The Beatles, Queen, P!nk, Weird Al Yankovic, Talking Heads, Backstreet Boys, Mozart, Bach, any classical composer, any Billboard Hot 100 charting song.

IMPORTANT:
- Explicit lyrics (occasional fuck/shit) are NOT brain rot. Orthogonal to this judgment.
- A low-popularity track from a real artist (deep cut from a known band, indie act) is authentic. Brain rot specifically = algorithmic bait.
- When in doubt about a real-but-obscure song, lean authentic.

OUTPUT (strict JSON, no prose):
{"verdict": "authentic" | "brain_rot" | "borderline", "confidence": <number 0-1>, "reasoning": "<one sentence>"}`;

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (anthropicClient) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

async function llmClassify(
  track: SpotifyTrack,
  artists: EnrichedArtist[],
): Promise<ClassificationResult> {
  const payload = {
    track_name: track.name,
    artists: artists.map((a) => ({
      name: a.name,
      spotify_followers: a.followers,
      spotify_popularity: a.popularity,
      spotify_genres: a.genres,
      musicbrainz_id: a.mb_id,
      musicbrainz_returned_name: a.mb_name,
      musicbrainz_name_matches_spotify: a.mb_id ? normalizeName(a.name) === normalizeName(a.mb_name ?? '') : false,
      musicbrainz_tags: a.mb_tags?.map((t) => t.name) ?? [],
      musicbrainz_begin_year: a.mb_begin_year,
      musicbrainz_type: a.mb_type,
      musicbrainz_country: a.mb_country,
    })),
    album: track.album.name,
    release_date: track.album.release_date,
    explicit: track.explicit,
    duration_seconds: Math.round(track.duration_ms / 1000),
  };

  const result = await getAnthropic().messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 400,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Classify this track. Return only the JSON object.\n\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  });

  const textBlock = result.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new Error('Claude returned no text');
  const match = textBlock.text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Claude response not JSON-parseable: ${textBlock.text}`);
  const parsed = JSON.parse(match[0]) as { verdict: Verdict; confidence: number; reasoning: string };

  return {
    verdict: parsed.verdict,
    confidence: parsed.confidence,
    signals: { llm_reasoning: parsed.reasoning, llm_model: 'claude-opus-4-7' },
  };
}

export async function classifyTrack(
  track: SpotifyTrack,
  artists: EnrichedArtist[],
): Promise<ClassificationResult & { classifier_version: string }> {
  const heuristic = hardHeuristics(track, artists[0]);
  if (heuristic) {
    const version = isLlmEnabled() ? CLASSIFIER_VERSION : CLASSIFIER_VERSION_HEURISTICS_ONLY;
    return { ...heuristic, classifier_version: version };
  }
  if (!isLlmEnabled()) {
    return {
      verdict: 'borderline',
      confidence: 0.5,
      signals: { heuristics_only: true, note: 'LLM disabled; routed to review queue' },
      classifier_version: CLASSIFIER_VERSION_HEURISTICS_ONLY,
    };
  }
  const llm = await llmClassify(track, artists);
  return { ...llm, classifier_version: CLASSIFIER_VERSION };
}
