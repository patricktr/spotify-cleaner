# spotify-cleaner

*A self-hosted Next.js app that audits a family's Spotify libraries and quietly removes AI-generated brain-rot tracks before they fill up a kid's Liked Songs.*

## Why this exists

If you have a kid with a Spotify account on your Family Plan, you've probably noticed that searches for real songs increasingly return algorithmically optimized garbage from artists named things like "Poopers the Penguin" — anonymous projects with a few hundred monthly listeners, freshly uploaded, engineered to hijack autoplay queues. The Spotify product team does not appear to care, and parental controls don't touch it. This is a personal frustration project: a thing that watches one kid's library every night and pulls out the slop, with an audit trail so anything wrongly removed can be put back.

## What it does

- **Multi-account from day one.** Connects up to four family members via OAuth and stores encrypted refresh tokens per account. Only accounts with `cleanup_enabled = true` get auto-unliked.
- **Daily library scan.** Pulls every track in Liked Songs, classifies anything new, auto-unlikes high-confidence brain rot, and writes a reversible `actions` row for every removal.
- **Recently-played poller.** Every 30 minutes it grabs the last 50 plays for each connected account (Spotify's API ceiling) so aggregate listening data accumulates over time.
- **Inspection UI at `/review`.** Lists every classified track across all accounts (filterable by account and verdict, sortable by confidence) with the actual signals each verdict was based on. Thumbs-up / thumbs-down buttons record your override into the `reviews` table — used both as a safety net (the cleaner respects `keep`/`protect` decisions) and as ground-truth feedback for tuning heuristic weights.
- **Password-gated dashboard.** The whole admin UI sits behind a single shared password (`ADMIN_PASSWORD`), enforced by edge middleware. Cron endpoints and the Spotify OAuth callback are allowlisted so they keep working.

## How classification works

The classifier in `lib/classifier.ts` is heuristics-first, LLM-on-the-edge. Most tracks never hit Claude. Each scanned artist is enriched from two data sources before classification:

1. **Spotify Web API** — track name, artist name, album, release date. Track popularity, `preview_url`, and the entire `/audio-features` endpoint are stripped from dev-mode apps as of November 2024, so we don't rely on them. The `/artists/{id}` lookup gives us follower count, popularity, and genre tags when we can reach it (Spotify rate-limits this hard in dev mode).
2. **[MusicBrainz Web Service v2](https://musicbrainz.org/doc/MusicBrainz_API)** — free, no auth, paced at 1 request/second per their ToS. Returns artist `id`, name, type (`Person` / `Group` / `Other`), country, life-span (`begin` and `end` years), and folksonomy tags. MusicBrainz is human-curated, so "is this artist in MB at all, with a matching name and a non-trivial cataloging footprint" is a strong proxy for "is this a real artist."

**Hard heuristics, in priority order:**

| Heuristic | Verdict | Confidence | Requires |
| --- | --- | --- | --- |
| Toilet-humor regex in track name (`poop / fart / butt / pee-pee / booger / tinkle / toot / stinky / tushy`) | `brain_rot` | 0.95 | track name only |
| Brain-rot tag from Spotify (`phonk`, `sigma`, `skibidi`, `gachi`, `brainrot`, `rage rap`, `tiktok rap`) | `brain_rot` | 0.9 | Spotify artist genres |
| Brain-rot tag from MusicBrainz (same list) | `brain_rot` | 0.88 | MB tags |
| Mega-artist on Spotify (followers > 5M) | `authentic` | 0.92 | Spotify follower count |
| Established artist in MB: normalized name match + cataloged `begin_year` + 5+ years active. Confidence 0.9 with 5+ tags, 0.8 otherwise. | `authentic` | 0.8–0.9 | MB name match + life-span |
| AI-slop strong: Spotify followers < 5k, released in last 12 months, MB has no name match | `brain_rot` | 0.9 | Spotify followers + release date + MB result |
| AI-slop partial: Spotify followers < 5k, released in last 12 months (MB inconclusive) | `brain_rot` | 0.75 | Spotify followers + release date |
| Cataloged artist in MB: name match + `Person`/`Group` + ≥1 tag (but no life-span) | `authentic` | 0.65 | MB name match + tags |
| Obscure + no MB match: Spotify followers < 50k AND MB name mismatch | `brain_rot` | 0.7 | Spotify followers + MB result |
| Weak MB match: name match but no tags, no life-span | falls through | — | — |

**Everything that falls through** goes to Claude `opus-4-7` (when `ANTHROPIC_API_KEY` is set) with a cached system prompt that bakes in:

- Anchor artists that are always authentic regardless of taste: The Beatles, Queen, P!nk, Weird Al Yankovic, Talking Heads, Backstreet Boys, Mozart, Bach, any classical composer, anything that has ever charted on the Billboard Hot 100.
- Explicit lyrics are orthogonal to the judgment — `fuck` in a Pink song is not brain rot.
- The target is *dopamine-optimized algorithmic bait*, not "music I don't like." A real-but-obscure deep cut leans authentic.
- Claude sees the full enriched artist payload, including a `musicbrainz_name_matches_spotify` boolean computed from a normalized comparison (strips diacritics, lowercase, drops common punctuation including both straight and curly quote marks).

The system prompt is sent with `cache_control: ephemeral`, so per-request cost stays low once the cache warms.

**Heuristics-only mode is a supported configuration:** leave `ANTHROPIC_API_KEY` unset (or set `LLM_CLASSIFIER_ENABLED=false`) and the heuristic layer runs as usual, with anything it can't resolve queued as `borderline` (confidence 0.5) for manual review at `/review`.

### Note: MusicBrainz's `score` is decorative

The classifier stores `mb_score` for diagnostics but **does not gate** on it. Lucene normalizes the top result of any search to 100, even for terrible matches — searching `artist:"Poopers the Magic Penguin"` returns "Rie Sinclair" at score 100. The real match-quality signal is a normalized comparison of the MB-returned name against the artist name we searched for. Only a name match counts as an MB hit.

## Setup

You will need: a GitHub account, a Vercel account, a Spotify Developer app, and — optionally — an Anthropic API key.

1. **Fork and clone.**

    ```sh
    git clone https://github.com/<you>/spotify-cleaner.git
    cd spotify-cleaner
    pnpm install
    ```

2. **Create a Vercel project and link it.**

    ```sh
    vercel link
    ```

3. **Provision Neon Postgres via the Vercel Marketplace.** This auto-injects `POSTGRES_URL` and `POSTGRES_URL_NON_POOLING` into your Vercel project env.

    ```sh
    vercel integration add neon
    vercel env pull .env.local
    ```

4. **Create a Spotify Developer app** at https://developer.spotify.com/dashboard. Grab the Client ID and Client Secret. Under "Redirect URIs" add both:

    - `http://localhost:3000/api/spotify/callback`
    - `https://<your-prod-domain>/api/spotify/callback`

5. **Get an Anthropic API key** at https://console.anthropic.com. *Optional* — if you skip this, the heuristic layer still runs and anything it can't resolve will sit in the review queue (verdict `borderline`, confidence 0.5) for you to handle by hand. You can also leave the key set but force heuristics-only mode with `LLM_CLASSIFIER_ENABLED=false`.

6. **Set env vars in Vercel** (see `.env.example`):

    ```sh
    SPOTIFY_CLIENT_ID
    SPOTIFY_CLIENT_SECRET
    SPOTIFY_REDIRECT_URI       # https://<your-prod-domain>/api/spotify/callback
    TOKEN_ENCRYPTION_KEY       # 32 random bytes, base64url-encoded
    ANTHROPIC_API_KEY          # optional; omit for heuristics-only mode
    LLM_CLASSIFIER_ENABLED     # optional; set to `false` to force heuristics-only even when the key is set
    CRON_SECRET                # 32 random bytes you generate; Vercel cron requests include it as the Authorization Bearer token
    ADMIN_PASSWORD             # the shared password for the app-level login gate at /login
    # POSTGRES_URL, POSTGRES_URL_NON_POOLING come from the Neon integration
    ```

    Generate the encryption key with:

    ```sh
    node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
    ```

7. **Apply the schema.**

    ```sh
    pnpm db:push
    ```

8. **Deploy.**

    ```sh
    vercel deploy --prod
    ```

9. **Connect accounts.** Visit your production domain, use the connect form on the admin home, and walk through Spotify OAuth once per family member. Flip `cleanup_enabled` to `true` only on the account whose library you want pruned.

## Cron schedules

Schedules are defined in `vercel.json`:

| Path | Schedule | What it does |
| --- | --- | --- |
| `/api/cron/poll-plays` | `*/30 * * * *` | Every 30 minutes. Pulls the last 50 plays for every connected account into the `plays` table. |
| `/api/cron/scan-library` | `0 4 * * *` | Daily at 04:00 UTC. For every account with a stored refresh token: reconciles Liked Songs, enriches new artists via Spotify + MusicBrainz, classifies anything lacking a current-version row. Auto-unlikes brain rot only for accounts with `cleanup_enabled = true`. |

Both endpoints reject any request whose `Authorization` header isn't `Bearer $CRON_SECRET`. To trigger manually for a single account (useful when iterating on the classifier, since MusicBrainz rate-limiting means a full scan of an uncached library takes about 1.1 seconds per unique artist):

```sh
# All accounts
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-prod-domain>/api/cron/scan-library

# Just one account
curl -H "Authorization: Bearer $CRON_SECRET" "https://<your-prod-domain>/api/cron/scan-library?account_id=<uuid>"
```

`/api/cron/ping` is a diagnostic endpoint that runs a single `SELECT 1` against the database and reports the round-trip latency.

## Aggressiveness and reversibility

The auto-unlike behavior is controlled by `AUTO_UNLIKE_THRESHOLD` (default `0.7`). Any classification with `verdict = brain_rot` and `confidence >= AUTO_UNLIKE_THRESHOLD` gets unliked on the next scan. Set it higher (e.g., `0.85`) to be more conservative, or lower to be more aggressive.

Nothing is destructive:

- Every unlike writes an `actions` row recording the track, the classification that triggered it, and the `prior_liked_at` timestamp.
- A re-like is just another `actions` row with `action = 'relike'` and `reverted_action_id` pointing back at the original. The original row's `reverted_at` is filled in.
- If you ever want to undo everything, you can iterate `actions` where `reverted_at IS NULL`, call `PUT /v1/me/tracks` on Spotify with each track ID, and write the matching `relike` rows.

The `reviews` table also acts as a safety net: a `protect` or `keep` decision on a track prevents the cleaner from ever unliking it for that account, even if the classifier later flips its verdict.

## Caveats

- **Spotify dev-mode strips a lot.** Track `popularity` and `preview_url` are not returned from `/me/tracks` for apps in Development Mode. `/audio-features` returns 403. `/artists?ids=` (batched) returns 403; we work around it by calling `/artists/{id}` per-ID with parallel chunks and tolerating per-request failures. To get any of that back, you'd need to apply for Extended Quota Mode with Spotify (multi-week review).
- **Spotify rate-limits get unforgiving.** A single bad batch of artist fetches can earn you a `Retry-After: 80000+` for hours. The fetch wrapper caps retries at 30s and gives up after that rather than burning the function budget.
- **MusicBrainz needs ~1 second per artist.** First scan of an uncached 50-song library spends about 35 seconds inside MusicBrainz. Subsequent scans are near-instant because we don't re-fetch.
- **MB monthly listeners and "popularity" aren't a thing.** Neither MB nor Spotify dev-mode exposes Spotify's UI-level monthly-listener counter. The classifier uses MB tags + life-span + Spotify follower count as the proxies. A few legitimate-but-tiny indie artists may get caught in the AI-slop net; mark them `keep` at `/review` and the cleaner will leave them alone going forward.
- **Spotify Kids accounts are not supported.** The Spotify Kids app uses a separate account type that doesn't expose the standard Web API. This works for normal Spotify accounts, including Family Plan sub-accounts on the regular Spotify app.
- **Spotify dev apps allowlist users.** Before a family member can OAuth, you must add them in the dev app's User Management section (up to 25 users in Development Mode).
- **You are running this against a kid's account.** Use judgment. The classifier is opinionated. The thresholds are tunable. Watch the `actions` table for a few days before trusting it.
- **Heuristics-only mode leans on the review queue.** Without an Anthropic API key, tracks the heuristics can't resolve land in `/review` as borderline (confidence 0.5). With MusicBrainz enrichment doing most of the heavy lifting, a typical small kid's library produces a manageable borderline list — but on larger libraries (parent accounts with hundreds of songs) expect noticeably more borderlines without LLM adjudication.

## Roadmap

- **Artist-level "trusted" overrides.** If you mark any track from artist X as `keep` at `/review`, treat all of X's other tracks as authentic-leaning. The `reviews` table already supports a nullable `account_id` for global overrides, which is the natural home for this.
- **Feedback-driven heuristic tuning.** Once enough reviews accumulate, compare heuristic verdicts to the recorded ground-truth decisions and report per-rule precision/recall. Use that to bump or demote individual rule confidences without guesswork.
- **Aggregate insights pages.** Top artists per account, listening trends from `plays`, brain-rot ingress rate over time, "tracks classified brain rot before vs. after we tightened the AI-slop rule."
- **Per-account classifier overrides beyond `keep` / `protect`.** The `reviews` table supports `always_unlike`; the scan logic doesn't honor it yet.
- **An "undo last scan" admin action** that reverts every unreverted `actions` row from the last 24 hours in one call.
- **Extended Quota Mode application** — if the dev-mode tax (no track popularity, no preview URL, no audio features) becomes a meaningful classifier ceiling, apply with Spotify to lift it.

## License

[AGPL-3.0-or-later](./LICENSE). If you host a modified version as a network service, you must make your modified source available to users of that service.
