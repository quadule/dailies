import { startEditorServer } from "../edit/editor/server.js";
import { openInOSDefault } from "../util/open.js";

// `dailies cut edit <id>`: serve the browser editor for a session on
// 127.0.0.1 until Ctrl-C. The URL goes to stdout (one line, or JSON with
// --json) so a script can pick it up; everything else goes to stderr.
export async function cutEdit(args: {
  sessionId: string;
  port?: number;
  open: boolean;
  json: boolean;
}): Promise<number> {
  const { sessionId } = args;
  let editor: Awaited<ReturnType<typeof startEditorServer>>;
  try {
    editor = await startEditorServer({ sessionId, port: args.port });
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }
  process.stdout.write(
    args.json
      ? `${JSON.stringify({ sessionId, url: editor.url })}\n`
      : `${editor.url}\n`
  );
  process.stderr.write(`Editing ${sessionId} — press Ctrl-C to stop\n`);
  if (args.open) {
    openInOSDefault(editor.url);
  }

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (editor.rendering()) {
        // A second Ctrl-C quits now; the render's partial file is left behind.
        process.stderr.write(
          "Finishing the render first — press Ctrl-C again to quit now\n"
        );
        process.once("SIGINT", () => process.exit(130));
      }
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  await editor.close();
  return 0;
}
