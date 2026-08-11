# Microsoft's own Playwright image ships Chromium + every OS-level dependency it needs,
# pre-installed and version-matched to the tag - avoids re-deriving the exact apt package
# list `playwright install --with-deps` would need, and avoids version-matching Chromium to
# playwright-core by hand (see the git history of the Vercel serverless attempt this
# service replaces). Keep this tag in lockstep with the "playwright" version in
# package.json.
FROM mcr.microsoft.com/playwright:v1.61.0-noble

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.mjs ./

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.mjs"]
