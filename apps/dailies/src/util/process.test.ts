import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isOnPath,
  mapLimit,
  ProcessError,
  type ProcessOutput,
  run,
} from "./process.js";

const node = process.execPath;
const runNode = (script: string, options?: Parameters<typeof run>[3]) =>
  run(node, ["-e", script], 5000, options);

async function failureOf(
  promise: Promise<ProcessOutput>
): Promise<ProcessError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ProcessError);
    return err as ProcessError;
  }
  throw new Error("Expected the subprocess to fail");
}

describe("run", () => {
  it("gives a command immediate EOF when no stdin was supplied", async () => {
    const result = await runNode(String.raw`
      process.stdin.resume();
      process.stdin.on('end', () => require("node:fs").writeSync(1, 'EOF'));
    `);
    expect(result).toEqual({ stdout: "EOF", stderr: "" });
  });

  it.each([
    "",
    'a JSON request: {"caption":"café 🌍"}\n',
  ])("writes supplied input and closes it, including an empty payload: %j", async (input) => {
    const result = await runNode(
      `
        let input = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => input += chunk);
        process.stdin.on('end', () => {
          require("node:fs").writeSync(1, input);
          require("node:fs").writeSync(2, 'closed');
        });
      `,
      { input }
    );
    expect(result).toEqual({ stdout: input, stderr: "closed" });
  });

  it("preserves UTF-8 characters split across output chunks", async () => {
    const result = await runNode(String.raw`
      const text = Buffer.from('🌍');
      require("node:fs").writeSync(1, text.subarray(0, 1));
      setTimeout(() => require("node:fs").writeSync(1, text.subarray(1)), 20);
    `);
    expect(result.stdout).toBe("🌍");
  });

  it("keeps output and the last stderr lines when a command exits nonzero", async () => {
    const error = await failureOf(
      runNode(String.raw`
      require("node:fs").writeSync(1, 'partial result');
      require("node:fs").writeSync(2, 'first\nsecond\nthird\nfourth\nfifth');
      process.exitCode = 7;
    `)
    );
    expect(error).toMatchObject({
      exitCode: 7,
      reason: "exit",
      stderr: "first\nsecond\nthird\nfourth\nfifth",
      stdout: "partial result",
    });
    expect(error.message).toBe(`${node} failed:\nsecond\nthird\nfourth\nfifth`);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("uses stdout diagnostics when a failing command has no stderr", async () => {
    const error = await failureOf(
      runNode(String.raw`
      require("node:fs").writeSync(1, '{"error":"Not logged in"}');
      process.exitCode = 2;
    `)
    );
    expect(error.message).toContain('failed:\n{"error":"Not logged in"}');
  });

  it("keeps shell syntax literal and supports the original echo callback", async () => {
    const literal = "a' b; $(not-a-command) `not-a-command`";
    const echo = vi.fn();
    const result = await run(
      node,
      ["-e", 'require("node:fs").writeSync(1, process.argv[1])', literal],
      5000,
      echo
    );
    expect(result.stdout).toBe(literal);
    expect(echo).toHaveBeenCalledTimes(1);
    expect(echo.mock.calls[0]?.[0]).toContain("'a'\\'' b;");
  });

  it("enforces independent byte budgets for stdout and stderr", async () => {
    const result = await runNode(
      `
      require("node:fs").writeSync(1, 'abcd');
      require("node:fs").writeSync(2, 'efgh');
    `,
      { maxBuffer: 4 }
    );
    expect(result).toEqual({ stdout: "abcd", stderr: "efgh" });
  });

  it.each([
    "stdout",
    "stderr",
  ] as const)("bounds oversized %s output and waits for the child to exit", async (stream) => {
    const error = await failureOf(
      runNode(
        `
      require('node:fs').writeSync(${stream === "stdout" ? 2 : 1}, String(process.pid));
      require('node:fs').writeSync(${stream === "stdout" ? 1 : 2}, 'x'.repeat(10000));
      setInterval(() => {}, 1000);
    `,
        { maxBuffer: 512 }
      )
    );
    expect(error.reason).toBe("maxBuffer");
    expect(error.message).toContain("output exceeded maxBuffer");
    expect(Buffer.byteLength(error[stream])).toBe(512);
    const pid = Number(error[stream === "stdout" ? "stderr" : "stdout"]);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("reports timeout despite earlier diagnostics and kills the child", async () => {
    const error = await failureOf(
      run(
        node,
        [
          "-e",
          `
      require("node:fs").writeSync(1, String(process.pid));
      require("node:fs").writeSync(2, 'still working');
      setInterval(() => {}, 1000);
    `,
        ],
        500
      )
    );
    expect(error.reason).toBe("timeout");
    expect(error.message).toContain("timed out after 500ms");
    expect(error.message).toContain("still working");
    const pid = Number(error.stdout);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.each([
    0, 9,
  ])("handles a child exiting %d before consuming piped input", async (code) => {
    const promise = runNode(
      `
      require("node:fs").writeSync(2, 'finished early');
      process.exit(${code});
    `,
      { input: "x".repeat(8 * 1024 * 1024) }
    );
    if (code === 0) {
      expect((await promise).stderr).toBe("finished early");
    } else {
      const error = await failureOf(promise);
      expect(error).toMatchObject({ exitCode: code, reason: "exit" });
      expect(error.message).toContain("finished early");
    }
  });

  it("retains the spawn error when the executable is missing", async () => {
    const missing = path.join(tmpdir(), `dailies-missing-${randomUUID()}`);
    const error = await failureOf(run(missing, [], 1000, { input: "request" }));
    expect(error.reason).toBe("spawn");
    expect(error.cause).toMatchObject({ code: "ENOENT" });
    expect(error.message).toContain("ENOENT");
  });
});

describe("isOnPath", () => {
  it("distinguishes callable binaries from a failed probe", async () => {
    expect(await isOnPath(node, ["--version"])).toBe(true);
    expect(await isOnPath(node, ["--not-a-real-node-option"])).toBe(false);
  });
});

describe("mapLimit", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

  it("returns results in INPUT order, not completion order", async () => {
    const out = await mapLimit([30, 20, 10, 0], 4, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:20", "2:10", "3:0"]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
        return n * 2;
      }
    );
    expect(peak).toBe(3);
    expect(out).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  });

  it("runs everything serially at a limit of 1", async () => {
    const order: number[] = [];
    await mapLimit([0, 1, 2], 1, async (n) => {
      order.push(n);
      await tick();
      order.push(n);
      return n;
    });
    // A serial pass never interleaves: each item's start/finish are adjacent.
    expect(order).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it("treats a zero or negative limit as one", async () => {
    await expect(mapLimit([1, 2], 0, async (n) => n)).resolves.toEqual([1, 2]);
    await expect(mapLimit([1, 2], -5, async (n) => n)).resolves.toEqual([1, 2]);
  });

  it("handles an empty list without running anything", async () => {
    let calls = 0;
    const out = await mapLimit([], 4, async () => {
      calls++;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("rethrows the LOWEST-index failure and starts nothing more", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([0, 1, 2, 3, 4, 5, 6, 7], 2, async (n) => {
        started.push(n);
        await tick();
        if (n === 1 || n === 0) {
          throw new Error(`boom ${n}`);
        }
        return n;
      })
    ).rejects.toThrow("boom 0");
    // Both in-flight items ran; nothing past them was scheduled.
    expect(started).toEqual([0, 1]);
  });

  it("lets in-flight work settle before rejecting (no late rejections)", async () => {
    let settled = 0;
    await expect(
      mapLimit([0, 1, 2, 3], 4, async (n) => {
        await new Promise((resolve) => setTimeout(resolve, n * 4));
        settled++;
        if (n === 0) {
          throw new Error("first failed");
        }
        return n;
      })
    ).rejects.toThrow("first failed");
    expect(settled).toBe(4);
  });
});
