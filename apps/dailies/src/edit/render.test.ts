import { describe, expect, it } from "vitest";
import { narratorOf, singlePassArgs, voiceFromLabel } from "./render.js";

describe("narratorOf", () => {
  it("maps a TTS provider id to the narrator a cut names", () => {
    expect(narratorOf("gemini-tts")).toBe("gemini");
    expect(narratorOf("elevenlabs-tts")).toBe("elevenlabs");
    expect(narratorOf("omlx-tts")).toBe("omlx");
    expect(narratorOf("mystery-tts")).toBeUndefined();
  });
});

describe("voiceFromLabel", () => {
  it("reads the voice out of a provider label", () => {
    expect(voiceFromLabel("gemini:Charon")).toBe("Charon");
    expect(voiceFromLabel("elevenlabs:Aria")).toBe("Aria");
    expect(voiceFromLabel("omlx:kokoro/af_heart")).toBe("af_heart");
  });

  it("names no voice for a model that uses its default", () => {
    expect(voiceFromLabel("omlx:kokoro")).toBeUndefined();
  });
});

describe("singlePassArgs", () => {
  const base = {
    source: "/s/src.webm",
    videoFilter: "",
    clips: [] as { path: string; offsetSec: number }[],
    durationSec: 12.34,
    outPath: "/s/out.webm",
  };
  const burn = { srtPath: "/s/c.srt", bandPx: 162, style: "FontSize=42" };
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("asks for a plain copy when there is nothing to render", () => {
    expect(singlePassArgs(base)).toBeNull();
  });

  it("stream-copies the picture when only voice is added", () => {
    const args = singlePassArgs({
      ...base,
      clips: [{ path: "/s/a.m4a", offsetSec: 1.5 }],
    }) as string[];
    expect(after(args, "-c:v")).toBe("copy");
    expect(after(args, "-map")).toBe("0:v");
    expect(after(args, "-filter_complex")).toContain("[1:a]adelay=1500|1500");
    expect(after(args, "-c:a")).toBe("libopus");
    expect(after(args, "-t")).toBe("12.340");
  });

  it("cuts, burns and mixes in one encode", () => {
    const args = singlePassArgs({
      ...base,
      videoFilter: "fps=25,select='between(n,0,9)'",
      burn,
      clips: [{ path: "/s/a.m4a", offsetSec: 0 }],
    }) as string[];
    expect(after(args, "-filter_complex")).toBe(
      "[0:v]fps=25,select='between(n,0,9)',pad=iw:ih+162:0:0:color=black,subtitles='/s/c.srt':force_style='FontSize=42'[vout];[1:a]adelay=0|0[a0];[a0]amix=inputs=1:normalize=0:dropout_transition=0[aout]"
    );
    expect(after(args, "-map")).toBe("[vout]");
    expect(after(args, "-c:v")).toBe("libvpx");
    expect(after(args, "-cpu-used")).toBe("3");
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
  });

  it("leaves audio out when nothing is spoken", () => {
    const args = singlePassArgs({ ...base, burn }) as string[];
    expect(args).toContain("-an");
    expect(args).not.toContain("[aout]");
  });
});
