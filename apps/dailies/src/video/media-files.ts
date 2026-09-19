import { rename, rm, writeFile } from "node:fs/promises";

// Commit a complete provider response through a sibling file so a failed write
// cannot replace an existing playable asset with an empty or partial one.
export async function writeFileAtomic(
  outPath: string,
  bytes: Buffer,
  emptyMessage = "refusing to write 0 bytes"
): Promise<void> {
  if (bytes.length === 0) {
    throw new Error(emptyMessage);
  }
  const tmp = `${outPath}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, outPath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err instanceof Error ? err : new Error(String(err));
  }
}
