// Apple Intelligence (on-device Foundation Models) as a text provider.
//
// No API key, no network, nothing leaves the machine. Requires macOS 26+ with
// Apple Intelligence enabled and Xcode command line tools for `swiftc`.
//
// The helper is shipped as SOURCE (see ./apple-source.ts) and compiled once into
// ~/.dailies/bin, keyed by a hash of that source so an updated helper rebuilds
// itself. Shipping a prebuilt arm64 binary in an npm package would mean
// architecture matrices and notarization for a file the user can build in a
// second.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dailiesDir } from "dailies-daemon-client";
import { isOnPath, ProcessError, run } from "../../util/process.js";
import type { GenerateJsonArgs, TextProvider } from "../types.js";
import { AFM_SWIFT_SOURCE } from "./apple-source.js";

const COMPILE_TIMEOUT_MS = 120_000;

// Keyed by source hash: a changed helper compiles to a new path instead of
// silently reusing a stale binary.
export function helperPath(): string {
  const hash = createHash("sha256")
    .update(AFM_SWIFT_SOURCE)
    .digest("hex")
    .slice(0, 12);
  return path.join(dailiesDir(), "bin", `dailies-afm-${hash}`);
}

// Compile the helper if it isn't already built. Returns its path, or throws with
// the compiler's own message — which is what the user needs to see when their
// SDK is too old for FoundationModels.
export async function ensureHelper(): Promise<string> {
  const out = helperPath();
  if (existsSync(out)) {
    return out;
  }
  await mkdir(path.dirname(out), { recursive: true });
  const src = `${out}.swift`;
  const tmp = `${out}.building-${process.pid}`;
  try {
    await writeFile(src, AFM_SWIFT_SOURCE, "utf8");
    // -parse-as-library is required: the helper uses @main, which conflicts
    // with swiftc's default top-level-code mode for a single file.
    await run(
      "swiftc",
      ["-O", "-parse-as-library", src, "-o", tmp],
      COMPILE_TIMEOUT_MS
    );
    await chmod(tmp, 0o755);
    // Atomic: a half-written binary must never be picked up as cached.
    await rename(tmp, out);
    return out;
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not build the Apple Intelligence helper — ${detail}`
    );
  } finally {
    await rm(src, { force: true }).catch(() => undefined);
  }
}

// Run the helper with a JSON request on stdin. Rejects with the helper's stderr,
// which distinguishes "Apple Intelligence unavailable" from a generation error.
async function runHelper(
  bin: string,
  request: string,
  timeoutMs: number
): Promise<string> {
  try {
    const { stdout } = await run(bin, [], timeoutMs, { input: request });
    return stdout;
  } catch (err) {
    // Keep the provider's established diagnostics while retaining the shared
    // runner's output, exit status and underlying system error as the cause.
    if (err instanceof ProcessError && err.reason === "timeout") {
      throw new Error(
        `the Apple Intelligence helper timed out after ${timeoutMs}ms`,
        { cause: err }
      );
    }
    if (err instanceof ProcessError && err.reason === "exit") {
      throw new Error(err.stderr.trim() || `helper exited ${err.exitCode}`, {
        cause: err,
      });
    }
    throw err;
  }
}

export function createAppleProvider(): TextProvider {
  return {
    describe(): string {
      return "Apple Intelligence (on-device)";
    },

    async generateJson(args: GenerateJsonArgs): Promise<string> {
      const { echo, label, prompt, schema, timeoutMs } = args;
      const bin = await ensureHelper();
      echo?.(
        `$ ${path.basename(bin)} <<< '{"prompt": "<${label} prompt, ${prompt.length} chars>", "schema": …}'`
      );
      return await runHelper(
        bin,
        JSON.stringify({ prompt, schema }),
        timeoutMs
      );
    },

    id: "apple",

    // Foundation Models exposes no version string; the system model is whatever
    // the OS ships.
    model: "apple-on-device",

    async isAvailable(): Promise<boolean> {
      // Only plausible on macOS, and only with a Swift toolchain to build the
      // helper. Whether the MODEL is available is decided by the helper itself
      // (exit 3), because asking costs a process launch.
      if (process.platform !== "darwin") {
        return false;
      }
      if (existsSync(helperPath())) {
        return true;
      }
      return await isOnPath("swiftc", ["--version"]);
    },
  };
}
