import { describe, expect, it } from "vitest";
import { type Cut, type CutVoice, formatCut } from "../../cut.js";
import type { EditorSession, VoiceLineResponse } from "../contract.js";
import { ApiError } from "./api.js";
import { clipVoice, type VoicedClip } from "./preview.js";
import { EditorState } from "./state.js";
import {
  answeredClip,
  mergeVoiced,
  seedVoiced,
  stopsTheRest,
  unvoicedLines,
  type VoiceApi,
  type VoiceContext,
  Voicer,
} from "./voice.js";

const SAY: CutVoice = { narrator: "say" };

function cutOf(parts: Partial<Cut>): Cut {
  return {
    version: 1,
    video: "page.webm",
    voice: {},
    steps: [],
    cuts: [],
    holds: [],
    speedups: [],
    captions: [],
    narration: [],
    ...parts,
  };
}

function clip(text: string, voice: CutVoice = SAY, file = "cut/a.m4a") {
  return { text, voice: clipVoice(voice), file, durationSec: 1.5 };
}

describe("seedVoiced", () => {
  it("keys each listed clip by its line's words in the cut's voice", () => {
    const cut = cutOf({
      voice: { narrator: "say", speed: 1.2 },
      narration: [
        { at: 1, text: "Open the form" },
        { at: 2, text: "Here it is", audio: "recordings/rec-1.webm" },
      ],
    });
    expect(
      seedVoiced(cut, [
        { index: 0, file: "cut/tts-1.m4a", durationSec: 1.5 },
        // A recorded line, and an index the cut doesn't have: nothing to key.
        { index: 1, file: "cut/tts-2.m4a", durationSec: 1 },
        { index: 5, file: "cut/tts-3.m4a", durationSec: 1 },
      ])
    ).toEqual([
      {
        text: "Open the form",
        voice: { narrator: "say", name: "", speed: 1.2 },
        file: "cut/tts-1.m4a",
        durationSec: 1.5,
      },
    ]);
  });
});

describe("mergeVoiced", () => {
  it("adds clips, and a clip for the same words in the same voice replaces the old one", () => {
    const old = [clip("one", SAY, "cut/1.m4a"), clip("two", SAY, "cut/2.m4a")];
    const merged = mergeVoiced(old, [
      clip("two", SAY, "cut/2b.m4a"),
      clip("two", { narrator: "say", name: "Ava" }, "cut/2c.m4a"),
      clip("three", SAY, "cut/3.m4a"),
    ]);
    expect(merged.map((c) => c.file)).toEqual([
      "cut/1.m4a",
      "cut/2b.m4a",
      "cut/2c.m4a",
      "cut/3.m4a",
    ]);
    // The list it was given is left alone.
    expect(old.map((c) => c.file)).toEqual(["cut/1.m4a", "cut/2.m4a"]);
  });

  it("keys an answer by the words and the voice the server says", () => {
    const answer: VoiceLineResponse = {
      file: "cut/tts-1.m4a",
      durationSec: 1.5,
      text: "Open the form",
      voice: { narrator: "say" },
    };
    expect(answeredClip(answer)).toEqual({
      text: "Open the form",
      voice: { narrator: "say", name: "", speed: 1 },
      file: "cut/tts-1.m4a",
      durationSec: 1.5,
    });
  });
});

describe("unvoicedLines", () => {
  it("lists the text-to-speech lines with words and no clip in the cut's voice", () => {
    const cut = cutOf({
      voice: SAY,
      narration: [
        { at: 1, text: "voiced" },
        { at: 2, text: "not yet" },
        { at: 3, text: "", audio: "recordings/rec-1.webm" },
        { at: 4, text: "  " },
      ],
    });
    expect(unvoicedLines(cut, [clip("voiced")])).toEqual([1]);
    // Another voice: none of the clips apply.
    expect(
      unvoicedLines({ ...cut, voice: { narrator: "gemini" } }, [clip("voiced")])
    ).toEqual([0, 1]);
  });
});

describe("stopsTheRest", () => {
  it("stops on what fails every line the same way", () => {
    expect([0, 409, 503].every(stopsTheRest)).toBe(true);
    expect([400, 500].some(stopsTheRest)).toBe(false);
  });
});

// A server that voices every line in 1.5s and pins `say`, as the real one
// does on a machine whose only narrator is a say command.
function fakeServer(state: EditorState) {
  let disk = structuredClone(state.cut);
  const voiced: number[] = [];
  const server: VoiceApi & {
    disk(cut: Cut): void;
    fail?: ApiError;
    voiced: number[];
  } = {
    voiced,
    disk(cut) {
      disk = structuredClone(cut);
    },
    voiceLine(index) {
      if (server.fail) {
        return Promise.reject(server.fail);
      }
      voiced.push(index);
      disk.voice = disk.voice.narrator ? disk.voice : SAY;
      const line = disk.narration[index];
      return Promise.resolve({
        file: `cut/tts-${index}.m4a`,
        durationSec: 1.5,
        text: line?.text ?? "",
        voice: disk.voice,
      });
    },
    session() {
      return Promise.resolve({
        cut: structuredClone(disk),
        voiced: voiced.map((index) => ({
          index,
          file: `cut/tts-${index}.m4a`,
          durationSec: 1.5,
        })),
      } as unknown as EditorSession);
    },
  };
  return server;
}

function setup(cut: Cut) {
  const state = new EditorState(cut);
  const server = fakeServer(state);
  const messages: string[] = [];
  let saves = 0;
  const ctx: VoiceContext = {
    state,
    voiced: [] as VoicedClip[],
    refresh: () => undefined,
    status: (m) => messages.push(m),
  };
  const voicer = new Voicer(
    ctx,
    {
      blocked: () => undefined,
      changed: () => undefined,
      reload(fresh) {
        if (state.dirty) {
          state.setDisk(fresh.cut, { rendered: true });
        } else {
          state.load(fresh.cut, { rendered: true });
        }
      },
      save() {
        saves += 1;
        const sent = JSON.stringify(state.cut);
        const saved = JSON.parse(formatCut(state.cut)) as Cut;
        server.disk(saved);
        state.markSaved(saved, sent);
        return Promise.resolve(true);
      },
    },
    server
  );
  return { state, server, ctx, voicer, messages, saves: () => saves };
}

describe("Voicer", () => {
  it("saves first, voices the line, and takes back the voice it pinned", async () => {
    const { state, server, ctx, voicer, saves } = setup(
      cutOf({ narration: [{ at: 1 / 3, text: "Open the form" }] })
    );
    // Off the millisecond grid, so the save hands back new line objects
    // with rounded times and the line is found by its place.
    state.edit((cut) => {
      cut.narration.push({ at: 5 / 3, text: "Fill it in" });
      return;
    });
    const outcome = await voicer.voice(1);
    expect(outcome).toMatchObject({ file: "cut/tts-1.m4a", durationSec: 1.5 });
    expect(saves()).toBe(1);
    expect(server.voiced).toEqual([1]);
    expect(state.dirty).toBe(false);
    expect(state.cut.voice).toEqual(SAY);
    expect(ctx.voiced).toEqual([clip("Fill it in", SAY, "cut/tts-1.m4a")]);
    expect(voicer.phaseOf(1)).toMatchObject({ phase: "voiced" });
    expect(voicer.phaseOf(0).phase).toBe("idle");
    expect(voicer.busy).toBe(false);

    // Undo keeps the pin; editing the words drops the clip, undoing brings
    // it back.
    state.edit((cut) => {
      const line = cut.narration[1];
      if (line) {
        line.text = "Fill it in, then save";
      }
      return;
    });
    expect(voicer.phaseOf(1).phase).toBe("idle");
    state.undo();
    expect(voicer.phaseOf(1).phase).toBe("voiced");
    state.undo();
    expect(state.cut.voice).toEqual(SAY);
  });

  it("refuses a recorded line, a line with no words, and a second voicing", async () => {
    const { voicer, server } = setup(
      cutOf({
        narration: [
          { at: 1, text: "spoken" },
          { at: 2, text: "", audio: "recordings/rec-1.webm" },
          { at: 3, text: " " },
        ],
      })
    );
    expect(await voicer.voice(1)).toMatchObject({
      error: expect.stringContaining("recorded"),
    });
    expect(await voicer.voice(2)).toMatchObject({
      error: expect.stringContaining("Type what the line says"),
    });
    expect(await voicer.voice(9)).toMatchObject({
      error: expect.stringContaining("no narration line 9"),
    });
    const first = voicer.voice(0);
    expect(voicer.refusal(0)).toContain("one at a time");
    await first;
    expect(server.voiced).toEqual([0]);
  });

  it("keeps the server's message on the line, and a missing narrator stops Voice all", async () => {
    const { voicer, server, messages } = setup(
      cutOf({
        narration: [
          { at: 1, text: "one" },
          { at: 2, text: "two" },
        ],
      })
    );
    server.fail = new ApiError("no voice available for the narration", 503);
    await voicer.voiceAll();
    expect(voicer.batch.map((r) => r.state)).toEqual(["failed", "skipped"]);
    expect(voicer.phaseOf(0)).toEqual({
      phase: "failed",
      message: "no voice available for the narration",
    });
    expect(voicer.phaseOf(1).phase).toBe("idle");
    expect(messages.at(-1)).toContain("Voiced 0 of 2");

    // The narrator is back: the next run voices both, one after the other.
    server.fail = undefined;
    await voicer.voiceAll();
    expect(voicer.batch.map((r) => r.state)).toEqual(["voiced", "voiced"]);
    expect(server.voiced).toEqual([0, 1]);
    expect(voicer.phaseOf(0).phase).toBe("voiced");
    expect(messages.at(-1)).toBe("Voiced all 2");
  });

  it("goes on past a line the server couldn't voice", async () => {
    const { voicer, server } = setup(
      cutOf({
        narration: [
          { at: 1, text: "one" },
          { at: 2, text: "two" },
        ],
      })
    );
    const voiceLine = server.voiceLine;
    server.voiceLine = (index) =>
      index === 0
        ? Promise.reject(new ApiError("the say command failed", 500))
        : voiceLine(index);
    await voicer.voiceAll();
    expect(voicer.batch.map((r) => r.state)).toEqual(["failed", "voiced"]);
    expect(voicer.batch[0]?.message).toBe("the say command failed");
  });
});
