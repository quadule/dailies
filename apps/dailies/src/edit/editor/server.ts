// The local HTTP server behind `dailies cut edit`: serves the browser editor
// for one session and the API it edits the cut through. node:http only, bound
// to 127.0.0.1.
//
// It reads and writes the same files the CLI does — cut.json through
// readCut/writeCut, renders through renderCut — so an edit saved here and one
// an agent makes by hand are the same edit. The only files it writes itself
// are cut.json and the session's recordings/ folder; a render writes what
// `dailies cut render` writes.
//
// Security for a tool on localhost: requests must name 127.0.0.1:<port> or
// localhost:<port> as their Host (a DNS-rebinding page names its own host),
// every /api/* request must carry X-Dailies-Editor: 1 (a cross-site page can't
// set a custom header without a preflight), and preflights are refused. File
// routes take a bare file name and must resolve inside the session directory.
// AGENTS.md ("Editing in the browser") documents the full HTTP contract.

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  SESSION_SCREENSHOT_EXT,
  SESSION_SCREENSHOTS_DIR,
  SESSION_VIDEO_DIR,
  sessionStepSlug,
} from "dailies-protocol";
import { logger } from "../../logger.js";
import { readSessionRecord, type SessionStep } from "../../session/registry.js";
import { audioDurationSec } from "../../video/ffmpeg.js";
import { NARRATOR_CHOICES } from "../../video/media-preferences.js";
import { captionBandPx, captionFontPx } from "../../video/narrate.js";
import { captionLineMax } from "../../video/srt.js";
import { type Cut, type CutStep, formatCut, parseCut } from "../cut.js";
import { readCut, writeCut } from "../cut-file.js";
import {
  type CutRenderResult,
  type CutSource,
  loadCutSource,
  renderCut,
} from "../render.js";
import { EDITOR_CLIENT_CSS, EDITOR_CLIENT_JS } from "./client.generated.js";
import {
  EDITOR_HEADER,
  EDITOR_HEADER_VALUE,
  type EditorRecording,
  type EditorSession,
  type EditorStep,
  MAX_RECORDING_BYTES,
  RECORDING_TYPES,
  RECORDINGS_DIR,
  type RenderStatus,
} from "./contract.js";
import { editorPage } from "./page.js";

// A cut is a few hundred KB at most, even for a long run.
const MAX_CUT_BYTES = 5 * 1024 * 1024;

// Headers on every response. CORP keeps another site from embedding the
// session's video and screenshots; the rest are the usual hardening.
const BASE_HEADERS: Record<string, string> = {
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

// The page loads only its own bundle. blob: is for playing back a recording
// before it is uploaded; inline styles are for a client setting widths and
// positions from data.
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const MEDIA_TYPES: Record<string, string> = {
  ".webm": "video/webm",
  ".png": "image/png",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

// A file name a route accepts: one path segment, no leading dot.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface EditorServer {
  close(): Promise<void>;
  // True while a render started from the editor is still running.
  rendering(): boolean;
  url: string;
}

// ---------------------------------------------------------------------------
// Pure helpers. Exported for tests.
// ---------------------------------------------------------------------------

// A single `bytes=` range against a file of `size` bytes. Undefined means
// "serve the whole file" (no header, or one this server doesn't do, like a
// multi-range); "unsatisfiable" means 416.
export function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match) {
    return;
  }
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") {
    return;
  }
  if (from === "") {
    const suffix = Number(to);
    if (suffix === 0 || size === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  if (to !== "" && Number(to) < start) {
    return;
  }
  if (start >= size) {
    return "unsatisfiable";
  }
  return { start, end: to === "" ? size - 1 : Math.min(Number(to), size - 1) };
}

// The steps as the editor shows them, with their SOURCE time. The session
// record is authoritative (precinematicVideoTime is the step's place in the
// clean source once a render or cinematic pass has run; before that,
// videoTime still is); cut.steps fills in a step the record has no time for,
// matched by name and occurrence. A step with no time in either never reached
// the recording and is left out.
export function editorSteps(
  steps: SessionStep[],
  cutSteps: CutStep[],
  screenshots: ReadonlySet<string>
): EditorStep[] {
  const seen = new Map<string, number>();
  const out: EditorStep[] = [];
  for (const step of steps) {
    const nth = seen.get(step.name) ?? 0;
    seen.set(step.name, nth + 1);
    const fromCut = cutSteps.filter((s) => s.name === step.name)[nth]?.at;
    const at = step.precinematicVideoTime ?? step.videoTime ?? fromCut;
    if (at === undefined) {
      continue;
    }
    const shot = `${sessionStepSlug(step.name)}${SESSION_SCREENSHOT_EXT}`;
    out.push({
      name: step.name,
      at,
      ok: step.ok,
      durationMs: step.durationMs,
      ...(step.skim ? { skim: true } : {}),
      ...(step.error ? { error: step.error } : {}),
      ...(screenshots.has(shot)
        ? { screenshot: `/${SESSION_SCREENSHOTS_DIR}/${shot}` }
        : {}),
    });
  }
  return out;
}

// The file a route names inside `dir/sub`, or undefined when the name isn't a
// bare file name (a separator, a dot segment, an encoded one, a NUL).
export function namedFile(
  dir: string,
  sub: string,
  encoded: string
): string | undefined {
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    return;
  }
  if (!SAFE_NAME.test(name) || path.basename(name) !== name) {
    return;
  }
  const file = path.join(dir, sub, name);
  const rel = path.relative(dir, file);
  return rel.startsWith("..") || path.isAbsolute(rel) ? undefined : file;
}

// A request body that went past its limit.
export class BodyTooLarge extends Error {}

// A pipeline stage that passes a body through until it has carried more than
// `limit` bytes, then fails with BodyTooLarge.
export function byteLimit(
  limit: number
): (chunks: AsyncIterable<Buffer>) => AsyncGenerator<Buffer> {
  return async function* limited(chunks) {
    let total = 0;
    for await (const chunk of chunks) {
      total += chunk.length;
      if (total > limit) {
        throw new BodyTooLarge(`the body is over ${limit} bytes`);
      }
      yield chunk;
    }
  };
}

// The extension a recording upload is saved with, from its Content-Type.
export function recordingExtension(
  contentType: string | undefined
): string | undefined {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type ? RECORDING_TYPES[type] : undefined;
}

// ---------------------------------------------------------------------------
// Responses.
// ---------------------------------------------------------------------------

function send(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | number>,
  body?: string | Buffer
): void {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(
    res,
    status,
    {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    JSON.stringify(body)
  );
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error });
}

function sendText(res: ServerResponse, status: number, text: string): void {
  send(
    res,
    status,
    {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
    `${text}\n`
  );
}

// Drop the connection once the answer is out, rather than read the rest of a
// body the server stopped reading.
function closeAfterAnswer(req: IncomingMessage, res: ServerResponse): void {
  res.once("finish", () => req.socket.destroy());
  res.setHeader("Connection", "close");
}

// Refuse a body that is too big, then drop the connection.
function refuseTooLarge(req: IncomingMessage, res: ServerResponse): void {
  closeAfterAnswer(req, res);
  sendError(res, 413, "the request body is too large");
}

async function readBody(
  req: IncomingMessage,
  limit: number
): Promise<Buffer | "too-large"> {
  if (Number(req.headers["content-length"]) > limit) {
    return "too-large";
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    total += (chunk as Buffer).length;
    if (total > limit) {
      return "too-large";
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// Stream a request body into `file`, through byteLimit. Every failure — the
// client going away, the disk refusing the file — rejects, and the file is
// closed before this settles, so the caller can remove it. Resolves with the
// bytes written, or "too-large" with the body only partly read.
async function saveBody(
  req: IncomingMessage,
  file: string,
  limit: number
): Promise<number | "too-large"> {
  const out = createWriteStream(file);
  const closed = new Promise<void>((resolve) => {
    out.once("close", () => resolve());
  });
  // pipeline listens for errors only while it runs.
  out.on("error", () => undefined);
  try {
    // Not destroyed when the limit stops the read, so a 413 can still go out.
    await pipeline(
      req.iterator({ destroyOnReturn: false }),
      byteLimit(limit),
      out
    );
    return out.bytesWritten;
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      return "too-large";
    }
    throw err;
  } finally {
    out.destroy();
    await closed;
  }
}

// Serve a file, honoring a single byte range — <video> and <audio> seek by
// asking for one, and won't seek at all without Accept-Ranges.
async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  root: string
): Promise<void> {
  const real = await realpath(file).catch(() => undefined);
  const realRoot = await realpath(root).catch(() => root);
  const info = real ? await stat(real).catch(() => undefined) : undefined;
  if (!(real?.startsWith(realRoot + path.sep) && info?.isFile())) {
    sendText(res, 404, "Not found");
    return;
  }
  const size = info.size;
  const etag = `"${size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
  const headers: Record<string, string | number> = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "Content-Type":
      MEDIA_TYPES[path.extname(file).toLowerCase()] ??
      "application/octet-stream",
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
  };
  const ifRange = req.headers["if-range"];
  const range =
    ifRange && ifRange !== etag
      ? undefined
      : parseRange(req.headers.range, size);
  if (range === undefined && req.headers["if-none-match"] === etag) {
    send(res, 304, headers);
    return;
  }
  if (range === "unsatisfiable") {
    send(res, 416, { ...headers, "Content-Range": `bytes */${size}` });
    return;
  }
  const status = range ? 206 : 200;
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  res.writeHead(status, {
    ...BASE_HEADERS,
    ...headers,
    "Content-Length": size === 0 ? 0 : end - start + 1,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }
  await pipeline(createReadStream(real, { start, end }), res).catch(
    (err: unknown) => {
      // A player that seeks away closes the stream mid-file; that is normal.
      logger.debug({ err, file }, "editor file stream ended early");
    }
  );
}

// ---------------------------------------------------------------------------
// The server.
// ---------------------------------------------------------------------------

export async function startEditorServer(args: {
  sessionId: string;
  // 0 or absent picks a free port.
  port?: number;
}): Promise<EditorServer> {
  const { sessionId } = args;
  const loaded = await loadCutSource(sessionId);
  if ("error" in loaded) {
    throw new Error(loaded.error);
  }
  const editor = new Editor(sessionId, loaded);
  const server = createServer((req, res) => {
    editor.handle(req, res).catch((err: unknown) => {
      logger.warn({ err, url: req.url }, "editor request failed");
      if (res.headersSent) {
        res.destroy();
      } else {
        sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `port ${args.port} is already in use — pick another with --port, or leave it off for a free one`
            )
          : err
      );
    server.once("error", failed);
    server.listen(args.port ?? 0, "127.0.0.1", () => {
      server.off("error", failed);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  editor.allowHosts(port);
  return {
    url: `http://127.0.0.1:${port}/`,
    rendering: () => editor.rendering(),
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      // Let a render started here finish, so its own cleanup runs.
      await editor.settled();
    },
  };
}

class Editor {
  private readonly dir: string;
  private readonly hosts = new Set<string>();
  private readonly durations = new Map<
    string,
    { key: string; durationSec: number | undefined }
  >();
  private render: RenderStatus = { state: "idle", progress: [] };
  private running: Promise<void> = Promise.resolve();

  private readonly sessionId: string;
  private readonly source: CutSource;

  constructor(sessionId: string, source: CutSource) {
    this.sessionId = sessionId;
    this.source = source;
    this.dir = source.dir;
  }

  allowHosts(port: number): void {
    this.hosts.add(`127.0.0.1:${port}`);
    this.hosts.add(`localhost:${port}`);
  }

  rendering(): boolean {
    return this.render.state === "running";
  }

  settled(): Promise<void> {
    return this.running;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.hosts.has(req.headers.host ?? "")) {
      sendText(res, 403, "Forbidden: this editor only answers to localhost");
      return;
    }
    if (req.method === "OPTIONS") {
      sendText(res, 403, "Forbidden");
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      sendText(res, 400, "Bad request");
      return;
    }
    if (pathname.startsWith("/api/")) {
      if (req.headers[EDITOR_HEADER.toLowerCase()] !== EDITOR_HEADER_VALUE) {
        sendError(
          res,
          403,
          `every /api/ request needs the header ${EDITOR_HEADER}: ${EDITOR_HEADER_VALUE}`
        );
        return;
      }
      await this.api(req, res, pathname);
      return;
    }
    if (!(req.method === "GET" || req.method === "HEAD")) {
      send(res, 405, { Allow: "GET, HEAD" });
      return;
    }
    await this.asset(req, res, pathname);
  }

  // ----- pages and files -----

  private async asset(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string
  ): Promise<void> {
    if (pathname === "/") {
      const record = await readSessionRecord(this.sessionId);
      send(
        res,
        200,
        {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": PAGE_CSP,
        },
        editorPage({ sessionName: record.name || this.sessionId })
      );
      return;
    }
    if (pathname === "/editor.js" || pathname === "/editor.css") {
      const js = pathname === "/editor.js";
      send(
        res,
        200,
        {
          "Content-Type": js
            ? "text/javascript; charset=utf-8"
            : "text/css; charset=utf-8",
          "Cache-Control": "no-store",
        },
        js ? EDITOR_CLIENT_JS : EDITOR_CLIENT_CSS
      );
      return;
    }
    if (pathname === "/source.webm") {
      await sendFile(req, res, this.source.source, this.dir);
      return;
    }
    if (pathname === "/video.webm") {
      await sendFile(req, res, await this.videoPath(), this.dir);
      return;
    }
    const [, sub, name, ...rest] = pathname.split("/");
    if (
      rest.length === 0 &&
      name &&
      (sub === RECORDINGS_DIR || sub === SESSION_SCREENSHOTS_DIR)
    ) {
      const file = namedFile(this.dir, sub, name);
      if (!file) {
        sendText(res, 400, "Bad file name");
        return;
      }
      await sendFile(req, res, file, this.dir);
      return;
    }
    sendText(res, 404, "Not found");
  }

  // The rendered video: video/<cut.video>, from the cut on disk now.
  private async videoPath(): Promise<string> {
    const read = await readCut(this.sessionId);
    const name = "cut" in read ? read.cut.video : this.source.cut.video;
    return path.join(
      this.dir,
      SESSION_VIDEO_DIR,
      path.basename(name) === name ? name : this.source.cut.video
    );
  }

  // ----- the API -----

  private async api(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string
  ): Promise<void> {
    const method = req.method ?? "GET";
    const route = `${method} ${pathname}`;
    if (route === "GET /api/session") {
      await this.getSession(res);
    } else if (route === "PUT /api/cut") {
      await this.putCut(req, res);
    } else if (route === "GET /api/render") {
      sendJson(res, 200, this.render);
    } else if (route === "POST /api/render") {
      this.startRender(res);
    } else if (route === "POST /api/recordings") {
      await this.uploadRecording(req, res);
    } else if (
      method === "DELETE" &&
      pathname.startsWith(`/api/${RECORDINGS_DIR}/`)
    ) {
      await this.deleteRecording(
        res,
        pathname.slice(`/api/${RECORDINGS_DIR}/`.length)
      );
    } else if (
      [
        "/api/session",
        "/api/cut",
        "/api/render",
        `/api/${RECORDINGS_DIR}`,
      ].includes(pathname)
    ) {
      sendError(res, 405, `${method} is not supported on ${pathname}`);
    } else {
      sendError(res, 404, `no such route: ${method} ${pathname}`);
    }
  }

  // The cut on disk, or a 409 when someone left it unparseable.
  private async currentCut(res: ServerResponse): Promise<Cut | undefined> {
    const read = await readCut(this.sessionId);
    if ("error" in read) {
      sendError(res, 409, read.error);
      return;
    }
    return read.cut;
  }

  private async getSession(res: ServerResponse): Promise<void> {
    const cut = await this.currentCut(res);
    if (!cut) {
      return;
    }
    const record = await readSessionRecord(this.sessionId);
    const shots = await readdir(path.join(this.dir, SESSION_SCREENSHOTS_DIR))
      .then((names) => new Set(names))
      .catch(() => new Set<string>());
    const { probed } = this.source;
    const bandPx = captionBandPx(probed.height);
    const fontPx = captionFontPx(bandPx);
    const video = await stat(await this.videoPath()).catch(() => undefined);
    const session: EditorSession = {
      id: this.sessionId,
      ...(record.name ? { name: record.name } : {}),
      cut,
      source: {
        durationSec: this.source.sourceDurationSec,
        fps: probed.frameRate,
        width: probed.width,
        height: probed.height,
      },
      caption: {
        bandPx,
        fontPx,
        lineMax: captionLineMax(probed.width, fontPx),
      },
      steps: editorSteps(record.steps, cut.steps, shots),
      narrators: NARRATOR_CHOICES,
      video: {
        url: `/video.webm?v=${Math.round(video?.mtimeMs ?? 0)}`,
        path: cut.video,
      },
      recordings: await this.recordings(),
    };
    sendJson(res, 200, session);
  }

  private async putCut(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (this.rendering()) {
      // The render pins its voice into cut.json when it finishes, writing the
      // cut it started from — a save now could be overwritten.
      sendError(res, 409, "a render is running — save again when it finishes");
      return;
    }
    const body = await readBody(req, MAX_CUT_BYTES);
    if (body === "too-large") {
      refuseTooLarge(req, res);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString("utf8"));
    } catch (err) {
      sendError(
        res,
        400,
        `the body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    const parsed = parseCut(raw);
    if ("error" in parsed) {
      sendError(res, 400, parsed.error);
      return;
    }
    // What goes to disk is formatCut's form, times rounded to the
    // millisecond, and that has to parse too: a range a fraction of a
    // millisecond long parses here and rounds to nothing there.
    const saved = parseCut(JSON.parse(formatCut(parsed.cut)));
    if ("error" in saved) {
      sendError(res, 400, `${saved.error} (times are kept to the millisecond)`);
      return;
    }
    const existing = await readCut(this.sessionId);
    const video =
      "cut" in existing ? existing.cut.video : this.source.cut.video;
    if (parsed.cut.video !== video) {
      sendError(
        res,
        400,
        `video must stay "${video}" — the editor edits the recording it was opened on`
      );
      return;
    }
    await writeCut(this.sessionId, parsed.cut);
    // What is on disk now.
    sendJson(res, 200, { cut: saved.cut });
  }

  private startRender(res: ServerResponse): void {
    if (this.rendering()) {
      sendError(res, 409, "a render is already running");
      return;
    }
    const status: RenderStatus = {
      state: "running",
      progress: [],
      ...(this.render.result ? { result: this.render.result } : {}),
    };
    this.render = status;
    this.running = renderCut({
      sessionId: this.sessionId,
      progress: (message) => status.progress.push(message),
      echo: () => {
        // ffmpeg's per-command echo is noise here; failures carry stderr.
      },
    }).then(
      (result: CutRenderResult | { error: string }) => {
        if ("error" in result) {
          status.state = "error";
          status.error = result.error;
        } else {
          status.state = "done";
          status.result = result;
        }
      },
      (err: unknown) => {
        logger.warn({ err, sessionId: this.sessionId }, "editor render failed");
        status.state = "error";
        status.error = err instanceof Error ? err.message : String(err);
      }
    );
    sendJson(res, 202, status);
  }

  // ----- recordings -----

  private async recordings(): Promise<EditorRecording[]> {
    const dir = path.join(this.dir, RECORDINGS_DIR);
    const names = await readdir(dir).catch(() => [] as string[]);
    const known = new Set(Object.values(RECORDING_TYPES));
    const out: EditorRecording[] = [];
    for (const name of names.sort()) {
      const ext = path.extname(name).slice(1).toLowerCase();
      if (!(SAFE_NAME.test(name) && known.has(ext))) {
        continue;
      }
      const durationSec = await this.durationOf(path.join(dir, name));
      if (durationSec) {
        out.push({ file: `${RECORDINGS_DIR}/${name}`, durationSec });
      }
    }
    return out;
  }

  // A recording's length, probed once per version of the file.
  private async durationOf(file: string): Promise<number | undefined> {
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) {
      return;
    }
    const key = `${info.size}:${info.mtimeMs}`;
    const cached = this.durations.get(file);
    if (cached?.key === key) {
      return cached.durationSec;
    }
    const durationSec = await audioDurationSec(this.source.ffmpeg, file);
    this.durations.set(file, { key, durationSec });
    return durationSec;
  }

  private async uploadRecording(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const ext = recordingExtension(req.headers["content-type"]);
    if (!ext) {
      sendError(
        res,
        415,
        `a recording must be one of ${Object.keys(RECORDING_TYPES).join(", ")}`
      );
      return;
    }
    if (Number(req.headers["content-length"]) > MAX_RECORDING_BYTES) {
      refuseTooLarge(req, res);
      return;
    }
    const dir = path.join(this.dir, RECORDINGS_DIR);
    await mkdir(dir, { recursive: true });
    // Dot-prefixed, so a half-written upload is never listed or served.
    const partial = path.join(dir, `.upload-${process.pid}-${Date.now()}.part`);
    try {
      let total: number | "too-large";
      try {
        total = await saveBody(req, partial, MAX_RECORDING_BYTES);
      } catch (err) {
        // Answered 500 by the request handler, possibly mid-upload.
        closeAfterAnswer(req, res);
        throw err;
      }
      if (total === "too-large") {
        refuseTooLarge(req, res);
        return;
      }
      if (total === 0) {
        sendError(res, 400, "the recording is empty");
        return;
      }
      const name = freshName(dir, ext);
      const file = path.join(dir, name);
      await rename(partial, file);
      const durationSec = await this.durationOf(file);
      if (!durationSec) {
        await rm(file, { force: true });
        sendError(res, 422, "could not read the recording's audio");
        return;
      }
      sendJson(res, 201, { file: `${RECORDINGS_DIR}/${name}`, durationSec });
    } finally {
      await rm(partial, { force: true });
    }
  }

  private async deleteRecording(
    res: ServerResponse,
    encoded: string
  ): Promise<void> {
    const file = namedFile(this.dir, RECORDINGS_DIR, encoded);
    if (!file) {
      sendError(res, 400, "a recording is named by its bare file name");
      return;
    }
    const relative = `${RECORDINGS_DIR}/${path.basename(file)}`;
    const read = await readCut(this.sessionId);
    const user =
      "cut" in read
        ? read.cut.narration.find(
            (line) =>
              line.audio !== undefined &&
              path.posix.normalize(line.audio.replaceAll("\\", "/")) ===
                relative
          )
        : undefined;
    if (user) {
      sendError(
        res,
        409,
        `${relative} is the audio of the narration line at ${user.at.toFixed(2)}s — remove or change that line first`
      );
      return;
    }
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) {
      sendError(res, 404, `no recording ${relative}`);
      return;
    }
    await rm(file, { force: true });
    this.durations.delete(file);
    send(res, 204, {});
  }
}

// rec-<UTC timestamp>.<ext>, with a counter in the unlikely case two uploads
// land in the same millisecond.
function freshName(dir: string, ext: string): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  for (let n = 1; ; n++) {
    const name = `rec-${stamp}${n === 1 ? "" : `-${n}`}.${ext}`;
    if (!existsSync(path.join(dir, name))) {
      return name;
    }
  }
}
