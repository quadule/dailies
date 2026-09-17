import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { sessionDir, sessionManifestPath } from "dailies-daemon-client";
import {
  type ArtifactInfo,
  SESSION_ATTACHMENTS_DIR,
  SESSION_CONSOLE_FILE,
  SESSION_HAR_FILE,
  SESSION_SCREENSHOT_EXT,
  SESSION_SCREENSHOTS_DIR,
  SESSION_TRACE_FILE,
  SESSION_VIDEO_DIR,
  SESSION_VIDEO_EXT,
  type SessionEndResult,
  type SessionPhase,
  type StepPage,
} from "dailies-protocol";
import type { SessionRecord } from "./registry.js";

async function statRef(
  kind: ArtifactInfo["kind"],
  filePath: string
): Promise<ArtifactInfo | undefined> {
  try {
    const info = await stat(filePath);
    if (info.isFile()) {
      return { bytes: info.size, kind, path: filePath };
    }
  } catch {
    // missing artifact
  }
  return;
}

async function dirArtifacts(
  kind: ArtifactInfo["kind"],
  dir: string,
  suffix: string
): Promise<ArtifactInfo[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const refs = await Promise.all(
    files
      // Skip the cinematic pass's preserved pre-cinematic cut (`*.precinematic.<ext>`,
      // see precinematicVideoPath in video/narrate.ts) — it's a working copy for
      // theme re-runs, not a session recording, so it must not be discovered as a
      // second video (which would get condensed/reported alongside the real one).
      .filter((f) => f.endsWith(suffix) && !/\.precinematic\.[^.]+$/.test(f))
      .map((f) => statRef(kind, path.join(dir, f)))
  );
  return refs.filter((r): r is ArtifactInfo => r !== undefined);
}

// Freeform files an external tool dropped into attachments/ before `session
// end` ran. Non-recursive (subdirectories fail the isFile() check below and
// are silently skipped); dotfiles and empty files are excluded since those
// are almost always editor/OS cruft rather than an intentional artifact.
async function attachmentArtifacts(dir: string): Promise<ArtifactInfo[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const refs = await Promise.all(
    files
      .filter((f) => !f.startsWith("."))
      .map((f) => statRef("attachment", path.join(dir, f)))
  );
  return refs.filter((r): r is ArtifactInfo => r !== undefined && r.bytes > 0);
}

// What the daemon recorded about this session when it ended, or undefined when
// there is no readable manifest. The filesystem knows which videos exist; only the
// manifest knows which PAGE each one was and which page each step ended on — and a
// re-finalize (`session end` on an already-ended session) has no daemon to ask.
// Without this, re-cutting a two-page session goes back to guessing.
async function readManifest(sessionId: string): Promise<
  | {
      artifacts?: { pageName?: string; path?: string }[];
      stepPages?: StepPage[];
    }
  | undefined
> {
  try {
    const raw = await readFile(sessionManifestPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as {
      artifacts?: { pageName?: string; path?: string }[];
      stepPages?: StepPage[];
    };
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    // No manifest, or unreadable/corrupt — the caller carries on without it.
    return;
  }
}

// Reconstruct a SessionEndResult by scanning the session dir on disk. Used when
// the daemon can no longer finalize the session (restarted / lost it) but the
// artifacts it already flushed remain — so `session end`/`abort` can still emit
// a report instead of leaving a zombie record.
export async function endResultFromDisk(
  record: SessionRecord
): Promise<SessionEndResult> {
  const dir = sessionDir(record.id);
  const refs = await Promise.all([
    statRef("trace", path.join(dir, SESSION_TRACE_FILE)),
    statRef("har", path.join(dir, SESSION_HAR_FILE)),
    statRef("console", path.join(dir, SESSION_CONSOLE_FILE)),
  ]);
  const [videos, screenshots, attachments] = await Promise.all([
    dirArtifacts("video", path.join(dir, SESSION_VIDEO_DIR), SESSION_VIDEO_EXT),
    dirArtifacts(
      "screenshot",
      path.join(dir, SESSION_SCREENSHOTS_DIR),
      SESSION_SCREENSHOT_EXT
    ),
    attachmentArtifacts(path.join(dir, SESSION_ATTACHMENTS_DIR)),
  ]);
  const artifacts = [
    ...refs.filter((r): r is ArtifactInfo => r !== undefined),
    ...videos,
    ...screenshots,
    ...attachments,
  ];

  // Re-attach what only the manifest knows: which page each recording is of.
  const manifest = await readManifest(record.id);
  const pageNames = new Map(
    (manifest?.artifacts ?? [])
      .filter((a) => a.path && a.pageName)
      .map((a) => [a.path as string, a.pageName as string])
  );
  for (const artifact of artifacts) {
    const pageName = pageNames.get(artifact.path);
    if (pageName) {
      artifact.pageName = pageName;
    }
  }

  const phase: SessionPhase = record.status === "aborted" ? "aborted" : "ended";
  return {
    artifacts,
    manifestPath: sessionManifestPath(record.id),
    session: {
      artifactsDir: dir,
      browser: record.browser,
      capture: record.capture,
      endedAt: Date.parse(record.endedAt ?? "") || Date.now(),
      headless: record.headless,
      name: record.name,
      pageCount: 0,
      phase,
      runCount: record.steps.length,
      sessionId: record.id,
      startedAt: Date.parse(record.createdAt) || Date.now(),
    },
    stepPages: manifest?.stepPages,
  };
}
