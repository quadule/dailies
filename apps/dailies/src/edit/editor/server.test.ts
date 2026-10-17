import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { type IncomingHttpHeaders, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sessionStepSlug } from "dailies-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionRecord, SessionStep } from "../../session/registry.js";
import { findFfmpeg } from "../../video/condense.js";
import { VP8_ENCODE_ARGS } from "../../video/ffmpeg.js";
import { NARRATOR_CHOICES } from "../../video/media-preferences.js";
import { captionBandPx, captionFontPx } from "../../video/narrate.js";
import { captionLineMax } from "../../video/srt.js";
import { type Cut, formatCut } from "../cut.js";
import type {
  EditorSession,
  RenderStatus,
  UploadRecordingResponse,
} from "./contract.js";
import {
  type EditorServer,
  editorSteps,
  namedFile,
  parseRange,
  recordingExtension,
  startEditorServer,
} from "./server.js";

const run = promisify(execFile);

describe("parseRange", () => {
  it("reads a closed, an open-ended and a suffix range", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-10", 1000)).toEqual({ start: 990, end: 999 });
    expect(parseRange("bytes=990-5000", 1000)).toEqual({
      start: 990,
      end: 999,
    });
  });

  it("serves the whole file for no range, a malformed one or a multi-range", () => {
    expect(parseRange(undefined, 1000)).toBeUndefined();
    expect(parseRange("bytes=5-1", 1000)).toBeUndefined();
    expect(parseRange("bytes=0-1,5-9", 1000)).toBeUndefined();
    expect(parseRange("items=0-1", 1000)).toBeUndefined();
  });

  it("refuses a range past the end", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
  });
});

describe("namedFile", () => {
  it("accepts a bare file name inside the folder", () => {
    expect(namedFile("/s", "recordings", "rec-1.webm")).toBe(
      path.join("/s", "recordings", "rec-1.webm")
    );
  });

  it.each([
    "..",
    "../cut.json",
    "..%2fcut.json",
    "%2e%2e%2fcut.json",
    ".hidden",
    "a%00b",
    "a%5cb",
    "%E0%A4%A",
  ])("refuses %s", (name) => {
    expect(namedFile("/s", "recordings", name)).toBeUndefined();
  });
});

describe("recordingExtension", () => {
  it("maps MediaRecorder's types, ignoring parameters", () => {
    expect(recordingExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(recordingExtension("audio/mp4")).toBe("m4a");
    expect(recordingExtension("audio/x-wav")).toBe("wav");
    expect(recordingExtension("video/webm")).toBeUndefined();
    expect(recordingExtension(undefined)).toBeUndefined();
  });
});

describe("editorSteps", () => {
  const step = (name: string, extra: Partial<SessionStep>): SessionStep => ({
    name,
    ok: true,
    exitCode: 0,
    durationMs: 100,
    startedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  });

  it("takes source time from the record, falling back to the cut", () => {
    const steps = editorSteps(
      [
        step("open", { precinematicVideoTime: 0.5, videoTime: 9 }),
        step("fill", { videoTime: 1.5, skim: true }),
        step("fill", {}),
        step("lost", {}),
      ],
      [
        { name: "fill", at: 1.4 },
        { name: "fill", at: 2.5 },
      ],
      new Set([`${sessionStepSlug("open")}.png`])
    );
    expect(steps).toEqual([
      {
        name: "open",
        at: 0.5,
        ok: true,
        durationMs: 100,
        screenshot: `/screenshots/${sessionStepSlug("open")}.png`,
      },
      { name: "fill", at: 1.5, ok: true, durationMs: 100, skim: true },
      { name: "fill", at: 2.5, ok: true, durationMs: 100 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The server, against a real session directory and a real (tiny) recording.
// ---------------------------------------------------------------------------

const ffmpeg = await findFfmpeg();
const SESSION = "editor-test-0001";
const VIDEO = "page@main.webm";

interface Reply {
  body: Buffer;
  headers: IncomingHttpHeaders;
  json<T>(): T;
  status: number;
}

describe.skipIf(!ffmpeg)("editor server", () => {
  let home: string;
  let dir: string;
  let editor: EditorServer;
  let port: number;
  const originalHome = process.env.HOME;

  const cut: Cut = {
    version: 1,
    video: VIDEO,
    voice: {},
    steps: [
      { name: "open", at: 0.2 },
      { name: "fill", at: 1 },
    ],
    cuts: [],
    holds: [],
    speedups: [],
    captions: [{ start: 0.2, end: 1.2, text: "Open the form" }],
    narration: [],
  };

  // Raw node:http, so paths go out exactly as written (fetch would resolve
  // the dot segments before sending).
  function call(
    pathname: string,
    opts: {
      method?: string;
      headers?: Record<string, string | number>;
      body?: Buffer | string;
      api?: boolean;
    } = {}
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: pathname,
          method: opts.method ?? "GET",
          headers: {
            ...(opts.api === false ? {} : { "X-Dailies-Editor": "1" }),
            ...opts.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body,
              json: <T>() => JSON.parse(body.toString("utf8")) as T,
            });
          });
        }
      );
      req.on("error", reject);
      req.end(opts.body);
    });
  }

  const putCut = (body: unknown) =>
    call("/api/cut", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  async function sine(file: string, seconds: number, extra: string[] = []) {
    await run(ffmpeg as string, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${seconds}`,
      ...extra,
      file,
    ]);
    return readFile(file);
  }

  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), "dailies-editor-"));
    process.env.HOME = home;
    dir = path.join(home, ".dailies", "sessions", SESSION);
    await mkdir(path.join(dir, "video"), { recursive: true });
    await mkdir(path.join(dir, "screenshots"), { recursive: true });
    await run(ffmpeg as string, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=2:size=320x240:rate=25",
      ...VP8_ENCODE_ARGS,
      path.join(dir, "video", VIDEO),
    ]);
    await writeFile(
      path.join(dir, "screenshots", `${sessionStepSlug("open")}.png`),
      "png"
    );
    const record: SessionRecord = {
      id: SESSION,
      name: "Editor <fixture>",
      artifactsDir: dir,
      browser: `__session__${SESSION}`,
      capture: {
        trace: true,
        video: true,
        har: true,
        console: true,
        full: false,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      headless: true,
      schemaVersion: 1,
      status: "ended",
      steps: [
        {
          name: "open",
          ok: true,
          exitCode: 0,
          durationMs: 800,
          startedAt: "2026-01-01T00:00:01.000Z",
          // A render ran: videoTime is output time, the source is preserved.
          videoTime: 0.9,
          precinematicVideoTime: 0.2,
        },
        {
          name: "fill",
          ok: false,
          exitCode: 1,
          durationMs: 1200,
          error: "timed out",
          skim: true,
          startedAt: "2026-01-01T00:00:03.000Z",
          videoTime: 1,
        },
      ],
    };
    await writeFile(
      path.join(dir, "session.json"),
      JSON.stringify(record, null, 2)
    );
    await writeFile(path.join(dir, "cut.json"), formatCut(cut));
    editor = await startEditorServer({ sessionId: SESSION });
    port = Number(new URL(editor.url).port);
  });

  afterAll(async () => {
    await editor?.close();
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("refuses an /api/ request without the editor header", async () => {
    const res = await call("/api/session", { api: false });
    expect(res.status).toBe(403);
    expect(res.json<{ error: string }>().error).toContain("X-Dailies-Editor");
  });

  it("refuses a request naming another host", async () => {
    for (const host of [`evil.example:${port}`, "127.0.0.1:1", "localhost"]) {
      const res = await call("/api/session", { headers: { Host: host } });
      expect(res.status).toBe(403);
      expect((await call("/", { headers: { Host: host } })).status).toBe(403);
    }
    const ok = await call("/api/session", {
      headers: { Host: `localhost:${port}` },
    });
    expect(ok.status).toBe(200);
  });

  it("refuses preflights", async () => {
    const res = await call("/api/cut", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "PUT",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("serves the page, the bundle and the stylesheet", async () => {
    const page = await call("/", { api: false });
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toContain(
      "script-src 'self'"
    );
    const html = page.body.toString("utf8");
    expect(html).toContain("<title>Editor &lt;fixture&gt; · Dailies editor");
    expect(html).toContain('src="/editor.js"');
    const js = await call("/editor.js", { api: false });
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.body.toString("utf8")).toContain("/api/session");
    const css = await call("/editor.css", { api: false });
    expect(css.headers["content-type"]).toContain("text/css");
  });

  it("describes the session, with every step in source time", async () => {
    const res = await call("/api/session");
    expect(res.status).toBe(200);
    const session = res.json<EditorSession>();
    expect(session.id).toBe(SESSION);
    expect(session.name).toBe("Editor <fixture>");
    expect(session.cut.captions).toEqual(cut.captions);
    expect(session.source).toMatchObject({ fps: 25, width: 320, height: 240 });
    expect(session.source.durationSec).toBeCloseTo(2, 1);
    const bandPx = captionBandPx(240);
    expect(session.caption).toEqual({
      bandPx,
      fontPx: captionFontPx(bandPx),
      lineMax: captionLineMax(320, captionFontPx(bandPx)),
    });
    expect(session.steps).toEqual([
      {
        name: "open",
        at: 0.2,
        ok: true,
        durationMs: 800,
        screenshot: `/screenshots/${sessionStepSlug("open")}.png`,
      },
      {
        name: "fill",
        at: 1,
        ok: false,
        durationMs: 1200,
        error: "timed out",
        skim: true,
      },
    ]);
    expect(session.narrators).toEqual([...NARRATOR_CHOICES]);
    expect(session.video).toEqual({
      path: VIDEO,
      url: expect.stringMatching(/^\/video\.webm\?v=\d+$/),
    });
    expect(session.recordings).toEqual([]);
    // The source sidecar didn't exist; the server made it the way a render does.
    expect(
      existsSync(path.join(dir, "video", "page@main.precinematic.webm"))
    ).toBe(true);
  });

  it("serves a step's screenshot", async () => {
    const res = await call(`/screenshots/${sessionStepSlug("open")}.png`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("saves a valid cut in formatCut form and returns it normalized", async () => {
    const edited = {
      ...cut,
      holds: [{ at: 1.234_56, seconds: 1 }],
      captions: [{ start: 0.2, end: 1.2, text: "Open the form, slowly" }],
    };
    const res = await putCut(edited);
    expect(res.status).toBe(200);
    const saved = res.json<{ cut: Cut }>().cut;
    expect(saved.holds).toEqual([{ at: 1.235, seconds: 1 }]);
    expect(await readFile(path.join(dir, "cut.json"), "utf8")).toBe(
      formatCut(saved)
    );
  });

  it("surfaces the parser's message and leaves the file alone", async () => {
    const before = await readFile(path.join(dir, "cut.json"), "utf8");
    const bad = await putCut({ ...cut, holds: [{ at: -1, seconds: 1 }] });
    expect(bad.status).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe(
      "holds[0].at must be a number ≥ 0 (seconds)"
    );
    const typo = await putCut({ ...cut, hold: [] });
    expect(typo.json<{ error: string }>().error).toContain(
      'did you mean "holds"'
    );
    const notJson = await call("/api/cut", { method: "PUT", body: "{" });
    expect(notJson.status).toBe(400);
    expect(await readFile(path.join(dir, "cut.json"), "utf8")).toBe(before);
  });

  it("refuses a cut for another video or version", async () => {
    const video = await putCut({ ...cut, video: "other.webm" });
    expect(video.status).toBe(400);
    expect(video.json<{ error: string }>().error).toContain(VIDEO);
    const version = await putCut({ ...cut, version: 2 });
    expect(version.status).toBe(400);
    expect(version.json<{ error: string }>().error).toContain("version");
  });

  it("serves the source in byte ranges", async () => {
    const whole = await call("/source.webm", { api: false });
    expect(whole.status).toBe(200);
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(whole.headers["content-type"]).toBe("video/webm");
    const size = whole.body.length;
    const part = await call("/source.webm", {
      headers: { Range: "bytes=0-99" },
    });
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 0-99/${size}`);
    expect(part.body).toEqual(whole.body.subarray(0, 100));
    const tail = await call("/source.webm", {
      headers: { Range: "bytes=-10" },
    });
    expect(tail.headers["content-range"]).toBe(
      `bytes ${size - 10}-${size - 1}/${size}`
    );
    const past = await call("/source.webm", {
      headers: { Range: `bytes=${size}-` },
    });
    expect(past.status).toBe(416);
    expect(past.headers["content-range"]).toBe(`bytes */${size}`);
    const video = await call("/video.webm", {
      headers: { Range: "bytes=0-0" },
    });
    expect(video.status).toBe(206);
  });

  it("refuses paths that leave the folder they name", async () => {
    const cutJson = await readFile(path.join(dir, "cut.json"), "utf8");
    for (const p of [
      "/recordings/../cut.json",
      "/recordings/%2e%2e/cut.json",
      "/recordings/%2e%2e%2fcut.json",
      "/recordings/..%2fcut.json",
      "/screenshots/..%2f..%2f..%2fsession.json",
      "/screenshots/%2E%2E%5Csession.json",
      "/recordings/a/b.wav",
      "/cut.json",
    ]) {
      const res = await call(p);
      expect(res.status, p).toBeGreaterThanOrEqual(400);
      expect(res.body.toString("utf8"), p).not.toContain(cutJson.slice(0, 40));
    }
    // A link out of the session directory is not followed.
    await mkdir(path.join(dir, "recordings"), { recursive: true });
    await writeFile(path.join(home, "secret.wav"), "secret");
    await symlink(
      path.join(home, "secret.wav"),
      path.join(dir, "recordings", "escape.wav")
    );
    const escaped = await call("/recordings/escape.wav");
    expect(escaped.status).toBe(404);
    await rm(path.join(dir, "recordings", "escape.wav"));
  });

  it("saves an uploaded recording, measures it, and deletes it", async () => {
    const wav = await sine(path.join(home, "line.wav"), 1);
    const res = await call("/api/recordings", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    });
    expect(res.status).toBe(201);
    const upload = res.json<UploadRecordingResponse>();
    expect(upload.file).toMatch(/^recordings\/rec-\w+\.wav$/);
    expect(upload.durationSec).toBeCloseTo(1, 1);
    expect(await readFile(path.join(dir, upload.file))).toEqual(wav);

    const served = await call(`/${upload.file}`, {
      headers: { Range: "bytes=0-3" },
    });
    expect(served.status).toBe(206);
    expect(served.body.toString("latin1")).toBe("RIFF");
    const session = (await call("/api/session")).json<EditorSession>();
    expect(session.recordings).toEqual([upload]);

    const name = path.basename(upload.file);
    expect(
      (await call(`/api/recordings/${name}`, { method: "DELETE" })).status
    ).toBe(204);
    expect(existsSync(path.join(dir, upload.file))).toBe(false);
    expect(
      (await call(`/api/recordings/${name}`, { method: "DELETE" })).status
    ).toBe(404);
  });

  it("measures a live-recorded webm, which has no duration in its header", async () => {
    const webm = await sine(path.join(home, "live.webm"), 1.5, [
      "-c:a",
      "libopus",
      "-f",
      "webm",
      "-live",
      "1",
    ]);
    const res = await call("/api/recordings", {
      method: "POST",
      headers: { "Content-Type": "audio/webm;codecs=opus" },
      body: webm,
    });
    expect(res.status).toBe(201);
    const upload = res.json<UploadRecordingResponse>();
    expect(upload.file).toMatch(/\.webm$/);
    expect(upload.durationSec).toBeCloseTo(1.5, 1);
    await call(`/api/${upload.file}`, { method: "DELETE" });
  });

  it("refuses an upload it can't keep", async () => {
    const wrongType = await call("/api/recordings", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(wrongType.status).toBe(415);
    const empty = await call("/api/recordings", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: "",
    });
    expect(empty.status).toBe(400);
    const garbage = await call("/api/recordings", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: "not audio at all",
    });
    expect(garbage.status).toBe(422);
    const huge = await call("/api/recordings", {
      method: "POST",
      headers: {
        "Content-Type": "audio/webm",
        "Content-Length": 200 * 1024 * 1024 + 1,
      },
    }).catch(() => undefined);
    // Answered 413 before reading the body, or the connection was dropped.
    expect(huge === undefined || huge.status === 413).toBe(true);
    const left = await readdir(path.join(dir, "recordings")).catch(() => []);
    expect(left).toEqual([]);
  });

  it("won't delete a recording a narration line uses, or a path", async () => {
    const wav = await sine(path.join(home, "used.wav"), 1);
    const upload = (
      await call("/api/recordings", {
        method: "POST",
        headers: { "Content-Type": "audio/x-wav" },
        body: wav,
      })
    ).json<UploadRecordingResponse>();
    const current = (await call("/api/session")).json<EditorSession>().cut;
    await putCut({
      ...current,
      narration: [{ at: 0.5, text: "Here it is", audio: upload.file }],
    });
    const name = path.basename(upload.file);
    const used = await call(`/api/recordings/${name}`, { method: "DELETE" });
    expect(used.status).toBe(409);
    const traversal = await call("/api/recordings/..%2fcut.json", {
      method: "DELETE",
    });
    expect(traversal.status).toBe(400);
    expect(existsSync(path.join(dir, "cut.json"))).toBe(true);
    await putCut({ ...current, narration: [] });
    await call(`/api/recordings/${name}`, { method: "DELETE" });
  });

  it("renders in-process, keeps foreign files in cut/, and bumps the video URL", async () => {
    const before = (await call("/api/session")).json<EditorSession>();
    await mkdir(path.join(dir, "cut"), { recursive: true });
    await writeFile(path.join(dir, "cut", "line1.m4a"), "mine");
    await writeFile(path.join(dir, "cut", "tts-0123456789abcdef.m4a"), "old");

    const started = await call("/api/render", { method: "POST" });
    expect(started.status).toBe(202);
    expect(started.json<RenderStatus>().state).toBe("running");
    expect((await call("/api/render", { method: "POST" })).status).toBe(409);
    expect((await putCut(before.cut)).status).toBe(409);

    let status = started.json<RenderStatus>();
    for (let i = 0; i < 300 && status.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = (await call("/api/render")).json<RenderStatus>();
    }
    expect(status.error).toBeUndefined();
    expect(status.state).toBe("done");
    expect(status.progress).toContain("rendering…");
    expect(status.result?.durationSec).toBeGreaterThan(2);
    expect(editor.rendering()).toBe(false);

    const after = (await call("/api/session")).json<EditorSession>();
    expect(after.video.url).not.toBe(before.video.url);
    // Steps keep their source time after the render re-times the record.
    expect(after.steps.map((s) => s.at)).toEqual([0.2, 1]);
    expect(existsSync(path.join(dir, "cut", "line1.m4a"))).toBe(true);
    expect(existsSync(path.join(dir, "cut", "tts-0123456789abcdef.m4a"))).toBe(
      false
    );
  }, 60_000);
});
