import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { CLI_PATH, runCli } from "../helpers/run-cli.js";

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      "dist/cli.js missing — run `pnpm build` before `pnpm test`"
    );
  }
});

// `dailies --help` stays scannable: lifecycle, the compact sandbox + `browser.*`
// API quick-reference, and the session workflow guide render at the top level,
// but the long scripting guide (observe-first/interaction rules, worked
// examples, Playwright methods) lives on `dailies run --help` — at the point of
// need — reached via a same-CLI pointer (never the separately-installed
// removed `dailies-browser` binary, and no engine-only flags leaking in).
describe("--help content", () => {
  it("root --help: lifecycle, compact API, workflow guide, pointer to run", async () => {
    const out = await runCli(["--help"]);
    expect(out.code).toBe(0);

    // Session orchestration framing.
    expect(out.stdout).toContain("THE SESSION LIFECYCLE:");
    expect(out.stdout).toContain("WHAT IS CAPTURED");

    // The compact sandbox + script API quick-reference stays inline.
    expect(out.stdout).toContain("SANDBOX ENVIRONMENT:");
    expect(out.stdout).toContain("This is NOT Node.js");
    expect(out.stdout).toContain("Script API available inside every script:");
    expect(out.stdout).toContain("browser.getPage(nameOrId)");
    expect(out.stdout).toContain("https://playwright.dev/docs/api/class-page");

    // The session workflow guide stays; the long scripting guide does not —
    // it moved to `dailies run --help`, reached via a pointer.
    expect(out.stdout).toContain("SESSION WORKFLOW GUIDE:");
    expect(out.stdout).toContain("dailies run --help");
    expect(out.stdout).not.toContain("SCRIPTING GUIDE:");
    expect(out.stdout).not.toContain("Common Playwright Page methods:");

    for (const sub of [
      "session",
      "run",
      "status",
      "ui",
      "install",
      "init",
      "stop",
      "daemon",
    ]) {
      expect(out.stdout).toContain(sub);
    }
  });

  it("root --help has no dead-end pointer and no engine-only flags", async () => {
    const out = await runCli(["--help"]);
    expect(out.code).toBe(0);

    // The old indirection ("see `dailies-browser --help` for the full
    // reference") must be gone — that CLI no longer exists; one-offs are
    // `dailies exec`, whose guide is served from this same binary.
    expect(out.stdout).not.toContain("see `dailies-browser --help`");
    expect(out.stdout).not.toContain("dailies-browser --help");

    // Engine-only material must not leak into the orchestrator's help.
    expect(out.stdout).not.toContain("--connect");
    expect(out.stdout).not.toContain("--browser ");
    expect(out.stdout).not.toContain("Connecting to a running Chrome instance");
  });

  it("`run --help` carries the full scripting reference and step semantics", async () => {
    const out = await runCli(["run", "--help"]);
    expect(out.code).toBe(0);

    // Step semantics.
    expect(out.stdout).toContain("Run a script as one step inside a session");
    expect(out.stdout).toContain("auto-captured screenshot");
    expect(out.stdout).toContain("persist across steps");

    // The full sandbox + script API reference, at the point of need.
    expect(out.stdout).toContain("SANDBOX ENVIRONMENT:");
    expect(out.stdout).toContain("browser.getPage(nameOrId)");
    expect(out.stdout).toContain("browser.newPage()");
    expect(out.stdout).toContain("browser.listPages()");
    expect(out.stdout).toContain("browser.closePage(name)");
    expect(out.stdout).toContain("saveScreenshot");
    expect(out.stdout).toContain("writeFile");
    expect(out.stdout).toContain("readFile");
    expect(out.stdout).toContain("https://playwright.dev/docs/api/class-page");

    // The full scripting guide now lives here (moved off the top-level help):
    // discovery, methods table, and examples in dailies's own invocation style.
    expect(out.stdout).toContain("SCRIPTING GUIDE:");
    expect(out.stdout).toContain("snapshotForAI");
    expect(out.stdout).toContain("Common Playwright Page methods:");
    expect(out.stdout).toContain('dailies run --session "$id" --step');

    // Own options documented.
    expect(out.stdout).toContain("--session");
    expect(out.stdout).toContain("--step");
    expect(out.stdout).toContain("--timeout");

    // Self-contained: no reference to the engine CLI at all.
    expect(out.stdout).not.toContain("dailies-browser");
    expect(out.stdout).not.toContain("--connect");
  });
});
