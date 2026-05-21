-- Spotify Family Music Cleaner — schema
--
-- Multi-account from day one (4 family members). V1 only runs the cleanup cron
-- for one kid, but likes/plays tracking and aggregate insights work for any
-- account that has granted OAuth.
--
-- Conventions:
--   - Spotify IDs (track/artist/album) stored as text (Spotify's native format)
--   - Internal surrogate keys are uuid or bigserial
--   - All timestamps are timestamptz, UTC
--   - Refresh/access tokens are encrypted application-side using TOKEN_ENCRYPTION_KEY

create extension if not exists "pgcrypto";

-- =============================================================================
-- ACCOUNTS
-- =============================================================================

create table spotify_accounts (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  role text not null check (role in ('admin', 'parent', 'kid')),
  spotify_user_id text unique,
  refresh_token_encrypted text,
  access_token_encrypted text,
  access_token_expires_at timestamptz,
  scopes text[] not null default '{}',
  cleanup_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index spotify_accounts_role_idx on spotify_accounts(role);

-- =============================================================================
-- CATALOG (cached Spotify metadata, shared across accounts)
-- =============================================================================

create table artists (
  id text primary key,
  name text not null,
  -- Spotify fields (nullable; populated when /artists/{id} succeeds)
  followers integer,
  popularity integer,
  genres text[] not null default '{}',
  fetched_at timestamptz,
  -- MusicBrainz fields (nullable; populated when MB search succeeds)
  mb_id text,
  mb_score integer,
  mb_tags jsonb,
  mb_country text,
  mb_type text,
  mb_begin_year integer,
  mb_ended boolean,
  mb_fetched_at timestamptz,
  created_at timestamptz not null default now()
);
create index artists_followers_idx on artists(followers);
create index artists_mb_id_idx on artists(mb_id) where mb_id is not null;

create table tracks (
  id text primary key,
  name text not null,
  artist_ids text[] not null,
  primary_artist_id text references artists(id),
  album_id text,
  album_name text,
  duration_ms integer,
  explicit boolean,
  popularity integer,
  release_date date,
  preview_url text,
  isrc text,
  tempo real,
  energy real,
  danceability real,
  acousticness real,
  instrumentalness real,
  valence real,
  loudness real,
  audio_features_fetched_at timestamptz,
  fetched_at timestamptz not null default now()
);
create index tracks_primary_artist_idx on tracks(primary_artist_id);
create index tracks_release_date_idx on tracks(release_date);

-- =============================================================================
-- PER-ACCOUNT ACTIVITY
-- =============================================================================

-- Liked Songs library state. removed_at flips when the track disappears from the
-- user's library (whether removed by the user or by the cleaner).
create table library_likes (
  id bigserial primary key,
  account_id uuid not null references spotify_accounts(id) on delete cascade,
  track_id text not null references tracks(id),
  liked_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by text check (removed_by in ('user', 'cleaner')),
  unique (account_id, track_id, first_seen_at)
);
create index library_likes_active_idx on library_likes(account_id) where removed_at is null;
create index library_likes_track_idx on library_likes(track_id);

-- Recently-played stream. Spotify exposes only the last 50 plays per user, so we
-- poll every ~30min. (account_id, played_at) is unique since played_at is unique
-- per user in Spotify's API.
create table plays (
  id bigserial primary key,
  account_id uuid not null references spotify_accounts(id) on delete cascade,
  track_id text not null references tracks(id),
  played_at timestamptz not null,
  context_type text,
  context_uri text,
  unique (account_id, played_at)
);
create index plays_account_played_idx on plays(account_id, played_at desc);
create index plays_track_idx on plays(track_id);

-- =============================================================================
-- CLASSIFICATION & ACTIONS
-- =============================================================================

-- One row per (track, classifier_version). Verdict is about the music itself, not
-- per-account; account-specific overrides live in `reviews`.
create table classifications (
  id bigserial primary key,
  track_id text not null references tracks(id),
  verdict text not null check (verdict in ('authentic', 'brain_rot', 'borderline')),
  confidence real not null check (confidence between 0 and 1),
  classifier_version text not null,
  signals jsonb not null,
  created_at timestamptz not null default now(),
  unique (track_id, classifier_version)
);
create index classifications_track_idx on classifications(track_id, created_at desc);
create index classifications_verdict_idx on classifications(verdict, confidence desc);

-- Auto-unlike audit log. Reversible: a 'relike' row points back at the original
-- 'unlike' via reverted_action_id, and the original row's reverted_at gets set.
create table actions (
  id bigserial primary key,
  account_id uuid not null references spotify_accounts(id) on delete cascade,
  track_id text not null references tracks(id),
  action text not null check (action in ('unlike', 'relike')),
  classification_id bigint references classifications(id),
  prior_liked_at timestamptz,
  performed_at timestamptz not null default now(),
  reverted_at timestamptz,
  reverted_action_id bigint references actions(id)
);
create index actions_account_performed_idx on actions(account_id, performed_at desc);
create index actions_unreverted_idx on actions(account_id) where reverted_at is null;

-- Thumbs up/down decisions. 'protect' is stronger than 'keep': it pins the track
-- as authentic for that account even if the classifier later flips.
create table reviews (
  id bigserial primary key,
  track_id text not null references tracks(id),
  account_id uuid references spotify_accounts(id),
  decision text not null check (decision in ('keep', 'unlike', 'protect', 'always_unlike')),
  notes text,
  reviewed_at timestamptz not null default now()
);
create index reviews_track_idx on reviews(track_id, reviewed_at desc);
create index reviews_account_idx on reviews(account_id, reviewed_at desc) where account_id is not null;

-- =============================================================================
-- VIEWS
-- =============================================================================

-- Borderline tracks currently liked in a cleanup-enabled account, no review yet.
create view review_queue as
select
  ll.account_id,
  sa.display_name as account_name,
  t.id as track_id,
  t.name as track_name,
  a.name as artist_name,
  a.followers as artist_followers,
  t.popularity as track_popularity,
  t.release_date,
  t.preview_url,
  c.verdict,
  c.confidence,
  c.signals,
  ll.liked_at
from library_likes ll
  join spotify_accounts sa on sa.id = ll.account_id
  join tracks t on t.id = ll.track_id
  left join artists a on a.id = t.primary_artist_id
  join classifications c on c.track_id = t.id
  left join reviews r on r.track_id = t.id
    and (r.account_id = ll.account_id or r.account_id is null)
where ll.removed_at is null
  and sa.cleanup_enabled = true
  and c.verdict = 'borderline'
  and r.id is null
  and c.created_at = (
    select max(c2.created_at) from classifications c2 where c2.track_id = c.track_id
  );
