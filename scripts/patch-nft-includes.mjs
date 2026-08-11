// outputFileTracingIncludes in next.config.ts does not reliably pick up node_modules-rooted
// globs under this Next.js version's Turbopack build (confirmed by direct inspection: the
// glob itself resolves correctly, but the resolved files never make it into the route's
// .nft.json - see the investigation in the "PDF download 500" conversation this was added
// in). That .nft.json is the literal file Vercel's build step reads to decide which files
// ship inside each deployed serverless function, so this script edits it directly, as a
// post-build step, adding exactly what outputFileTracingIncludes should have added itself.
//
// If a future Next.js upgrade fixes the underlying Turbopack tracing gap, the entries this
// script adds will just become harmless duplicates (the .nft.json's files end up in a Set
// downstream) - safe to leave in place either way, but worth deleting this script and its
// package.json wiring if that's ever confirmed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const patches = [
  {
    traceFile: join(projectRoot, ".next/server/app/api/quotes/[quoteId]/download/route.js.nft.json"),
    mustExist: [
      join(projectRoot, "node_modules/playwright-core/browsers.json"),
      join(projectRoot, "node_modules/@sparticuz/chromium/bin/chromium.br"),
      join(projectRoot, "node_modules/@sparticuz/chromium/bin/swiftshader.tar.br"),
      join(projectRoot, "node_modules/@sparticuz/chromium/bin/fonts.tar.br"),
      join(projectRoot, "node_modules/@sparticuz/chromium/bin/al2023.tar.br"),
    ],
  },
];

let patchedAny = false;
for (const { traceFile, mustExist } of patches) {
  if (!existsSync(traceFile)) {
    console.warn(`[patch-nft-includes] trace file not found, skipping: ${traceFile}`);
    continue;
  }
  const data = JSON.parse(readFileSync(traceFile, "utf-8"));
  const traceDir = dirname(traceFile);
  let changed = false;
  for (const absPath of mustExist) {
    if (!existsSync(absPath)) {
      console.warn(`[patch-nft-includes] source file missing, cannot include: ${absPath}`);
      continue;
    }
    const relPath = relative(traceDir, absPath);
    if (!data.files.includes(relPath)) {
      data.files.push(relPath);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(traceFile, JSON.stringify(data));
    console.log(`[patch-nft-includes] patched ${relative(projectRoot, traceFile)}`);
    patchedAny = true;
  }
}

if (!patchedAny) {
  console.log("[patch-nft-includes] nothing to patch (already present or trace files missing)");
}
