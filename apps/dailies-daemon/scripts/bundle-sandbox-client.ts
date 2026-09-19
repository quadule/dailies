import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// Resolve from this script, matching apps/dailies/scripts/build.mjs.
const daemonDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = resolve(
  daemonDir,
  "src/sandbox/forked-client/bundle-entry.ts"
);
const outfile = resolve(daemonDir, "dist/sandbox-client.js");

await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [entryPoint],
  bundle: true,
  format: "iife",
  globalName: "__PlaywrightClient",
  outfile,
  platform: "neutral",
  target: "es2022",
});
