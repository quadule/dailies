import { spawn } from "node:child_process";
import { dailiesDir } from "../paths.js";
import { ensureDaemonExtracted } from "./extract.js";
import { npmCommand } from "./npm.js";

// Install Playwright + runtime deps under ~/.dailies/. Extracts the
// embedded daemon bundle, then `npm install` + `playwright install chromium`.
// Used by the `dailies` CLI — which afterwards retires a daemon still serving
// the PREVIOUS bundle, if it is idle. That decision lives in the CLI because
// only it knows which sessions are active; this package sees browsers, not
// sessions, and a recording in progress must never be cut off by an upgrade.
export async function installDaemonRuntime(): Promise<number> {
  const base = dailiesDir();
  await ensureDaemonExtracted();
  const npm = npmCommand();
  await runInstall(npm, ["install"], base);
  await runInstall(
    npm,
    ["exec", "--", "playwright", "install", "chromium"],
    base
  );
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

function runInstall(
  program: string,
  args: string[],
  cwd: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32",
    });
    child.on("error", (err) => {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        reject(
          new Error(
            `Could not find \`${program}\` in PATH while setting up the embedded daemon runtime in ${cwd}. Install Node.js/npm and re-run the install command.`
          )
        );
        return;
      }
      reject(
        new Error(
          `Failed to run \`${program} ${args.join(" ")}\` in ${cwd}: ${err.message}`
        )
      );
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (signal) {
        reject(
          new Error(`\`${program} ${args.join(" ")}\` terminated by signal`)
        );
        return;
      }
      reject(
        new Error(
          `\`${program} ${args.join(" ")}\` failed with exit code ${code ?? "?"}`
        )
      );
    });
  });
}
