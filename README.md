# Warbotics

Astro site on Cloudflare Workers that renders `src/content/docs/**/*.md` and
exposes a Cloudflare AI Search UI across:

- **warbotics-content** — this repo's markdown (uploaded by `scripts/index-content.ts`)
- **wpilib-docs** — [docs.wpilib.org](https://docs.wpilib.org/) (Cloudflare crawls it)
- **user-`<slackUserId>`** — a per-user instance created on first Slack sign-in

Sign-in is "Sign in with Slack" (OpenID Connect). When a user signs in, the
callback ensures their personal AI Search instance exists and records the
instance id in a server-side session. Subsequent searches fan out across the
shared instances plus the caller's own — the foundation for "see each other's
questions" later.

---

## Prerequisites

- Node 20+
- A Cloudflare account with AI Search enabled (open beta as of this writing)
- A Slack workspace where you can create an app

---

## 1. Clone + install

```sh
git clone https://github.com/timmclaughlin/warbotics
cd warbotics
npm install
cp .dev.vars.example .dev.vars
```

## 2. Cloudflare setup

1. Create a KV namespace for sessions:
   ```sh
   npx wrangler kv namespace create warbotics-sessions
   ```
   Paste the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`.

2. Create a scoped API token at
   <https://dash.cloudflare.com/profile/api-tokens> with permissions:
   - `Workers AI → AI Search → Edit`
   - `Account → Workers KV Storage → Edit`

   Put the token in `.dev.vars` as `CLOUDFLARE_API_TOKEN=…`. The account ID is
   already pinned in `wrangler.toml` (`e9abbdd7b6e80b20b43abe0c39a09019`).

   For production: `npx wrangler secret put CLOUDFLARE_API_TOKEN`. The Worker
   uses this secret at runtime to create per-user instances on Slack login and
   to log search queries into the caller's personal instance.

   > For one-off local bootstrap runs you can skip the token: export the
   > wrangler OAuth token into the same var:
   > ```sh
   > export CLOUDFLARE_API_TOKEN=$(grep oauth_token "$HOME/Library/Preferences/.wrangler/config/default.toml" | head -1 | sed 's/.*= *//;s/"//g')
   > ```
   > The OAuth token is short-lived but fine for a one-time `npm run bootstrap:instances`.

3. Create the shared AI Search instances:
   ```sh
   npm run bootstrap:instances
   ```
   This creates the `warbotics` namespace and two instances: `warbotics-content`
   (fed by `npm run index:content`) and `wpilib-docs` (empty — see note below).

4. Index the markdown in this repo into `warbotics-content`:
   ```sh
   npm run index:content
   ```
   Re-run this whenever content changes. (You can wire it into GitHub Actions
   on pushes to `main` — see `§ Re-indexing` below.)

### Populating `wpilib-docs` via Browser Rendering → R2

Cloudflare AI Search's built-in `web-crawler` source only works on domains
verified on your account, so `docs.wpilib.org` is blocked. We go around that
with Browser Rendering's `/crawl` endpoint — it'll fetch WPILib for us, we
write the markdown into an R2 bucket we own, and re-bind the AI Search
instance to that bucket.

One-time setup:

1. **Enable R2** on your account at
   <https://dash.cloudflare.com/e9abbdd7b6e80b20b43abe0c39a09019/r2> (accept
   the billing terms — pay-as-you-go, ~free at this scale).
2. **Create the bucket**:
   ```sh
   npx wrangler r2 bucket create warbotics-wpilib
   ```
3. **Create an API token** at <https://dash.cloudflare.com/profile/api-tokens>
   with these permissions:
   - `Workers AI → AI Search: Edit`
   - `Account → Workers R2 Storage: Edit`
   - `Account → Browser Rendering: Edit`

   Put it in `.dev.vars` as `CLOUDFLARE_API_TOKEN`. (The short-lived wrangler
   OAuth token doesn't include the Browser Rendering scope.)

Then run:

```sh
npm run crawl:wpilib
```

This submits a crawl (500 pages, markdown), polls until it finishes, uploads
each page into `r2://warbotics-wpilib/`, and recreates `wpilib-docs` as an
R2-backed instance. Safe to re-run; each run replaces the previous contents.

To crawl a different source, set `CRAWL_URL`, `CRAWL_LIMIT`, `WPILIB_BUCKET`
env vars before running. Add more sources by making sibling `crawl-*.ts`
scripts (or parameterize further).

## 3. Slack app setup

This is a **"Sign in with Slack" (OIDC) app** — pure identity provider, no bot
user, no channels, no slash commands. If you see "create a bot" instructions
elsewhere, that's a different kind of Slack app.

### Create the app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. App name: `Warbotics`. Development workspace: the one matching team id
   `TCB754LRM`.
3. Click **Create App**.

### Enable "Sign in with Slack"

Slack hides the OIDC scopes behind a feature toggle. You won't see `openid`
in the normal scope picker until you enable it.

1. In the sidebar go to **OAuth & Permissions**.
2. Scroll to **Scopes** → **User Token Scopes** → **Add an OAuth Scope** and
   add all three:
   - `openid`
   - `email`
   - `profile`
   (If they're not in the dropdown, scroll down to **"Sign in with Slack"**
   section and click **Add to your app** — that unlocks them.)
3. Scroll to **Redirect URLs** → **Add New Redirect URL** → add both:
   - `https://warbotics.tim-e9a.workers.dev/api/auth/slack/callback` (prod)
   - `http://localhost:4321/api/auth/slack/callback` (dev)
   Click **Save URLs**.

### No bot, no channels

- Do **not** add bot token scopes.
- Do **not** add event subscriptions.
- Do **not** add slash commands or interactivity.
- Do **not** add an incoming webhook.

### Install + copy credentials

1. **Install App** (sidebar) → **Install to Workspace** → **Allow**.
   You're authorizing yourself to sign in, not adding a bot.
2. **Basic Information** → **App Credentials**:
   - `Client ID` → paste into `wrangler.toml [vars]` under `SLACK_CLIENT_ID`
   - `Client Secret` → `.dev.vars` as `SLACK_CLIENT_SECRET`, and for prod:
     ```sh
     npx wrangler secret put SLACK_CLIENT_SECRET
     ```
   - `Signing Secret` → same treatment for `SLACK_SIGNING_SECRET` (not
     currently used — we don't receive Slack events — but wired for when we
     start accepting webhooks).

### Workspace lock

`SLACK_TEAM_ID = "TCB754LRM"` is already set in `wrangler.toml`, so the
callback rejects any sign-in that comes back with a different team id. No
action needed.

### Session secret

Already generated in your `.dev.vars`. For prod:
```sh
npx wrangler secret put SESSION_SECRET    # paste the value from .dev.vars
```

## 4. Run locally

```sh
npm run dev            # Astro dev server (http://localhost:4321)
# or, to run against the Cloudflare runtime with bindings:
npm run build && npm run preview
```

## 5. Deploy

Set the production site URL in `wrangler.toml` (`SLACK_REDIRECT_URI`) and
`astro.config.mjs` (`site`), then:

```sh
npm run deploy
```

Promote secrets one-by-one:

```sh
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put SLACK_CLIENT_SECRET
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SESSION_SECRET
```

---

## Architecture

```
 Browser ──► Astro SSR (Cloudflare Worker)
                │
                ├── src/middleware.ts        — reads session cookie, gates routes
                ├── src/pages/api/auth/...   — Slack OIDC flow
                ├── src/pages/api/search.ts  — cross-instance search
                │
                └── src/lib/
                    ├── slack.ts    — OIDC authorize / token / userinfo
                    ├── session.ts  — signed cookie + KV-backed session
                    └── search.ts   — REST wrapper for AI Search

 Cloudflare AI Search (namespace: "warbotics")
   ├── warbotics-content   — this repo's md (uploaded by scripts/index-content.ts)
   ├── wpilib-docs         — crawled from https://docs.wpilib.org/
   └── user-<slackUserId>  — created on first login; logs queries for personal context
```

### Per-user instances

On OAuth callback:

```ts
await search.ensureInstance(`user-${slackUserId}`, {
  indexMethod: { keyword: true, vector: true },
});
```

Each query on `/api/search` fans out across the shared instances and the
caller's own instance, and pipes the query text back into the personal
instance (via `ctx.waitUntil`) so future searches surface prior context.

### Future: see each others' questions

The personal instances are already keyed by Slack user id. A future change
can add a `team-<slackTeamId>` shared instance that mirrors queries marked
public — and `search()` can include the team instance for every authenticated
user. No schema migration required.

### Re-indexing

The simplest path is a GitHub Action on push to `main`:

```yaml
- run: npm ci
- run: npm run index:content
  env:
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

For a scheduled re-index you can add a Cloudflare Cron trigger to a second
Worker (the Astro Worker's handler is SSR-shaped and doesn't expose
`scheduled()` without extra plumbing).

### Adding more crawl sources

Edit `scripts/bootstrap-instances.ts` and add another `client.ensureInstance`
call with a different `id` and `website.url`. Then add the new instance id
to `AI_SEARCH_INSTANCE_*` in `wrangler.toml` and include it in the
`instanceIds` array in `src/pages/api/search.ts`.

---

## File layout

```
astro.config.mjs         — Astro + Cloudflare adapter
wrangler.toml            — Worker config, bindings, public vars
.dev.vars.example        — local secrets template (copy to .dev.vars)
src/
  env.d.ts               — env bindings + App.Locals types
  middleware.ts          — session loading + route gating
  content.config.ts      — "docs" collection schema
  content/docs/*.md      — renderable + indexable content
  lib/{slack,session,search}.ts
  layouts/Base.astro
  pages/
    index.astro, login.astro, search.astro
    docs/{index,[...slug]}.astro
    api/search.ts
    api/auth/logout.ts
    api/auth/slack/{authorize,callback}.ts
  styles/global.css
scripts/
  bootstrap-instances.ts — create shared AI Search instances
  index-content.ts       — upload md files to warbotics-content
  load-env.ts            — reads .dev.vars / .env for node scripts
```
