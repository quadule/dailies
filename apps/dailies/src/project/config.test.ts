import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isWorthDemoing,
  loadProject,
  PROJECT_DIR,
  parseProjectConfig,
} from "./config.js";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dailies-project-"));
  await mkdir(path.join(dir, PROJECT_DIR), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dir, PROJECT_DIR, name), body);
  }
  return dir;
}

describe("parseProjectConfig", () => {
  it("reads url, demo paths, prompt and the mode", () => {
    const cfg = parseProjectConfig({
      demo: {
        mode: "song",
        paths: ["app/views/**", "app/components/**"],
        prompt: "1970s heist film",
      },
      url: "http://localhost:3000",
    });
    expect(cfg.url).toBe("http://localhost:3000");
    expect(cfg.demo.paths).toEqual(["app/views/**", "app/components/**"]);
    expect(cfg.demo.prompt).toBe("1970s heist film");
    expect(cfg.demo.mode).toBe("song");
  });

  it("leaves the mode unset so the agent picks, rather than defaulting", () => {
    expect(parseProjectConfig({}).demo.mode).toBeNull();
    expect(parseProjectConfig({ demo: {} }).demo.mode).toBeNull();
  });

  it("ignores an unrecognized mode rather than pinning one", () => {
    expect(parseProjectConfig({ demo: { mode: "epic" } }).demo.mode).toBeNull();
  });

  it("falls back to defaults for junk rather than throwing", () => {
    // A config typo must never be able to stop someone recording a session.
    for (const junk of [null, undefined, 42, "nope", [], { demo: "nope" }]) {
      const cfg = parseProjectConfig(junk);
      expect(cfg.url).toBeNull();
      expect(cfg.demo.paths).toEqual([]);
      expect(cfg.demo.prompt).toBeNull();
    }
    expect(
      parseProjectConfig({ demo: { paths: [1, "ok", null, "  "] } }).demo.paths
    ).toEqual(["ok"]);
    expect(parseProjectConfig({ url: "   " }).url).toBeNull();
  });
});

describe("isWorthDemoing", () => {
  it("demos any change when no paths are configured", () => {
    const verdict = isWorthDemoing(["README.md"], []);
    expect(verdict.worth).toBe(true);
    expect(verdict.reason).toContain("no demo.paths configured");
  });

  it("skips when nothing changed", () => {
    expect(isWorthDemoing([], []).worth).toBe(false);
    expect(isWorthDemoing(["", "  "], ["**"]).worth).toBe(false);
  });

  it("matches ** across any depth, including none", () => {
    const patterns = ["app/views/**/*.erb"];
    expect(isWorthDemoing(["app/views/show.erb"], patterns).worth).toBe(true);
    expect(isWorthDemoing(["app/views/a/b/show.erb"], patterns).worth).toBe(
      true
    );
    expect(isWorthDemoing(["app/models/user.rb"], patterns).worth).toBe(false);
  });

  it("treats a trailing slash as the whole subtree", () => {
    const patterns = ["app/components/"];
    expect(isWorthDemoing(["app/components/button.rb"], patterns).worth).toBe(
      true
    );
    expect(
      isWorthDemoing(["app/components/deep/nested.rb"], patterns).worth
    ).toBe(true);
    expect(isWorthDemoing(["app/componentsX/other.rb"], patterns).worth).toBe(
      false
    );
  });

  it("keeps * from crossing path separators", () => {
    expect(isWorthDemoing(["app/x.rb"], ["app/*.rb"]).worth).toBe(true);
    expect(isWorthDemoing(["app/deep/x.rb"], ["app/*.rb"]).worth).toBe(false);
  });

  it("does not treat dots or plus signs as regex metacharacters", () => {
    expect(isWorthDemoing(["app/a.rb"], ["app/a.rb"]).worth).toBe(true);
    // `.` is literal, so it must not match an arbitrary character.
    expect(isWorthDemoing(["app/axrb"], ["app/a.rb"]).worth).toBe(false);
    expect(isWorthDemoing(["c++/x"], ["c++/*"]).worth).toBe(true);
  });

  it("ignores a leading ./ on either side", () => {
    expect(isWorthDemoing(["./app/views/a.erb"], ["app/views/**"]).worth).toBe(
      true
    );
    expect(isWorthDemoing(["app/views/a.erb"], ["./app/views/**"]).worth).toBe(
      true
    );
  });

  it("names the matching files in its reason, capped", () => {
    const changed = ["a.erb", "b.erb", "c.erb", "d.erb"];
    const verdict = isWorthDemoing(changed, ["*.erb"]);
    expect(verdict.reason).toContain("4 user-facing file(s)");
    expect(verdict.reason).toContain("…");
  });

  it("explains a skip in terms of the configured paths", () => {
    const verdict = isWorthDemoing(["docs/x.md"], ["app/**"]);
    expect(verdict.worth).toBe(false);
    expect(verdict.reason).toContain("match demo.paths");
  });
});

describe("loadProject", () => {
  it("finds .dailies/ by walking up from a subdirectory", async () => {
    const dir = await project({
      "config.json": '{"url":"http://localhost:4000"}',
    });
    const nested = path.join(dir, "a", "b");
    await mkdir(nested, { recursive: true });

    const loaded = await loadProject(nested);

    expect(loaded.root).toBe(path.join(dir, PROJECT_DIR));
    expect(loaded.config.url).toBe("http://localhost:4000");
  });

  it("reports flows.md and its line count", async () => {
    const dir = await project({ "flows.md": "# Flows\nline two\nline three" });
    const loaded = await loadProject(dir);
    expect(loaded.flowsPath).toBe(path.join(dir, PROJECT_DIR, "flows.md"));
    expect(loaded.flowsLines).toBe(3);
  });

  it("returns defaults when there is no .dailies directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dailies-bare-"));
    const loaded = await loadProject(dir);
    expect(loaded.root).toBeNull();
    expect(loaded.flowsPath).toBeNull();
    expect(loaded.config.demo.mode).toBeNull();
  });

  it("survives malformed config.json with defaults", async () => {
    const dir = await project({ "config.json": "{ not json" });
    const loaded = await loadProject(dir);
    expect(loaded.root).not.toBeNull();
    expect(loaded.config.url).toBeNull();
    expect(loaded.config.demo.mode).toBeNull();
  });

  it("reports a config with no flows file, and vice versa", async () => {
    const onlyConfig = await loadProject(
      await project({ "config.json": '{"url":"http://x"}' })
    );
    expect(onlyConfig.flowsPath).toBeNull();
    expect(onlyConfig.config.url).toBe("http://x");

    const onlyFlows = await loadProject(await project({ "flows.md": "# hi" }));
    expect(onlyFlows.flowsPath).not.toBeNull();
    expect(onlyFlows.config.url).toBeNull();
  });
});
