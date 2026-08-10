# Deploying to Vercel + Neon

This is the setup needed to get the app off `localhost` and onto a real URL a few
reservations team members can log into. I can't create any of these accounts myself -
everything in "Prerequisites" needs you to do it, then hand me the values.

## Prerequisites (you do these)

1. **A git repository.** This project has never been put under git - `git status` from
   the project root confirms `fatal: not a git repository`. Vercel's normal workflow
   (auto-deploy on push) needs the code in GitHub, GitLab, or Bitbucket. Simplest path:
   ```sh
   cd "Quotation Maker"
   git init
   git add webapp CLAUDE.md AGENTS.md   # NOT rates-extracted/, the CONTRACT RATES trees, etc.
   git commit -m "Initial commit"
   ```
   then create a **private** GitHub repo and push to it. I can help write a sensible
   `.gitignore` and do the commits, but creating the actual GitHub repo (and deciding who
   else gets access) is your call.
2. **A Vercel account**, with the GitHub repo above connected as a new project. Set the
   project's root directory to `webapp/` (this repo has the Next.js app in a subfolder,
   not at the repo root).
3. **A Neon account** with a new Postgres project/database created. Neon gives you two
   connection strings - a direct one and a **pooled** one (usually has `-pooler` in the
   hostname). **Use the pooled one for `DATABASE_URL`** - serverless functions open many
   short-lived connections, and Neon's pooler (PgBouncer-based) is built for exactly that;
   a direct connection can hit Postgres's connection limit under concurrent use.
4. Your **Anthropic API key** (already have this) and the **spend cap** set in the
   Anthropic Console, per the earlier conversation about predictable monthly cost.

## Environment variables (set these in Vercel's Project Settings → Environment Variables)

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon's **pooled** connection string |
| `AUTH_SECRET` | A fresh secret for production - **do not reuse the local dev one**. Generate with `openssl rand -base64 32` |
| `ANTHROPIC_API_KEY` | Your real key |
| `ANTHROPIC_MODEL_EXTRACTION` | `claude-opus-5` |
| `ANTHROPIC_MODEL_CHAT` | `claude-sonnet-5` |

Auth.js v5 auto-detects the deployment URL on Vercel (via `VERCEL_URL`) - no `AUTH_URL`
needed unless a custom domain is added later, in which case set `AUTH_URL` explicitly.

## Database schema: known gap - migration history is incomplete

`prisma/migrations/` only has two migrations (`20260805171252_init`,
`20260805175448_add_rate_card_seasons`). Every schema change since then - `RateCardEvent`,
`Quote`, `Conversation`, `ConversationMessage`, `SourceDocument`, `ExtractionRun`, and
today's `Quote.documentData` field - was applied with `prisma db push`, which doesn't
write migration files. Running `prisma migrate deploy` against a fresh Neon database
right now would only create the first two migrations' tables and silently leave the rest
missing.

**For this first deploy**, the pragmatic fix is to sync the schema the same way it's been
done locally the whole time:
```sh
DATABASE_URL="<neon pooled connection string>" npx prisma db push
```
Run this once, from your machine, pointed at the new Neon database, before the app is
used for real. It's the same command (and the same honest gap) as local dev - I'm not
introducing a new risk here, just carrying forward the existing one.

**Worth fixing properly before this matters more** (i.e. once real data and a team both
depend on coordinated schema changes): regenerate a clean migration history with
`prisma migrate dev` against a disposable database, so future changes go through
`prisma migrate deploy` instead of `db push`. Flagging this rather than silently doing it
now, since squashing history is a judgment call, not a required step for launch.

## Build configuration

Vercel runs `npm install` then `npm run build`. Two things this needs, both already true
of this repo:
- `@prisma/client` is a dependency, and `prisma generate` needs to run before `next build`
  sees any Prisma types. Check `package.json`'s `build` script actually does this (if not:
  `"build": "prisma generate && next build"`).
- `playwright` (the full package with its own bundled browser download) is a
  **devDependency**, not a regular dependency - Vercel's production install skips
  devDependencies, so it won't try to download a desktop Chromium build during the Vercel
  build. `playwright-core` and `@sparticuz/chromium` (the serverless-compatible browser)
  are regular dependencies and do get installed.

## What changed to make this deployable at all

For context, since this wasn't originally built with Vercel in mind:
- PDF rendering (`lib/render/render-pdf.ts`) now detects `process.env.VERCEL` and
  launches either the full local Chromium (dev) or `@sparticuz/chromium` +
  `playwright-core` (Vercel) - see that file's comments.
- **No PDF or uploaded rate document is ever written to disk anywhere**, by design (per
  the "stream-only" decision) - the download route renders fresh from
  `Quote.documentData` (stored in Postgres) on every request and streams the bytes
  straight back. Re-downloading a quote costs a fresh Chromium render each time; nothing
  is cached.
- `next.config.ts` has `outputFileTracingIncludes` pointing at `templates/*.hbs` and
  `src/lib/render/assets/**` - without this, Vercel's build wouldn't know to bundle those
  files into the download route's serverless function, since they're read via `fs` at
  runtime rather than imported.
- The chat route and download route both set `runtime = "nodejs"` (not Edge - Prisma and
  Playwright both need real Node) and a longer `maxDuration` than Vercel's default, since
  a multi-tool-call agent turn or a Chromium PDF render can run past 10s.

## Post-deploy smoke test

Once deployed and `DATABASE_URL` is pointed at the fresh Neon database:
1. `npx tsx prisma/seed.ts` (pointed at the Neon DB) to create your Rate Manager account -
   or add a one-off script/route to do this, since Vercel doesn't give you a shell.
2. Re-run `migrate-rates.ts` against the Neon DB to populate the Soroi rate cards (same
   script, same command, just pointed at `DATABASE_URL=<neon>` instead of local Postgres).
3. Log in on the real URL, generate a test quote, confirm the download button actually
   returns a PDF (this is the one path that behaves differently in production vs. local
   dev - it's exercising `@sparticuz/chromium` for the first time outside this
   conversation's testing).
4. Confirm a STAFF-role test account can't reach `/admin/rates` or `/admin/users` - this
   was flagged as untested weeks ago and still hasn't been checked for real.
