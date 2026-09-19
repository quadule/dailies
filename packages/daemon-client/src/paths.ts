// biome-ignore lint/performance/noBarrelFile: Retain the daemon-client path API without maintaining another filesystem layout.
export {
  daemonBundlePath,
  daemonEndpoint,
  daemonPidPath,
  daemonSocketPath,
  daemonStderrLogPath,
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
} from "dailies-runtime/paths";
