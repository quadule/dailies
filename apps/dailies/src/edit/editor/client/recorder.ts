// Voice recordings for narration lines: upload audio to the session's
// recordings/ and attach it to a line. Today the audio comes from a file
// picker; microphone capture (getUserMedia + MediaRecorder) belongs here too
// and ends the same way, in attachRecording. The inspector shows whatever
// recordingControls returns in its narration section, so a Record button
// added there appears beside "Attach file…".

import { RECORDING_TYPES, type UploadRecordingResponse } from "../contract.js";
import { api } from "./api.js";
import type { EditorContext } from "./context.js";
import { h, icon } from "./dom.js";
import { snapTime } from "./format.js";

let bound: EditorContext | undefined;

export function bindRecorder(ctx: EditorContext): void {
  bound = ctx;
}

function context(): EditorContext {
  if (!bound) {
    throw new Error("the recorder isn't bound to the editor yet");
  }
  return bound;
}

// Types a browser gives audio files that the server knows by another name.
const ALIASES: Record<string, string> = {
  "audio/x-m4a": "audio/mp4",
  "audio/aac": "audio/mp4",
  "audio/mp3": "audio/mpeg",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "video/webm": "audio/webm",
  "application/ogg": "audio/ogg",
};

const BY_EXTENSION: Record<string, string> = {
  webm: "audio/webm",
  weba: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

// The Content-Type to upload audio as (one of RECORDING_TYPES), from the
// blob's own type or, failing that, its file name. Undefined when the server
// won't take it. Pure.
export function uploadType(type: string, name = ""): string | undefined {
  const base = type.split(";")[0]?.trim().toLowerCase() ?? "";
  const known = ALIASES[base] ?? base;
  if (known in RECORDING_TYPES) {
    return known;
  }
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return name.includes(".") ? BY_EXTENSION[ext] : undefined;
}

// Upload `blob` and attach it: to narration line `lineIndex` when given (its
// text stays, as the caption and the record of what it says), else as a new
// line at `atSec` (source seconds). One undo step; the new or changed line is
// selected. Resolves with the saved file and its length.
export async function attachRecording(
  blob: Blob,
  atSec: number,
  lineIndex?: number
): Promise<UploadRecordingResponse> {
  const ctx = context();
  const name = blob instanceof File ? blob.name : "";
  const type = uploadType(blob.type, name);
  if (!type) {
    throw new Error(
      `${name || "that audio"} is ${blob.type || "of an unknown type"} — a recording must be WebM, Ogg, M4A, MP3 or WAV`
    );
  }
  const saved = await api.uploadRecording(blob, type);
  ctx.session.recordings = [
    ...ctx.session.recordings.filter((r) => r.file !== saved.file),
    saved,
  ];
  ctx.state.edit((cut) => {
    const line = lineIndex === undefined ? undefined : cut.narration[lineIndex];
    if (line && lineIndex !== undefined) {
      line.audio = saved.file;
      return { kind: "line", index: lineIndex };
    }
    cut.narration.push({
      at: snapTime(atSec, ctx.grid),
      text: "",
      audio: saved.file,
    });
    return { kind: "line", index: cut.narration.length - 1 };
  });
  return saved;
}

// Pick an audio file and attach it, reporting the outcome in the status line.
async function attachPicked(
  input: HTMLInputElement,
  lineIndex: number | undefined
): Promise<void> {
  const ctx = context();
  const file = input.files?.[0];
  input.value = "";
  if (!file) {
    return;
  }
  ctx.status(`Uploading ${file.name}…`);
  try {
    const saved = await attachRecording(file, ctx.playhead(), lineIndex);
    ctx.status(
      `Attached ${saved.file} (${saved.durationSec.toFixed(1)}s) — save to keep it`
    );
  } catch (err) {
    ctx.status(
      `Couldn't attach ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      "error"
    );
  }
}

// The controls that bring audio into a line: a file picker for now. For a
// line that already has audio the picker replaces it.
export function recordingControls(
  lineIndex: number | undefined,
  hasAudio: boolean
): HTMLElement[] {
  const input = h("input", {
    type: "file",
    accept: "audio/*",
    class: "file-input",
    on: {
      change: () => {
        void attachPicked(input, lineIndex);
      },
    },
  });
  const label = h(
    "label",
    { class: "btn file-btn" },
    input,
    icon("upload"),
    h("span", { text: hasAudio ? "Replace from file…" : "Attach file…" })
  );
  return [label];
}
