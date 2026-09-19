# Contributing

Thanks for your interest in dailies.

## Before you open a PR

1. Open an issue first to discuss substantial changes — bugfixes are welcome directly.
2. Run `make check` locally; CI runs the same.
3. Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, etc.) — the `commit-msg` hook enforces this.

## Dev loop

```bash
make install     # pnpm install
make build       # build everything
make test        # run all tests
make check       # what CI runs
```

Per-workspace:

```bash
pnpm --filter dailies-daemon dev        # run the daemon from source (tsx)
pnpm --filter dailies-cli    dev        # run the CLI from source (tsx)
pnpm --filter dailies-cli    test:watch # vitest in watch mode (same for dailies-daemon)
```

## House rules

- No `console.*` in committed code — use `dailies-logger` for diagnostics and `process.stdout` for CLI output (enforced by Biome's `noConsole`).
- All new code is TypeScript with `strict: true` and no `any`.
- Tests are vitest, colocated: `foo.test.ts` sits beside `foo.ts` (or in a `__tests__/` directory next to it, as the daemon's sandbox does). The only `test/` directories hold what has no single source file to sit next to — the CLI's help snapshots and shared helpers (`apps/dailies/test/`) and `packages/daemon-client/test/`.
- Ultracite (Biome) formats and lints everything; the pre-commit hook runs `ultracite fix` on staged files (`pnpm lint` / `pnpm format` to run manually).
- Shared doc content (scripting API, workflow rules) lives in `docs/snippets/` — edit there and run `make docs`; don't hand-edit the stitched regions in `skills/`/`README.md` or `packages/cli-kit/src/snippets.generated.ts` (`make check` fails on drift).
