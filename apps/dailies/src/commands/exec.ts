import { readFile } from "node:fs/promises";
import { requestId } from "dailies-cli-kit";
import { ensureDaemonRunning, sendRequest } from "dailies-daemon-client";
import type { ExecuteRequest } from "dailies-protocol";
import { readInjectScripts } from "../inject-scripts.js";
import { renderJsonResult } from "./render.js";

// One-off, UNRECORDED script execution — the counterpart to `dailies run`,
// which requires a session and records the script as a step (trace/video/HAR/
// console). Keeping these as separate subcommands rather than one command with
// an optional --session is deliberate: a forgotten flag would otherwise turn a
// step you meant to record into a silent no-op that never reaches the report.
export interface ExecArgs {
  browser: string;
  connect?: string;
  file?: string;
  headless: boolean;
  ignoreHttpsErrors: boolean;
  injectScriptPaths: readonly string[];
  json: boolean;
  script?: string;
  timeoutMs: number;
}

export async function execScript(args: ExecArgs): Promise<number> {
  let script = args.script;
  if (script === undefined && args.file) {
    try {
      script = await readFile(args.file, "utf8");
    } catch (err) {
      // Normalize ENOENT to the canonical message the daemon/tests expect.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("No such file or directory (os error 2)");
      }
      throw err;
    }
  }
  if (script === undefined || script.trim() === "") {
    process.stderr.write("No script provided (pass a FILE or pipe stdin)\n");
    return 2;
  }

  await ensureDaemonRunning();

  const initScripts = await readInjectScripts(
    args.injectScriptPaths,
    process.cwd()
  );

  const request: ExecuteRequest = {
    id: requestId("execute"),
    type: "execute",
    browser: args.browser,
    script,
    timeoutMs: args.timeoutMs,
  };
  if (args.headless) {
    request.headless = true;
  }
  if (args.ignoreHttpsErrors) {
    request.ignoreHTTPSErrors = true;
  }
  if (args.connect !== undefined) {
    request.connect = args.connect;
  }
  if (initScripts.length > 0) {
    request.initScripts = initScripts;
  }

  return sendRequest(request, renderJsonResult);
}
