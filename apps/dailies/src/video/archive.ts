// Free stock music from the Internet Archive (archive.org) as a no-generation
// MusicProvider. Additive, same contract as the other providers (write a finished
// audio file to `outPath` or throw), wrapped in the caller's try/catch.
//
// WHY: ACE-Step generates music but needs a heavy local server; the Free Music
// Archive's public API is gone. archive.org has a real public API and a large
// pool of openly-licensed audio, so this is the light path — a quick search +
// download + trim, no model.
//
// LICENSING: results are constrained to the `netlabels` collection (curated
// Creative-Commons netlabel music) and to items that declare a `licenseurl`. The
// chosen track's title/creator/license/URL are surfaced in the provider notes so
// the run can attribute it (most CC licenses require attribution). Nothing is
// uploaded; only public GET requests are made.
//
// Unlike the generative providers, a downloaded track is an arbitrary length, so
// this provider trims it to the requested duration with ffmpeg (with a short
// fade-out) — otherwise an over-long bed would extend the final video.
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Logger } from "dailies-logger";
import { userAgent } from "./http.js";
import type { MediaProviders, MusicProvider } from "./providers.js";

const execFileAsync = promisify(execFile);

const SEARCH_URL = "https://archive.org/advancedsearch.php";
const META_BASE = "https://archive.org/metadata";
const DL_BASE = "https://archive.org/download";
const SEARCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const TRIM_TIMEOUT_MS = 120_000;
// How many top hits to choose among (a little variety without drifting off-theme).
const SEARCH_ROWS = 25;

type Echo = (line: string) => void;

export interface ArchiveTrack {
  creator?: string;
  identifier: string;
  licenseurl?: string;
  title: string;
}

// Strip Lucene-significant characters from the free-text direction so it can be
// dropped into a query clause safely, and cap length. Pure → unit-tested.
export function sanitizeQuery(directionText: string): string {
  return directionText
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

// Build the advancedsearch.php URL. Constrains to CC netlabel audio that declares
// a license; sorts by downloads so popular (usually higher-quality) tracks come
// first. `instrumental` biases the text toward beds. Pure → unit-tested.
//
// The theme words are joined with OR, NOT left space-separated: archive.org's
// Lucene default operator ANDs bare terms, so a multi-word direction like
// "upbeat energetic pop" required ALL words in one track and matched (almost)
// nothing — the provider then threw "no archive.org tracks matched". OR keeps the
// thematic bias (download-sorted, so popular tracks that hit ANY theme word win)
// while always returning a usable pool.
export function buildSearchUrl(
  directionText: string,
  instrumental: boolean
): string {
  const words = sanitizeQuery(directionText).split(/\s+/).filter(Boolean);
  if (instrumental) {
    words.push("instrumental");
  }
  // Fall back to a broad term if the direction sanitized to nothing, so the
  // query is always valid.
  const focus = words.length > 0 ? words.join(" OR ") : "music";
  const q = `(${focus}) AND mediatype:audio AND collection:netlabels AND licenseurl:[* TO *]`;
  const params = new URLSearchParams({
    q,
    sort: "downloads desc",
    rows: String(SEARCH_ROWS),
    output: "json",
  });
  // fl[] must repeat per field; URLSearchParams handles that via append.
  for (const f of ["identifier", "title", "creator", "licenseurl"]) {
    params.append("fl[]", f);
  }
  return `${SEARCH_URL}?${params.toString()}`;
}

// A field can come back as a string or a string[] (archive.org repeats some
// fields); take the first string either way. Pure.
function firstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return;
}

// Parse the advancedsearch response into tracks. Pure → unit-tested.
export function parseSearchDocs(body: unknown): ArchiveTrack[] {
  const docs = (body as { response?: { docs?: unknown } })?.response?.docs;
  if (!Array.isArray(docs)) {
    return [];
  }
  const tracks: ArchiveTrack[] = [];
  for (const d of docs) {
    const id = (d as { identifier?: unknown }).identifier;
    if (typeof id !== "string") {
      continue;
    }
    const titleRaw = (d as { title?: unknown }).title;
    tracks.push({
      identifier: id,
      title: typeof titleRaw === "string" ? titleRaw : id,
      creator: firstString((d as { creator?: unknown }).creator),
      licenseurl: firstString((d as { licenseurl?: unknown }).licenseurl),
    });
  }
  return tracks;
}

// Pick a playable audio file name from an item's metadata, preferring an MP3.
// Pure → unit-tested.
export function pickAudioFile(body: unknown): string | null {
  const files = (body as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    return null;
  }
  const named = files
    .map((f) => (f as { name?: unknown }).name)
    .filter((n): n is string => typeof n === "string");
  const mp3 = named.find((n) => /\.mp3$/i.test(n));
  return mp3 ?? named.find((n) => /\.(ogg|flac|m4a|wav)$/i.test(n)) ?? null;
}

// A human attribution line for the provider notes. Pure → unit-tested.
export function attributionFor(track: ArchiveTrack): string {
  const who = track.creator ? ` by ${track.creator}` : "";
  const lic = track.licenseurl ? ` (${track.licenseurl})` : "";
  return `music: "${track.title}"${who}${lic} — https://archive.org/details/${track.identifier}`;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "user-agent": userAgent() },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`archive.org GET ${res.status}`);
  }
  return res.json();
}

// Download a URL to a path (streamed to a Buffer; tracks are a few MB).
async function downloadTo(
  url: string,
  outPath: string,
  timeoutMs: number
): Promise<void> {
  const res = await fetch(url, {
    headers: { "user-agent": userAgent() },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`archive.org download ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("archive.org returned 0 bytes");
  }
  await writeFile(outPath, bytes);
}

function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface ArchiveDeps {
  echo?: Echo;
  ffmpeg: string;
  log: Logger;
  notes: string[];
  // Injectable for tests; defaults to Math.random.
  random?: () => number;
}

// ffprobe usually sits beside ffmpeg with the same name suffix (mirrors narrate's
// ffprobeFor). Used to learn a downloaded track's length so a window can be picked.
function ffprobeFor(ffmpeg: string): string {
  const slash = Math.max(ffmpeg.lastIndexOf("/"), ffmpeg.lastIndexOf("\\"));
  const dir = slash >= 0 ? ffmpeg.slice(0, slash + 1) : "";
  const base = slash >= 0 ? ffmpeg.slice(slash + 1) : ffmpeg;
  return base.startsWith("ffmpeg")
    ? dir + base.replace("ffmpeg", "ffprobe")
    : "ffprobe";
}

async function probeDurationSec(ffmpeg: string, src: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      ffprobeFor(ffmpeg),
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        src,
      ],
      { timeout: TRIM_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }
    );
    const v = Number(stdout.trim());
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

// Mean volume (dBFS) of a [startSec, startSec+seconds) slice via volumedetect.
// Louder ≈ a fuller, more "vocal/chorus" section; quieter ≈ an intro/breakdown.
// Returns -Infinity when it can't be measured so it never wins the argmax.
async function meanVolumeDb(
  ffmpeg: string,
  src: string,
  startSec: number,
  seconds: number
): Promise<number> {
  try {
    const { stderr } = await execFileAsync(
      ffmpeg,
      [
        "-hide_banner",
        "-nostats",
        "-ss",
        startSec.toFixed(2),
        "-t",
        seconds.toFixed(2),
        "-i",
        src,
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      { timeout: TRIM_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }
    );
    const m = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
    return m ? Number(m[1]) : Number.NEGATIVE_INFINITY;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

// Argmax of a level array (first max wins); -1 for an empty array. Pure → tested.
export function loudestIndex(levels: number[]): number {
  let best = -1;
  let bestVal = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < levels.length; i++) {
    const v = levels[i] ?? Number.NEGATIVE_INFINITY;
    if (v > bestVal) {
      bestVal = v;
      best = i;
    }
  }
  return best;
}

// Evenly-spaced candidate window starts across [0, maxStart], inclusive of both
// ends, with at most `count` probes. Pure → tested.
export function windowStarts(maxStart: number, count: number): number[] {
  if (maxStart <= 0) {
    return [0];
  }
  const n = Math.max(1, count);
  if (n === 1) {
    return [0];
  }
  const step = maxStart / (n - 1);
  return Array.from({ length: n }, (_, i) => Math.min(maxStart, i * step));
}

// Pick the start offset (seconds) of the loudest `wantSec` window in `src` — the
// "smarter section selection" so a long stock track plays from its fullest part
// instead of always from a (often quiet) intro. Returns 0 when the track is too
// short to choose, or measurement fails. Probes a handful of evenly-spaced
// windows; the head is always one candidate so a track that's loudest up front
// still works.
const WINDOW_PROBES = 8;
export async function pickLoudestOffset(
  ffmpeg: string,
  src: string,
  wantSec: number
): Promise<number> {
  const dur = await probeDurationSec(ffmpeg, src);
  const maxStart = dur - wantSec;
  if (!(dur > 0) || maxStart <= 1) {
    return 0;
  }
  const starts = windowStarts(maxStart, WINDOW_PROBES);
  const levels = await Promise.all(
    starts.map((s) => meanVolumeDb(ffmpeg, src, s, wantSec))
  );
  const idx = loudestIndex(levels);
  return idx >= 0 ? (starts[idx] ?? 0) : 0;
}

// Trim `seconds` out of `src` to `outPath` (wav by ext), starting at `startSec`,
// with a short fade-in (when starting mid-track, to avoid an abrupt cut-in) and a
// 2s fade-out at the end.
async function trimTo(
  ffmpeg: string,
  src: string,
  seconds: number,
  outPath: string,
  echo?: Echo,
  startSec = 0
): Promise<void> {
  const dur = Math.max(1, Math.round(seconds));
  const fadeStart = Math.max(0, dur - 2);
  const fades = [
    ...(startSec > 0.05 ? ["afade=t=in:st=0:d=1"] : []),
    `afade=t=out:st=${fadeStart}:d=2`,
  ].join(",");
  const args = [
    "-hide_banner",
    "-nostats",
    "-y",
    ...(startSec > 0.05 ? ["-ss", startSec.toFixed(2)] : []),
    "-i",
    src,
    "-t",
    String(dur),
    "-af",
    fades,
    "-ac",
    "2",
    "-ar",
    "44100",
    outPath,
  ];
  echo?.(`$ ${[ffmpeg, ...args].map(sq).join(" ")}`);
  await execFileAsync(ffmpeg, args, {
    timeout: TRIM_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Search and pick one track (no download), for crediting or fetching.
async function selectTrack(
  deps: ArchiveDeps,
  directionText: string,
  instrumental: boolean
): Promise<ArchiveTrack> {
  const searchUrl = buildSearchUrl(directionText, instrumental);
  deps.echo?.(`$ curl -s ${sq(searchUrl)}`);
  const tracks = parseSearchDocs(await getJson(searchUrl, SEARCH_TIMEOUT_MS));
  if (tracks.length === 0) {
    throw new Error("no archive.org tracks matched");
  }
  // Pick among the top hits for a little variety run-to-run.
  const random = deps.random ?? Math.random;
  const track = tracks[Math.floor(random() * tracks.length)] ?? tracks[0];
  if (!track) {
    throw new Error("no archive.org track selected");
  }
  return track;
}

// Download `track`, trim `seconds` of it to `outPath`, and record its
// attribution in `notes`.
async function downloadAndTrim(
  deps: ArchiveDeps,
  track: ArchiveTrack,
  seconds: number,
  outPath: string
): Promise<void> {
  const metaUrl = `${META_BASE}/${track.identifier}`;
  const file = pickAudioFile(await getJson(metaUrl, SEARCH_TIMEOUT_MS));
  if (!file) {
    throw new Error(`no audio file in ${track.identifier}`);
  }
  const dlUrl = `${DL_BASE}/${track.identifier}/${encodeURIComponent(file)}`;
  const raw = `${outPath}.src`;
  deps.echo?.(`$ curl -sL ${sq(dlUrl)} -o ${sq(raw)}`);
  try {
    await downloadTo(dlUrl, raw, DOWNLOAD_TIMEOUT_MS);
    // Smarter section selection: play the loudest (fullest) window of the track,
    // not always its (often quiet) intro.
    const startSec = await pickLoudestOffset(deps.ffmpeg, raw, seconds);
    await trimTo(deps.ffmpeg, raw, seconds, outPath, deps.echo, startSec);
    deps.notes.push(attributionFor(track));
  } finally {
    await rm(raw, { force: true });
  }
}

function createMusicProvider(deps: ArchiveDeps): MusicProvider {
  // The bed track, pre-selected by credit() so the credits roll names the exact
  // track the bed will use.
  let cachedBed: ArchiveTrack | undefined;
  return {
    id: "archive-music",
    async credit(directionText) {
      cachedBed = await selectTrack(deps, directionText, true);
      return attributionFor(cachedBed);
    },
    async bed(directionText, seconds, outPath) {
      const track = cachedBed ?? (await selectTrack(deps, directionText, true));
      await downloadAndTrim(deps, track, seconds, outPath);
    },
    async song(directionText, seconds, outPath) {
      const track = await selectTrack(deps, directionText, false);
      await downloadAndTrim(deps, track, seconds, outPath);
    },
  };
}

// Resolve the archive.org music provider. Enabled either explicitly
// ($DAILIES_ARCHIVE_MUSIC=1) or, when `allowFallback` is set, as the default
// score when no music MODEL is configured — so a plain `--cinematic` run still
// gets music with no key/GPU. Because it reaches out to the network and
// licensing/quality vary, an auto-enable is announced in the run notes and can
// be turned off with $DAILIES_ARCHIVE_MUSIC=0. Returns just notes when disabled.
export function resolveArchiveMusic(opts: {
  env: NodeJS.ProcessEnv;
  ffmpeg: string;
  log: Logger;
  notes: string[];
  echo?: Echo;
  allowFallback?: boolean;
  // The user pinned archive.org (`--music archive` / $DAILIES_MUSIC=archive):
  // on regardless of the env flag or any configured model.
  force?: boolean;
}): Pick<MediaProviders, "music"> & { enabled: boolean; explicit: boolean } {
  const { env, ffmpeg, log, notes, echo, allowFallback, force } = opts;
  const flag = env.DAILIES_ARCHIVE_MUSIC?.trim();
  const explicit = force === true || flag === "1";
  // "0" is a hard off switch that also blocks the no-model fallback.
  const auto = allowFallback === true && flag !== "0";
  if (!(explicit || auto)) {
    return { enabled: false, explicit: false };
  }
  log.debug({ auto, explicit }, "archive.org music provider enabled");
  if (!explicit) {
    notes.push(
      "no music model configured — scoring with free Creative-Commons music from archive.org (reaches out to the network; set DAILIES_ARCHIVE_MUSIC=0 to disable)"
    );
  }
  return {
    enabled: true,
    explicit,
    music: createMusicProvider({ ffmpeg, echo, log, notes }),
  };
}
