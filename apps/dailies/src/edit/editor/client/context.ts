// What the editor's views share: the session, the state, the current
// analysis of the cut, and the stage's playhead. main.ts builds it and keeps
// `analysis` current before the views refresh.

import type { EditorSession } from "../contract.js";
import type { Grid } from "./format.js";
import type { Analysis, RenderedLine } from "./preview.js";
import type { EditorState } from "./state.js";

export interface EditorContext {
  analysis: Analysis;
  grid: Grid;
  // Stop playback (scrubbing does).
  pause(): void;
  // The playhead, in source seconds.
  playhead(): number;
  // The session changed under the views (a recording deleted): recompute
  // and redraw.
  refresh(): void;
  // Voiced lines from the last render, for line durations.
  rendered: RenderedLine[];
  seek(sec: number): void;
  session: EditorSession;
  state: EditorState;
  // A message in the status line; "error" ones are styled and read as such.
  status(message: string, tone?: "error"): void;
}
