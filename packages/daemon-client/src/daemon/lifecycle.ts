import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { isDaemonRunning } from "../ipc/connect.js";
import { logger } from "../logger.js";
import { daemonPidPath, daemonStderrLogPath } from "../paths.js";
import { findDaemonCommand } from "./entry.js";
import { embeddedRuntimeInstalled } from "./extract.js";
import { spawnDaemon } from "./spawn.js";

const log = logger.child({ component: "daemon-supervisor" });

const STARTUP_DEADLINE_MS = 5000;
const POLL_INTERVAL_MS = 100;
// How much of the daemon's stderr to quote when it never comes up. A stack
// trace's first frames are the informative part; the rest is noise in a CLI
// error.
const STARTUP_LOG_TAIL_LINES = 20;

// The tail of ~/.dailies/daemon.stderr.log — whatever the daemon printed before
// dying, which for an import-time crash is the only record that exists. Empty
// when there is nothing to show; never throws.
async function daemonStderrTail(): Promise<string> {
  try {
    const text = await readFile(daemonStderrLogPath(), "utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    return lines.slice(-STARTUP_LOG_TAIL_LINES).join("\n");
  } catch {
    return "";
  }
}

// Returns the daemon PID from ~/.dailies/daemon.pid, or null if the
// file is missing/unreadable/unparseable.
export async function currentDaemonPid(): Promise<number | null> {
  try {
    const raw = await readFile(daemonPidPath(), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Throws if the daemon cannot be brought up within STARTUP_DEADLINE_MS.
export async function ensureDaemonRunning(): Promise<void> {
  if (await isDaemonRunning()) {
    log.debug("daemon already running");
    return;
  }

  const command = await findDaemonCommand();
  if (
    command.requiresRuntimeInstall &&
    !(await embeddedRuntimeInstalled(command.workdir))
  ) {
    throw new Error(
      "Embedded daemon dependencies are missing. Run `dailies install` first."
    );
  }

  log.debug(
    { program: command.program, workdir: command.workdir },
    "spawning daemon"
  );
  spawnDaemon(command);

  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (await isDaemonRunning()) {
      log.debug("daemon started");
      return;
    }
  }
  const tail = await daemonStderrTail();
  throw new Error(
    [
      "Daemon failed to start within 5 seconds.",
      tail,
      "See ~/.dailies/daemon.log, and run `dailies install` if the runtime is missing.",
    ]
      .filter((part) => part.length > 0)
      .join("\n")
  );
}

// Waits up to `timeoutMs` for the daemon to stop accepting connections.
export async function waitForDaemonExit(
  _pid: number | null,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isDaemonRunning())) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const seconds = Math.round(timeoutMs / 1000);
  throw new Error(`Daemon failed to stop within ${seconds} seconds`);
}
