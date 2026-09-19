import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// Deliberately not `import.meta.dirname`: it landed in Node 20.11, which is
// exactly the engines floor, so it is the first thing to break if that floor
// ever moves back. This form runs on any Node 20 and matches its sibling,
// apps/dailies/scripts/build.mjs.
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
