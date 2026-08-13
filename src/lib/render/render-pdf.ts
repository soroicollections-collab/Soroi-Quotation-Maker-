import * as fs from "node:fs";
import * as path from "node:path";
import Handlebars from "handlebars";
import type { Browser } from "playwright";
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

// Getting a real Chromium binary to run correctly *inside* a Vercel serverless function
// (via @sparticuz/chromium + playwright-core) turned out to be persistently fragile in
// this Next.js/Turbopack build - three separate real bugs (a version mismatch, then two
// different missing-file tracing gaps) before deciding it wasn't worth a fourth round.
// PDF rendering now always happens in the always-on render-service/ (see its README) -
// locally that's just a plain HTTP call to a Chromium process running the exact same way
// local dev's browser used to run in-process; in production it's a call to that same
// service deployed as its own host. Either way, this file no longer launches a browser
// itself at all - one fewer place PDF rendering can break independently of the
// render-service, and one fewer heavy dependency (@sparticuz/chromium, playwright-core)
// in the main app's own deployment.
const RENDER_SERVICE_URL = process.env.RENDER_SERVICE_URL;
const RENDER_SERVICE_TOKEN = process.env.RENDER_SERVICE_TOKEN;

async function renderHtmlToPdf(html: string): Promise<Buffer> {
  if (RENDER_SERVICE_URL) {
    return renderViaService(html);
  }
  // No RENDER_SERVICE_URL configured - assume local dev without the render-service
  // running, and fall back to a directly-launched local browser (the full `playwright`
  // package, a devDependency) so `npm run dev` keeps working with zero extra setup.
  return renderViaLocalBrowser(html);
}

async function renderViaService(html: string): Promise<Buffer> {
  if (!RENDER_SERVICE_TOKEN) {
    throw new Error("RENDER_SERVICE_URL is set but RENDER_SERVICE_TOKEN is not - refusing to call the render service unauthenticated.");
  }
  const res = await fetch(`${RENDER_SERVICE_URL}/render-pdf`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RENDER_SERVICE_TOKEN}`,
    },
    body: JSON.stringify({ html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`render-service returned ${res.status}: ${body.slice(0, 500)}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

let browserPromise: Promise<Browser> | null = null;
function getLocalBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // Only imported when actually reached (no RENDER_SERVICE_URL set), so a production
    // deploy that always has RENDER_SERVICE_URL configured never needs `playwright`
    // installed at all.
    browserPromise = import("playwright").then(({ chromium }) => chromium.launch({ headless: true }));
  }
  return browserPromise;
}

async function renderViaLocalBrowser(html: string): Promise<Buffer> {
  const browser = await getLocalBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdf = await page.pdf({ printBackground: true, format: "A4" });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
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
    masterLogoWhite: masterLogoDataUri("white"),
    coverPhoto: coverPhotoDataUri(format),
  });

  return renderHtmlToPdf(html);
}

export { slugify };
