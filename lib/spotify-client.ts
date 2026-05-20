import { sql } from './db';
import { encrypt, decrypt } from './crypto';
import { refreshAccessToken } from './spotify';

export interface AccountToken {
  id: string;
  spotify_user_id: string;
  display_name: string;
  role: string;
  cleanup_enabled: boolean;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: Date;
}

interface AccountRow {
  id: string;
  spotify_user_id: string;
  display_name: string;
  role: string;
  cleanup_enabled: boolean;
  refresh_token_encrypted: string;
  access_token_encrypted: string;
  access_token_expires_at: Date;
}

export async function getAccountWithToken(accountId: string): Promise<AccountToken> {
  const rows = (await sql`
    SELECT id, spotify_user_id, display_name, role, cleanup_enabled,
           refresh_token_encrypted, access_token_encrypted, access_token_expires_at
    FROM spotify_accounts
    WHERE id = ${accountId}
  `) as unknown as AccountRow[];

  if (rows.length === 0) throw new Error(`Account ${accountId} not found`);
  const row = rows[0];

  const refresh_token = decrypt(row.refresh_token_encrypted);
  let access_token = decrypt(row.access_token_encrypted);
  let expires_at = row.access_token_expires_at;

  if (expires_at.getTime() - Date.now() < 60_000) {
    const refreshed = await refreshAccessToken(refresh_token);
    access_token = refreshed.access_token;
    expires_at = new Date(Date.now() + refreshed.expires_in * 1000);
    const newRefresh = refreshed.refresh_token ?? refresh_token;
    await sql`
      UPDATE spotify_accounts
      SET access_token_encrypted = ${encrypt(access_token)},
          refresh_token_encrypted = ${encrypt(newRefresh)},
          access_token_expires_at = ${expires_at},
          updated_at = now()
      WHERE id = ${accountId}
    `;
  }

  return {
    id: row.id,
    spotify_user_id: row.spotify_user_id,
    display_name: row.display_name,
    role: row.role,
    cleanup_enabled: row.cleanup_enabled,
    access_token,
    refresh_token,
    access_token_expires_at: expires_at,
  };
}

const API = 'https://api.spotify.com/v1';

async function spotifyFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return spotifyFetch(token, path, init);
  }
  return res;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
  album: { id: string; name: string; release_date: string };
  duration_ms: number;
  explicit: boolean;
  popularity: number;
  preview_url: string | null;
  external_ids?: { isrc?: string };
}

export interface SpotifyLikedTrack {
  added_at: string;
  track: SpotifyTrack;
}

export async function getAllLikedSongs(token: string): Promise<SpotifyLikedTrack[]> {
  const all: SpotifyLikedTrack[] = [];
  let offset = 0;
  const limit = 50;
  while (true) {
    const res = await spotifyFetch(token, `/me/tracks?limit=${limit}&offset=${offset}`);
    if (!res.ok) throw new Error(`/me/tracks failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { items: SpotifyLikedTrack[]; next: string | null };
    all.push(...json.items);
    if (!json.next) break;
    offset += limit;
  }
  return all;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  followers: { total: number };
  popularity: number;
  genres: string[];
}

export async function getArtists(token: string, ids: string[]): Promise<SpotifyArtist[]> {
  if (ids.length === 0) return [];
  // Spotify's batch /artists?ids=... endpoint returns 403 for apps in
  // Development Mode (post Nov 2024). The per-artist /artists/{id} endpoint
  // still works, so fan out single-artist calls in parallel chunks.
  // Individual failures are logged and skipped rather than throwing,
  // so one bad artist doesn't tank an entire scan.
  const out: SpotifyArtist[] = [];
  const CHUNK_SIZE = 10;
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const settled = await Promise.allSettled(
      chunk.map(async (id) => {
        const res = await spotifyFetch(token, `/artists/${id}`);
        if (!res.ok) throw new Error(`/artists/${id} failed: ${res.status}`);
        return (await res.json()) as SpotifyArtist;
      }),
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') out.push(r.value);
      else console.warn('[getArtists] skipping artist:', r.reason instanceof Error ? r.reason.message : r.reason);
    }
  }
  return out;
}

export interface SpotifyAudioFeatures {
  id: string;
  tempo: number;
  energy: number;
  danceability: number;
  acousticness: number;
  instrumentalness: number;
  valence: number;
  loudness: number;
}

export async function getAudioFeatures(_token: string, _ids: string[]): Promise<SpotifyAudioFeatures[]> {
  // Spotify deprecated /audio-features (single + batch) for apps in
  // Development Mode in late 2024. Both /audio-features/{id} and
  // /audio-features?ids=... now return 403 Forbidden for our app.
  //
  // The classifier doesn't use audio features anyway — heuristics rely on
  // artist metadata, track popularity, release date, and the title regex.
  // Audio-feature columns in the `tracks` table will stay NULL, which is fine.
  //
  // If this app is ever promoted to Extended Quota Mode, restore the batched
  // implementation from git history (commit 72ff8fd).
  return [];
}

export interface SpotifyPlayHistory {
  track: SpotifyTrack;
  played_at: string;
  context: { type: string; uri: string } | null;
}

export async function getRecentlyPlayed(token: string, sinceMs?: number): Promise<SpotifyPlayHistory[]> {
  const params = new URLSearchParams({ limit: '50' });
  if (sinceMs) params.set('after', String(sinceMs));
  const res = await spotifyFetch(token, `/me/player/recently-played?${params}`);
  if (!res.ok) throw new Error(`/me/player/recently-played failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { items: SpotifyPlayHistory[] };
  return json.items;
}

export async function unlikeTracks(token: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await spotifyFetch(token, `/me/tracks?ids=${batch.join(',')}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`DELETE /me/tracks failed: ${res.status} ${await res.text()}`);
  }
}

export async function likeTracks(token: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await spotifyFetch(token, `/me/tracks?ids=${batch.join(',')}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`PUT /me/tracks failed: ${res.status} ${await res.text()}`);
  }
}
