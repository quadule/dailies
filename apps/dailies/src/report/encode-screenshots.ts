import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Screenshots are most of a report's bytes: a 197-step run embedded 26 MB of
// PNG, 38 MB once base64'd. Lossless WebP keeps every pixel (UI text stays
// sharp) at about a third of the size; lossy WebP measured no smaller on these
// flat UI frames, and downscaling blurs text while saving little.
const WEBP_ARGS = ["-c:v", "libwebp", "-lossless", "1", "-f", "webp"];
const ENCODE_TIMEOUT_MS = 30_000;

async function encodeWebp(ffmpeg: string, file: string): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-i", file, ...WEBP_ARGS, "pipe:1"],
    {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      timeout: ENCODE_TIMEOUT_MS,
    }
  );
  if (stdout.length === 0) {
    throw new Error("ffmpeg wrote no image");
  }
  return stdout;
}

// Each screenshot as a data: URI for the self-contained report, keyed as given.
// Re-encoded to WebP when ffmpeg can; any image that can't be (no ffmpeg, an
// ffmpeg built without libwebp, a bad file) is embedded as the original PNG, so
// a missing encoder never costs the report a screenshot. An unreadable file is
// left out.
export async function screenshotDataUris(
  files: { key: string; path: string }[],
  ffmpeg: string | undefined
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let webp = Boolean(ffmpeg);
  let encoded = 0;
  const embed = async (file: string): Promise<string | undefined> => {
    if (webp && ffmpeg) {
      try {
        const buf = await encodeWebp(ffmpeg, file);
        encoded++;
        return `data:image/webp;base64,${buf.toString("base64")}`;
      } catch {
        // Failing before any image has worked most likely means this ffmpeg
        // can't write WebP at all; don't pay a failed spawn for every
        // remaining screenshot.
        if (encoded === 0) {
          webp = false;
        }
      }
    }
    try {
      const buf = await readFile(file);
      return `data:image/png;base64,${buf.toString("base64")}`;
    } catch {
      return; // missing screenshot — skip
    }
  };
  const queue = [...files];
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const uri = await embed(file.path);
      if (uri) {
        out[file.key] = uri;
      }
    }
  };
  const workers = Math.max(1, Math.min(8, os.availableParallelism()));
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}
