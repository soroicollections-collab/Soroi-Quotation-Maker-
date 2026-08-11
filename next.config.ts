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
      // @sparticuz/chromium locates its own ~66MB of binary blobs (chromium.br,
      // swiftshader/fonts/al2023 tarballs) via `dirname(fileURLToPath(import.meta.url))`
      // inside its own package, not a literal path - the same dynamic-path tracing gap
      // as the two entries above, just inside a dependency's code instead of ours. Without
      // this, the deployed function launches with no actual Chromium binary to find.
      "./node_modules/@sparticuz/chromium/bin/**/*",
    ],
    // The chat route's non-Soroi property tools (list_non_soroi_rate_files,
    // read_non_soroi_rate_file) read rates-extracted/*.json via fs at runtime, not
    // import - same tracing gap as above, different route.
    "src/app/api/quote/chat/route": ["./rates-extracted/**/*"],
  },
};

export default nextConfig;
