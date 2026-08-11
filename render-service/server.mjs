// Always-on HTML-to-PDF rendering service. Exists because getting a real Chromium binary
// to run correctly inside Vercel's serverless functions (via @sparticuz/chromium +
// playwright-core) turned out to be persistently fragile in this Next.js/Turbopack build -
// three separate real bugs in that path (a version mismatch, then two different missing-file
// tracing gaps) before deciding it wasn't worth a fourth round. This service does exactly
// what a normal `playwright` install does locally: launch a real Chromium process and keep
// it warm, no serverless packaging involved at all.
//
// The main app still does all the Soroi-specific work (Handlebars templates, embedding
// logos/photos as data URIs, building the QuoteDocumentData) - it just POSTs the final HTML
// here instead of calling page.pdf() itself. This service has zero knowledge of quotes,
// templates, or branding; it only knows "HTML in, PDF bytes out."
import express from "express";
import { chromium } from "playwright";
import crypto from "node:crypto";

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.RENDER_SERVICE_TOKEN;

if (!AUTH_TOKEN) {
  console.error("RENDER_SERVICE_TOKEN is not set - refusing to start with an unauthenticated public endpoint.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "20mb" }));

// One warm browser instance, reused across requests - avoids paying Chromium's ~1-2s
// launch cost on every single PDF. Relaunches automatically if the browser process dies.
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !timingSafeEqual(token, AUTH_TOKEN)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// No auth required - used by the hosting platform's health checks and to wake a sleeping
// free-tier instance before the real request arrives.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/render-pdf", requireAuth, async (req, res) => {
  const { html } = req.body ?? {};
  if (typeof html !== "string" || !html.trim()) {
    return res.status(400).json({ error: "Request body must include a non-empty 'html' string." });
  }

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdf = await page.pdf({ printBackground: true, format: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.send(pdf);
  } catch (err) {
    console.error("Render failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`render-service listening on :${PORT}`);
});
