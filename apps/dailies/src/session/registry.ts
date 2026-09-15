import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  sessionDir,
  sessionRecordPath,
  sessionsRootDir,
} from "dailies-daemon-client";
import type { CaptureOptions } from "dailies-protocol";
import { withSessionLock } from "./lock.js";

export const SESSION_SCHEMA_VERSION = 1;

export interface SessionStep {
  durationMs: number;
  exitCode: number;
  name: string;
  ok: boolean;
  // The step's position in the PRE-cinematic (condensed) cut, preserved when the
  // cinematic pass first runs so `session end --cinematic --prompt …` can be
  // re-run with a different theme from the clean condensed source + its timings,
  // without re-recording. Survives across cinematic re-runs (videoTime does not).
  precinematicVideoTime?: number;
  // The script text this step ran — surfaced in the report/results.json so a
  // reviewer can see what the agent actually sent.
  script?: string;
  startedAt: string;
  // Where this step lands in the CONDENSED video, in seconds. Set at session
  // end once the video has been trimmed, so the report/viewer timeline can seek
  // the video to a step (and highlight the current step as it plays). The
  // cinematic pass overwrites this with the step's position in the cinematic cut.
  videoTime?: number;
}

export interface SessionRecord {
  artifactsDir: string;
  browser: string;
  capture: CaptureOptions;
  // ISO time real content first appeared — the first non-about:blank page load
  // (or, with `session start --url`, that page's post-settle time). Same clock
  // basis as createdAt. session end trims the video head to
  // (contentStartedAt - createdAt), dropping the leading blank (about:blank + the
  // first navigation's white load screen).
  contentStartedAt?: string;
  createdAt: string;
  endedAt?: string;
  headless: boolean;
  id: string;
  // Named numbers recorded at `session end --metric name=value`. Dailies never
  // interprets them; they are persisted so runs can be compared over time.
  metrics?: { name: string; value: number }[];
  name?: string;
  schemaVersion: number;
  status: "active" | "ended" | "aborted";
  steps: SessionStep[];
  // The agent's explicit run verdict, declared at `session end --pass/--fail`.
  // When set, it decides the report's pass/fail — a failed intermediate step
  // (a timed-out click, an abandoned retry, a dead end the agent recovered from)
  // no longer forces the whole run to "failed". Absent → fall back to the
  // mechanical "any step exited non-zero" rule. Per-step statuses stay honest.
  verdict?: { status: "pass" | "fail"; reason?: string };
}

async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

export async function createSessionRecord(
  record: SessionRecord
): Promise<void> {
  await mkdir(sessionDir(record.id), { recursive: true });
  await atomicWriteJson(sessionRecordPath(record.id), record);
}

export async function readSessionRecord(id: string): Promise<SessionRecord> {
  try {
    const raw = await readFile(sessionRecordPath(id), "utf8");
    return JSON.parse(raw) as SessionRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No such session "${id}"`);
    }
    throw err;
  }
}

// Atomic, lock-free write. Callers doing a read-modify-write must hold the
// session lock first (see updateSessionRecord, or withSessionLock in run.ts).
export async function writeSessionRecord(record: SessionRecord): Promise<void> {
  await atomicWriteJson(sessionRecordPath(record.id), record);
}

// Read-modify-write under the per-session lock. The mutator edits the record in
// place; the updated record is persisted atomically and returned.
export function updateSessionRecord(
  id: string,
  mutate: (record: SessionRecord) => void
): Promise<SessionRecord> {
  return withSessionLock(id, async () => {
    const record = await readSessionRecord(id);
    mutate(record);
    await writeSessionRecord(record);
    return record;
  });
}

export async function listSessions(): Promise<SessionRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionsRootDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const settled = await Promise.all(
    entries.map((entryId) => readSessionRecord(entryId).catch(() => null))
  );
  return settled
    .filter((record): record is SessionRecord => record !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
