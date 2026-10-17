// The editor server's API, typed by ../contract.ts. Every /api/* request
// carries the editor header; every error answer is `{ error }`, surfaced here
// as an ApiError with the server's own message.

import type { Cut } from "../../cut.js";
import {
  EDITOR_HEADER,
  EDITOR_HEADER_VALUE,
  type EditorError,
  type EditorSession,
  type RenderStatus,
  type SaveCutResponse,
  type UploadRecordingResponse,
  type VoiceLineRequest,
  type VoiceLineResponse,
} from "../contract.js";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(
  method: string,
  url: string,
  body?: { json: unknown } | { blob: Blob; type: string }
): Promise<T> {
  const headers: Record<string, string> = {
    [EDITOR_HEADER]: EDITOR_HEADER_VALUE,
  };
  let payload: BodyInit | undefined;
  if (body && "json" in body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body.json);
  } else if (body) {
    headers["Content-Type"] = body.type;
    payload = body.blob;
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch {
    throw new ApiError(
      "the editor server isn't answering — is `dailies cut edit` still running?",
      0
    );
  }
  if (res.status === 204) {
    return undefined as T;
  }
  const data = (await res.json().catch(() => ({}))) as T & Partial<EditorError>;
  if (!res.ok) {
    throw new ApiError(
      data.error ?? `${method} ${url} failed (${res.status})`,
      res.status
    );
  }
  return data;
}

export const api = {
  session: () => call<EditorSession>("GET", "/api/session"),
  saveCut: (cut: Cut) =>
    call<SaveCutResponse>("PUT", "/api/cut", { json: cut }),
  startRender: () => call<RenderStatus>("POST", "/api/render"),
  renderStatus: () => call<RenderStatus>("GET", "/api/render"),
  uploadRecording: (blob: Blob, type: string) =>
    call<UploadRecordingResponse>("POST", "/api/recordings", { blob, type }),
  // `name` is the bare file name in recordings/.
  deleteRecording: (name: string) =>
    call<undefined>("DELETE", `/api/recordings/${encodeURIComponent(name)}`),
  // Voice the text-to-speech line at `index` of the cut on disk.
  voiceLine: (index: number) =>
    call<VoiceLineResponse>("POST", "/api/voice", {
      json: { index } satisfies VoiceLineRequest,
    }),
};
