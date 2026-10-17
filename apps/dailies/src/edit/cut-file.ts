// Where a session's cut.json lives, and reading/writing it. Separate from the
// renderer so `session end` can write the seed cut without importing it.

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionDir } from "dailies-daemon-client";
import { CUT_FILE, type Cut, formatCut, parseCut } from "./cut.js";

export function cutPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), CUT_FILE);
}

// Distinguishes two writes in flight in one process (two editor saves).
let writes = 0;

// Write a cut: the seed `session end` writes on the run that condensed the
// recording (the only run that knows the captions in condensed time), a
// render pinning its voice, an editor save. Written beside the file and
// renamed into place, so a reader — the editor's GET racing a save — never
// sees half a file, and a process killed mid-write leaves the old cut whole.
export async function writeCut(sessionId: string, cut: Cut): Promise<string> {
  const file = cutPath(sessionId);
  writes += 1;
  const tmp = `${file}.tmp.${process.pid}.${writes}`;
  try {
    await writeFile(tmp, formatCut(cut), "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return file;
}

export async function readCut(
  sessionId: string
): Promise<{ cut: Cut } | { error: string }> {
  const file = cutPath(sessionId);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {
      error: `No ${CUT_FILE} for session "${sessionId}". It is written when \`session end\` condenses the recording; a session finished with --no-condense, or before cuts existed, can't be edited.`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      error: `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = parseCut(json);
  return "error" in parsed ? { error: `${file}: ${parsed.error}` } : parsed;
}
