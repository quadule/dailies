import { installCommand } from "./install.js";

// First-run setup: install the browser runtime, then point the user at the
// agent plugin and where reports land. Skills/agents/commands install via the
// plugin marketplaces (Claude Code / Cursor / Codex) — there is no separate
// skill installer.
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
      "",
      // Not "see examples/ in the repo": someone who installed from npm has no
      // repo to look in. Three commands they can paste instead.
      "  Record your first session:",
      "    id=$(dailies session start --name demo)",
      '    echo \'const p = await browser.getPage("demo"); await p.goto("https://example.com")\' \\',
      '      | dailies run --session "$id" --step open',
      '    dailies session end "$id" --open',
      "",
    ].join("\n")
  );
  return 0;
}
