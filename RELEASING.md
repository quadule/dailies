# Releasing

Dailies publishes **one** public package to npm — `dailies-cli`, which puts the `dailies`
binary on your PATH. Everything else is private: bundled or embedded into it.

## What publishes

| Package          | npm                | bin              | Notes                                              |
| ---------------- | ------------------ | ---------------- | -------------------------------------------------- |
| `dailies-cli`    | public             | `dailies`         | Self-contained esbuild bundle (deps inlined)       |
| `dailies-daemon` | **private**        | —                | Embedded as a string into the CLI bundle           |
| `dailies-protocol`, `dailies-logger`, `dailies-cli-kit`, `dailies-daemon-client`, `dailies-config` | **private** | — | Bundled into the CLI by esbuild |

`dailies-daemon`'s Playwright runtime is **not** a package dependency — it's fetched into
`~/.dailies/` at runtime by `dailies install`, so a plain `npm i -g dailies-cli` stays small.

## Prerequisites (one-time)

1. **`NPM_TOKEN`** — an npm automation token with publish rights. Two places need it, and
   they're independent:
   - **The release workflow** (the normal path) reads it as a GitHub repo secret. As of
     2026-09-14 the repo has only `ANTHROPIC_API_KEY` and `GEMINI_API_KEY`, so CI cannot
     publish until the secret is added.
   - **Publishing locally** (escape hatch) needs it in your shell. Keep it in 1Password and
     inject it per-command with `op run --env-file=…` rather than writing it to `~/.npmrc` —
     a token in a dotfile outlives the command that needed it.
2. **The `dailies-cli` name** — unclaimed as of 2026-09-14. Note that the bare `dailies` name is
   taken by an unrelated package, so the first publish also tests npm's name-similarity check.
3. **Provenance** — the release workflow sets `id-token: write` so npm records build provenance;
   the `repository` field in each manifest must point at this repo (it does).

## Cutting a release

The guided way — `make release` (wraps `scripts/release.sh`): it refuses a dirty/stale tree,
prompts for the bump (patch/minor/major or a custom version), bumps every package in lockstep,
refreshes the lockfile, validates the build + npm packaging (dry-run), creates the
`chore(release): vX.Y.Z` commit and the annotated tag — then **stops and hands you the push**:

```bash
make release                  # interactive: pick patch / minor / major
make release BUMP=minor        # non-interactive bump
make release VERSION=1.4.0      # explicit version
# env knobs: YES=1 (skip confirm) · NO_VERIFY=1 (skip build+dry-run) · ALLOW_DIRTY=1
```

It prints the exact push to run last. Pushing the tag records the release in git; it does **not**
publish. Publishing is a separate, deliberate step (below).

The manual equivalent, if you'd rather run the steps yourself:

```bash
node scripts/sync-version.mjs 0.2.0   # one version across every package.json + plugin manifests + skill frontmatter
pnpm install                          # refresh the lockfile
git commit -am "chore(release): v0.2.0"  # NB: "release:" alone fails commitlint — use a conventional type
git tag v0.2.0
git push origin main --follow-tags
```

## Publishing

Publishing is a **manual workflow run**, never a side effect of pushing a tag — so an accidental
`git push --tags` can't reach the registry:

```bash
gh workflow run release.yml -f version=0.2.0
```

(or run **Release** from the Actions tab and type the version). The workflow refuses to continue
unless the version you typed matches the workspace version, then runs `pnpm build` (topo-ordered)
and `pnpm -r publish --access public --provenance`. `pnpm -r publish` automatically skips private
packages and rewrites `workspace:*` to the concrete version.

## How updates reach agents

npm publishes the CLI, but the agent plugin packs are served straight from this repo — a release
is what makes them update-visible. `scripts/sync-version.mjs`
stamps the same version into every manifest that update detection reads:

- **Claude Code** compares `.claude-plugin/marketplace.json` `plugins[].version` against the
  installed plugin — **no version bump, no visible update**. Users pull it with
  `/plugin marketplace update dailies-marketplace` (or per-marketplace auto-update, which is OFF by
  default for third-party marketplaces).
- **Cursor / Codex** read `.cursor-plugin/plugin.json` and `plugins/dailies/.codex-plugin/plugin.json`
  versions — both synced by the release flow. (Each `skills/*/SKILL.md` `metadata.version` is also
  synced for honesty, not detection.)

Shared doc content (scripting API, workflow rules) lives in `docs/snippets/` and is stitched into
the skills, README, and the CLI's `--help` by `make docs` — edit snippets, restitch, commit;
`make check` fails on drift. See `docs/snippets/README.md`.

## Verifying a build locally (no publish)

```bash
pnpm build
(cd apps/dailies && npm pack)          # -> dailies-cli-<v>.tgz  (NB: `pnpm pack` rejects --filter)
tar -tzf apps/dailies/dailies-cli-*.tgz # expect dist/, package.json, README.md — no node_modules
```
