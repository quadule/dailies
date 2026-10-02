// Where a session's cut.json lives, and reading/writing it. Separate from the
// renderer so `session end` can write the seed cut without importing it.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionDir } from "dailies-daemon-client";
import { CUT_FILE, type Cut, formatCut, parseCut } from "./cut.js";

export function cutPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), CUT_FILE);
}

// Write the seed cut. Called by `session end` on the run that condensed the
// recording — the only run that knows the captions in condensed time.
export async function writeCut(sessionId: string, cut: Cut): Promise<string> {
  const file = cutPath(sessionId);
  await writeFile(file, formatCut(cut), "utf8");
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
