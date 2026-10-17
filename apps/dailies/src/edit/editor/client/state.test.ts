import { describe, expect, it } from "vitest";
import type { Cut } from "../../cut.js";
import { uploadType } from "./recorder.js";
import { type Change, EditorState } from "./state.js";

function seed(): Cut {
  return {
    version: 1,
    video: "page.webm",
    voice: {},
    steps: [{ name: "open", at: 0 }],
    cuts: [],
    holds: [],
    speedups: [],
    captions: [{ start: 1, end: 2, text: "hello" }],
    narration: [],
  };
}

describe("EditorState", () => {
  it("starts saved and becomes unsaved on an edit", () => {
    const state = new EditorState(seed());
    expect(state.dirty).toBe(false);
    state.edit((cut) => {
      cut.holds.push({ at: 1, seconds: 2 });
      return { kind: "hold", index: 0 };
    });
    expect(state.dirty).toBe(true);
    expect(state.selection).toEqual({ kind: "hold", index: 0 });
  });

  it("undoes and redoes whole edits", () => {
    const state = new EditorState(seed());
    state.edit((cut) => {
      cut.captions.push({ start: 3, end: 4, text: "two" });
      return;
    });
    state.edit((cut) => {
      (cut.captions[0] as { text: string }).text = "changed";
      return;
    });
    state.undo();
    expect(state.cut.captions.map((c) => c.text)).toEqual(["hello", "two"]);
    state.undo();
    expect(state.cut.captions).toHaveLength(1);
    expect(state.dirty).toBe(false);
    expect(state.canUndo).toBe(false);
    state.redo();
    state.redo();
    expect(state.cut.captions.map((c) => c.text)).toEqual(["changed", "two"]);
    expect(state.canRedo).toBe(false);
  });

  it("makes a gesture one undo step", () => {
    const state = new EditorState(seed());
    state.begin();
    for (const start of [1.1, 1.2, 1.3]) {
      state.edit((cut) => {
        (cut.captions[0] as { start: number }).start = start;
        return;
      });
    }
    state.end();
    expect(state.cut.captions[0]?.start).toBe(1.3);
    state.undo();
    expect(state.cut.captions[0]?.start).toBe(1);
    expect(state.canUndo).toBe(false);
  });

  it("drops redo after a new edit", () => {
    const state = new EditorState(seed());
    state.edit((cut) => {
      cut.holds.push({ at: 1, seconds: 1 });
      return;
    });
    state.undo();
    state.edit((cut) => {
      cut.cuts.push({ start: 1, end: 2 });
      return;
    });
    expect(state.canRedo).toBe(false);
  });

  it("removes the selection and clears a stale one on undo", () => {
    const state = new EditorState(seed());
    state.select({ kind: "caption", index: 0 });
    expect(state.removeSelected()).toBe(true);
    expect(state.cut.captions).toHaveLength(0);
    expect(state.selection).toBeUndefined();
    expect(state.removeSelected()).toBe(false);
    state.undo();
    expect(state.cut.captions).toHaveLength(1);
  });

  it("takes the server's normalized cut after a save, unless edited meanwhile", () => {
    const state = new EditorState(seed());
    state.edit((cut) => {
      (cut.captions[0] as { start: number }).start = 1.033_333_3;
      return;
    });
    const sent = JSON.stringify(state.cut);
    const normalized = {
      ...seed(),
      captions: [{ start: 1.033, end: 2, text: "hello" }],
    };
    state.markSaved(normalized, sent);
    expect(state.cut.captions[0]?.start).toBe(1.033);
    expect(state.dirty).toBe(false);

    state.edit((cut) => {
      (cut.captions[0] as { text: string }).text = "typed";
      return;
    });
    const stale = JSON.stringify({ ...state.cut, captions: [] });
    state.markSaved(normalized, stale);
    expect(state.cut.captions[0]?.text).toBe("typed");
    expect(state.dirty).toBe(true);
  });

  it("tells subscribers what changed", () => {
    const state = new EditorState(seed());
    const seen: Change[] = [];
    state.subscribe((change) => seen.push(change));
    state.setMarks({ in: 1 });
    state.select({ kind: "caption", index: 0 });
    state.edit((cut) => {
      cut.holds.push({ at: 1, seconds: 1 });
      return;
    });
    expect(seen.map((c) => [c.marks, c.selection, c.cut])).toEqual([
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ]);
  });
});

describe("uploadType", () => {
  it("takes the types the server knows, ignoring parameters", () => {
    expect(uploadType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(uploadType("audio/wav")).toBe("audio/wav");
  });

  it("maps a browser's other names for them", () => {
    expect(uploadType("audio/x-m4a")).toBe("audio/mp4");
    expect(uploadType("audio/mp3")).toBe("audio/mpeg");
    expect(uploadType("video/webm")).toBe("audio/webm");
  });

  it("falls back to the file name", () => {
    expect(uploadType("", "take.m4a")).toBe("audio/mp4");
    expect(uploadType("application/octet-stream", "take.WAV")).toBe(
      "audio/wav"
    );
  });

  it("refuses the rest", () => {
    expect(uploadType("audio/flac", "take.flac")).toBeUndefined();
    expect(uploadType("")).toBeUndefined();
  });
});
