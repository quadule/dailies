import { readFile } from "node:fs/promises";

// Both execution commands accept the same input: supplied text takes precedence
// over a file, and blank input must not become a phantom recorded step.
export async function readScript(args: {
  file?: string;
  script?: string;
}): Promise<string | undefined> {
  let script = args.script;
  if (script === undefined && args.file) {
    try {
      script = await readFile(args.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("No such file or directory (os error 2)");
      }
      throw err;
    }
  }
  if (script === undefined || script.trim() === "") {
    process.stderr.write("No script provided (pass a FILE or pipe stdin)\n");
    return;
  }
  return script;
}
