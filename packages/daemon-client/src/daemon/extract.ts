import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  DAEMON_RUNTIME_DEPENDENCIES,
  EMBEDDED_PACKAGE_JSON,
} from "dailies-protocol";
import { satisfies } from "semver";
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

// An older CLI may have installed these packages already. Their versions must
// also satisfy the current bundle: Playwright's private protocol changes across
// releases, so mere presence would let an incompatible runtime crash at startup.
export async function embeddedRuntimeInstalled(
  baseDir: string
): Promise<boolean> {
  const installed = await Promise.all(
    Object.entries(DAEMON_RUNTIME_DEPENDENCIES).map(([pkg, range]) =>
      dependencyInstalled(baseDir, pkg, range)
    )
  );
  return installed.every(Boolean);
}

async function dependencyInstalled(
  baseDir: string,
  pkg: string,
  range: string
): Promise<boolean> {
  try {
    const manifest = JSON.parse(
      await readFile(`${baseDir}/node_modules/${pkg}/package.json`, "utf8")
    ) as { version?: unknown } | null;
    return (
      typeof manifest?.version === "string" &&
      satisfies(manifest.version, range)
    );
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
