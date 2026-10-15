import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type CaptionEvent,
  CaptionEventSchema,
  SESSION_CAPTIONS_FILE,
} from "dailies-protocol";

// The captions this session showed, as timed data. Read from disk rather than
// held from the run so a re-finalize (re-rendering a report, re-cutting a video)
// sees exactly what the original run did. Missing or malformed is not an error:
// a session that never called showCaption has no file, and a caption is
// presentation — it must never be the reason a report fails to build.
export async function readCaptions(
  artifactsDir: string
): Promise<CaptionEvent[]> {
  try {
    const raw = await readFile(
      path.join(artifactsDir, SESSION_CAPTIONS_FILE),
      "utf8"
    );
    const parsed = CaptionEventSchema.array().safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
