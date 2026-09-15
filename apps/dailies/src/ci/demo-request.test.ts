import { describe, expect, it } from "vitest";
import { EMPTY_CONFIG, parseProjectConfig } from "../project/config.js";
import {
  buildDecisionPrompt,
  decideDemo,
  decideDemoWithAgent,
  demoedShas,
  isAlreadyDemoed,
  parseDecision,
  parseDemoRequest,
  previousMetrics,
  targetFromComments,
} from "./demo-request.js";

// The real shape: a Buildkite pr-commenter bot posts the review-app URL with its
// own HTML marker once the deploy succeeds.
const DEPLOY_COMMENT =
  "## Review App Deployment\nYour PR was deployed successfully to https://wrapbook-dev-pr-64365.wrapbook.reviews\n\n<!-- review-app-deploy::pr-commenter-buildkite-plugin -->";
const TARGET_COMMENT = {
  marker: "review-app-deploy::pr-commenter-buildkite-plugin",
  pattern: "https://[a-z0-9-]+\\.wrapbook\\.reviews",
};

describe("targetFromComments", () => {
  it("reads the URL out of a marked deploy comment", () => {
    expect(targetFromComments([DEPLOY_COMMENT], TARGET_COMMENT)).toBe(
      "https://wrapbook-dev-pr-64365.wrapbook.reviews"
    );
  });

  it("ignores a human saying the deploy failed", () => {
    // A reviewer writing "the review app failed deployment" must not be mistaken
    // for the bot's success comment — only the marker counts.
    const human = "the review app failed deployment, I'll review when it's up";
    expect(targetFromComments([human], TARGET_COMMENT)).toBeNull();
  });

  it("prefers the most recent deploy, so a redeploy wins", () => {
    const older = DEPLOY_COMMENT.replace("64365", "11111");
    expect(targetFromComments([older, DEPLOY_COMMENT], TARGET_COMMENT)).toBe(
      "https://wrapbook-dev-pr-64365.wrapbook.reviews"
    );
  });

  it("refuses a non-https match even inside a marked comment", () => {
    const sneaky =
      "http://evil.wrapbook.reviews\n<!-- review-app-deploy::pr-commenter-buildkite-plugin -->";
    expect(
      targetFromComments([sneaky], {
        marker: TARGET_COMMENT.marker,
        pattern: "https?://[a-z0-9.-]+",
      })
    ).toBeNull();
  });

  it("is off unless configured", () => {
    expect(targetFromComments([DEPLOY_COMMENT], null)).toBeNull();
  });
});

describe("parseDemoRequest", () => {
  it("leaves the mode unset with a random theme and the first URL", () => {
    const r = parseDemoRequest(
      "Adds login. Try it at https://staging.example.com/login please."
    );
    expect(r.target).toBe("https://staging.example.com/login");
    expect(r.mode).toBeNull();
    expect(r.prompt).toBeNull();
  });

  it("prefers an explicit target marker over a stray URL", () => {
    const r = parseDemoRequest(
      "See https://github.com/x/y for context.\ndailies-url: https://app.test/dash"
    );
    expect(r.target).toBe("https://app.test/dash");
  });

  it("reads a theme/prompt marker", () => {
    expect(
      parseDemoRequest(
        "Demo target: https://a.test\ndailies-theme: 1970s heist film, as a limerick"
      ).prompt
    ).toBe("1970s heist film, as a limerick");
    expect(
      parseDemoRequest("Theme: noir\nDemo URL: https://a.test").prompt
    ).toBe("noir");
  });

  it("reads a plain-demo request as the plain mode", () => {
    expect(parseDemoRequest("https://a.test — plain demo please").mode).toBe(
      "plain"
    );
    expect(parseDemoRequest("https://a.test\nno narration").mode).toBe("plain");
  });

  it("accepts a local .html path target (static local demo)", () => {
    expect(parseDemoRequest("dailies-url: demo/index.html").target).toBe(
      "demo/index.html"
    );
    expect(
      parseDemoRequest("Try fixtures/checkout.html in the repo").target
    ).toBe("fixtures/checkout.html");
  });

  it("accepts a file:// URL target", () => {
    expect(parseDemoRequest("dailies-url: file:///tmp/demo.html").target).toBe(
      "file:///tmp/demo.html"
    );
  });

  it("returns a null target when the body has no URL or html path", () => {
    const r = parseDemoRequest("Just refactors internals, no UI.");
    expect(r.target).toBeNull();
    expect(r.mode).toBeNull();
  });

  it("strips wrapping/trailing punctuation from a URL", () => {
    expect(parseDemoRequest("open (https://a.test/x).").target).toBe(
      "https://a.test/x"
    );
  });

  it("handles an empty body", () => {
    expect(parseDemoRequest("")).toEqual({
      target: null,
      targetIsExplicit: false,
      mode: null,
      prompt: null,
    });
  });
});

describe("decideDemo", () => {
  const config = parseProjectConfig({
    demo: { paths: ["app/views/**"], prompt: "repo default theme" },
    url: "http://localhost:3000",
  });

  it("falls back to the repo default target and theme", () => {
    const d = decideDemo({
      body: "Adds a field.",
      changedPaths: ["app/views/a.erb"],
      config,
    });
    expect(d.run).toBe(true);
    expect(d.target).toBe("http://localhost:3000");
    expect(d.prompt).toBe("repo default theme");
    expect(d.mode).toBe("cinematic");
  });

  it("lets the PR body override the target and theme", () => {
    const d = decideDemo({
      body: "dailies-url: https://pr-1.review.app\ndailies-theme: noir",
      changedPaths: ["app/views/a.erb"],
      config,
    });
    expect(d.target).toBe("https://pr-1.review.app");
    expect(d.prompt).toBe("noir");
  });

  it("keeps the repo default when the body only mentions a URL in prose", () => {
    // Every real PR description opens with a ticket link. Scavenging it as the
    // demo target pointed CI at the tracker instead of the app.
    const d = decideDemo({
      body: "## Description\n[APA-3002](https://linear.app/wrapbook/issue/APA-3002)\n\nAdds a card.",
      changedPaths: ["app/views/a.erb"],
      config,
    });
    expect(d.target).toBe("http://localhost:3000");
  });

  it("still scavenges a body URL when the repo has no configured target", () => {
    const noUrl = parseProjectConfig({ demo: { paths: ["app/views/**"] } });
    const d = decideDemo({
      body: "Deployed at https://pr-9.review.app for review.",
      changedPaths: ["app/views/a.erb"],
      config: noUrl,
    });
    expect(d.target).toBe("https://pr-9.review.app");
    expect(d.run).toBe(true);
  });

  it("prefers the deploy comment's review-app URL over the repo default", () => {
    const withComment = parseProjectConfig({
      demo: { paths: ["app/views/**"], targetComment: TARGET_COMMENT },
      url: "http://localhost:3000",
    });
    const d = decideDemo({
      body: "## Description\n[APA-3002](https://linear.app/wrapbook/issue/APA-3002)",
      changedPaths: ["app/views/a.erb"],
      comments: [DEPLOY_COMMENT],
      config: withComment,
    });
    expect(d.target).toBe("https://wrapbook-dev-pr-64365.wrapbook.reviews");
  });

  it("still lets an explicit dailies-url: beat the deploy comment", () => {
    const withComment = parseProjectConfig({
      demo: { paths: ["app/views/**"], targetComment: TARGET_COMMENT },
      url: "http://localhost:3000",
    });
    const d = decideDemo({
      body: "dailies-url: https://staging.example.test",
      changedPaths: ["app/views/a.erb"],
      comments: [DEPLOY_COMMENT],
      config: withComment,
    });
    expect(d.target).toBe("https://staging.example.test");
  });

  it("falls back to the repo default when no deploy comment has landed yet", () => {
    const withComment = parseProjectConfig({
      demo: { paths: ["app/views/**"], targetComment: TARGET_COMMENT },
      url: "http://localhost:3000",
    });
    const d = decideDemo({
      body: "Adds a card.",
      changedPaths: ["app/views/a.erb"],
      comments: ["still building…"],
      config: withComment,
    });
    expect(d.target).toBe("http://localhost:3000");
  });

  it("reads a plain-demo body as the plain mode", () => {
    const d = decideDemo({
      body: "plain demo please",
      changedPaths: ["app/views/a.erb"],
      config,
    });
    expect(d.mode).toBe("plain");
  });

  it("reads a sing-it request as the song mode", () => {
    const d = decideDemo({
      body: "small win — sing it",
      changedPaths: ["app/views/a.erb"],
      config,
    });
    expect(d.mode).toBe("song");
  });

  it("lets plain win when a body somehow asks for both", () => {
    const d = decideDemo({
      body: "sing it, but actually no narration please",
      changedPaths: ["app/views/a.erb"],
      config,
    });
    expect(d.mode).toBe("plain");
  });

  it("honors a repo-pinned mode, with no body opinion", () => {
    const plain = parseProjectConfig({
      demo: { mode: "plain" },
      url: "http://x",
    });
    expect(
      decideDemo({ body: "", changedPaths: ["a"], config: plain }).mode
    ).toBe("plain");
  });

  it("lets the PR body override a repo-pinned mode", () => {
    const pinned = parseProjectConfig({
      demo: { mode: "song" },
      url: "http://x",
    });
    expect(
      decideDemo({ body: "plain demo", changedPaths: ["a"], config: pinned })
        .mode
    ).toBe("plain");
  });

  it("skips when no changed file is user-facing", () => {
    const d = decideDemo({ body: "", changedPaths: ["README.md"], config });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("match demo.paths");
    // Still reports the target it WOULD have used — useful in the log.
    expect(d.target).toBe("http://localhost:3000");
  });

  it("skips with actionable advice when there is no target anywhere", () => {
    const d = decideDemo({
      body: "",
      changedPaths: ["app/views/a.erb"],
      config: EMPTY_CONFIG,
    });
    expect(d.run).toBe(false);
    expect(d.reason).toContain(".dailies/config.json");
    expect(d.reason).toContain("dailies-url:");
  });

  it("runs on any change when the repo configures no paths", () => {
    const anyChange = parseProjectConfig({ url: "http://x" });
    expect(
      decideDemo({ body: "", changedPaths: ["docs/x.md"], config: anyChange })
        .run
    ).toBe(true);
  });
});

describe("isAlreadyDemoed", () => {
  const marker = (sha: string) =>
    `🎬 demo ready\n<!-- dailies-demo: ${sha} -->`;
  const HEAD = "a".repeat(40);

  it("matches a full sha recorded in a previous comment", () => {
    expect(isAlreadyDemoed(HEAD, [marker(HEAD)])).toBe(true);
  });

  it("matches a short sha against the full head", () => {
    expect(isAlreadyDemoed(HEAD, [marker("aaaaaaa")])).toBe(true);
  });

  it("is false when the PR has moved on", () => {
    expect(isAlreadyDemoed("b".repeat(40), [marker(HEAD)])).toBe(false);
  });

  it("ignores unrelated comments and prose mentioning the sha", () => {
    expect(isAlreadyDemoed(HEAD, ["looks good to me", "please rebase"])).toBe(
      false
    );
    // Only the marker counts — a sha quoted in prose must not suppress a demo.
    expect(isAlreadyDemoed(HEAD, [`built from ${HEAD}`])).toBe(false);
  });

  it("is false with no head sha, so a broken lookup demos rather than skips", () => {
    expect(isAlreadyDemoed("", [marker(HEAD)])).toBe(false);
  });

  it("finds the marker among several comments, case-insensitively", () => {
    const comments = [
      "nope",
      marker("BBBBBBB"),
      "also nope",
      marker(HEAD.slice(0, 12)),
    ];
    expect(isAlreadyDemoed(HEAD, comments)).toBe(true);
    expect(demoedShas(comments)).toHaveLength(2);
  });
});

describe("decideDemo freshness", () => {
  const config = parseProjectConfig({ url: "http://localhost:3000" });
  const HEAD = "c".repeat(40);
  const marker = (sha: string) => `🎬 demo\n<!-- dailies-demo: ${sha} -->`;

  it("skips a head that already has a demo", () => {
    const d = decideDemo({
      body: "",
      changedPaths: ["app/a.rb"],
      comments: [marker(HEAD)],
      config,
      headSha: HEAD,
    });
    expect(d.run).toBe(false);
    expect(d.reason).toBe(`already demoed at ${HEAD.slice(0, 7)}`);
  });

  it("runs once the PR moves to a new head", () => {
    const d = decideDemo({
      body: "",
      changedPaths: ["app/a.rb"],
      comments: [marker(HEAD)],
      config,
      headSha: "d".repeat(40),
    });
    expect(d.run).toBe(true);
  });

  it("runs when there are no comments at all", () => {
    expect(
      decideDemo({
        body: "",
        changedPaths: ["app/a.rb"],
        config,
        headSha: HEAD,
      }).run
    ).toBe(true);
  });

  it("reports the stale demo before complaining about a missing target", () => {
    // An already-demoed PR should be quiet, not nag about configuration.
    const d = decideDemo({
      body: "",
      changedPaths: ["app/a.rb"],
      comments: [marker(HEAD)],
      config: EMPTY_CONFIG,
      headSha: HEAD,
    });
    expect(d.reason).toContain("already demoed");
  });
});

describe("buildDecisionPrompt", () => {
  const base = {
    body: "Adds a nightly backfill job.",
    changedPaths: ["app/jobs/backfill.rb"],
    hint: null,
    paths: [],
  };

  // The prompt is hard-wrapped for readability, so assert against
  // whitespace-normalized text rather than coupling tests to line breaks.
  const flat = (args: Parameters<typeof buildDecisionPrompt>[0]) =>
    buildDecisionPrompt(args).replace(/\s+/g, " ");

  it("tells the model a non-UI change can still be demo-worthy", () => {
    // The whole reason this isn't a glob match.
    expect(flat(base)).toContain("NO UI code at all");
    expect(flat(base)).toContain("background job");
  });

  it("asks whether watching adds anything, not merely whether it is visible", () => {
    // A copy edit IS visible but is fully described by the diff — the naive
    // "could a person see it" criterion gets that case wrong.
    expect(flat(base)).toContain("not whether a person COULD see");
    expect(flat(base)).toContain("Only displayed text changes");
  });

  it("states the exclusions BEFORE the reasons to say yes, and as overriding", () => {
    // Ordering is load-bearing: a small model reads a long "worth it" list and
    // then rationalizes past a NEVER rule buried underneath it.
    const prompt = flat(base);
    expect(prompt).toContain("override every reason to say yes");
    expect(prompt.indexOf("STEP 1")).toBeLessThan(prompt.indexOf("STEP 2"));
    expect(prompt.indexOf("Only displayed text")).toBeLessThan(
      prompt.indexOf("worth recording, name the ONE")
    );
  });

  it("tells the model to enable a flag or setting the change hides behind", () => {
    // Otherwise the recording shows the old behavior and proves nothing.
    expect(buildDecisionPrompt(base)).toContain("enable it");
  });

  it("includes the PR body and the changed files", () => {
    const prompt = buildDecisionPrompt(base);
    expect(prompt).toContain("Adds a nightly backfill job.");
    expect(prompt).toContain("app/jobs/backfill.rb");
  });

  it("passes demo.paths as a hint, explicitly not a rule", () => {
    const prompt = buildDecisionPrompt({ ...base, paths: ["app/views/**"] });
    expect(prompt).toContain("a hint, not a rule");
    expect(prompt).toContain("app/views/**");
  });

  it("includes the project hint when set, and omits the section when not", () => {
    expect(
      buildDecisionPrompt({ ...base, hint: "we care about onboarding" })
    ).toContain("we care about onboarding");
    expect(buildDecisionPrompt(base)).not.toContain(
      "What this project considers"
    );
  });

  it("caps the file list and says how many were elided", () => {
    const many = Array.from({ length: 90 }, (_, i) => `app/f${i}.rb`);
    const prompt = buildDecisionPrompt({ ...base, changedPaths: many });
    expect(prompt).toContain("Changed files (90)");
    expect(prompt).toContain("and 30 more files");
    expect(prompt).not.toContain("app/f89.rb");
  });

  it("handles an empty PR body", () => {
    expect(buildDecisionPrompt({ ...base, body: "  " })).toContain(
      "(no description)"
    );
  });
});

describe("parseDecision", () => {
  it("reads a verdict with a flow", () => {
    expect(
      parseDecision(
        '{"worth":true,"reason":"changes the payslip","flow":"Open a payslip"}'
      )
    ).toEqual({
      flow: "Open a payslip",
      mode: null,
      reason: "changes the payslip",
      worth: true,
    });
  });

  it("tolerates a fenced or prose-wrapped reply", () => {
    expect(
      parseDecision('Sure!\n```json\n{"worth":false,"reason":"docs only"}\n```')
    ).toEqual({
      flow: null,
      mode: null,
      reason: "docs only",
      worth: false,
    });
  });

  it("rejects a reply with no boolean verdict, so the caller can fall back", () => {
    expect(parseDecision("not json")).toBeNull();
    expect(parseDecision('{"reason":"hmm"}')).toBeNull();
    expect(parseDecision('{"worth":"yes"}')).toBeNull();
  });

  it("substitutes a placeholder rather than failing on a missing reason", () => {
    expect(parseDecision('{"worth":true}')?.reason).toBe("no reason given");
  });
});

describe("decideDemoWithAgent", () => {
  const agentConfig = parseProjectConfig({
    demo: { decide: "agent", paths: ["app/views/**"] },
    url: "http://localhost:3000",
  });
  const HEAD = "e".repeat(40);

  it("does not spend a model call on an already-demoed head", async () => {
    const d = await decideDemoWithAgent({
      body: "",
      changedPaths: ["app/views/a.erb"],
      comments: [`<!-- dailies-demo: ${HEAD} -->`],
      config: agentConfig,
      headSha: HEAD,
    });
    expect(d.run).toBe(false);
    expect(d.decidedBy).toBe("freshness");
  });

  it("does not spend a model call when there is no target", async () => {
    const d = await decideDemoWithAgent({
      body: "",
      changedPaths: ["app/views/a.erb"],
      config: parseProjectConfig({ demo: { decide: "agent" } }),
    });
    expect(d.decidedBy).toBe("config");
  });

  it("skips the agent entirely in paths mode", async () => {
    const d = await decideDemoWithAgent({
      body: "",
      changedPaths: ["docs/x.md"],
      config: parseProjectConfig({
        demo: { decide: "paths", paths: ["app/**"] },
        url: "http://x",
      }),
    });
    expect(d.decidedBy).toBe("paths");
    expect(d.run).toBe(false);
  });

  it("runs on any change in always mode", async () => {
    const d = await decideDemoWithAgent({
      body: "",
      changedPaths: ["docs/x.md"],
      config: parseProjectConfig({
        demo: { decide: "always" },
        url: "http://x",
      }),
    });
    expect(d.decidedBy).toBe("always");
    expect(d.run).toBe(true);
  });

  it("falls back to path matching when no provider is available", async () => {
    // No provider pinned to a real backend: DAILIES_LLM names a nonexistent one.
    const prev = process.env.DAILIES_LLM;
    process.env.DAILIES_LLM = "nonexistent-provider";
    try {
      const d = await decideDemoWithAgent({
        body: "",
        changedPaths: ["app/views/a.erb"],
        config: agentConfig,
        headSha: "f".repeat(40),
      });
      // The path verdict survives, and the reason says the agent was unavailable.
      expect(d.run).toBe(true);
      expect(d.decidedBy).toBe("paths (agent unavailable)");
      expect(d.reason).toContain("agent decision was unavailable");
    } finally {
      if (prev === undefined) {
        process.env.DAILIES_LLM = undefined;
        Reflect.deleteProperty(process.env, "DAILIES_LLM");
      } else {
        process.env.DAILIES_LLM = prev;
      }
    }
  });
});

describe("parseDecision mode", () => {
  it("reads a mode the model picked", () => {
    expect(
      parseDecision('{"worth":true,"reason":"fun one","mode":"song"}')?.mode
    ).toBe("song");
  });

  it("ignores an unrecognized mode rather than failing the decision", () => {
    const d = parseDecision('{"worth":true,"reason":"ok","mode":"epic"}');
    expect(d?.mode).toBeNull();
    expect(d?.worth).toBe(true);
  });

  it("drops a mode volunteered on a skip, like flow", () => {
    expect(
      parseDecision('{"worth":false,"reason":"docs","mode":"song"}')?.mode
    ).toBeNull();
  });
});

describe("parseDecision flow hygiene", () => {
  it("drops a flow the model volunteered on a skip", () => {
    // Observed live: the model fills `flow` in even when it says worth:false.
    const d = parseDecision(
      '{"worth":false,"reason":"specs only","flow":"Sign in and look at the screen"}'
    );
    expect(d).toEqual({
      flow: null,
      mode: null,
      reason: "specs only",
      worth: false,
    });
  });

  it("keeps the flow when the demo will run", () => {
    expect(
      parseDecision(
        '{"worth":true,"reason":"changes net pay","flow":"Open the pay screen"}'
      )?.flow
    ).toBe("Open the pay screen");
  });
});

describe("previousMetrics", () => {
  const marker = (sha: string, extra = "") =>
    `🎬 demo\n<!-- dailies-demo: ${sha}${extra} -->`;

  it("reads the metrics out of the newest demo comment", () => {
    expect(
      previousMetrics([
        marker("aaaaaaa", " coverage=30"),
        marker("bbbbbbb", " coverage=42.5 steps=4"),
      ])
    ).toEqual([
      { name: "coverage", value: 42.5 },
      { name: "steps", value: 4 },
    ]);
  });

  it("returns none for the original sha-only marker", () => {
    // A PR whose demo history predates metrics must still parse.
    expect(previousMetrics([marker("aaaaaaa")])).toEqual([]);
  });

  it("skips past a metric-less newer comment to find the last real numbers", () => {
    expect(
      previousMetrics([marker("aaaaaaa", " coverage=30"), marker("bbbbbbb")])
    ).toEqual([{ name: "coverage", value: 30 }]);
  });

  it("ignores comments with no marker at all", () => {
    expect(previousMetrics(["lgtm", "please rebase"])).toEqual([]);
  });

  it("still recognizes a metric-carrying marker as a demo of that commit", () => {
    // The freshness check and the metric read share one regex.
    const HEAD = "c".repeat(40);
    expect(isAlreadyDemoed(HEAD, [marker(HEAD, " coverage=42.5")])).toBe(true);
  });
});
