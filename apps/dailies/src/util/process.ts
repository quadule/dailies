import { spawn } from "node:child_process";
import { formatCommand } from "./shell.js";

export const VERSION_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export type Echo = (line: string) => void;

export interface RunOptions {
  echo?: Echo;
  // Omitted input gives the child immediate EOF. Supplied input is written in
  // full and then closed, including when it is an explicitly empty string.
  input?: string | Uint8Array;
  // Limit each output stream independently, in bytes rather than characters.
  maxBuffer?: number;
}

export interface ProcessOutput {
  stderr: string;
  stdout: string;
}

type FailureReason = "exit" | "spawn" | "stdin" | "timeout" | "maxBuffer";

interface Failure {
  cause: Error;
  exitCode?: number | null;
  reason: FailureReason;
  signal?: NodeJS.Signals | null;
}

// Keep output available for probes that print useful data before a nonzero
// exit, and retain the original error for callers that need its system code.
export class ProcessError extends Error implements ProcessOutput {
  readonly exitCode?: number | null;
  readonly reason: FailureReason;
  readonly signal?: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(cmd: string, output: ProcessOutput, failure: Failure) {
    const source = output.stderr.trim() || output.stdout.trim();
    const tail = source.split("\n").slice(-4).join("\n");
    // Preserve the familiar command + diagnostic tail for nonzero exits.
    // Timeout/overflow reasons must remain visible even if the child logged.
    const reason = failure.reason === "exit" ? "" : failure.cause.message;
    let message = `${cmd} failed${reason ? `: ${reason}` : ""}`;
    if (tail) {
      message += `:\n${tail}`;
    } else if (!reason) {
      message += `: ${failure.cause.message}`;
    }
    super(message, { cause: failure.cause });
    this.name = "ProcessError";
    this.reason = failure.reason;
    this.exitCode = failure.exitCode;
    this.signal = failure.signal;
    this.stdout = output.stdout;
    this.stderr = output.stderr;
  }
}

// Decode only after all chunks arrive: UTF-8 characters can span pipe chunks.
function outputBuffer(maxBytes: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    append(chunk: Buffer): boolean {
      const remaining = maxBytes - bytes;
      chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.length, remaining);
      return chunk.length <= remaining;
    },
    text: () => Buffer.concat(chunks, bytes).toString("utf8"),
  };
}

// Execute without a shell. The legacy fourth-argument echo callback remains
// supported; options add piped input without introducing a second runner.
export async function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
  echoOrOptions?: Echo | RunOptions
): Promise<ProcessOutput> {
  const options =
    typeof echoOrOptions === "function"
      ? { echo: echoOrOptions }
      : (echoOrOptions ?? {});
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 0) {
    throw new RangeError("maxBuffer must be a non-negative integer");
  }
  options.echo?.(`$ ${formatCommand(cmd, args)}`);
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = outputBuffer(maxBuffer);
    const stderr = outputBuffer(maxBuffer);
    let settled = false;
    let pendingFailure: Failure | undefined;

    const finish = (failure?: Failure) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      const output = { stdout: stdout.text(), stderr: stderr.text() };
      if (failure) {
        reject(new ProcessError(cmd, output, failure));
      } else {
        resolve(output);
      }
    };
    const terminate = (failure: Failure) => {
      if (settled || pendingFailure) {
        return;
      }
      pendingFailure = failure;
      child.kill("SIGKILL");
      // Close the pipes, but settle only after the child's close event. Callers
      // may remove temporary files immediately after rejection; the child must
      // have exited before they do. Closing our pipe ends also avoids waiting on
      // descendants that inherited a pipe after the direct child was killed.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(
      () =>
        terminate({
          cause: new Error(`timed out after ${timeoutMs}ms`),
          reason: "timeout",
        }),
      timeoutMs
    );
    const capture = (
      buffer: ReturnType<typeof outputBuffer>,
      chunk: Buffer
    ) => {
      if (!(settled || pendingFailure || buffer.append(chunk))) {
        terminate({
          cause: new Error("output exceeded maxBuffer"),
          reason: "maxBuffer",
        });
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (cause) => finish({ cause, reason: "spawn" }));
    child.on("close", (exitCode, signal) => {
      if (pendingFailure) {
        finish(pendingFailure);
        return;
      }
      finish(
        exitCode === 0
          ? undefined
          : {
              cause: new Error(`Command failed: ${cmd}`),
              exitCode,
              reason: "exit",
              signal,
            }
      );
    });
    child.stdin?.on("error", (cause: NodeJS.ErrnoException) => {
      // A short-lived child may close stdin before our write completes. Its
      // exit/output is the useful result; EPIPE must not crash the parent.
      if (cause.code !== "EPIPE" && cause.code !== "ERR_STREAM_DESTROYED") {
        terminate({ cause, reason: "stdin" });
      }
    });
    child.stdin?.end(options.input);
  });
}

// Run `task` over every item with at most `limit` of them in flight, returning
// the results in INPUT order (not completion order) so a caller can keep its
// arrays in lockstep. Used to overlap independent subprocess work — the spawns
// are the slow part and they don't depend on each other.
//
// On a rejection: no further items are started, the in-flight ones are allowed to
// settle (so nothing rejects after this resolves), and the LOWEST-index failure is
// rethrown — deterministic regardless of which one landed first, so a caller that
// lets errors through fails the same way a serial loop would.
// Pure control flow → unit-tested.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const errors = new Map<number, unknown>();
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && errors.size === 0) {
      const index = next;
      next++;
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      try {
        results[index] = await task(item, index);
      } catch (err) {
        errors.set(index, err);
      }
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  if (errors.size > 0) {
    throw errors.get(Math.min(...errors.keys()));
  }
  return results;
}

// Is a binary callable on PATH? Best-effort probe used for preconditions.
export async function isOnPath(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args, VERSION_PROBE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}
