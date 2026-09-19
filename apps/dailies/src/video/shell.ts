// Shell-quoting helpers shared by the cinematic pipeline so every generation
// command it echoes is copy-pasteable into a terminal verbatim (the user can
// grab a line, tweak the voice/model/prompt, and re-run it by hand).

// Always quote, including otherwise safe paths in curl previews.
export function singleQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// Shell-quote one argument. POSIX single-quoting: wrap in '…' and escape any
// embedded ' as '\''. Bare tokens (letters, digits, and a few safe punctuation
// chars) pass through so the common case stays readable. The whole point is
// copy-paste reproduction — voice names like "Ava (Premium)" have spaces and
// parens and MUST survive. Pure → unit-tested.
export function shellQuote(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_./:@%+=-]+$/.test(arg)) {
    return arg;
  }
  return singleQuote(arg);
}

// Render a command + args as one copy-pasteable shell line. Pure → unit-tested.
export function formatCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].map(shellQuote).join(" ");
}
