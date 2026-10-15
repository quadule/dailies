import { sessionReportPath } from "dailies-daemon-client";
import { type CutRenderResult, renderCut } from "../edit/render.js";

// m:ss.s — a timeline position someone can scrub a player to.
export function at(sec: number): string {
  const tenths = Math.round(Math.max(0, sec) * 10);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Up to this many entries, the timeline lists everything. Past it (a long run
// has hundreds of steps and dozens of captions), it lists only the edits, each
// with the step on screen, and counts the rest — `--json` still has every one.
const FULL_TIMELINE_MAX = 40;

// The timeline `cut render` prints, in output time. Each edit names its source
// time ("written at") so it can be matched back to its line in cut.json.
export function timelineLines(result: CutRenderResult): string[] {
  const edits = [
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
  ];
  const steps = result.steps.map((s) => ({
    t: s.at,
    label: `step     ${s.name}`,
  }));
  const captions = result.captions.map((c) => ({
    t: c.start,
    label: `caption  "${c.text}" until ${at(c.end)}`,
  }));
  const row = (e: { t: number; label: string }) =>
    `${at(e.t).padStart(8)}  ${e.label}`;
  const byTime = (a: { t: number }, b: { t: number }) => a.t - b.t;
  const all = [...steps, ...edits, ...captions];
  if (all.length <= FULL_TIMELINE_MAX) {
    return all.sort(byTime).map(row);
  }
  // The step on screen at an output time: the last one to have started by then.
  const onScreen = (t: number) => {
    let shown: { name: string; at: number } | undefined;
    for (const step of result.steps) {
      if (step.at <= t + 0.05 && (!shown || step.at >= shown.at)) {
        shown = step;
      }
    }
    return shown?.name;
  };
  const lines = [
    `${count(result.steps.length, "step")} and ${count(result.captions.length, "caption")} placed (--json lists each). Edits:`,
  ];
  if (edits.length === 0) {
    lines.push("  (none — the video plays the cut as recorded)");
  }
  for (const edit of edits.sort(byTime)) {
    const step = onScreen(edit.t);
    lines.push(`  ${row(edit)}${step ? `   · during ${step}` : ""}`);
  }
  return lines;
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
  const timeline = timelineLines(result);
  if (timeline.length > 0) {
    out.write("\nIn the rendered video:\n");
    for (const line of timeline) {
      out.write(`  ${line}\n`);
    }
  }
  process.stdout.write(`${result.videoPath}\n`);
  return 0;
}
