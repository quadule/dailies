// Real, openly-licensed title-card backgrounds from Wikimedia Commons — a "safe
// source" alternative to the local gradient and the generative providers, for
// when you want actual imagery without an API key or a GPU. Additive
// TitleBackgroundProvider: render() writes a finished image to outPath or throws,
// and narrate.ts wraps it so any failure degrades to the next background source.
//
// LICENSING (the reason this is careful, not a naive image search): a Commons
// search returns MIXED licenses — public domain, CC0, CC-BY, CC-BY-SA, and also
// non-free / fair-use files. We query imageinfo `extmetadata`, filter to a
// permissive allowlist, and push full attribution (artist, license, source page)
// into the run `notes` — CC-BY/BY-SA REQUIRE attribution. $DAILIES_WIKIMEDIA_IMAGES=1
// forces it on and =0 turns it off, but it now also switches on by itself when
// no image MODEL covers the title-card slot (announced in the notes) — it is the
// stock fallback, mirroring archive.org for music. Only public GETs are made.
import { writeFile } from "node:fs/promises";
import type { Logger } from "dailies-logger";
import { userAgent } from "./http.js";
import type { MediaProviders, TitleBackgroundProvider } from "./providers.js";

const API_URL = "https://commons.wikimedia.org/w/api.php";
const SEARCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
// How many hits to consider; the first permissive raster wins.
const SEARCH_LIMIT = 20;

type Echo = (line: string) => void;

export interface CommonsImage {
  artist?: string;
  descriptionUrl: string;
  imageUrl: string;
  license: string;
  title: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested).
// ---------------------------------------------------------------------------

// Collapse whitespace and cap length.
export function sanitizeImageQuery(directionText: string): string {
  return directionText.replace(/\s+/g, " ").trim().slice(0, 120);
}

// Common words carrying no visual signal — dropped so the search terms are just
// the evocative nouns/adjectives.
const IMAGE_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "on",
  "at",
  "and",
  "or",
  "to",
  "with",
  "as",
  "is",
  "it",
  "its",
  "into",
  "for",
  "by",
  "from",
  "over",
  "under",
  "near",
  "this",
  "that",
  "these",
  "those",
  "be",
  "being",
  "amid",
  "up",
  "down",
  "out",
  "off",
  "then",
  "than",
  "render",
  "style",
  "scene",
  "shot",
  "image",
  "photo",
  "picture",
  "background",
  "cinematic",
]);

// How many keywords the FIRST Commons search uses. CirrusSearch ANDs file-search
// terms, so a long conjunction matches nothing (e.g. six evocative-but-unrelated
// words never co-occur in one file). Two–three plain terms reliably return
// images, so we lead with a broad query and relax from there.
const MAX_SEARCH_TERMS = 3;

// Extract a few evocative keywords from a (possibly long, multi-theme) creative
// direction. Commons CirrusSearch treats file-search terms as an AND, so feeding
// it a whole styled sentence — or a hyphenated compound like "rain-soaked" —
// matches nothing; a short list of plain content words is what actually hits.
// Strips accents (so "exposé" → "expose", not a truncated "expos"), splits on any
// non-alphanumeric (hyphens break apart), drops stopwords and very short tokens,
// de-dupes, and caps the count. Pure → unit-tested.
export function imageKeywords(directionText: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  const normalized = directionText
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  for (const raw of normalized.split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || IMAGE_STOPWORDS.has(raw) || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    words.push(raw);
    if (words.length >= 5) {
      break;
    }
  }
  return words;
}

// Build the Commons API URL: a generator=search over the File namespace,
// restricted to raster images (filetype:bitmap), pulling the display URL + the
// license extmetadata for each hit. Pure → unit-tested.
export function buildCommonsSearchUrl(
  directionText: string,
  width: number
): string {
  const terms = sanitizeImageQuery(directionText) || "cinematic landscape";
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${terms} filetype:bitmap`,
    gsrnamespace: "6", // File:
    gsrlimit: String(SEARCH_LIMIT),
    prop: "imageinfo",
    iiprop: "url|mime|mediatype|extmetadata",
    iiurlwidth: String(Math.max(640, Math.round(width))),
  });
  return `${API_URL}?${params.toString()}`;
}

// A permissive-license allowlist: public domain, CC0, and the CC-BY / CC-BY-SA
// family (any version). Everything else — non-free, fair-use, GFDL-only,
// unknown — is rejected. Matches the machine-readable extmetadata `License` key
// (e.g. "pd", "cc0", "cc-by-2.0", "cc-by-sa-4.0"). Pure → unit-tested.
export function isPermissiveLicense(licenseKey: unknown): boolean {
  if (typeof licenseKey !== "string") {
    return false;
  }
  const key = licenseKey.trim().toLowerCase();
  return (
    key === "pd" ||
    key === "cc0" ||
    key.startsWith("cc-by-sa") ||
    key.startsWith("cc-by") ||
    key === "cc-pd-mark"
  );
}

// Strip the HTML Commons wraps the Artist field in, to a short plain string.
export function cleanArtist(html: unknown): string | undefined {
  if (typeof html !== "string") {
    return;
  }
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 80) : undefined;
}

// Pick the first hit that's a raster image under a permissive license and has a
// usable display URL. Returns null when none qualifies. Pure → unit-tested.
export function pickCommonsImage(body: unknown): CommonsImage | null {
  const pages = (body as { query?: { pages?: Record<string, unknown> } })?.query
    ?.pages;
  if (!pages || typeof pages !== "object") {
    return null;
  }
  // `search` order is lost in the pages map; sort by the generator index so the
  // most relevant hit is considered first.
  const sorted = Object.values(pages).sort(
    (a, b) =>
      ((a as { index?: number }).index ?? 0) -
      ((b as { index?: number }).index ?? 0)
  );
  for (const page of sorted) {
    const info = (page as { imageinfo?: unknown[] }).imageinfo?.[0] as
      | {
          url?: unknown;
          thumburl?: unknown;
          mediatype?: unknown;
          extmetadata?: Record<string, { value?: unknown }>;
        }
      | undefined;
    if (info?.mediatype !== "BITMAP") {
      continue;
    }
    const meta = info.extmetadata ?? {};
    if (!isPermissiveLicense(meta.License?.value)) {
      continue;
    }
    const imageUrl =
      (typeof info.thumburl === "string" && info.thumburl) ||
      (typeof info.url === "string" && info.url) ||
      "";
    if (!imageUrl) {
      continue;
    }
    return {
      title: String((page as { title?: unknown }).title ?? "Wikimedia image"),
      imageUrl,
      descriptionUrl:
        typeof meta.LicenseUrl?.value === "string"
          ? (meta.LicenseUrl.value as string)
          : "",
      license:
        typeof meta.LicenseShortName?.value === "string"
          ? (meta.LicenseShortName.value as string)
          : String(meta.License?.value ?? "unknown"),
      artist: cleanArtist(meta.Artist?.value),
    };
  }
  return null;
}

// A human attribution line for the run notes (CC-BY/BY-SA require crediting the
// author + license). Pure → unit-tested.
export function attributionFor(image: CommonsImage): string {
  const who = image.artist ? ` by ${image.artist}` : "";
  const lic = image.license ? ` (${image.license})` : "";
  const page = image.title
    ? ` — https://commons.wikimedia.org/wiki/${encodeURIComponent(image.title.replace(/ /g, "_"))}`
    : "";
  return `title image: "${image.title}"${who}${lic}${page}`;
}

// The credits-roll line for an image: the creator first, because that is who
// the licence requires be credited — the platform and licence follow as
// provenance. Pure → unit-tested.
export function creditFor(image: CommonsImage): string {
  const who = image.artist?.trim() || "unknown creator";
  const lic = image.license ? `, ${image.license}` : "";
  return `Title art — ${who} (Wikimedia Commons${lic})`;
}

// ---------------------------------------------------------------------------
// I/O.
// ---------------------------------------------------------------------------

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "user-agent": userAgent() },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Wikimedia GET ${res.status}`);
  }
  return res.json();
}

async function downloadTo(url: string, outPath: string): Promise<void> {
  const res = await fetch(url, {
    headers: { "user-agent": userAgent() },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Wikimedia download ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("Wikimedia returned 0 bytes");
  }
  await writeFile(outPath, bytes);
}

function createProvider(notes: string[], echo?: Echo): TitleBackgroundProvider {
  // The image this run actually used, so credit() can name its author.
  let used: CommonsImage | null = null;
  return {
    id: "wikimedia-image",
    credit() {
      return used ? creditFor(used) : undefined;
    },
    async render(directionText, width, _height, outPath) {
      // Progressively relax the query: start with all extracted keywords and
      // drop the trailing (less salient) ones until a permissive image matches —
      // down to a single keyword, then buildCommonsSearchUrl's generic fallback.
      // This is why a long/multi-theme direction still lands an image.
      const keywords = imageKeywords(directionText);
      let image: CommonsImage | null = null;
      const start = Math.min(Math.max(1, keywords.length), MAX_SEARCH_TERMS);
      for (let n = start; n >= 1 && !image; n--) {
        const searchUrl = buildCommonsSearchUrl(
          keywords.slice(0, n).join(" "),
          width
        );
        echo?.(`$ curl -s ${searchUrl}`);
        image = pickCommonsImage(await getJson(searchUrl));
      }
      if (!image) {
        throw new Error("no permissively-licensed Wikimedia image matched");
      }
      echo?.(`$ curl -sL '${image.imageUrl}' -o '${outPath}'`);
      await downloadTo(image.imageUrl, outPath);
      // CC-BY/BY-SA require attribution — record it in the run notes AND keep
      // the image so the credits roll can name the author too.
      used = image;
      notes.push(attributionFor(image));
    },
  };
}

// Resolve the Wikimedia title-background provider. Enabled either explicitly
// ($DAILIES_WIKIMEDIA_IMAGES=1) or, when `allowFallback` is set, as the default
// title imagery when no image MODEL is configured — so a plain `--cinematic` run
// gets a real photo with no key/GPU (the always-available local gradient is
// still the final fallback below it). Because it reaches out to the network and
// licenses vary, an auto-enable is announced in the run notes and can be turned
// off with $DAILIES_WIKIMEDIA_IMAGES=0. Attribution is pushed into `notes` by
// reference at render time (mirrors archive.ts).
export function resolveWikimediaImage(opts: {
  env: NodeJS.ProcessEnv;
  notes: string[];
  log: Logger;
  echo?: Echo;
  allowFallback?: boolean;
  // The user pinned Wikimedia (`--image wikimedia` / $DAILIES_IMAGE=wikimedia):
  // on regardless of the env flag or any configured image model.
  force?: boolean;
}): Pick<MediaProviders, "titleBackground"> & { enabled: boolean } {
  const { env, notes, log, echo, allowFallback, force } = opts;
  const flag = env.DAILIES_WIKIMEDIA_IMAGES?.trim();
  const explicit = force === true || flag === "1";
  // "0" is a hard off switch that also blocks the no-model fallback.
  const auto = allowFallback === true && flag !== "0";
  if (!(explicit || auto)) {
    return { enabled: false };
  }
  log.debug(
    { auto, explicit },
    "Wikimedia Commons title-image provider enabled"
  );
  if (!explicit) {
    notes.push(
      "no image model configured — using an openly-licensed Wikimedia Commons photo for the title card (reaches out to the network; set DAILIES_WIKIMEDIA_IMAGES=0 to disable)"
    );
  }
  return { enabled: true, titleBackground: createProvider(notes, echo) };
}
