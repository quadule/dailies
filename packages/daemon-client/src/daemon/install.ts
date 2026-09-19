import { installRuntimeDependencies } from "dailies-runtime/install";
import { dailiesDir } from "../paths.js";
import { ensureDaemonExtracted } from "./extract.js";

// Install Playwright + runtime deps under ~/.dailies/. Extracts the
// embedded daemon bundle, then `npm install` + `playwright install chromium`.
// Used by the `dailies` CLI — which afterwards retires a daemon still serving
// the PREVIOUS bundle, if it is idle. That decision lives in the CLI because
// only it knows which sessions are active; this package sees browsers, not
// sessions, and a recording in progress must never be cut off by an upgrade.
export async function installDaemonRuntime(): Promise<number> {
  const base = dailiesDir();
  await ensureDaemonExtracted();
  await installRuntimeDependencies(base);
  if (process.platform === "linux") {
    // We deliberately do NOT run `playwright install-deps`: it needs sudo, and
    // a CLI install should not escalate on its own. The repo's own CI passes
    // --with-deps for the same reason this line exists.
    process.stdout.write(
      "Linux: Chromium needs system libraries — if the browser fails to launch, run `sudo npx playwright install-deps chromium` (or your distro's equivalent).\n"
    );
  }
  return 0;
}
