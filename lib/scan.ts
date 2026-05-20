import { sql } from './db';
import {
  getAccountWithToken,
  getAllLikedSongs,
  getArtists,
  getAudioFeatures,
  unlikeTracks,
} from './spotify-client';
import type { SpotifyArtist, SpotifyAudioFeatures } from './spotify-client';
import { classifyTrack, AUTO_UNLIKE_THRESHOLD } from './classifier';

export interface ScanResult {
  accountId: string;
  displayName: string;
  totalLiked: number;
  newSinceLastScan: number;
  classified: number;
  autoUnliked: number;
  queuedForReview: number;
  errors: string[];
}

export async function scanAccount(accountId: string): Promise<ScanResult> {
  console.log('[scan] start', { accountId });
  const account = await getAccountWithToken(accountId);
  console.log('[scan] token ok', { display: account.display_name, cleanup: account.cleanup_enabled });
  const result: ScanResult = {
    accountId,
    displayName: account.display_name,
    totalLiked: 0,
    newSinceLastScan: 0,
    classified: 0,
    autoUnliked: 0,
    queuedForReview: 0,
    errors: [],
  };

  // Note: we proceed for ALL accounts. The auto-unlike block below is gated
  // on account.cleanup_enabled. When cleanup is off, this becomes a dry-run
  // that populates library_likes + classifications without writing to Spotify.

  // 1) Pull current Liked Songs from Spotify
  const likedTracks = await getAllLikedSongs(account.access_token);
  console.log('[scan] liked songs pulled', { count: likedTracks.length });
  result.totalLiked = likedTracks.length;

  // 2) Reconcile library_likes table
  const currentIds = new Set(likedTracks.map((lt) => lt.track.id));
  const existingRows = (await sql`
    SELECT track_id FROM library_likes
    WHERE account_id = ${accountId} AND removed_at IS NULL
  `) as unknown as Array<{ track_id: string }>;
  const existingIds = new Set(existingRows.map((r) => r.track_id));

  const newLikes = likedTracks.filter((lt) => !existingIds.has(lt.track.id));
  const removedIds = [...existingIds].filter((id) => !currentIds.has(id));
  result.newSinceLastScan = newLikes.length;
  console.log('[scan] diff', { new: newLikes.length, removed: removedIds.length });

  // 3) Fetch and cache artist + audio-feature metadata for new tracks
  const newTrackIds = newLikes.map((lt) => lt.track.id);
  const newArtistIds = [...new Set(newLikes.flatMap((lt) => lt.track.artists.map((a) => a.id)))];
  console.log('[scan] need artists', { count: newArtistIds.length });

  const artistMap = new Map<string, SpotifyArtist>();
  if (newArtistIds.length > 0) {
    const artists = await getArtists(account.access_token, newArtistIds);
    console.log('[scan] artists fetched', { fetched: artists.length, requested: newArtistIds.length });
    for (const a of artists) {
      artistMap.set(a.id, a);
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

  const audioFeaturesMap = new Map<string, SpotifyAudioFeatures>();
  if (newTrackIds.length > 0) {
    const features = await getAudioFeatures(account.access_token, newTrackIds);
    for (const f of features) audioFeaturesMap.set(f.id, f);
  }

  console.log('[scan] inserting tracks', { count: newLikes.length });
  let trackIdx = 0;
  for (const lt of newLikes) {
    trackIdx++;
    if (trackIdx % 25 === 0) console.log('[scan] track insert progress', { done: trackIdx, total: newLikes.length });
    const t = lt.track;
    const f = audioFeaturesMap.get(t.id);
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
      ON CONFLICT (id) DO UPDATE SET
        popularity = EXCLUDED.popularity,
        fetched_at = now()
    `;
    await sql`
      INSERT INTO library_likes (account_id, track_id, liked_at)
      VALUES (${accountId}, ${t.id}, ${new Date(lt.added_at)})
      ON CONFLICT DO NOTHING
    `;
  }

  // Mark user-removed tracks
  for (const trackId of removedIds) {
    await sql`
      UPDATE library_likes
      SET removed_at = now(), removed_by = 'user'
      WHERE account_id = ${accountId} AND track_id = ${trackId} AND removed_at IS NULL
    `;
  }

  // 4) Classify tracks without a classification yet (within this account's active likes)
  const trackIdsToClassify = (await sql`
    SELECT DISTINCT t.id
    FROM library_likes ll
    JOIN tracks t ON t.id = ll.track_id
    WHERE ll.account_id = ${accountId} AND ll.removed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM classifications c WHERE c.track_id = t.id)
  `) as unknown as Array<{ id: string }>;

  const idsToClassifySet = new Set(trackIdsToClassify.map((r) => r.id));
  const fullTrackById = new Map(likedTracks.map((lt) => [lt.track.id, lt]));

  for (const { id } of trackIdsToClassify) {
    const lt = fullTrackById.get(id);
    if (!lt) continue; // shouldn't happen — only classify tracks currently in Liked Songs
    try {
      const trackArtists = lt.track.artists
        .map((a) => artistMap.get(a.id))
        .filter((a): a is SpotifyArtist => a !== undefined);

      // If artists weren't fetched this scan (already in DB), pull from DB cache
      if (trackArtists.length === 0 && lt.track.artists.length > 0) {
        const cached = (await sql`
          SELECT id, name, followers, popularity, genres
          FROM artists WHERE id = ANY(${lt.track.artists.map((a) => a.id)})
        `) as unknown as Array<{
          id: string;
          name: string;
          followers: number;
          popularity: number;
          genres: string[];
        }>;
        for (const c of cached) {
          trackArtists.push({
            id: c.id,
            name: c.name,
            followers: { total: c.followers },
            popularity: c.popularity,
            genres: c.genres,
          });
        }
      }

      const c = await classifyTrack(lt.track, trackArtists);
      const inserted = (await sql`
        INSERT INTO classifications (track_id, verdict, confidence, classifier_version, signals)
        VALUES (${lt.track.id}, ${c.verdict}, ${c.confidence}, ${c.classifier_version}, ${sql.json(c.signals)})
        ON CONFLICT (track_id, classifier_version) DO UPDATE SET
          verdict = EXCLUDED.verdict,
          confidence = EXCLUDED.confidence,
          signals = EXCLUDED.signals,
          created_at = now()
        RETURNING id
      `) as unknown as Array<{ id: number }>;
      result.classified++;

      if (account.cleanup_enabled && c.verdict === 'brain_rot' && c.confidence >= AUTO_UNLIKE_THRESHOLD) {
        // Skip if user has protected this track
        const overrides = (await sql`
          SELECT decision FROM reviews
          WHERE track_id = ${lt.track.id}
            AND (account_id = ${accountId} OR account_id IS NULL)
            AND decision IN ('protect', 'keep')
          ORDER BY reviewed_at DESC LIMIT 1
        `) as unknown as Array<{ decision: string }>;
        if (overrides.length > 0) continue;

        await unlikeTracks(account.access_token, [lt.track.id]);
        await sql`
          INSERT INTO actions (account_id, track_id, action, classification_id, prior_liked_at)
          VALUES (${accountId}, ${lt.track.id}, 'unlike', ${inserted[0].id}, ${new Date(lt.added_at)})
        `;
        await sql`
          UPDATE library_likes
          SET removed_at = now(), removed_by = 'cleaner'
          WHERE account_id = ${accountId} AND track_id = ${lt.track.id} AND removed_at IS NULL
        `;
        result.autoUnliked++;
      } else if (c.verdict === 'borderline' || (c.verdict === 'brain_rot' && c.confidence < AUTO_UNLIKE_THRESHOLD)) {
        result.queuedForReview++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${lt.track.id} "${lt.track.name}": ${msg}`);
    }
  }

  // Suppress unused-var warning for now
  void idsToClassifySet;

  return result;
}
