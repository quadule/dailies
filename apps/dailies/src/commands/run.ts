import { requestId } from "dailies-cli-kit";
import { ensureDaemonRunning, sendRequest } from "dailies-daemon-client";
import type { ExecuteRequest } from "dailies-protocol";
import { withSessionLock } from "../session/lock.js";
import { readSessionRecord, writeSessionRecord } from "../session/registry.js";
import { resultRenderer } from "./render.js";
import { readScript } from "./script-input.js";

// Enough of a step's error to say why it failed — Playwright's call log after
// the first lines is mostly repetition.
const STEP_ERROR_CHARS = 600;

// Playwright colors its call log for a terminal; the record is read as text.
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stepError(message: string): string {
  return message.replace(ANSI_ESCAPE, "").trim().slice(0, STEP_ERROR_CHARS);
}

// Passes the script's stdout through while counting it. Everything a step or
// peek prints is read back by the agent that ran it, so the count is what that
// output cost in context — the number that tells a 2k-char step from one that
// dumped a 100k-char snapshot.
export function countingStdout(target: NodeJS.WritableStream): {
  chars: () => number;
  stream: NodeJS.WritableStream;
} {
  let chars = 0;
  const stream = {
    write(chunk: string | Uint8Array, ...rest: unknown[]): boolean {
      chars +=
        typeof chunk === "string"
          ? chunk.length
          : Buffer.from(chunk).toString("utf8").length;
      return (target.write as (...args: unknown[]) => boolean)(chunk, ...rest);
    },
  } as NodeJS.WritableStream;
  return { chars: () => chars, stream };
}

interface RunArgs {
  file?: string;
  json: boolean;
  // Read the live page without recording a step (see `run --peek`).
  peek?: boolean;
  script?: string;
  sessionId: string;
  skim?: boolean;
  step?: string;
  timeoutMs?: number;
}

export async function runInSession(args: RunArgs): Promise<number> {
  // Fail fast (outside the lock) on an unknown/inactive session and load the
  // script before we serialize on the session.
  const pre = await readSessionRecord(args.sessionId);
  if (pre.status !== "active") {
    process.stderr.write(
      `Session "${args.sessionId}" is ${pre.status}; cannot run new steps.\n`
    );
    return 1;
  }

  if (args.peek && (args.step !== undefined || args.skim)) {
    process.stderr.write(
      "--peek records no step, so it takes no --step or --skim.\n"
    );
    return 2;
  }

  const scriptText = await readScript(args);
  if (scriptText === undefined) {
    return 2;
  }

  // Make sure a daemon is up before we serialize on the session. If it had been
  // stopped/crashed, ensureDaemonRunning starts a fresh one that no longer knows
  // this session, so the execute below is rejected with "No active session" and
  // the reconcile path below marks the record aborted — instead of surfacing a
  // raw ECONNREFUSED and leaving a zombie "active" record behind.
  await ensureDaemonRunning();

  // Hold the session lock across the whole run so the step index / screenshot
  // slug and the step append can't race a concurrent `dailies run` on the same
  // session (the daemon already serializes them per browser).
  return withSessionLock(args.sessionId, async () => {
    const record = await readSessionRecord(args.sessionId);
    if (record.status !== "active") {
      process.stderr.write(
        `Session "${args.sessionId}" is ${record.status}; cannot run new steps.\n`
      );
      return 1;
    }

    const stepName = args.step ?? `step-${record.steps.length + 1}`;
    const startedAt = Date.now();
    // A peek sends no step name, so the daemon skips the trace group, the
    // settle and the screenshot, and runs the script read-only.
    const request: ExecuteRequest = {
      id: requestId("execute"),
      type: "execute",
      browser: record.browser,
      script: scriptText,
      ...(args.peek ? { readOnly: true } : { step: stepName }),
    };
    if (args.timeoutMs !== undefined) {
      request.timeoutMs = args.timeoutMs;
    }

    // Capture the daemon's terminal error message separately from the script's
    // own stderr (both would otherwise merge into one stream), so the
    // session-loss check below can't be spoofed by a script that prints
    // "No active session" to stderr and then fails.
    let daemonError = "";
    const stdout = countingStdout(process.stdout);
    const code = await sendRequest(
      request,
      resultRenderer(args.json),
      stdout.stream,
      process.stderr,
      (message) => {
        daemonError = message;
      }
    );

    // The daemon lost the session (e.g. it restarted). Reconcile the record and
    // do NOT record a phantom step — no script actually ran.
    if (code !== 0 && daemonError.includes("No active session")) {
      record.status = "aborted";
      record.endedAt = new Date().toISOString();
      await writeSessionRecord(record);
      process.stderr.write(
        `Session "${args.sessionId}" is no longer active on the daemon; marked aborted.\n`
      );
      return 1;
    }
    if (args.peek) {
      // A peek records no step, but what it printed was still read: keep a
      // running total so the session's output cost includes its looks.
      const peeks = record.peeks ?? { count: 0, outputChars: 0 };
      record.peeks = {
        count: peeks.count + 1,
        outputChars: peeks.outputChars + stdout.chars(),
      };
      await writeSessionRecord(record);
      return code;
    }

    record.steps.push({
      durationMs: Date.now() - startedAt,
      exitCode: code,
      ...(code !== 0 && daemonError ? { error: stepError(daemonError) } : {}),
      name: stepName,
      ok: code === 0,
      outputChars: stdout.chars(),
      script: scriptText,
      ...(args.skim ? { skim: true } : {}),
      startedAt: new Date(startedAt).toISOString(),
    });
    await writeSessionRecord(record);
    return code;
  });
}
