# Dependency update — 2026-09-19

Updated every declared external workspace dependency to the npm `latest` channel and refreshed
transitive resolutions. Packages already current, including QuickJS 0.32.0, remain on that release.
The package manager stays on pnpm 12.4.2: npm marks the newer 12.5.1 as `next-12`, and GitHub's
latest-release endpoint also selects 12.4.2.

## Main updates

| Dependency | Previous installed version | Updated version |
| --- | --- | --- |
| Playwright / playwright-core | 1.61.1 | 1.63.0 |
| TypeScript | 5.9.3 | 7.0.2 |
| Vitest | 4.1.6 | 5.0.1 |
| Zod | 3.25.76 | 4.6.5 |
| Commander | 12.1.0 | 15.0.0 |
| Pino | 9.14.0 | 10.3.1 |
| pnpm | 9.15.0 | 12.4.2 |
| Biome / Ultracite | 2.4.16 / 7.8.1 | 2.5.14 / 7.12.0 |
| esbuild / tsx | 0.27.7 / 4.21.0 | 0.28.2 / 4.23.13 |
| Turbo | 2.9.12 | 2.11.2 |
| commitlint | 19.8.1 | 21.2.3 |
| lint-staged | 15.5.2 | 17.5.1 |

CI actions were updated to checkout 7.0.1, setup-node 7.0.0, cache 6.1.0, upload-artifact 7.0.1,
and pnpm/action-setup 6.1.0. Workflow linting uses actionlint 1.7.12; the staged release uses
npm 12.0.2. The release helper now validates with `npm pack --dry-run`, matching the actual
packager. Publishing remains a separate, manually approved operation.

## Compatibility work

- **Node versions:** the published CLI requires Node 22.12.0 or newer. Contributor tooling needs
  22.22.1 or newer, with Node 24 LTS recommended through `.nvmrc`. CI covers both contributor
  versions. npm 12's release tooling runs on Node 24.15 or newer.
- **Playwright:** the host adapter follows the new connection constructor, timeout metadata,
  event-wait messages, and protocol shapes. The maintained QuickJS client keeps its platform
  adaptation rather than being replaced with Node-specific upstream code. Tracked accessibility
  snapshots retain their cross-step behavior using the upstream structured snapshot and renderer.
  Playwright removed handle-based exposed bindings; requesting `{ handle: true }` now fails with
  guidance instead of silently delivering a serialized value in place of a `JSHandle`.
  The binding test also exposed a transport limitation: awaiting a binding callback inside the
  evaluation that invokes it can stall. Starting the call and collecting its result in a later
  evaluation works; this sequence is documented in the fork README. The drain code is unchanged,
  but this limitation was not reproduced against the previous dependency versions.
- **Existing installations:** startup checks installed runtime package versions against the
  embedded bundle's requirements. A stale Playwright installation prompts `dailies install`
  instead of failing inside private internals. A regression checks that the embedded dependency
  specifications stay aligned with the workspace.
- **Zod:** input defaults still expand missing capture settings; omitted result payloads still
  work. Invalid numeric limits remain rejected. **Commander:** uses its supported ESM exports,
  with capture/cursor defaults and negative flags covered by CLI tests.
- **Tooling:** removed the unused TypeScript `baseUrl`; migrated Vitest's removed sequential API.
  Kept established source-order and serial-operation lint conventions explicit, avoiding automatic
  reordering of objects or removal of defensive runtime checks. Accepted the new formatter's
  layout and package-manifest ordering.
- **Installation:** pnpm build permission is explicit for esbuild; the refreshed dependency graph
  no longer needs MSW's postinstall work. Release-age exceptions are restricted to the exact stable
  versions selected for this update. No blanket build or registry-policy bypass is configured.

## Verification

- Forced full lint, documentation, compile, build and test checks passed on Node 22.22.1 and
  Node 24.21.0: **1,137 passed and five opt-in skips on each version** (CLI 867, daemon 213,
  daemon client 32, runtime 25). All 16 tasks succeeded with the cache bypassed.
- A frozen pnpm 12 install passed. `pnpm outdated -r --format json` returned `{}`; the refreshed
  lockfile's `pnpm audit --json` reports zero known vulnerabilities across all severities.
- actionlint 1.7.12 and ShellCheck 0.11.0 passed all three workflows; the release helper also
  passed shell syntax and ShellCheck validation. No workflow or publication was triggered.
- npm 12 packed the CLI with exactly five files, no consumer npm dependencies, and the original
  license attribution. The extracted CLI runs on Node 22.12.0 without the workspace's modules.
  The final package's page/context binding guards passed, and its browser rendered the recorded
  report successfully. The report and a captured step screenshot were visually inspected.
- The packaged CLI rejected the old local runtime with the installation remedy, then successfully
  upgraded it. A Node 22.12.0 recording navigated the local form fixture, filled a textbox, toggled
  a checkbox, and asserted persistent values and an empty unchanged snapshot across steps. The
  trace identifies Playwright 1.63.0. The report, trace, HAR, four step screenshots and an 11.76-second
  captioned video were produced; the video decodes as VP8 at 1440 × 1062. One failed smoke-script
  invocation used a helper on a locator instead of the page; the corrected step and final
  assertions passed, and the report preserves that retry.

Recorded evidence remains local under session `dependency-upgrade-node-22-mu8w6v00-a7754c`.
Only `report.html` and the finished video are intended for sharing; the complete session directory
is not a release artifact. Validation ran on Linux with Chromium; macOS, Windows and live media
provider calls were not exercised.

## Upstream references

- [Playwright 1.63 release notes](https://playwright.dev/docs/release-notes#version-163)
- [Zod 4 migration](https://zod.dev/v4/changelog)
- [Vitest 5 migration](https://vitest.dev/guide/migration/)
- [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [pnpm installation](https://pnpm.io/installation) and [build settings](https://pnpm.io/settings/build)
- [Node release support](https://nodejs.org/en/about/previous-releases)
