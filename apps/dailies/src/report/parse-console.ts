import { parseJsonLines } from "./json-lines.js";

export interface ConsoleEntry {
  col?: number;
  kind?: string;
  line?: number;
  message?: string;
  text?: string;
  ts?: number;
  type?: string;
  url?: string;
}

// Total function: the daemon writes console.log as newline-delimited JSON (one
// record per console / pageerror event). Unparseable lines are skipped.
export function parseConsole(raw: string): ConsoleEntry[] {
  return parseJsonLines(raw).filter(
    (entry) =>
      ["kind", "message", "text", "type", "url"].every(
        (key) => entry[key] === undefined || typeof entry[key] === "string"
      ) &&
      ["col", "line", "ts"].every(
        (key) => entry[key] === undefined || Number.isFinite(entry[key])
      )
  );
}

export function countConsoleErrors(entries: ConsoleEntry[]): number {
  return entries.filter((e) => e.kind === "pageerror" || e.type === "error")
    .length;
}
