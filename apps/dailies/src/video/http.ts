// One User-Agent for every outbound fetch the media providers make.
//
// WHY it lives here: Wikimedia asks callers to identify themselves (a vague UA
// is throttled), archive.org appreciates the same, and both were getting it
// wrong in different ways — a hand-written string naming a repo that doesn't
// exist and a frozen "1.0", or no header at all. A shared helper means the
// version tracks the shipped build and the contact URL is right everywhere.
//
// The literal `process.env.DAILIES_CLI_VERSION` must stay spelled out: the
// esbuild bundle replaces that exact expression with the package version at
// build time (see scripts/build.mjs), so a destructured or computed lookup
// would silently fall back to "dev" in the published CLI.
const REPO_URL = "https://github.com/quadule/dailies";

export function userAgent(): string {
  const version = process.env.DAILIES_CLI_VERSION ?? "dev";
  return `dailies-cli/${version} (+${REPO_URL})`;
}
