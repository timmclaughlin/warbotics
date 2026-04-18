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

> **wpilib-docs is empty by design.** Cloudflare AI Search's `web-crawler`
> source only crawls domains verified on your account — `docs.wpilib.org`
> isn't one of ours, so the crawl route is blocked. Two paths to populate it:
>
> - **R2 mirror**: scrape WPILib locally, upload to an R2 bucket you own,
>   then recreate the instance with `type: "r2"`, `source: "<bucket-name>"`.
> - **Direct upload**: scrape + `client.uploadItem(wpilibInstance, key, text, meta)`
>   for each page. Use the same pattern as `scripts/index-content.ts`.

## 3. Slack app setup

1. Create an app at <https://api.slack.com/apps> → **From scratch**.
2. **OAuth & Permissions** → **Redirect URLs** → add:
   - `http://localhost:4321/api/auth/slack/callback` (dev)
   - `https://<your-domain>/api/auth/slack/callback` (prod)
3. **Manage Distribution** → enable **Sign in with Slack** (OpenID Connect).
   Required scopes: `openid`, `profile`, `email`.
4. From **Basic Information** copy:
   - `Client ID` → `SLACK_CLIENT_ID` (public, in `wrangler.toml [vars]`)
   - `Client Secret` → `SLACK_CLIENT_SECRET` (secret, in `.dev.vars`)
5. **(Optional)** Restrict sign-in to a single workspace: set `SLACK_TEAM_ID`
   in `wrangler.toml [vars]` to your team id (`T…`). Any other workspace will
   be rejected in the callback.
6. Generate a session HMAC key and put it in `.dev.vars`:
   ```sh
   openssl rand -base64 48
   ```
   For production: `npx wrangler secret put SESSION_SECRET`.

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
