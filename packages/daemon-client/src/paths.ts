import { homedir } from "node:os";
import { join } from "node:path";
import { daemonPipeName } from "./ipc/pipename.js";

const DIR_NAME = ".dailies";
const DAEMON_SOCKET = "daemon.sock";
const DAEMON_PID = "daemon.pid";
const DAEMON_STDERR_LOG = "daemon.stderr.log";
const DAEMON_BUNDLE = "daemon.mjs";
const SANDBOX_CLIENT = "sandbox-client.js";
const PACKAGE_JSON = "package.json";
const TMP_DIR = "tmp";
const SESSIONS_DIR = "sessions";
const SESSION_RECORD = "session.json";
const SESSION_MANIFEST = "manifest.json";
const SESSION_RESULTS = "results.json";
const SESSION_REPORT = "report.html";

export function home(): string {
  const dir = homedir();
  if (!dir) {
    throw new Error("Could not determine home directory");
  }
  return dir;
}

export function dailiesDir(): string {
  return join(home(), DIR_NAME);
}

export function daemonSocketPath(): string {
  return join(dailiesDir(), DAEMON_SOCKET);
}

export function daemonPidPath(): string {
  return join(dailiesDir(), DAEMON_PID);
}

// Where the spawned daemon's raw stderr lands. The daemon's own pino log
// (daemon.log) only exists once its module body has run, so a crash BEFORE that
// — an import-time throw from a half-installed runtime — can only be seen here.
export function daemonStderrLogPath(): string {
  return join(dailiesDir(), DAEMON_STDERR_LOG);
}

export function daemonBundlePath(): string {
  return join(dailiesDir(), DAEMON_BUNDLE);
}

export function sandboxClientPath(): string {
  return join(dailiesDir(), SANDBOX_CLIENT);
}

export function packageJsonPath(): string {
  return join(dailiesDir(), PACKAGE_JSON);
}

export function tmpDir(): string {
  return join(dailiesDir(), TMP_DIR);
}

// Endpoint path used by net.createConnection / createServer. On POSIX this
// is a Unix domain socket path; on Windows it is a named-pipe path
// (`\\.\pipe\dailies-daemon-{user}`) — Node's `net` module accepts both.
export function daemonEndpoint(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${daemonPipeName()}`;
  }
  return daemonSocketPath();
}

// ---- Session artifact layout: ~/.dailies/sessions/<id>/ ----
// Shared by the daemon (writes trace/video/HAR/console + manifest) and the
// `dailies` orchestrator (writes session.json, reads artifacts, renders report).

export function sessionsRootDir(): string {
  return join(dailiesDir(), SESSIONS_DIR);
}

export function sessionDir(sessionId: string): string {
  return join(sessionsRootDir(), sessionId);
}

export function sessionRecordPath(sessionId: string): string {
  return join(sessionDir(sessionId), SESSION_RECORD);
}

export function sessionManifestPath(sessionId: string): string {
  return join(sessionDir(sessionId), SESSION_MANIFEST);
}

// Canonical, schema-versioned per-session record (references every artifact).
export function sessionResultsPath(sessionId: string): string {
  return join(sessionDir(sessionId), SESSION_RESULTS);
}

export function sessionReportPath(sessionId: string): string {
  return join(sessionDir(sessionId), SESSION_REPORT);
}
