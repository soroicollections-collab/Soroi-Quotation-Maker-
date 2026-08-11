# render-service

A tiny, always-on HTML-to-PDF rendering service. It exists because getting a real
Chromium binary to run correctly *inside* a Vercel serverless function (via
`@sparticuz/chromium` + `playwright-core`) turned out to be persistently fragile in the
main app's Next.js/Turbopack build - three separate real bugs (a Chromium/playwright-core
version mismatch, then two different missing-file bundling gaps) before deciding it wasn't
worth chasing a fourth. This service sidesteps the whole problem class: it's a normal,
always-running Node process with a normal `playwright` install, exactly like local
development already worked before any of that serverless-specific code existed.

It knows nothing about quotes, templates, or Soroi branding - the main app (`../`) does all
of that (Handlebars compilation, embedding logos/photos as data URIs) and POSTs the final
HTML here. This service's whole job is "HTML in, PDF bytes out."

## API

- `GET /health` - no auth, returns `{"ok": true}`. Used for the host's health checks and to
  wake a sleeping free-tier instance before a real request arrives.
- `POST /render-pdf` - requires `Authorization: Bearer <RENDER_SERVICE_TOKEN>`. Body:
  `{"html": "<html>...</html>"}`. Returns the PDF as `application/pdf` bytes.

## Running locally

```sh
cd render-service
npm install
RENDER_SERVICE_TOKEN=some-local-secret npm run dev
```

The main app (`../`) only calls this service if `RENDER_SERVICE_URL` is set in its own
`.env` - leave it unset for normal local development and the main app falls back to
launching a local browser directly (the `playwright` devDependency there), same as before
this service existed. Set both `RENDER_SERVICE_URL=http://localhost:8080` and a matching
`RENDER_SERVICE_TOKEN` in the main app's `.env` if you specifically want to test the
HTTP-call path locally too.

## Deploying

This is a plain Dockerfile-based service - it'll run on Render, Railway, Fly.io, or
anywhere else that can build and run a Dockerfile with a persistent process (not a
serverless/functions product - the whole point is escaping that constraint). Steps are the
same shape regardless of host:

1. Create a new service, pointed at this GitHub repo, with **root directory set to
   `render-service/`** (this repo also contains the separate Next.js app at its root - the
   host needs to know to build from this subfolder, not the repo root).
2. It should auto-detect the `Dockerfile` and build from it. If the platform asks for a
   start command instead of using the Dockerfile's own `CMD`, use `node server.mjs`.
3. Set environment variables on the host:
   - `RENDER_SERVICE_TOKEN` - generate a fresh one (`openssl rand -base64 32`), not the same
     value as any other secret in this project. This is what authenticates the main app's
     requests - treat it like a password.
   - `PORT` - most platforms set this automatically; only set it yourself if the platform
     requires you to (the server reads `process.env.PORT`, defaulting to 8080).
4. Once deployed, note the service's public URL and set these on the **main app's** host
   (Vercel):
   - `RENDER_SERVICE_URL` - this service's URL, no trailing slash (e.g.
     `https://soroi-render.onrender.com`)
   - `RENDER_SERVICE_TOKEN` - the exact same value set on this service in step 3

## Operational notes

- **Free tiers on most platforms spin down after a period of inactivity.** The first
  request after a cold start will be slow (the platform has to boot a fresh container, then
  this process has to launch Chromium) - possibly slow enough to hit the main app's own
  download-route timeout. If PDF generation feels reliably slow only after periods of no
  use, that's this, not a new bug - either upgrade to a tier that stays warm, or set up a
  periodic health-check ping (e.g. a free uptime monitor hitting `/health` every few
  minutes) to keep it awake.
- **This endpoint executes attacker-controlled HTML if the token ever leaks** - it's a
  generic "render this HTML" service with real compute behind it, not scoped to Soroi
  quotes specifically. Keep `RENDER_SERVICE_TOKEN` out of client-side code, logs, and
  version control the same as any other secret.
- The warm browser instance (`getBrowser()` in `server.mjs`) is reused across requests for
  speed. If it crashes mid-request, the next request relaunches it automatically - no
  restart needed, but a burst of failures right after a crash is expected while that
  happens.
