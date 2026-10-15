# Doc snippets — single source for shared LLM-facing docs

These fragments are the single source of truth for content that appears on more than one
surface: the CLIs' `--help` (via `packages/cli-kit/src/snippets.generated.ts`), the agent
skills (`skills/`), the subagents (`agents/`), and the README.

Edit a snippet, then run `make docs` (or `node scripts/stitch-docs.mjs --write`) to re-stitch
every consumer. CI runs `--check` and fails if a stitched surface drifts. Never hand-edit the
content between `<!-- dailies:snippet … -->` markers or the generated TypeScript module.

Conventions:

- Embed a snippet once per load path. An agent reads `dailies-scripting` plus one workflow skill
  (subagents preload both), so a rule already in `dailies-scripting` stays out of the workflow
  skills and `agents/`. AGENTS.md ("Shared docs") lists where each group lives.

- Markdown that reads well as plain terminal text: hyphen bullets and inline backticks; no
  tables, no headings, no bold — consumers supply their own headings.
- `{{cli}}` is substituted per consumer: `dailies` in CLI help (the default), `npx dailies-cli`
  in skills/agents (`cli=npx-cli` on the marker).
- `examples/` holds bare script bodies (no code fences); markdown consumers opt into fencing
  with `fenced=js` on the marker, and cli-kit wraps them in per-CLI invocations.
- Facts must match the daemon implementation (`apps/dailies-daemon/src/`) — e.g.
  `browser.listPages()` really returns `[{ id, url, title, name }]` and `setTimeout` really is
  a sandbox global. When in doubt, read the source before editing.
