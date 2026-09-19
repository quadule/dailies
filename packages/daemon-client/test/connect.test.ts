import { Socket } from "node:net";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  type DaemonConnection,
  DaemonConnectionClosed,
  streamResponses,
} from "../src/ipc/connect.js";

function connection(lines: string[]): DaemonConnection {
  return {
    socket: new Socket(),
    reader: (async function* () {
      for (const line of lines) {
        yield line;
      }
    })(),
  };
}

function capture() {
  const chunks: string[] = [];
  return {
    chunks,
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }),
  };
}

describe("daemon response streaming", () => {
  it("routes output and results until completion, then closes the connection", async () => {
    const conn = connection(
      [
        { type: "stdout", data: "hello" },
        { type: "stderr", data: "warning" },
        { type: "future-message", data: "ignored" },
        { type: "result", data: { value: 3 } },
        { type: "complete", success: true },
        { type: "stdout", data: "after completion" },
      ].map((message) => JSON.stringify({ id: "test", ...message }))
    );
    const stdout = capture();
    const stderr = capture();
    const code = await streamResponses(conn, {
      stdout: stdout.stream,
      stderr: stderr.stream,
      renderResult: (data, output) => output.write(JSON.stringify(data)),
    });
    expect(code).toBe(0);
    expect(stdout.chunks).toEqual(["hello", '{"value":3}']);
    expect(stderr.chunks).toEqual(["warning"]);
    expect(conn.socket.destroyed).toBe(true);
  });

  it("reports a terminal error separately from script stderr", async () => {
    const conn = connection(
      [
        { type: "stderr", data: "script warning" },
        { type: "error", message: "browser disconnected" },
      ].map((message) => JSON.stringify({ id: "test", ...message }))
    );
    const stderr = capture();
    const onError = vi.fn();
    expect(
      await streamResponses(conn, {
        stdout: capture().stream,
        stderr: stderr.stream,
        onError,
      })
    ).toBe(1);
    expect(stderr.chunks).toEqual(["script warning", "browser disconnected\n"]);
    expect(onError).toHaveBeenCalledExactlyOnceWith("browser disconnected");
    expect(conn.socket.destroyed).toBe(true);
  });

  it.each([
    [[], DaemonConnectionClosed],
    [
      [JSON.stringify({ id: "test", type: "stdout", data: "partial" })],
      DaemonConnectionClosed,
    ],
    [["not json"], /malformed response from daemon/],
  ])(
    "rejects incomplete or malformed streams and closes the connection",
    async (lines, expected) => {
      const conn = connection(lines);
      await expect(
        streamResponses(conn, {
          stdout: capture().stream,
          stderr: capture().stream,
        })
      ).rejects.toThrow(expected);
      expect(conn.socket.destroyed).toBe(true);
    }
  );
});
