import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseDemoRequest } from "./demo-request.js";

const exec = promisify(execFile);
const dirs: string[] = [];
let prepareComment: string;
let prependComment: string;

// Exercise the actual copyable workflow's shell at the boundary with the CLI.
// A pure parser test cannot catch the workflow discarding settings beforehand.
beforeAll(async () => {
  const workflow = await readFile(
    new URL("../../../../.github/workflows/dailies-demo.yml", import.meta.url),
    "utf8"
  );
  const section = (start: string, end: string): string => {
    const from = workflow.indexOf(start);
    const to = workflow.indexOf(end, from);
    if (from < 0 || to < 0) {
      throw new Error(
        "Demo workflow input preparation moved; update this fixture"
      );
    }
    return workflow
      .slice(from, to)
      .replaceAll("/tmp/dailies-pick", "$PICK_DIR");
  };
  prepareComment = section('          ASK=""', "          MATRIX='[]'");
  prependComment = section(
    '            : > /tmp/dailies-pick/"$N".body',
    "            jq -r '.body //"
  );
});

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function prepare(
  comment: string
): Promise<{ body: string; flow: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dailies-workflow-"));
  dirs.push(dir);
  await exec(
    "bash",
    [
      "-euc",
      `${prepareComment}\nN=42\n${prependComment}\nprintf '%s' "$ASK" > "$PICK_DIR/flow.txt"`,
    ],
    {
      env: {
        ...process.env,
        COMMENT_BODY: comment,
        COMMENT_PR: "42",
        EVENT: "issue_comment",
        PICK_DIR: dir,
      },
    }
  );
  return {
    body: await readFile(join(dir, "42.body"), "utf8"),
    flow: await readFile(join(dir, "flow.txt"), "utf8"),
  };
}

describe.skipIf(process.platform === "win32")("demo comment settings", () => {
  it("carries a marker-only request to the decision without turning it into a flow", async () => {
    const { body, flow } = await prepare(
      "/dailies dailies-theme: noir detective"
    );
    expect(parseDemoRequest(`${body}dailies-theme: stale theme`).prompt).toBe(
      "noir detective"
    );
    expect(flow).toBe("");
  });

  it("keeps flow direction separate from target and theme overrides", async () => {
    const { body, flow } = await prepare(
      "/dailies record checkout\ndailies-url: https://preview.example/42\ntheme: silent film"
    );
    const request = parseDemoRequest(body);
    expect(request.target).toBe("https://preview.example/42");
    expect(request.prompt).toBe("silent film");
    expect(flow).toBe("record checkout");
  });

  it("treats shell syntax in a comment as literal data", async () => {
    const theme = "$(printf injected) `printf injected` 'quoted'";
    const { body } = await prepare(`/dailies theme: ${theme}`);
    expect(parseDemoRequest(body).prompt).toBe(theme);
  });
});
