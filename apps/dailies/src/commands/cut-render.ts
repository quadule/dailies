import { sessionReportPath } from "dailies-daemon-client";
import { renderCut } from "../edit/render.js";

// m:ss.s — a timeline position someone can scrub a player to.
export function at(sec: number): string {
  const tenths = Math.round(Math.max(0, sec) * 10);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

// `dailies cut render <id>`: rebuild the session video from its cut.json and
// print where everything landed, so whoever edited the cut (a person or an
// agent) can check the result without watching the whole video.
export async function cutRender(id: string, json: boolean): Promise<number> {
  process.stderr.write("Rendering the cut…\n");
  const result = await renderCut({
    sessionId: id,
    progress: (message) => process.stderr.write(`  · ${message}\n`),
    echo: () => {
      // The per-command ffmpeg echo is noise here; failures carry stderr.
    },
  });
  if ("error" in result) {
    process.stderr.write(`${result.error}\n`);
    return 1;
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ...result, reportPath: sessionReportPath(id) })}\n`
    );
    return 0;
  }
  const out = process.stderr;
  out.write(
    `  ✓ ${at(result.sourceDurationSec)} of footage → ${at(result.durationSec)} video\n`
  );
  for (const note of result.notes) {
    out.write(`  · ${note}\n`);
  }
  for (const warning of result.warnings) {
    out.write(`  ⚠ ${warning}\n`);
  }
  // Every edit, in output time. Each entry names its source time ("written at")
  // so it can be matched back to its line in cut.json.
  const timeline = [
    ...result.steps.map((s) => ({ t: s.at, label: `step     ${s.name}` })),
    ...result.cuts.map((c) => ({
      t: c.outAt,
      label: `cut      ${(c.end - c.start).toFixed(1)}s removed (written at ${c.start.toFixed(2)}–${c.end.toFixed(2)})`,
    })),
    ...result.holds.map((h) => ({
      t: h.outAt,
      label: `hold     ${h.seconds.toFixed(1)}s freeze (written at ${h.at.toFixed(2)})`,
    })),
    ...result.speedups.map((v) => ({
      t: v.outAt,
      label: `speedup  ${v.rate}x until ${at(v.outEnd)} (written at ${v.start.toFixed(2)}–${v.end.toFixed(2)})`,
    })),
    ...result.lines.map((l) => ({
      t: l.outStart,
      label: `line     "${l.text}" (${l.durationSec.toFixed(1)}s, written at ${l.at.toFixed(2)})`,
    })),
    ...result.captions.map((c) => ({
      t: c.start,
      label: `caption  "${c.text}" until ${at(c.end)}`,
    })),
  ].sort((a, b) => a.t - b.t);
  if (timeline.length > 0) {
    out.write("\nIn the rendered video:\n");
    for (const entry of timeline) {
      out.write(`  ${at(entry.t).padStart(8)}  ${entry.label}\n`);
    }
  }
  process.stdout.write(`${result.videoPath}\n`);
  return 0;
}
