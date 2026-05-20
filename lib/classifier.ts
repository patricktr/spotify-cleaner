import Anthropic from '@anthropic-ai/sdk';
import type { SpotifyTrack, SpotifyArtist } from './spotify-client';

export type Verdict = 'authentic' | 'brain_rot' | 'borderline';

export interface ClassificationResult {
  verdict: Verdict;
  confidence: number;
  signals: {
    heuristics?: string[];
    llm_reasoning?: string;
    llm_model?: string;
  };
}

export const CLASSIFIER_VERSION = 'heuristics-v1+claude-opus-4-7';
export const AUTO_UNLIKE_THRESHOLD = parseFloat(process.env.AUTO_UNLIKE_THRESHOLD ?? '0.7');

const TOILET_HUMOR_RE =
  /\b(poop(?:ers?|y|ed|ing)?|poo|fart(?:s|ing|ed)?|tushy|pee[\s-]?pee|booger|wee[\s-]?wee|tinkle|toot|toots|stinky)\b/i;

const BRAIN_ROT_GENRES = new Set([
  'phonk',
  'sigma',
  'skibidi',
  'gachi',
  'brainrot',
  'rage rap',
  'tiktok rap',
]);

function hardHeuristics(track: SpotifyTrack, primary: SpotifyArtist | undefined): ClassificationResult | null {
  const signals: string[] = [];

  if (TOILET_HUMOR_RE.test(track.name)) {
    signals.push(`toilet_humor_title: "${track.name}"`);
    return { verdict: 'brain_rot', confidence: 0.95, signals: { heuristics: signals } };
  }

  if (primary && primary.followers.total < 5000) {
    const released = track.album.release_date ? new Date(track.album.release_date) : null;
    if (released) {
      const ageMonths = (Date.now() - released.getTime()) / (1000 * 60 * 60 * 24 * 30);
      if (ageMonths < 12 && track.popularity < 20) {
        signals.push(
          `ai_slop_pattern: followers=${primary.followers.total}, age_months=${ageMonths.toFixed(1)}, popularity=${track.popularity}`,
        );
        return { verdict: 'brain_rot', confidence: 0.92, signals: { heuristics: signals } };
      }
    }
  }

  if (primary) {
    const matching = primary.genres.filter((g) => BRAIN_ROT_GENRES.has(g.toLowerCase()));
    if (matching.length > 0) {
      signals.push(`brain_rot_genres: ${matching.join(', ')}`);
      return { verdict: 'brain_rot', confidence: 0.85, signals: { heuristics: signals } };
    }
  }

  if (track.popularity >= 70) {
    signals.push(`high_popularity: ${track.popularity}`);
    return { verdict: 'authentic', confidence: 0.9, signals: { heuristics: signals } };
  }
  if (primary && primary.followers.total > 5_000_000) {
    signals.push(`mega_artist: followers=${primary.followers.total}`);
    return { verdict: 'authentic', confidence: 0.88, signals: { heuristics: signals } };
  }

  return null;
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

async function llmClassify(track: SpotifyTrack, artists: SpotifyArtist[]): Promise<ClassificationResult> {
  const payload = {
    track_name: track.name,
    artists: artists.map((a) => ({
      name: a.name,
      followers: a.followers.total,
      popularity: a.popularity,
      genres: a.genres,
    })),
    album: track.album.name,
    release_date: track.album.release_date,
    track_popularity: track.popularity,
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
  artists: SpotifyArtist[],
): Promise<ClassificationResult & { classifier_version: string }> {
  const heuristic = hardHeuristics(track, artists[0]);
  if (heuristic) return { ...heuristic, classifier_version: CLASSIFIER_VERSION };
  const llm = await llmClassify(track, artists);
  return { ...llm, classifier_version: CLASSIFIER_VERSION };
}
