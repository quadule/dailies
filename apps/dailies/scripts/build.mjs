#!/usr/bin/env node
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Build entry: bundles src/cli.ts into dist/cli.js with esbuild.
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");

// Wipe dist first. esbuild overwrites only what it emits, so an output it
// STOPPED producing lingers forever: a renamed dist/cli.cjs survived that way
// and kept shipping in the tarball long after nothing referenced it. The
// narrowed `files` in package.json is the second half of that fix.
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// Inject the package version so `dailies --version` reports it without reading
// package.json at runtime (the published bundle ships without an adjacent one).
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

const common = {
  entryPoints: [resolve(root, "src/cli.ts")],
  bundle: true,
  platform: "node",
  target: "node22.12",
  legalComments: "none",
  loader: {},
  external: [],
  define: {
    "process.env.DAILIES_CLI_VERSION": JSON.stringify(pkg.version),
  },
  logLevel: "info",
};

// ESM bundle — npm-published artifact. Banner gives the bundled module a
// real CJS-aware `require`, used by commander (CJS) when it loads node:*
// builtins via dynamic require.
const esm = build({
  ...common,
  outfile: resolve(dist, "cli.js"),
  format: "esm",
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  sourcemap: true,
});

await esm;
await chmod(resolve(dist, "cli.js"), 0o755);

// The published tarball must carry the MIT notice and its Canary/Sawyer Hood
// provenance. `pnpm publish` used to copy the workspace-root LICENSE in for
// free; `npm publish` does not — it only picks up a LICENSE sitting in the
// package directory, and it skips a symlinked one. So materialize it here
// (gitignored, like the embedded daemon asset) rather than committing a second
// copy that can drift from the root one.
await copyFile(resolve(root, "..", "..", "LICENSE"), resolve(root, "LICENSE"));
