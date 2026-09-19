import { readFile } from "node:fs/promises";

// Optional CI inputs fail open: a missing file costs context, never the run.
export async function readTextInput(file: string | undefined): Promise<string> {
  if (!file) {
    return "";
  }
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

// Both freshness decisions and metric comparisons read the same comment file.
export async function readComments(
  file: string | undefined
): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readTextInput(file));
    return Array.isArray(parsed)
      ? parsed.filter((c): c is string => typeof c === "string")
      : [];
  } catch {
    return [];
  }
}
