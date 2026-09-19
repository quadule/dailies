// dailies-daemon-client — shared daemon transport, endpoint/paths resolution,
// and daemon lifecycle/extract. Consumed by the `dailies` CLI to drive the
// daemon and embed its bundle.

export type { BrowserSummary, StatusSummary } from "dailies-protocol";
export { npmCommand } from "dailies-runtime/install";
export { findDaemonCommand } from "./daemon/entry.js";
export {
  embeddedRuntimeInstalled,
  ensureDaemonExtracted,
} from "./daemon/extract.js";
export { installDaemonRuntime } from "./daemon/install.js";
export {
  currentDaemonPid,
  ensureDaemonRunning,
  waitForDaemonExit,
} from "./daemon/lifecycle.js";
export { type DaemonCommand, spawnDaemon } from "./daemon/spawn.js";
export {
  connectToDaemon,
  type DaemonConnection,
  DaemonConnectionClosed,
  isDaemonRunning,
  type ResultRenderer,
  type StreamHandlers,
  sendMessage,
  sendRequest,
  streamResponses,
} from "./ipc/connect.js";
export { daemonPipeName, sanitizePipeSegment } from "./ipc/pipename.js";
export {
  daemonBundlePath,
  daemonEndpoint,
  daemonPidPath,
  daemonSocketPath,
  dailiesDir,
  home,
  packageJsonPath,
  sandboxClientPath,
  sessionDir,
  sessionManifestPath,
  sessionRecordPath,
  sessionReportPath,
  sessionResultsPath,
  sessionsRootDir,
  tmpDir,
} from "./paths.js";
