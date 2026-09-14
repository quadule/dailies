import { installCommand } from "./install.js";

// First-run setup: install the browser runtime, then point the user at the
// agent plugin and the viewer. Skills/agents/commands install via the plugin
// marketplaces (Claude Code / Cursor / Codex) — there is no separate skill
// installer. `create-dailies` is the friendlier Ink front-end.
export async function initCommand(): Promise<number> {
  process.stdout.write(
    "Setting up dailies…\n\n▶ Installing the browser runtime (Chromium)\n"
  );
  const runtime = await installCommand();
  if (runtime !== 0) {
    return runtime;
  }

  process.stdout.write(
    [
      "",
      "✓ dailies is ready.",
      "",
      "  Browse recorded sessions:        open ~/.dailies/sessions/<id>/report.html",
      "  Claude Code plugin:              /plugin marketplace add quadule/dailies",
      "                                   /plugin install dailies@dailies-marketplace",
      "  Try a demo:                      see examples/ in the repo",
      "",
    ].join("\n")
  );
  return 0;
}
