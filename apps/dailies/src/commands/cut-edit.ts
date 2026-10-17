import { startEditorServer } from "../edit/editor/server.js";
import { openInOSDefault } from "../util/open.js";

// `dailies cut edit <id>`: serve the browser editor for a session on
// 127.0.0.1 until Ctrl-C. The URL goes to stdout (one line, or JSON with
// --json) so a script can pick it up; everything else goes to stderr.
//
// A Ctrl-C during a render lets the render finish: the editor starts the
// render's processes (ffmpeg, a say command) in process groups of their own,
// so the terminal's SIGINT reaches only this process. A second Ctrl-C quits
// at once, and exiting kills those processes (util/process.ts).
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
  // A closed terminal quits without waiting for anything; exiting (rather
  // than dying of the signal) is what kills a render's processes.
  process.once("SIGHUP", () => process.exit(129));

  const waited = await new Promise<boolean>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      const rendering = editor.rendering();
      if (rendering) {
        process.stderr.write(
          "Finishing the render first — press Ctrl-C again to quit now\n"
        );
        // Exiting kills the render's processes; its partial output and the
        // captions it already wrote are left until the next render.
        const quit = () => {
          process.stderr.write(
            `Render interrupted — \`dailies cut render ${sessionId}\` renders the cut again\n`
          );
          process.exit(130);
        };
        process.once("SIGINT", quit);
        process.once("SIGTERM", quit);
      }
      resolve(rendering);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  await editor.close();
  if (!waited) {
    return 0;
  }
  const status = editor.renderStatus();
  if (status.state === "done" && status.result) {
    process.stderr.write(`Rendered ${status.result.videoPath}\n`);
    return 0;
  }
  process.stderr.write(
    `The render failed: ${status.error ?? "no reason given"}\n`
  );
  return 1;
}
