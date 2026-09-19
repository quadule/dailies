import { realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { dailiesDir } from "../paths.js";
import { ensureDaemonExtracted } from "./extract.js";
import type { DaemonCommand } from "./spawn.js";

// The Node that should run the daemon: the one running this CLI, so a user with
// several Node versions (nvm, volta, asdf, a system Node behind a shim) gets the
// daemon on the same runtime their `dailies` binary is on, rather than whatever
// bare "node" resolves to in the daemon's environment — which may be an older
// major, or missing from PATH entirely. Under a non-Node runtime (bun, deno)
// execPath is that runtime's binary and would not understand the bundle, so fall
// back to PATH lookup there.
function nodeProgram(): string {
  const exec = process.execPath;
  const name = basename(exec).toLowerCase();
  return name === "node" || name === "node.exe" ? exec : "node";
}

// Resolve the daemon launch command. Honors the DAILIES_DAEMON env var for
// custom entrypoints.
export async function findDaemonCommand(): Promise<DaemonCommand> {
  const override = process.env.DAILIES_DAEMON;
  if (override && override.length > 0) {
    return commandFromEntry(override);
  }
  const bundle = await ensureDaemonExtracted();
  return {
    program: nodeProgram(),
    args: [bundle],
    workdir: dailiesDir(),
    requiresRuntimeInstall: true,
  };
}

async function commandFromEntry(entry: string): Promise<DaemonCommand> {
  const abs = isAbsolute(entry) ? entry : resolve(entry);
  let resolved: string;
  try {
    resolved = await realpath(abs);
  } catch (err) {
    throw new Error(
      `Failed to resolve DAILIES_DAEMON entry ${abs}: ${(err as Error).message}`
    );
  }
  const parent = dirname(resolved);
  if (!parent || parent === "." || parent === resolved) {
    throw new Error("Daemon entrypoint has no parent directory");
  }
  const ext = extname(resolved); // Includes the dot; case-sensitive.

  switch (ext) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return {
        program: nodeProgram(),
        args: [resolved],
        workdir: parent,
        requiresRuntimeInstall: false,
      };
    case ".ts":
    case ".mts":
    case ".cts": {
      const tsxCli = await findTsxCli(resolved);
      return {
        program: nodeProgram(),
        args: [tsxCli, resolved],
        workdir: parent,
        requiresRuntimeInstall: false,
      };
    }
    default:
      return {
        program: resolved,
        args: [],
        workdir: parent,
        requiresRuntimeInstall: false,
      };
  }
}

async function findTsxCli(entry: string): Promise<string> {
  let dir = dirname(entry);
  while (true) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        return candidate;
      }
    } catch {
      // try parent
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    "Could not locate the tsx runtime required to launch the TypeScript daemon."
  );
}
