import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The PDF download route reads templates/*.hbs and src/lib/render/assets/** via
  // runtime fs.readFileSync calls, not static imports - Next's automatic file tracing
  // only follows import/require, so these need to be listed explicitly or they won't
  // ship with the deployed serverless function and the route will 500 on Vercel.
  outputFileTracingIncludes: {
    "src/app/api/quotes/[quoteId]/download/route": [
      "./templates/*.hbs",
      "./src/lib/render/assets/**/*",
    ],
    // The chat route's non-Soroi property tools (list_non_soroi_rate_files,
    // read_non_soroi_rate_file) read rates-extracted/*.json via fs at runtime, not
    // import - same tracing gap as above, different route.
    "src/app/api/quote/chat/route": ["./rates-extracted/**/*"],
  },
  // playwright-core and @sparticuz/chromium (the download route's serverless PDF launch
  // path) also need files outside their own statically-traced set - their internal code
  // locates them via dynamically-computed paths the same way our own routes above do, but
  // outputFileTracingIncludes above does not reliably pick up node_modules-rooted globs
  // under this Next version's Turbopack build (confirmed by direct inspection - the glob
  // resolves correctly on its own, the files just never reach the route's .nft.json). See
  // scripts/patch-nft-includes.mjs, run as part of `npm run build`, which patches the
  // .nft.json directly instead.
};

export default nextConfig;
