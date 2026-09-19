import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  DAEMON_RUNTIME_DEPENDENCIES,
  EMBEDDED_PACKAGE_JSON,
} from "dailies-protocol";
import { DAEMON_BUNDLE, SANDBOX_CLIENT } from "../assets/embedded.generated.js";
import {
  daemonBundlePath,
  dailiesDir,
  packageJsonPath,
  sandboxClientPath,
} from "../paths.js";

const DAEMON_BUNDLE_TEXT: string = DAEMON_BUNDLE;
const SANDBOX_CLIENT_TEXT: string = SANDBOX_CLIENT;
const PACKAGE_JSON_TEXT: string = EMBEDDED_PACKAGE_JSON;

// Write the embedded daemon bundle, sandbox client, and package.json
// template into ~/.dailies/ if missing or stale. Returns the daemon bundle path.
export async function ensureDaemonExtracted(): Promise<string> {
  const dir = dailiesDir();
  // 0700: ~/.dailies goes on to hold browser profiles with live cookies plus
  // every session's HAR and trace, and the daemon socket next to them is
  // unauthenticated. `recursive: true` leaves an existing directory's mode
  // alone, so this only tightens a fresh install. Mode is ignored on Windows.
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const daemonPath = daemonBundlePath();
  const sandboxPath = sandboxClientPath();
  const pkgPath = packageJsonPath();

  await Promise.all([
    syncTextFile(daemonPath, DAEMON_BUNDLE_TEXT),
    syncTextFile(sandboxPath, SANDBOX_CLIENT_TEXT),
    syncTextFile(pkgPath, PACKAGE_JSON_TEXT),
  ]);

  return daemonPath;
}

// Returns true if the npm-managed runtime has been installed (i.e.
// `dailies install` has been run). The set checked is derived from the single
// source of truth (DAEMON_RUNTIME_DEPENDENCIES), so a new runtime dependency is
// gated automatically without editing this allowlist.
export async function embeddedRuntimeInstalled(
  baseDir: string
): Promise<boolean> {
  const deps = Object.keys(DAEMON_RUNTIME_DEPENDENCIES);
  const installed = await Promise.all(
    deps.map((pkg) => dependencyInstalled(baseDir, pkg))
  );
  return installed.every(Boolean);
}

async function dependencyInstalled(
  baseDir: string,
  pkg: string
): Promise<boolean> {
  try {
    await readFile(`${baseDir}/node_modules/${pkg}/package.json`);
    return true;
  } catch {
    return false;
  }
}

async function syncTextFile(path: string, contents: string): Promise<void> {
  try {
    const existing = await readFile(path, "utf8");
    if (existing === contents) {
      return;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`Failed to inspect ${path}: ${(err as Error).message}`);
    }
  }
  await writeFile(path, contents);
}
