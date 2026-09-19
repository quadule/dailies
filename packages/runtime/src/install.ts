import { spawn } from "node:child_process";

export interface InstallOutput {
  drain(): Promise<void>;
  write(stream: "stdout" | "stderr", data: string): void;
}

// npm is a .cmd launcher on Windows. The shared runner uses a shell there so
// both installation entry points work with Node's Windows process spawning.
export function npmCommand(): string {
  return "npm";
}

// Extraction/package.json preparation belongs to the caller: the CLI extracts
// its embedded bundle, while the legacy RPC installs for the running daemon.
// With no output sink, npm inherits the CLI's terminal. The RPC supplies a
// queued sink, which must drain before another step or a completion message.
export async function installRuntimeDependencies(
  cwd: string,
  output?: InstallOutput
): Promise<void> {
  await runInstall(["install"], "npm install", cwd, output);
  await runInstall(
    ["exec", "--", "playwright", "install", "chromium"],
    "Playwright install",
    cwd,
    output
  );
}

async function runInstall(
  args: string[],
  label: string,
  cwd: string,
  output?: InstallOutput
): Promise<void> {
  const program = npmCommand();
  const command = `${program} ${args.join(" ")}`;
  const child = spawn(program, args, {
    cwd,
    env: process.env,
    stdio: output ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
    shell: process.platform === "win32",
  });

  if (output) {
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]?.setEncoding("utf8");
      child[stream]?.on("data", (data: string) => output.write(stream, data));
    }
  }

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (output) {
        reject(error);
      } else {
        const message =
          error.code === "ENOENT"
            ? `Could not find \`${program}\` in PATH while setting up the embedded daemon runtime in ${cwd}. Install Node.js/npm and re-run the install command.`
            : `Failed to run \`${command}\` in ${cwd}: ${error.message}`;
        reject(new Error(message));
      }
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await output?.drain();
  if (code === 0) {
    return;
  }

  // Preserve the public CLI remedies and the legacy RPC's step labels.
  if (output) {
    throw new Error(
      signal === null
        ? `${label} failed with exit code ${code ?? "unknown"}`
        : `${label} terminated by signal ${signal}`
    );
  }
  throw new Error(
    signal
      ? `\`${command}\` terminated by signal`
      : `\`${command}\` failed with exit code ${code ?? "?"}`
  );
}
