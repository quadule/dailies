import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { logger } from "../logger.js";
import { daemonStderrLogPath, dailiesDir } from "../paths.js";

export interface DaemonCommand {
  args: string[];
  program: string;
  requiresRuntimeInstall: boolean;
  workdir: string;
}

// Open ~/.dailies/daemon.stderr.log for append and hand back the fd, or
// undefined if it can't be opened (a read-only home, a full disk) — losing the
// crash log must never stop the daemon from starting.
function openStderrLog(): number | undefined {
  try {
    // 0700: the same directory holds browser profiles with live cookies.
    // `recursive: true` leaves an existing directory's mode alone.
    mkdirSync(dailiesDir(), { recursive: true, mode: 0o700 });
    // Truncated per spawn: only one daemon runs at a time, so the file is
    // exactly the current daemon's stderr and the startup tail can read it whole.
    return openSync(daemonStderrLogPath(), "w");
  } catch (err) {
    logger.debug({ err }, "could not open the daemon stderr log");
    return;
  }
}

// Spawn the daemon as a fully detached background process.
//
// - `detached: true` on POSIX calls setsid(2) on the child.
// - `detached: true` on Windows sets DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP.
// - stdin/stdout are /dev/null equivalents; stderr is appended to
//   ~/.dailies/daemon.stderr.log. The daemon builds its own pino logger only
//   after imports that can throw (the Playwright internals and the QuickJS
//   bundle both resolve files at import time), so a half-installed runtime
//   crashes before daemon.log exists — with stderr discarded, the user got
//   nothing but "Daemon failed to start within 5 seconds". ensureDaemonRunning
//   quotes the tail of this file on that deadline.
// - `windowsHide: true` prevents a flash console window on GUI parents.
// - `child.unref()` lets the CLI exit without waiting for the daemon.
export function spawnDaemon(command: DaemonCommand): void {
  const stderrFd = openStderrLog();
  try {
    const child = spawn(command.program, command.args, {
      cwd: command.workdir,
      detached: true,
      stdio: ["ignore", "ignore", stderrFd ?? "ignore"],
      windowsHide: true,
    });
    child.on("error", (err) => {
      // Errors are otherwise surfaced via the socket-poll loop in lifecycle.ts —
      // if the spawn fails the daemon never comes up and ensureRunning() returns
      // "Daemon failed to start within 5 seconds". Log the underlying cause.
      logger.error({ err }, "daemon process spawn error");
    });
    child.unref();
  } finally {
    // The child holds its own descriptor for the log; this is the parent's copy
    // and would otherwise leak for the life of the CLI process.
    if (stderrFd !== undefined) {
      closeSync(stderrFd);
    }
  }
}
