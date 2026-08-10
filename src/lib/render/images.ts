import * as fs from "node:fs";
import * as path from "node:path";

// Pre-resized brand assets (see the resize pass that generated them: logos to
// ~300-500px, cover photos to 1000px JPEG q65) - embedding these as base64 data URIs
// keeps every generated quote HTML file fully self-contained and portable, with no
// dependency on relative file paths resolving correctly wherever it's opened from.
//
// Resolved via process.cwd() rather than __dirname: Next.js's bundler (Turbopack)
// relocates compiled server code, so __dirname does not reliably point back to this
// file's real source directory at runtime - process.cwd() is the project root (webapp/)
// in both `next dev`/`next start` and a script run via tsx, and is the same pattern
// already used for the templates/output directories in render-pdf.ts.
const ASSETS_DIR = path.resolve(process.cwd(), "src/lib/render/assets");

const cache = new Map<string, string>();

function dataUri(relativePath: string, mimeType: string): string {
  const cached = cache.get(relativePath);
  if (cached) return cached;
  const fullPath = path.join(ASSETS_DIR, relativePath);
  const bytes = fs.readFileSync(fullPath);
  const uri = `data:${mimeType};base64,${bytes.toString("base64")}`;
  cache.set(relativePath, uri);
  return uri;
}

export function masterLogoDataUri(variant: "black" | "white" = "black"): string {
  return dataUri(`logos/master-${variant}.png`, "image/png");
}

export function coverPhotoDataUri(kind: "client" | "agent"): string {
  return dataUri(`cover-${kind}.jpg`, "image/jpeg");
}

// One logo file per Soroi property slug (10 properties). Non-Soroi properties in an
// itinerary get no logo - the templates fall back to a plain dot marker instead,
// per CLAUDE.md ("no logo file exists for those, and none should be invented").
const PROPERTY_LOGO_FILES: Record<string, string> = {
  "soroi-cheetah-tented-camp": "cheetah.png",
  "soroi-lions-bluff-lodge": "lions-bluff.png",
  "soroi-leopards-lair": "leopards-lair.png",
  "soroi-mara-bush-camp": "mara-bush-camp.png",
  "soroi-private-wing": "private-wing.png",
  "soroi-luxury-migration-camp": "luxury-migration-camp.png",
  "soroi-larsens-camp": "larsens-camp.png",
  "soroi-samburu-lodge": "samburu-lodge.png",
  "soroi-amboseli": "amboseli.png",
  "soroi-blue-diani": "blue-diani.png",
};

export function propertyLogoDataUri(propertySlug: string): string | null {
  const file = PROPERTY_LOGO_FILES[propertySlug];
  if (!file) return null;
  return dataUri(`logos/${file}`, "image/png");
}
