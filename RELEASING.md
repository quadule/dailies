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

1. **Trusted publishing (no token).** The release workflow authenticates to npm with
   OIDC — there is no `NPM_TOKEN` secret, and there should not be one. GitHub mints a
   short-lived token (`id-token: write`), npm checks it against the trusted publisher
   configured on the package, and provenance is attested automatically.

   Configured once on npmjs.com → `dailies-cli` → Settings → Trusted Publisher:

   | Field | Value |
   | --- | --- |
   | Provider | GitHub Actions |
   | Organization or user | `quadule` |
   | Repository | `dailies` |
   | Workflow filename | `release.yml` (filename only, not a path) |
   | Environment | *(leave blank)* |
   | Allowed actions | **`npm stage publish` only** |

   Stage-only is deliberate: CI can upload a release but cannot make it public. A maintainer
   promotes it with 2FA, so a compromised workflow still can't ship to users.

   Note the bootstrapping order: a trusted publisher attaches to a package that already
   exists, so the **first** publish of any new package needs a token with write access to
   *all* packages — a granular token scoped to selected packages cannot name one that has
   never been published, and fails with a misleading
   `E403 … You may not perform that action with these credentials`. `dailies-cli` is past
   that point; a future *new* package would hit it again.
2. **The `dailies-cli` name** — claimed; published since 2026-09-14. (The bare `dailies` name
   belongs to an unrelated package, which is why the CLI is `dailies-cli`.)
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

It prints the three commands that follow it — push, dispatch, approve. Pushing the tag records the
release in git; it does **not** publish. Publishing is a separate, deliberate step (below).

The manual equivalent, if you'd rather run the steps yourself:

```bash
node scripts/sync-version.mjs 0.2.0   # one version across every package.json + plugin manifests + skill frontmatter
pnpm install                          # refresh the lockfile
git commit -am "chore(release): v0.2.0"  # NB: "release:" alone fails commitlint — use a conventional type
git tag v0.2.0
git push origin main --follow-tags
```

Before either: retitle `CHANGELOG.md`'s `## Unreleased` section to the version (nothing in the
release flow does it). A version that was tagged but never published — a demo tag, a release
that stalled — is still that version, not the next one: move the tag to the final commit
(`git tag -fa vX.Y.Z`, then `git push --force origin refs/tags/vX.Y.Z` — force-push the tag only,
never the branch) rather than bumping past it, so npm sees the number the changelog announced.

## Publishing

Publishing is a **manual workflow run**, never a side effect of pushing a tag — so an accidental
`git push --tags` can't reach the registry:

```bash
gh workflow run release.yml --ref v0.2.0 -f version=0.2.0
```

`--ref v0.2.0` is not optional: dispatch it **on the tag**. The workflow refuses to continue unless
the version you typed matches the workspace version *and* the ref it was dispatched on is
`refs/tags/v<version>` — otherwise a run started on `main` after later commits landed would stage a
tarball built from those commits under the tagged version number, and npm never lets that version be
republished. (From the Actions tab: run **Release**, pick the tag in the ref dropdown, type the
version.) It then runs `pnpm build` (topo-ordered) and `npm stage publish` from `apps/dailies`. That
does **not** make the release public — see *Promoting a staged release* below.

Publishing uses **npm**, not `pnpm -r publish`, because OIDC landed natively in pnpm 10 and this
repo is pinned to pnpm 9.15 (pnpm 10 stopped running dependency build scripts by default, which
esbuild/sharp/Playwright need). With a single public package that has zero runtime deps — the only
`workspace:*` specs are devDependencies, which npm leaves as-is and consumers never install —
pnpm's rewriting has nothing to do, so the two are equivalent here. The workflow upgrades npm to the
11.x line first: trusted publishing needs npm >= 11.5.1, staged publishing >= 11.15.0, and Node 22
ships npm 10.x. That npm needs Node >= 22.14, which is a constraint on the **release runner** only
(it pins `node-version: 22`) — the published CLI's own floor is the `engines` range, Node 20.11.

## Promoting a staged release

The workflow leaves the version staged: uploaded to npm, not installable. Promote it yourself:

```bash
npm stage list dailies-cli      # find the stage id
npm stage view <stage-id>       # inspect what CI built
npm stage download <stage-id>   # or pull the tarball and look inside
npm stage approve <stage-id>    # 2FA prompt — this is what makes it public
npm stage reject <stage-id>     # discard it instead
```

Staging needs no 2FA; approving does. Staged versions occupy the same version-uniqueness index as
published ones, so a staged 1.2.3 blocks publishing 1.2.3 while it sits there. npm's docs don't say
whether rejecting frees the number again — assume it may not, and move to the next patch rather
than fighting it.

One consequence worth knowing: `pnpm publish` used to copy the workspace-root `LICENSE` into the
tarball for free. `npm publish` does not — it only includes a `LICENSE` in the package directory,
and skips a symlinked one. `apps/dailies/scripts/build.mjs` therefore copies it in at build time
(gitignored). If the published tarball ever loses `LICENSE`, that copy is why.

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
tar -tzf apps/dailies/dailies-cli-*.tgz
```

Expect exactly five entries: `dist/cli.js`, `dist/cli.js.map`, `package.json`, `README.md`,
`LICENSE` — no `node_modules`, and nothing else out of `dist/`. `files` names the two dist files
rather than `dist/` so an output the build stops emitting can't quietly keep shipping (a renamed
`dist/cli.cjs` did exactly that); `README.md` and `LICENSE` come from npm's own defaults, which is
why the LICENSE copy above has to land in the package **directory** and not in `dist/`.
