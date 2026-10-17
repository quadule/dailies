// The browser editor's HTTP contract: what `dailies cut edit` serves and what
// the client sends back. Shared by the server (server.ts) and the client
// bundle (client/main.ts), so this module must stay browser-safe — types and
// plain constants only, nothing that pulls in Node. AGENTS.md documents the
// routes these shapes travel over.

import type { NarratorChoice } from "../../video/media-preferences.js";
import type { Cut } from "../cut.js";
import type { CutRenderResult } from "../render.js";

// Every /api/* request must carry this header. A cross-site page can't add a
// custom header without a CORS preflight, and the server refuses preflights.
export const EDITOR_HEADER = "X-Dailies-Editor";
export const EDITOR_HEADER_VALUE = "1";

// Where uploaded voice recordings are saved, inside the session directory.
// Not under cut/ (the render's cache) or video/ (the artifact scanner's).
export const RECORDINGS_DIR = "recordings";

// The audio a recording upload may be, by Content-Type (parameters such as
// `;codecs=opus` are ignored), and the extension it is saved with.
export const RECORDING_TYPES: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

// Largest recording upload, in bytes.
export const MAX_RECORDING_BYTES = 200 * 1024 * 1024;

// A recorded step. `at` is SOURCE time (seconds into /source.webm), the same
// clock every time in the cut uses. Steps that never reached the recording
// are left out.
export interface EditorStep {
  at: number;
  durationMs: number;
  error?: string;
  name: string;
  ok: boolean;
  // "/screenshots/<file>.png" when the step left a screenshot.
  screenshot?: string;
  skim?: boolean;
}

// A voice recording saved in the session's recordings/ folder. `file` is the
// path a narration line's `audio` takes ("recordings/rec-….webm"); the audio
// itself is served at "/" + file.
export interface EditorRecording {
  durationSec: number;
  file: string;
}

// GET /api/session
export interface EditorSession {
  // Caption band geometry the render uses: the band added under the picture,
  // the font size in it, and how many characters fit on one line.
  caption: { bandPx: number; fontPx: number; lineMax: number };
  cut: Cut;
  id: string;
  name?: string;
  narrators: readonly NarratorChoice[];
  recordings: EditorRecording[];
  // The clean condensed recording every time in the cut points into.
  source: { durationSec: number; fps: number; height: number; width: number };
  steps: EditorStep[];
  // The rendered output. `url` changes (its `v`) after every render.
  video: { path: string; url: string };
}

// GET /api/render (also the body of POST /api/render's 202).
export interface RenderStatus {
  // Present when state is "error".
  error?: string;
  // renderCut's progress messages for the current or last render.
  progress: string[];
  // The last render that finished, kept while the next one runs.
  result?: CutRenderResult;
  state: "idle" | "running" | "done" | "error";
}

// PUT /api/cut → 200
export interface SaveCutResponse {
  cut: Cut;
}

// POST /api/recordings → 201
export type UploadRecordingResponse = EditorRecording;

// Every 4xx/5xx from /api/*.
export interface EditorError {
  error: string;
}
