# Release preparation review — 2026-09-19

This review covered the first-party CLI, daemon and sandbox integration, session/report lifecycle,
video and text providers, shared packages, documentation generation, and release/demo workflows.
The changes consolidate repeated mechanisms and fix concrete failure paths. The vendored Playwright
client was kept unchanged so it remains comparable with upstream.

## Consolidation completed

| Repeated responsibility | Shared implementation |
| --- | --- |
| CLI and daemon filesystem layout, session paths, and pipe naming | `packages/runtime/src/paths.ts`; existing import APIs remain available |
| Live session and disk-recovery artifact discovery | `packages/runtime/src/artifacts.ts`; capture flags remain explicit on live teardown |
| Four atomic media-file writers | `apps/dailies/src/video/media-files.ts`; provider-specific diagnostics are preserved |
| Five shell single-quote implementations | `apps/dailies/src/util/shell.ts`; existing curl preview formatting is preserved |
| Audio duration probing and shared encode constants/types | Existing helpers in `apps/dailies/src/video/ffmpeg.ts` |
| `run` and `exec` script loading, empty input, and stdin handling | `commands/script-input.ts` and the CLI's shared stdin reader |
| Comment-file parsing for CI decisions and metric comparison | `apps/dailies/src/ci/inputs.ts` |
| Console and trace JSONL reading | `apps/dailies/src/report/json-lines.ts` |
| Takeover stop-result interfaces | `SessionTakeoverStopResult` in `dailies-protocol` |
| Automatic and explicit CDP endpoint resolution | One browser-manager HTTP resolution path |
| Text and binary sandbox file reads | One containment-checked byte reader |

The new `dailies-runtime` package is private and source-distributed. Both CLI and daemon bundles
inline it. It avoids a dependency cycle through `dailies-daemon-client` and keeps Node filesystem
operations out of the protocol schema package. It adds no consumer-installed runtime dependency.

Redundant closed-page pruning, no-op tab enumeration, duplicate pending-promise handling, and
unreachable IPC terminal bookkeeping were also removed.

## Reliability fixes

- Client and daemon now choose the same Windows pipe when username environment variables are
  blank or absent. Previously their fallback rules differed.
- Report parsing tolerates null/malformed console, HAR, trace, and manifest metadata. Step names
  such as `constructor` and `__proto__` no longer collide with inherited object properties.
- Re-finalizing ended/aborted sessions goes directly to disk recovery, avoiding a useless daemon
  request and its misleading "Session not found" stack trace. Active-session failure behavior is
  preserved.
- `/dailies` comment preparation retains target/theme settings for the decision parser while
  keeping them out of the requested flow. Previously the workflow removed them from both inputs.
- Subprocess errors retain stdout/stderr. The ffmpeg audio-duration fallback can now read the
  duration that `ffmpeg -i` prints before exiting unsuccessfully.
- Narration and song assembly wait for started background work before cleaning temporary files
  when encoding fails. A delayed title-art provider cannot recreate a file after cleanup.
- Google service-account token exchange has a 30-second timeout and can retry after failure.

The review also caught and removed a proposed entry-point simplification that was unsafe after
esbuild bundling. The new built-CLI version test checks for extra output from imported executables.
Source-only tests did not cover this boundary.

## Boundaries to retain

- Recorded `run` and unrecorded `exec` share input handling, but remain distinct commands. Making
  session recording an optional flag would weaken the evidence contract.
- Live artifact collection respects capture settings; recovery scans surviving files and restores
  page/step metadata from the manifest. The shared scanner does not erase that distinction.
- Text generation and media slots keep their own selection policies, pins, retries, and degradation
  rules. Their similar-looking provider interfaces do not make those policies interchangeable.
- The host and QuickJS guest bridge remain separate trust/runtime boundaries.
- Random creative direction remains the default. Attachments remain the extension point for
  application-specific evidence. Credential scrubbing and provenance attribution remain intact.

## Follow-up refactors completed

1. **Narration/song assembly.** Both modes now use `assembleVideoBody` for geometry, background
   preparation, title cards, credits, offsets, and concatenation. Narration pacing, song onset,
   captions, and audio mixing remain explicit. Real ffmpeg fixtures were added before extraction
   and passed afterward: they check decoded frames, caption/credit pixels, exact timing, audio
   placement/levels, source preservation, and cleanup. This removes 104 production lines.
2. **General subprocess utilities.** `util/process.ts` owns execution, availability probes, and
   bounded concurrency; `util/shell.ts` owns command formatting. Text providers no longer depend
   on the video subsystem. Apple's stdin helper uses the shared runner while retaining its error
   messages. Real subprocess tests cover stdin/EOF, split UTF-8, output bounds, spawn failures,
   diagnostics, and timeout termination. Rejection waits for the killed child to close, preventing
   cleanup from racing a still-running process. Media probes remain in `video/ffmpeg.ts`.
3. **Guest bootstrap source.** Runtime shims, bridge/bootstrap, and page interactions now live in
   `sandbox/guest/`. The host module shrank from 1,792 to 717 lines. Generated JavaScript and its
   filenames are byte-for-byte unchanged; the guest capabilities and stack positions are preserved.
   Direct QuickJS tests and real-browser sandbox/security/interaction regressions cover the split.
4. **Provider probes/downloads.** `video/http.ts` shares stock JSON/download mechanics and local
   model-list probing. Providers retain their exact headers, search order, empty-body errors,
   timeouts, fallback policy, and attribution. Archive uses the shared duration probe with its
   original 120-second budget and unknown-duration fallback; sibling ffprobe resolution handles
   both slash conventions. Mocked transport tests make no external requests.
5. **Installation entry points.** Both entry points now use `dailies-runtime/install`; the legacy
   RPC remains supported. Extraction stays with each caller. The shared runner preserves inherited
   CLI output, framed/drained RPC streams, platform handling, diagnostics, and sequential failure
   behavior. The CLI still retires only an idle daemon after installation. Tests never invoke npm
   or download Chromium.

## Verification

Validation includes focused regression suites, the full repository check, the built CLI, npm package
contents, and a real Dailies recording against the repository's local form showcase. The smoke
exercises input interaction, persistent named-page state, sandbox file IO, a `constructor` step,
attachments, metrics, condensation, report rendering, and disk re-rendering. The generated report
was inspected through Dailies and as a rendered screenshot.

The initial review (`61321e6`) was validated on Linux with Node 26.8.2 and pnpm 9.15.0:

- `pnpm check`: docs synchronization, lint, workspace compilation/builds, and **1,027 passing tests**
  (822 CLI, 170 daemon, 21 daemon-client, 14 runtime); five existing opt-in tests skipped.
- `npm pack`: exactly the five documented files; the bundled license matches the root license;
  no runtime package dependencies. Extracted CLI prints `0.6.0` and valid standalone status JSON.
- Real recording: three passing steps, trace/HAR/video/console, three screenshots, an attachment,
  and a metric. Condensation reduced the recording from 2m 39s to 7.6s. Disk re-rendering preserved
  artifact/page metadata, metrics, and verdict with empty stderr and the daemon stopped.
- Real ffmpeg duration probe: normal ffprobe and deliberately unavailable ffprobe both report
  the same 0.25-second fixture duration.
- `git diff --check` and stitched-document checks pass. No changes to the vendored Playwright fork.

After all five follow-ups, the combined `pnpm check` passed again: **1,089 tests** (865 CLI,
178 daemon, 21 daemon-client, 25 runtime), with the same five opt-in skips. This includes the
successful narration/song render fixtures and direct guest-bootstrap tests. The extracted npm
package again contained exactly the expected five files, retained the root license, added no
runtime dependencies, and produced clean standalone version/status output. The earlier browser
recording remains initial-review evidence; the follow-up sandbox changes were exercised by the
real-browser integration suites rather than a new manual recording.

Windows/macOS behavior was reviewed and covered by relevant unit tests, not executed on those
operating systems. Live media-provider integration tests remain opt-in; no real model calls or
hosted generation were made. This work does not publish or deploy a release.
