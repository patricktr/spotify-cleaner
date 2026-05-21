import { sql } from './db';
import {
  getAccountWithToken,
  getAllLikedSongs,
  getArtists,
  getAudioFeatures,
  unlikeTracks,
} from './spotify-client';
import type { SpotifyAudioFeatures } from './spotify-client';
import {
  classifyTrack,
  AUTO_UNLIKE_THRESHOLD,
  CLASSIFIER_VERSION,
  CLASSIFIER_VERSION_HEURISTICS_ONLY,
} from './classifier';
import type { EnrichedArtist } from './classifier';
import { searchArtist } from './musicbrainz';

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

interface ExistingArtistRow {
  id: string;
  fetched_at: Date | null;
  mb_fetched_at: Date | null;
}

interface EnrichedArtistRow {
  id: string;
  name: string;
  followers: number | null;
  popularity: number | null;
  genres: string[];
  fetched_at: Date | null;
  mb_id: string | null;
  mb_score: number | null;
  mb_tags: Array<{ count: number; name: string }> | null;
  mb_country: string | null;
  mb_type: string | null;
  mb_begin_year: number | null;
  mb_fetched_at: Date | null;
}

function rowToEnriched(r: EnrichedArtistRow): EnrichedArtist {
  return {
    id: r.id,
    name: r.name,
    followers: r.followers,
    popularity: r.popularity,
    genres: r.genres ?? [],
    spotify_fetched: r.fetched_at != null,
    mb_id: r.mb_id,
    mb_score: r.mb_score,
    mb_tags: r.mb_tags,
    mb_country: r.mb_country,
    mb_type: r.mb_type,
    mb_begin_year: r.mb_begin_year,
    mb_fetched: r.mb_fetched_at != null,
  };
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

  // 1) Pull current Liked Songs from Spotify
  const likedTracks = await getAllLikedSongs(account.access_token);
  console.log('[scan] liked songs pulled', { count: likedTracks.length });
  result.totalLiked = likedTracks.length;

  // 2) Reconcile library_likes
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

  // 3) Artist handling — multi-step enrichment.
  //
  // We enrich every artist that's referenced either by a new like (we need
  // them for the upcoming track INSERT's FK) OR by an existing track that
  // needs re-classification (classifier wants the latest enrichment data).
  // The latter case is common after a classifier-version bump: no new likes
  // arrived, but every old track wants re-classifying with the new heuristics.
  const fullTrackById = new Map(likedTracks.map((lt) => [lt.track.id, lt]));

  // Tracks that need classification with the current classifier version.
  // We compute this before enrichment so we can include their artists in the
  // enrichment set.
  const tracksNeedingClassification = (await sql`
    SELECT DISTINCT t.id
    FROM library_likes ll
    JOIN tracks t ON t.id = ll.track_id
    WHERE ll.account_id = ${accountId} AND ll.removed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM classifications c
        WHERE c.track_id = t.id
          AND c.classifier_version = ANY(${[CLASSIFIER_VERSION, CLASSIFIER_VERSION_HEURISTICS_ONLY]})
      )
  `) as unknown as Array<{ id: string }>;
  console.log('[scan] tracks needing classification (pre-enrich)', { count: tracksNeedingClassification.length });

  // Union: artists from new likes + artists from tracks needing classification
  const artistIdSet = new Set<string>();
  for (const lt of newLikes) for (const a of lt.track.artists) artistIdSet.add(a.id);
  for (const { id } of tracksNeedingClassification) {
    const lt = fullTrackById.get(id);
    if (lt) for (const a of lt.track.artists) artistIdSet.add(a.id);
  }
  const referencedArtistIds = [...artistIdSet];

  // Names from /me/tracks (no API call needed) — includes both new and
  // re-classify artists since both flow through fullTrackById/likedTracks.
  const artistIdToName = new Map<string, string>();
  for (const lt of likedTracks) {
    for (const a of lt.track.artists) {
      if (!artistIdToName.has(a.id) && a.name) artistIdToName.set(a.id, a.name);
    }
  }

  // 3a) Check which artists already have rows + which fetches have happened
  const preexisting = referencedArtistIds.length > 0
    ? ((await sql`
        SELECT id, fetched_at, mb_fetched_at
        FROM artists WHERE id = ANY(${referencedArtistIds})
      `) as unknown as ExistingArtistRow[])
    : [];
  const preexistingMap = new Map(preexisting.map((r) => [r.id, r]));

  // 3b) Insert minimal rows for artists not yet in the DB
  const newArtistIds = referencedArtistIds.filter((id) => !preexistingMap.has(id));
  for (const aid of newArtistIds) {
    const name = artistIdToName.get(aid) ?? '(unknown)';
    await sql`
      INSERT INTO artists (id, name) VALUES (${aid}, ${name})
      ON CONFLICT (id) DO NOTHING
    `;
  }
  console.log('[scan] artist rows ensured', {
    referenced: referencedArtistIds.length,
    preexisting: preexistingMap.size,
    inserted: newArtistIds.length,
  });

  // 3c) Try Spotify enrichment for artists missing it. This may fail with 429
  //     under dev-mode rate limits — that's fine, MusicBrainz fills the gap.
  const needSpotify = referencedArtistIds.filter((id) => !preexistingMap.get(id)?.fetched_at);
  if (needSpotify.length > 0) {
    console.log('[scan] spotify enrichment', { needed: needSpotify.length });
    const spotifyArtists = await getArtists(account.access_token, needSpotify);
    console.log('[scan] spotify enriched', { fetched: spotifyArtists.length, requested: needSpotify.length });
    for (const a of spotifyArtists) {
      await sql`
        UPDATE artists
        SET name = ${a.name},
            followers = ${a.followers.total},
            popularity = ${a.popularity},
            genres = ${a.genres},
            fetched_at = now()
        WHERE id = ${a.id}
      `;
    }
  }

  // 3d) MusicBrainz enrichment for artists missing it. Sequential (1 req/s),
  //     so this dominates the scan time on a cold artist cache.
  const needMb = referencedArtistIds.filter((id) => !preexistingMap.get(id)?.mb_fetched_at);
  if (needMb.length > 0) {
    console.log('[scan] musicbrainz enrichment', { needed: needMb.length });
    let mbHits = 0;
    for (const aid of needMb) {
      const name = artistIdToName.get(aid);
      if (!name) continue;
      try {
        const mb = await searchArtist(name);
        if (mb) mbHits++;
        await sql`
          UPDATE artists
          SET mb_id = ${mb?.mb_id ?? null},
              mb_score = ${mb?.score ?? null},
              mb_tags = ${mb ? JSON.stringify(mb.tags) : null}::jsonb,
              mb_country = ${mb?.country ?? null},
              mb_type = ${mb?.type ?? null},
              mb_begin_year = ${mb?.begin_year ?? null},
              mb_ended = ${mb?.ended ?? null},
              mb_fetched_at = now()
          WHERE id = ${aid}
        `;
      } catch (e) {
        console.warn('[scan] mb error', { aid, name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    console.log('[scan] musicbrainz enriched', { matched: mbHits, attempted: needMb.length });
  }

  // 4) Audio features (stubbed to []; dev-mode 403). Insert tracks.
  const newTrackIds = newLikes.map((lt) => lt.track.id);
  const audioFeaturesMap = new Map<string, SpotifyAudioFeatures>();
  if (newTrackIds.length > 0) {
    const features = await getAudioFeatures(account.access_token, newTrackIds);
    for (const f of features) audioFeaturesMap.set(f.id, f);
  }

  console.log('[scan] inserting tracks', { count: newLikes.length });
  let trackIdx = 0;
  for (const lt of newLikes) {
    trackIdx++;
    if (trackIdx % 25 === 0) {
      console.log('[scan] track insert progress', { done: trackIdx, total: newLikes.length });
    }
    const t = lt.track;
    const f = audioFeaturesMap.get(t.id);
    const releaseDate = t.album.release_date ? new Date(t.album.release_date) : null;
    // primary_artist_id is now always safe — every referenced artist has a row
    // (minimal-or-enriched).
    const primaryArtistId = t.artists[0]?.id ?? null;
    await sql`
      INSERT INTO tracks (
        id, name, artist_ids, primary_artist_id, album_id, album_name,
        duration_ms, explicit, popularity, release_date, preview_url, isrc,
        tempo, energy, danceability, acousticness, instrumentalness, valence, loudness,
        audio_features_fetched_at, fetched_at
      )
      VALUES (
        ${t.id}, ${t.name}, ${t.artists.map((a) => a.id)}, ${primaryArtistId},
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

  // 5) Classify. tracksNeedingClassification was computed earlier (before
  //    enrichment). Now load enriched artist data and run the classifier.
  console.log('[scan] classifying', { count: tracksNeedingClassification.length });

  const enrichedMap = new Map<string, EnrichedArtist>();
  if (referencedArtistIds.length > 0) {
    const rows = (await sql`
      SELECT id, name, followers, popularity, genres, fetched_at,
             mb_id, mb_score, mb_tags, mb_country, mb_type, mb_begin_year, mb_fetched_at
      FROM artists WHERE id = ANY(${referencedArtistIds})
    `) as unknown as EnrichedArtistRow[];
    for (const r of rows) enrichedMap.set(r.id, rowToEnriched(r));
  }

  for (const { id } of tracksNeedingClassification) {
    const lt = fullTrackById.get(id);
    if (!lt) continue;
    try {
      const trackArtists = lt.track.artists
        .map((a) => enrichedMap.get(a.id))
        .filter((a): a is EnrichedArtist => a !== undefined);

      const c = await classifyTrack(lt.track, trackArtists);
      const inserted = (await sql`
        INSERT INTO classifications (track_id, verdict, confidence, classifier_version, signals)
        VALUES (${lt.track.id}, ${c.verdict}, ${c.confidence}, ${c.classifier_version}, ${JSON.stringify(c.signals)}::jsonb)
        ON CONFLICT (track_id, classifier_version) DO UPDATE SET
          verdict = EXCLUDED.verdict,
          confidence = EXCLUDED.confidence,
          signals = EXCLUDED.signals,
          created_at = now()
        RETURNING id
      `) as unknown as Array<{ id: number }>;
      result.classified++;

      if (account.cleanup_enabled && c.verdict === 'brain_rot' && c.confidence >= AUTO_UNLIKE_THRESHOLD) {
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

  return result;
}
