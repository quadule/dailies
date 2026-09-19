import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  type ArtifactInfo,
  type CaptureOptions,
  SESSION_ATTACHMENTS_DIR,
  SESSION_CONSOLE_FILE,
  SESSION_HAR_FILE,
  SESSION_SCREENSHOT_EXT,
  SESSION_SCREENSHOTS_DIR,
  SESSION_TRACE_FILE,
  SESSION_VIDEO_DIR,
  SESSION_VIDEO_EXT,
} from "dailies-protocol";

async function fileArtifact(
  kind: ArtifactInfo["kind"],
  filePath: string
): Promise<ArtifactInfo | undefined> {
  try {
    const info = await stat(filePath);
    if (info.isFile()) {
      return { bytes: info.size, kind, path: filePath };
    }
  } catch {
    // Missing or partial capture: retain whatever artifacts survived.
  }
  return;
}

async function directoryArtifacts(
  kind: ArtifactInfo["kind"],
  dir: string,
  include: (name: string) => boolean
): Promise<ArtifactInfo[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const refs = await Promise.all(
    names
      .filter(include)
      .map((name) => fileArtifact(kind, path.join(dir, name)))
  );
  return refs.filter((ref): ref is ArtifactInfo => ref !== undefined);
}

// Discover artifacts for both live teardown and recovery from disk. Only the
// daemon supplies capture flags: recovery retains every surviving file even
// when an older on-disk record has incomplete capture settings. Screenshots and
// attachments are independent of those flags.
export async function collectSessionArtifacts(
  artifactsDir: string,
  capture: Partial<CaptureOptions> = {}
): Promise<ArtifactInfo[]> {
  const refs = await Promise.all([
    capture.trace === false
      ? undefined
      : fileArtifact("trace", path.join(artifactsDir, SESSION_TRACE_FILE)),
    capture.har === false
      ? undefined
      : fileArtifact("har", path.join(artifactsDir, SESSION_HAR_FILE)),
    capture.console === false
      ? undefined
      : fileArtifact("console", path.join(artifactsDir, SESSION_CONSOLE_FILE)),
  ]);
  // A cinematic pass preserves its input as *.precinematic.<ext>. That working
  // copy is never a second recording or screenshot in the report.
  const captureFile = (suffix: string) => (name: string) =>
    name.endsWith(suffix) && !/\.precinematic\.[^.]+$/.test(name);
  const [videos, screenshots, attachments] = await Promise.all([
    capture.video === false
      ? []
      : directoryArtifacts(
          "video",
          path.join(artifactsDir, SESSION_VIDEO_DIR),
          captureFile(SESSION_VIDEO_EXT)
        ),
    directoryArtifacts(
      "screenshot",
      path.join(artifactsDir, SESSION_SCREENSHOTS_DIR),
      captureFile(SESSION_SCREENSHOT_EXT)
    ),
    // Non-recursive: directories are rejected by fileArtifact. Dotfiles and
    // empty files are editor/OS cruft rather than intentional attachments.
    directoryArtifacts(
      "attachment",
      path.join(artifactsDir, SESSION_ATTACHMENTS_DIR),
      (name) => !name.startsWith(".")
    ),
  ]);
  return [
    ...refs.filter((ref): ref is ArtifactInfo => ref !== undefined),
    ...videos,
    ...screenshots,
    ...attachments.filter((ref) => ref.bytes > 0),
  ];
}
