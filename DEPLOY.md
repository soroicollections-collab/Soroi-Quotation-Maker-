# Deploying to Vercel + Neon (+ render-service)

Live setup, kept current as it changes rather than describing a one-time initial deploy.
The app has two deployed pieces:
- **This Next.js app**, on Vercel, connected to `github.com/soroicollections-collab/Soroi-Quotation-Maker-` (repo root = this `webapp/` folder).
- **`render-service/`**, a separate always-on service that renders PDFs - see its own
  README for what it is and why it's separate. Deploy it independently (Render, Railway,
  Fly.io, or similar - anywhere that runs a Dockerfile as a persistent process).

## Accounts already set up

- **GitHub**: repo above, `main` branch auto-deploys to Vercel on push.
- **Vercel**: project connected, root directory `webapp/`.
- **Neon**: Postgres database created; `DATABASE_URL` uses the **pooled** connection string
  (has `-pooler` in the hostname) - serverless functions open many short-lived connections,
  and a direct connection can hit Postgres's connection limit under concurrent use.
- **Anthropic**: API key set, spend cap configured in the Console.

## Environment variables (Vercel → Project Settings → Environment Variables)

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon's **pooled** connection string |
| `AUTH_SECRET` | A fresh secret for production - **do not reuse the local dev one**. Generate with `openssl rand -base64 32` |
| `ANTHROPIC_API_KEY` | Your real key |
| `ANTHROPIC_MODEL_EXTRACTION` | `claude-opus-5` |
| `ANTHROPIC_MODEL_CHAT` | `claude-sonnet-5` |
| `RENDER_SERVICE_URL` | The deployed render-service's public URL, no trailing slash |
| `RENDER_SERVICE_TOKEN` | Must exactly match the same variable set on render-service itself |

Auth.js v5 auto-detects the deployment URL on Vercel (via `VERCEL_URL`) - no `AUTH_URL`
needed unless a custom domain is added later, in which case set `AUTH_URL` explicitly.

If `RENDER_SERVICE_URL` isn't set, PDF rendering falls back to launching a local browser
directly - fine for local dev, **not viable on Vercel** (no desktop Chromium available in
that environment; this is exactly the setup that broke three times before render-service/
existed - see its README for the history). Always set both vars in production.

## Database schema: known gap - migration history is incomplete

`prisma/migrations/` only has two migrations (`20260805171252_init`,
`20260805175448_add_rate_card_seasons`). Every schema change since then was applied with
`prisma db push`, which doesn't write migration files. Running `prisma migrate deploy`
against a fresh database would only create the first two migrations' tables and silently
leave the rest missing - use `prisma db push` against the target database instead, same as
local dev:
```sh
DATABASE_URL="<pooled connection string>" npx prisma db push
```
If the change narrows an enum or otherwise risks data loss, Prisma requires
`--accept-data-loss` and (when run by an AI agent) an explicit human consent step - check
what's actually using the old value first rather than assuming it's safe.

**Worth fixing properly before this matters more** (i.e. once real data and a team both
depend on coordinated schema changes): regenerate a clean migration history with
`prisma migrate dev` against a disposable database, so future changes go through
`prisma migrate deploy` instead of `db push`. Flagging this rather than silently doing it
now, since squashing history is a judgment call, not a required step.

## Build configuration

Vercel runs `npm install` then `npm run build` (`prisma generate && next build`) from the
`webapp/` root directory - it never touches `render-service/`, which is deployed
separately with its own root-directory setting on its own host. `@prisma/client` needs
`prisma generate` to run before `next build` sees any Prisma types, which the build script
already does.

`playwright` is a **devDependency** here, only used as a local-dev fallback when
`RENDER_SERVICE_URL` isn't set (see `lib/render/render-pdf.ts`) - Vercel's production
install skips devDependencies, so the deployed function never tries to download a desktop
Chromium build. There is no `@sparticuz/chromium` or `playwright-core` dependency in this
app at all anymore; that whole approach (launching Chromium inside the Vercel function
itself) was replaced by render-service/ after three separate real bugs trying to make it
work (a version mismatch, then two different missing-file bundling gaps under this
Next.js/Turbopack build) - see git history around the render-service/ introduction if the
full story is ever needed again.

## Architecture notes

- **No PDF or uploaded rate document is ever written to disk anywhere**, by design (per
  the "stream-only" decision) - the download route renders fresh from
  `Quote.documentData` (stored in Postgres) on every request, via a call to render-service,
  and streams the bytes straight back. Re-downloading a quote costs a fresh render each
  time; nothing is cached.
- `next.config.ts` has `outputFileTracingIncludes` pointing at `templates/*.hbs` and
  `src/lib/render/assets/**` - without this, Vercel's build wouldn't know to bundle those
  files into the download route's serverless function, since they're read via `fs` at
  runtime rather than imported. (This mechanism works fine for project-relative paths; it's
  specifically `node_modules`-rooted globs that didn't work reliably, which is part of why
  the Chromium-in-Vercel-function approach was abandoned rather than patched further.)
- The chat route and download route both set `runtime = "nodejs"` (not Edge - Prisma needs
  real Node) and a longer `maxDuration` than Vercel's default, since a multi-tool-call
  agent turn or a render-service round-trip can run past 10s.

## Post-deploy smoke test

1. `npx tsx prisma/seed.ts` (pointed at the Neon DB) to create your Rate Manager account -
   or add a one-off script/route to do this, since Vercel doesn't give you a shell.
2. Re-run `migrate-rates.ts` against the Neon DB to populate the Soroi rate cards (same
   script, same command, just pointed at `DATABASE_URL=<neon>` instead of local Postgres).
3. Log in on the real URL, generate a test quote, confirm the download button actually
   returns a PDF for both formats.
4. Confirm a Reservations- or Sales-role test account can't reach `/admin/rates` or
   `/admin/users`.
5. If PDF downloads are slow specifically after a period of no use, check whether
   render-service is on a free tier that spins down when idle - see its README's
   "Operational notes" section.
