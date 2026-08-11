import * as fs from "node:fs";
import * as path from "node:path";
import Handlebars from "handlebars";
import type { Browser } from "playwright-core";
import type { QuoteDocumentData } from "./quote-data";
import { masterLogoDataUri, coverPhotoDataUri } from "./images";

// process.cwd() inside the Next.js server (or a script run via tsx from webapp/) is
// already webapp/ - resolve template paths relative to that. Deliberately no disk
// output anywhere in this file: PDFs are rendered in-memory and streamed straight back
// to the caller (see the download route) - nothing is persisted server-side, per the
// "stream-only, no server-side quote storage" decision. Quote.documentData in Postgres
// is what makes a later re-render possible, not a saved file.
const TEMPLATES_DIR = path.resolve(process.cwd(), "templates");

const compiledCache = new Map<string, HandlebarsTemplateDelegate>();

function getTemplate(name: "agent-quote" | "client-quote"): HandlebarsTemplateDelegate {
  const cached = compiledCache.get(name);
  if (cached) return cached;
  const source = fs.readFileSync(path.join(TEMPLATES_DIR, `${name}.hbs`), "utf-8");
  const compiled = Handlebars.compile(source, { noEscape: true });
  compiledCache.set(name, compiled);
  return compiled;
}

// Vercel (and AWS Lambda, which it runs on) sets VERCEL=1 in every deployed environment,
// local `next dev`/`next start` never do. On Vercel there's no full desktop Chromium
// install available, so we launch a serverless-packaged build via @sparticuz/chromium
// instead - see that package's own README for this exact integration pattern with
// Playwright. Locally, the full `playwright` package's own bundled Chromium (installed
// via `npx playwright install chromium`) is simpler and doesn't need any of this.
const IS_SERVERLESS = !!process.env.VERCEL;

let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = IS_SERVERLESS ? launchServerlessBrowser() : launchLocalBrowser();
  }
  return browserPromise;
}

// playwright-core's version must match the Chromium build @sparticuz/chromium bundles -
// they're driven over the same CDP protocol, and a mismatch (e.g. playwright-core expecting
// Chromium 151 while @sparticuz/chromium only ships 149) fails the launch outright. This
// broke the download route in production once already (see git history) because
// playwright-core's caret range let it drift ahead of what @sparticuz/chromium had
// published. Both packages - and the local-dev-only `playwright` in devDependencies, kept
// in lockstep for the same reason - are pinned to exact versions in package.json rather
// than "^" for this reason. Before bumping either one, check that
// https://cdn.jsdelivr.net/npm/playwright-core@<version>/browsers.json reports the same
// Chromium major version as whatever @sparticuz/chromium version is being paired with it.
async function launchServerlessBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const chromiumBinary = (await import("@sparticuz/chromium")).default;
  return chromium.launch({
    args: chromiumBinary.args,
    executablePath: await chromiumBinary.executablePath(),
    headless: true,
  });
}

async function launchLocalBrowser(): Promise<Browser> {
  // Full `playwright` package - only imported in the local-dev path, so it's never
  // pulled into the Vercel serverless bundle (its own bundled browser download would
  // be redundant with @sparticuz/chromium and needlessly bloat the deployment).
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true }) as unknown as Promise<Browser>;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

/** Renders one format's PDF entirely in memory - no disk read/write of the output. */
export async function renderQuotePdfBuffer(params: {
  format: "agent" | "client";
  data: QuoteDocumentData;
}): Promise<Buffer> {
  const { format, data } = params;
  const templateName = format === "agent" ? "agent-quote" : "client-quote";
  const template = getTemplate(templateName);
  const html = template({
    ...data,
    masterLogo: masterLogoDataUri("black"),
    coverPhoto: coverPhotoDataUri(format),
  });

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdf = await page.pdf({ printBackground: true, format: "A4" });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

export { slugify };
