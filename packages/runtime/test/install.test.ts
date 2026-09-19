import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installRuntimeDependencies } from "../src/install.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function childProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}

function mockChild(child = childProcess()) {
  vi.mocked(spawn).mockReturnValueOnce(
    child as unknown as ReturnType<typeof spawn>
  );
  return child;
}

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("runtime installation", () => {
  it("runs dependencies before Chromium with inherited terminal output", async () => {
    const first = mockChild();
    const second = mockChild();
    const install = installRuntimeDependencies("/runtime");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      "npm",
      ["install"],
      expect.objectContaining({
        cwd: "/runtime",
        stdio: "inherit",
        windowsHide: true,
      })
    );
    first.emit("close", 0, null);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "npm",
      ["exec", "--", "playwright", "install", "chromium"],
      expect.objectContaining({ cwd: "/runtime", stdio: "inherit" })
    );
    second.emit("close", 0, null);
    await expect(install).resolves.toBeUndefined();
  });

  it("preserves RPC stream order and drains queued output before the next step and completion", async () => {
    const first = mockChild();
    const second = mockChild();
    const chunks: string[] = [];
    let releaseDrain = () => {};
    const drained = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const output = {
      write: (stream: string, data: string) => {
        chunks.push(`${stream}:${data}`);
      },
      drain: vi.fn().mockReturnValue(drained),
    };
    const install = installRuntimeDependencies("/runtime", output);
    expect(spawn).toHaveBeenCalledWith(
      "npm",
      ["install"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] })
    );
    first.stdout.write("one\n");
    first.stderr.write("two\n");
    first.emit("exit", 0, null);
    first.stdout.write("last\n");
    expect(output.drain).not.toHaveBeenCalled();
    first.emit("close", 0, null);
    await vi.waitFor(() => expect(output.drain).toHaveBeenCalledTimes(1));
    expect(chunks).toEqual(["stdout:one\n", "stderr:two\n", "stdout:last\n"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    releaseDrain();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    second.emit("close", 0, null);
    await install;
    expect(output.drain).toHaveBeenCalledTimes(2);
  });

  it.each([
    { code: 7, signal: null, message: "`npm install` failed with exit code 7" },
    {
      code: null,
      signal: "SIGTERM",
      message: "`npm install` terminated by signal",
    },
  ])("stops the CLI install after failure: $message", async ({
    code,
    signal,
    message,
  }) => {
    const child = mockChild();
    const install = installRuntimeDependencies("/runtime");
    const rejected = expect(install).rejects.toThrow(message);
    child.emit("close", code, signal);
    await rejected;
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      code: 7,
      signal: null,
      message: "Playwright install failed with exit code 7",
    },
    {
      code: null,
      signal: "SIGTERM",
      message: "Playwright install terminated by signal SIGTERM",
    },
  ])("keeps RPC failure labels and flushes output: $message", async ({
    code,
    signal,
    message,
  }) => {
    const first = mockChild();
    const second = mockChild();
    const output = {
      write: vi.fn(),
      drain: vi.fn().mockResolvedValue(undefined),
    };
    const install = installRuntimeDependencies("/runtime", output);
    const rejected = expect(install).rejects.toThrow(message);
    first.emit("close", 0, null);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    second.stderr.write("install failed");
    second.emit("close", code, signal);
    await rejected;
    expect(output.write).toHaveBeenCalledWith("stderr", "install failed");
    expect(output.drain).toHaveBeenCalledTimes(2);
  });

  it("gives the CLI's missing-npm remedy and preserves raw RPC spawn errors", async () => {
    const cliChild = mockChild();
    const rpcChild = mockChild();
    const error = Object.assign(new Error("spawn npm ENOENT"), {
      code: "ENOENT",
    });
    const cli = installRuntimeDependencies("/runtime");
    const cliRejected = expect(cli).rejects.toThrow(
      "Could not find `npm` in PATH while setting up the embedded daemon runtime in /runtime. Install Node.js/npm and re-run the install command."
    );
    cliChild.emit("error", error);
    await cliRejected;
    const rpc = installRuntimeDependencies("/runtime", {
      write: vi.fn(),
      drain: vi.fn(),
    });
    const rpcRejected = expect(rpc).rejects.toBe(error);
    rpcChild.emit("error", error);
    await rpcRejected;
  });

  it("reports other CLI spawn errors with the command and runtime directory", async () => {
    const child = mockChild();
    const install = installRuntimeDependencies("/runtime");
    const rejected = expect(install).rejects.toThrow(
      "Failed to run `npm install` in /runtime: denied"
    );
    child.emit("error", new Error("denied"));
    await rejected;
  });

  it("does not start Chromium when the RPC output sink fails", async () => {
    const child = mockChild();
    const error = new Error("socket closed");
    const install = installRuntimeDependencies("/runtime", {
      write: vi.fn(),
      drain: vi.fn().mockRejectedValue(error),
    });
    const rejected = expect(install).rejects.toBe(error);
    child.emit("close", 0, null);
    await rejected;
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    "win32",
    "linux",
  ])("uses a shell only for Windows launchers (%s)", async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(
      platform as NodeJS.Platform
    );
    const child = mockChild();
    const install = installRuntimeDependencies("/runtime");
    const rejected = expect(install).rejects.toThrow();
    expect(spawn).toHaveBeenCalledWith(
      "npm",
      ["install"],
      expect.objectContaining({ shell: platform === "win32" })
    );
    child.emit("close", 1, null);
    await rejected;
  });
});
