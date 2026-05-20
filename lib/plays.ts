import { sql } from './db';
import { getAccountWithToken, getRecentlyPlayed, getArtists, getAudioFeatures } from './spotify-client';

export interface PollResult {
  accountId: string;
  displayName: string;
  fetched: number;
  inserted: number;
}

export async function pollPlays(accountId: string): Promise<PollResult> {
  const account = await getAccountWithToken(accountId);

  const lastRows = (await sql`
    SELECT played_at FROM plays
    WHERE account_id = ${accountId}
    ORDER BY played_at DESC LIMIT 1
  `) as unknown as Array<{ played_at: Date }>;
  const sinceMs = lastRows[0] ? lastRows[0].played_at.getTime() : undefined;

  const plays = await getRecentlyPlayed(account.access_token, sinceMs);

  // Ensure tracks and artists exist in cache
  const trackIds = [...new Set(plays.map((p) => p.track.id))];
  const artistIds = [...new Set(plays.flatMap((p) => p.track.artists.map((a) => a.id)))];

  if (trackIds.length > 0) {
    const existingTracks = (await sql`
      SELECT id FROM tracks WHERE id = ANY(${trackIds})
    `) as unknown as Array<{ id: string }>;
    const existingTrackIds = new Set(existingTracks.map((r) => r.id));
    const missingTrackIds = trackIds.filter((id) => !existingTrackIds.has(id));

    if (missingTrackIds.length > 0) {
      const existingArtists = (await sql`
        SELECT id FROM artists WHERE id = ANY(${artistIds})
      `) as unknown as Array<{ id: string }>;
      const existingArtistIds = new Set(existingArtists.map((r) => r.id));
      const missingArtistIds = artistIds.filter((id) => !existingArtistIds.has(id));

      if (missingArtistIds.length > 0) {
        const fetched = await getArtists(account.access_token, missingArtistIds);
        for (const a of fetched) {
          await sql`
            INSERT INTO artists (id, name, followers, popularity, genres, fetched_at)
            VALUES (${a.id}, ${a.name}, ${a.followers.total}, ${a.popularity}, ${a.genres}, now())
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              followers = EXCLUDED.followers,
              popularity = EXCLUDED.popularity,
              genres = EXCLUDED.genres,
              fetched_at = now()
          `;
        }
      }

      const features = await getAudioFeatures(account.access_token, missingTrackIds);
      const featuresMap = new Map(features.map((f) => [f.id, f]));

      for (const p of plays) {
        if (!missingTrackIds.includes(p.track.id)) continue;
        const t = p.track;
        const f = featuresMap.get(t.id);
        const releaseDate = t.album.release_date ? new Date(t.album.release_date) : null;
        await sql`
          INSERT INTO tracks (
            id, name, artist_ids, primary_artist_id, album_id, album_name,
            duration_ms, explicit, popularity, release_date, preview_url, isrc,
            tempo, energy, danceability, acousticness, instrumentalness, valence, loudness,
            audio_features_fetched_at, fetched_at
          )
          VALUES (
            ${t.id}, ${t.name}, ${t.artists.map((a) => a.id)}, ${t.artists[0]?.id ?? null},
            ${t.album.id}, ${t.album.name},
            ${t.duration_ms}, ${t.explicit}, ${t.popularity}, ${releaseDate}, ${t.preview_url}, ${t.external_ids?.isrc ?? null},
            ${f?.tempo ?? null}, ${f?.energy ?? null}, ${f?.danceability ?? null},
            ${f?.acousticness ?? null}, ${f?.instrumentalness ?? null}, ${f?.valence ?? null}, ${f?.loudness ?? null},
            ${f ? new Date() : null}, now()
          )
          ON CONFLICT (id) DO NOTHING
        `;
      }
    }
  }

  let inserted = 0;
  for (const p of plays) {
    const ins = (await sql`
      INSERT INTO plays (account_id, track_id, played_at, context_type, context_uri)
      VALUES (
        ${accountId}, ${p.track.id}, ${new Date(p.played_at)},
        ${p.context?.type ?? null}, ${p.context?.uri ?? null}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    if (ins.length > 0) inserted++;
  }

  return { accountId, displayName: account.display_name, fetched: plays.length, inserted };
}
