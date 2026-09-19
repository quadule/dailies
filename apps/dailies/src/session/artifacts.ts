import { readFile } from "node:fs/promises";
import { sessionDir, sessionManifestPath } from "dailies-daemon-client";
import type {
  SessionEndResult,
  SessionPhase,
  StepPage,
} from "dailies-protocol";
import { collectSessionArtifacts } from "dailies-runtime/artifacts";
import type { SessionRecord } from "./registry.js";

// What the daemon recorded about this session when it ended, or undefined when
// there is no readable manifest. The filesystem knows which videos exist; only the
// manifest knows which PAGE each one was and which page each step ended on — and a
// re-finalize (`session end` on an already-ended session) has no daemon to ask.
// Without this, re-cutting a two-page session goes back to guessing.
async function readManifest(sessionId: string): Promise<
  | {
      artifacts: { pageName: string; path: string }[];
      stepPages?: StepPage[];
    }
  | undefined
> {
  try {
    const raw = await readFile(sessionManifestPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as {
      artifacts?: unknown;
      stepPages?: unknown;
    };
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    return {
      artifacts: Array.isArray(parsed.artifacts)
        ? parsed.artifacts.filter(
            (artifact) =>
              artifact &&
              typeof artifact.path === "string" &&
              typeof artifact.pageName === "string"
          )
        : [],
      stepPages: Array.isArray(parsed.stepPages)
        ? parsed.stepPages.filter(
            (step) =>
              step &&
              typeof step.step === "string" &&
              (step.page === undefined || typeof step.page === "string")
          )
        : undefined,
    };
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
  const artifacts = await collectSessionArtifacts(dir);

  // Re-attach what only the manifest knows: which page each recording is of.
  const manifest = await readManifest(record.id);
  const pageNames = new Map(
    (manifest?.artifacts ?? []).map((a) => [a.path, a.pageName])
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
