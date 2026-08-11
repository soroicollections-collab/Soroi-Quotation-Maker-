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
};

export default nextConfig;
