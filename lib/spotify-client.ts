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
  const out: SpotifyArtist[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await spotifyFetch(token, `/artists?ids=${batch.join(',')}`);
    if (!res.ok) throw new Error(`/artists failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { artists: SpotifyArtist[] };
    out.push(...json.artists);
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

export async function getAudioFeatures(token: string, ids: string[]): Promise<SpotifyAudioFeatures[]> {
  if (ids.length === 0) return [];
  const out: SpotifyAudioFeatures[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const res = await spotifyFetch(token, `/audio-features?ids=${batch.join(',')}`);
    if (!res.ok) throw new Error(`/audio-features failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { audio_features: Array<SpotifyAudioFeatures | null> };
    out.push(...json.audio_features.filter((f): f is SpotifyAudioFeatures => f !== null));
  }
  return out;
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
