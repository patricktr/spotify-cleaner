# spotify-cleaner

*A self-hosted Next.js app that audits a family's Spotify libraries and quietly removes AI-generated brain-rot tracks before they fill up a kid's Liked Songs.*

## Why this exists

If you have a kid with a Spotify account on your Family Plan, you've probably noticed that searches for real songs increasingly return algorithmically optimized garbage from artists named things like "Poopers the Penguin" — anonymous projects with a few hundred monthly listeners, freshly uploaded, engineered to hijack autoplay queues. The Spotify product team does not appear to care, and parental controls don't touch it. This is a personal frustration project: a thing that watches one kid's library every night and pulls out the slop, with an audit trail so anything wrongly removed can be put back.

## What it does

- **Multi-account from day one.** Connects up to four family members via OAuth and stores encrypted refresh tokens per account. Only accounts with `cleanup_enabled = true` get auto-unliked.
- **Daily library scan.** Pulls every track in Liked Songs, classifies anything new, auto-unlikes high-confidence brain rot, and writes a reversible `actions` row for every removal.
- **Recently-played poller.** Every 30 minutes it grabs the last 50 plays for each connected account (Spotify's API ceiling) so aggregate listening data accumulates over time.
- **Review queue.** Borderline tracks and low-confidence brain rot land in a `review_queue` view for thumbs-up / thumbs-down decisions per account. Decisions are stored in a `reviews` table and respected on the next scan.

## How classification works

The classifier in `lib/classifier.ts` is heuristics-first, LLM-on-the-edge. Most tracks never hit Claude.

**Hard heuristics (in order):**

1. **Toilet-humor title regex** — `poop / poo / fart / pee-pee / booger / tinkle / toot / stinky / tushy` in the track name. Verdict: `brain_rot`, confidence 0.95.
2. **AI-slop pattern** — primary artist has fewer than 5,000 followers, the track was released within the last 12 months, and track popularity is under 20. Verdict: `brain_rot`, confidence 0.92.
3. **Known brain-rot genres** — primary artist tagged with `phonk`, `sigma`, `skibidi`, `gachi`, `brainrot`, `rage rap`, or `tiktok rap`. Verdict: `brain_rot`, confidence 0.85.
4. **Mega-artist or high-popularity** — track popularity >= 70, or primary artist has more than 5 million followers. Verdict: `authentic`, confidence ~0.9.

**Everything else** goes to Claude `opus-4-7` with a cached system prompt that bakes in:

- Anchor examples that are always authentic regardless of taste: The Beatles, Queen, P!nk, Weird Al Yankovic, Talking Heads, Backstreet Boys, Mozart, Bach, any classical composer, anything that has ever charted on the Billboard Hot 100.
- Explicit lyrics are orthogonal to the judgment — `fuck` in a Pink song is not brain rot.
- The target is *dopamine-optimized algorithmic bait*, not "music I don't like." A real-but-obscure deep cut leans authentic.

The system prompt is sent with `cache_control: ephemeral`, so per-request cost stays low once the cache warms.

Heuristics-only mode is a supported configuration: leave `ANTHROPIC_API_KEY` unset (or set `LLM_CLASSIFIER_ENABLED=false`) and the heuristic layer runs as usual, with everything it can't resolve queued as `borderline` for manual review instead of being sent to Claude.

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
| `/api/cron/scan-library` | `0 4 * * *` | Daily at 04:00 UTC. Reconciles Liked Songs, classifies new tracks, auto-unlikes high-confidence brain rot, queues borderline tracks. |

Both endpoints reject any request whose `Authorization` header isn't `Bearer $CRON_SECRET`. To trigger manually:

```sh
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-prod-domain>/api/cron/scan-library
```

## Aggressiveness and reversibility

The auto-unlike behavior is controlled by `AUTO_UNLIKE_THRESHOLD` (default `0.7`). Any classification with `verdict = brain_rot` and `confidence >= AUTO_UNLIKE_THRESHOLD` gets unliked on the next scan. Set it higher (e.g., `0.85`) to be more conservative, or lower to be more aggressive.

Nothing is destructive:

- Every unlike writes an `actions` row recording the track, the classification that triggered it, and the `prior_liked_at` timestamp.
- A re-like is just another `actions` row with `action = 'relike'` and `reverted_action_id` pointing back at the original. The original row's `reverted_at` is filled in.
- If you ever want to undo everything, you can iterate `actions` where `reverted_at IS NULL`, call `PUT /v1/me/tracks` on Spotify with each track ID, and write the matching `relike` rows.

The `reviews` table also acts as a safety net: a `protect` or `keep` decision on a track prevents the cleaner from ever unliking it for that account, even if the classifier later flips its verdict.

## Caveats

- **Monthly listeners isn't a thing in the API.** Spotify's public API does not expose the "X monthly listeners" number you see in the app. The classifier uses artist follower count and track popularity as the closest proxies. These are correlated but not identical — a few legitimate-but-tiny indie artists may get caught in the AI-slop net.
- **Spotify Kids accounts are not supported.** The Spotify Kids app uses a separate account type that doesn't expose the standard Web API. This only works for normal Spotify accounts, including Family Plan sub-accounts on the regular Spotify app.
- **The review UI isn't built yet.** The `review_queue` view is populated and the `reviews` table accepts decisions, but you'd currently have to interact with it via SQL or build your own page. See Roadmap.
- **The admin dashboard isn't authenticated.** Right now, anyone who knows your production URL can see the account list and trigger an OAuth connect. Lock it down with [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection) (Standard / Password Protection) before going public.
- **You are running this against a kid's account.** Use judgment. The classifier is opinionated. The thresholds are tunable. Watch the `actions` table for a few days before trusting it.
- **Heuristics-only mode leans on the review queue.** If you run without an Anthropic API key (or with `LLM_CLASSIFIER_ENABLED=false`), every track the heuristics can't resolve is queued as `borderline` instead of being judged by Claude. Expect a larger review backlog — manageable once the review UI ships, painful via raw SQL today.

## Roadmap

- Review UI at `/review` that renders the `review_queue` view with audio previews and thumbs-up / thumbs-down buttons that write to `reviews`.
- Aggregate insights pages — top artists per account, listening trends from `plays`, brain-rot ingress rate over time.
- Per-account classifier overrides — the `reviews` table already supports it (`account_id` nullable, `decision = always_unlike` exists), but the scan logic only checks `protect` / `keep` today.
- An "undo last scan" admin action that reverts every unreverted `actions` row from the last 24 hours in one call.

## License

[AGPL-3.0-or-later](./LICENSE). If you host a modified version as a network service, you must make your modified source available to users of that service.
