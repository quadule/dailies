// Capture streams are newline-delimited JSON objects. A partial write or an
// unexpected JSON value must not prevent the rest of a report from rendering.
export function parseJsonLines(raw: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        records.push(value as Record<string, unknown>);
      }
    } catch {
      // Empty or malformed line: retain the complete records around it.
    }
  }
  return records;
}
