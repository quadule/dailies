import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mapLimit, parseFilterNames } from "./ffmpeg.js";
import {
  buildAudioMix,
  buildModelCredits,
  captionBandPx,
  captionFontPx,
  duckEnvelope,
  groupedLyricSteps,
  groupStepsForLyrics,
  layoutSongCues,
  lyricsPathFor,
  narrationJobs,
  orderGroupLyrics,
  planRetime,
  planSongTiming,
  precinematicVideoPath,
  songHoldSec,
  songTargetSec,
  stepFootageSec,
  subtitleStyle,
  titleMaxChars,
  titleStyle,
  ttsConcurrency,
  voiceCredit,
  wrapTitle,
} from "./narrate.js";
import {
  buildLyricsPrompt,
  buildNarrationPrompt,
  changeScaleHint,
  extractCaptions,
  normalizeTitle,
  parseLyricsJson,
  parseNarrationJson,
} from "./script-llm.js";
import {
  customSaySynth,
  parseInstalledVoices,
  pickVoice,
  sayCommand,
  speechText,
} from "./speech.js";
import {
  buildSrt,
  captionLineMax,
  padCaptionBox,
  secToSrtTimestamp,
  wrapCaption,
} from "./srt.js";

describe("secToSrtTimestamp", () => {
  it("formats zero as 00:00:00,000", () => {
    expect(secToSrtTimestamp(0)).toBe("00:00:00,000");
  });

  it("formats sub-second values with zero-padded milliseconds", () => {
    expect(secToSrtTimestamp(2.5)).toBe("00:00:02,500");
    expect(secToSrtTimestamp(0.07)).toBe("00:00:00,070");
    expect(secToSrtTimestamp(0.004)).toBe("00:00:00,004");
  });

  it("rolls minutes and seconds over correctly", () => {
    expect(secToSrtTimestamp(61.2)).toBe("00:01:01,200");
    expect(secToSrtTimestamp(125)).toBe("00:02:05,000");
  });

  it("handles values past one hour", () => {
    expect(secToSrtTimestamp(3661.123)).toBe("01:01:01,123");
  });

  it("clamps negatives to zero", () => {
    expect(secToSrtTimestamp(-5)).toBe("00:00:00,000");
  });
});

describe("buildSrt", () => {
  it("numbers cues from 1 and emits start/end/text blocks", () => {
    // Each one-line cue is padded to the two-line caption box with a U+00A0, so
    // the burn's bottom-anchored margin puts every first line at the band top.
    const srt = buildSrt([
      { start: 2.5, end: 6.2, text: "Our operative approaches." },
      { start: 6.2, end: 9, text: "The credentials are entered." },
    ]);
    expect(srt).toBe(
      "1\n00:00:02,500 --> 00:00:06,200\nOur operative approaches.\n\u00A0\n\n" +
        "2\n00:00:06,200 --> 00:00:09,000\nThe credentials are entered.\n\u00A0\n"
    );
  });

  it("returns an empty string for no cues", () => {
    expect(buildSrt([])).toBe("");
  });
});

describe("padCaptionBox", () => {
  it("pads a one-line cue up to the two-line box", () => {
    // The pad is what top-aligns a short cue: the burn style's MarginV is sized
    // for the full box, so a cue rendering fewer lines floats down inside it.
    expect(padCaptionBox("one line")).toBe("one line\n\u00A0");
  });

  it("leaves a full box alone", () => {
    expect(padCaptionBox("line one\nline two")).toBe("line one\nline two");
  });

  it("pads with U+00A0, not a space", () => {
    // Measured: ffmpeg's SRT decoder drops a whitespace-only trailing line, so
    // an ASCII space pad renders at the unpadded height and defeats the point.
    expect(padCaptionBox("x").split("\n").at(-1)).toBe("\u00A0");
    expect(padCaptionBox("x")).not.toBe("x\n ");
  });

  it("leaves an empty cue empty", () => {
    // Padding it would put a lone invisible character on screen, making a cue
    // with no words look like a caption.
    expect(padCaptionBox("")).toBe("");
  });
});

describe("buildAudioMix", () => {
  it("returns an empty string for zero tracks", () => {
    expect(buildAudioMix([])).toBe("");
  });

  it("wires a single full-volume track at index 1 into amix", () => {
    expect(buildAudioMix([{ delayMs: 2500 }])).toBe(
      "[1:a]adelay=2500|2500[a0];[a0]amix=inputs=1:normalize=0:dropout_transition=0[aout]"
    );
  });

  it("delays narration tracks and scales a music bed's volume", () => {
    expect(
      buildAudioMix([
        { delayMs: 0 },
        { delayMs: 3500 },
        { delayMs: 0, volume: 0.16 },
      ])
    ).toBe(
      "[1:a]adelay=0|0[a0];" +
        "[2:a]adelay=3500|3500[a1];" +
        "[3:a]adelay=0|0,volume=0.160[a2];" +
        "[a0][a1][a2]amix=inputs=3:normalize=0:dropout_transition=0[aout]"
    );
  });

  it("cross-fades the single score track from quiet bed to credits swell", () => {
    expect(
      buildAudioMix([
        {
          delayMs: 0,
          volume: 0.16,
          fadeOutAtSec: 18.5,
          fadeOutDurSec: 1.5,
        },
        {
          delayMs: 20_000,
          volume: 0.6,
          fadeInAtSec: 20,
          fadeInDurSec: 1.5,
        },
      ])
    ).toBe(
      "[1:a]adelay=0|0,volume=0.160,afade=t=out:st=18.500:d=1.500[a0];" +
        "[2:a]adelay=20000|20000,volume=0.600,afade=t=in:st=20.000:d=1.500[a1];" +
        "[a0][a1]amix=inputs=2:normalize=0:dropout_transition=0[aout]"
    );
  });

  it("appends a duck envelope after a bed's volume, single-quoted", () => {
    const f = buildAudioMix([
      { delayMs: 2500 },
      { delayMs: 0, volume: 0.1, duckExpr: "1-0.700*(X)" },
    ]);
    expect(f).toBe(
      "[1:a]adelay=2500|2500[a0];" +
        "[2:a]adelay=0|0,volume=0.100,volume='1-0.700*(X)':eval=frame[a1];" +
        "[a0][a1]amix=inputs=2:normalize=0:dropout_transition=0[aout]"
    );
  });
});

describe("duckEnvelope", () => {
  it("is empty when there are no narration windows", () => {
    expect(duckEnvelope([], { factor: 0.3, ramp: 0.25 })).toBe("");
  });

  it("rests at 1 and dips to `factor` across a ramped window", () => {
    const e = duckEnvelope([{ startSec: 2, endSec: 5 }], {
      factor: 0.3,
      ramp: 0.25,
    });
    // 1 minus (1-factor)=0.700 times a single clamped trapezoid pulse.
    expect(e).toBe("1-0.700*(clip(min((t-1.750)/0.250,(5.250-t)/0.250),0,1))");
  });

  it("takes the max across multiple windows so any line ducks", () => {
    const e = duckEnvelope(
      [
        { startSec: 1, endSec: 2 },
        { startSec: 4, endSec: 6 },
      ],
      { factor: 0.3, ramp: 0.25 }
    );
    expect(e).toContain("max(");
    expect(e.match(/clip\(/g)).toHaveLength(2);
    expect(e.startsWith("1-0.700*(")).toBe(true);
  });
});

describe("parseNarrationJson", () => {
  const valid =
    '{"title":"THE CAPER","steps":[{"index":0,"narration":"He approaches."}]}';

  it("parses clean JSON", () => {
    expect(parseNarrationJson(valid)).toEqual({
      title: "THE CAPER",
      steps: [{ index: 0, narration: "He approaches." }],
    });
  });

  const fence = "```";

  it("strips ```json fences before parsing", () => {
    expect(parseNarrationJson(`${fence}json\n${valid}\n${fence}`)).toEqual({
      title: "THE CAPER",
      steps: [{ index: 0, narration: "He approaches." }],
    });
  });

  it("strips bare ``` fences", () => {
    expect(parseNarrationJson(`${fence}\n${valid}\n${fence}`)).not.toBeNull();
  });

  it("recovers JSON from a chatty preamble (first { to last })", () => {
    expect(
      parseNarrationJson(
        `Sure! Here is the narration:\n${valid}\nHope it helps!`
      )
    ).toEqual({
      title: "THE CAPER",
      steps: [{ index: 0, narration: "He approaches." }],
    });
  });

  it("strips libass override tags from narration", () => {
    const parsed = parseNarrationJson(
      '{"title":"X","steps":[{"index":0,"narration":"{\\\\pos(9,9)}sneaky {\\\\fs99}text"}]}'
    );
    expect(parsed?.steps[0]?.narration).toBe("sneaky text");
  });

  it("returns null on garbage", () => {
    expect(parseNarrationJson("not json at all")).toBeNull();
    expect(parseNarrationJson("")).toBeNull();
  });

  it("returns null when the shape is wrong", () => {
    expect(parseNarrationJson('{"title":"x"}')).toBeNull();
    expect(parseNarrationJson('{"steps":[]}')).toBeNull();
    expect(parseNarrationJson('{"title":42,"steps":[]}')).toBeNull();
    expect(
      parseNarrationJson(
        '{"title":"x","steps":[{"index":"0","narration":"y"}]}'
      )
    ).toBeNull();
    expect(
      parseNarrationJson('{"title":"x","steps":[{"index":0}]}')
    ).toBeNull();
    expect(parseNarrationJson("[]")).toBeNull();
    expect(parseNarrationJson("null")).toBeNull();
  });

  it("recovers valid JSON despite a preamble or trailing prose (incl. braces)", () => {
    const body = '{"title":"T","steps":[{"index":0,"narration":"clean line"}]}';
    const expected = {
      title: "T",
      steps: [{ index: 0, narration: "clean line" }],
    };
    expect(parseNarrationJson(`Sure! Here is the narration:\n${body}`)).toEqual(
      expected
    );
    // Trailing prose that itself contains a brace must not drag the parse past
    // the real closing brace (the old firstOpen..lastClose slice would break).
    expect(parseNarrationJson(`${body}\n\nNote: adjust {as needed}.`)).toEqual(
      expected
    );
  });

  it("returns null on a truncated (unbalanced) reply", () => {
    expect(
      parseNarrationJson(
        '{"title":"T","steps":[{"index":0,"narration":"cut off'
      )
    ).toBeNull();
  });
});

describe("buildNarrationPrompt", () => {
  const steps = [
    { index: 0, name: "Open the login page", script: "page.open('/login')" },
    { index: 1, name: "Fill the password field" },
  ];

  it("embeds the creative direction and every step name", () => {
    const prompt = buildNarrationPrompt({
      direction: "1970s heist thriller, narrated as a limerick",
      steps,
    });
    expect(prompt).toContain(
      "Creative direction: 1970s heist thriller, narrated as a limerick"
    );
    expect(prompt).toContain("Open the login page");
    expect(prompt).toContain("Fill the password field");
  });

  it("demands strict JSON output", () => {
    const prompt = buildNarrationPrompt({
      direction: "nature documentary",
      steps,
    });
    expect(prompt).toContain("STRICT JSON");
    expect(prompt).toContain('"title"');
  });

  it("includes a step's script slice when present", () => {
    const prompt = buildNarrationPrompt({
      direction: "noir",
      steps,
    });
    expect(prompt).toContain("page.open('/login')");
  });

  it("surfaces showCaption text as an intent note, even past the slice", () => {
    // The caption sits far beyond SCRIPT_SLICE_CHARS (200) so the script slice
    // alone would drop it — extractCaptions reads the full script.
    const pad = "// filler ".repeat(40);
    const prompt = buildNarrationPrompt({
      direction: "noir",
      steps: [
        {
          index: 0,
          name: "Submit the form",
          script: `${pad}\nawait page.showCaption("Verifying the discount applies");`,
        },
      ],
    });
    expect(prompt).toContain('intent: "Verifying the discount applies"');
  });

  it("embeds the change scale as a SECONDARY cue when provided", () => {
    const withChange = buildNarrationPrompt({
      direction: "noir",
      change: {
        label: "45 commits, 71 files, +7386/-402",
        scaleHint: "large — go expansive",
      },
      steps,
    });
    expect(withChange).toContain("change under review is 45 commits");
    expect(withChange).toContain("SECONDARY");
    expect(withChange).toContain("go expansive");
    const without = buildNarrationPrompt({ direction: "noir", steps });
    expect(without).not.toContain("change under review");
  });
});

describe("precinematicVideoPath", () => {
  it("inserts .precinematic before the extension", () => {
    expect(precinematicVideoPath("/s/abc/video.webm")).toBe(
      "/s/abc/video.precinematic.webm"
    );
    expect(precinematicVideoPath("/s/abc/clip.mp4")).toBe(
      "/s/abc/clip.precinematic.mp4"
    );
  });
});

describe("songTargetSec", () => {
  it("scales with LYRIC-LINE count, clamped to [90s, 165s]", () => {
    expect(songTargetSec(0)).toBe(90);
    expect(songTargetSec(8)).toBe(90); // 2.5 + 72 + 12 = 86.5 → floored
    expect(songTargetSec(11)).toBe(114); // 2.5 + 99 + 12 = 113.5 → 114
    expect(songTargetSec(16)).toBe(159); // 2.5 + 144 + 12 = 158.5 → 159
    expect(songTargetSec(30)).toBe(165); // 2.5 + 270 + 12 = 284.5 → capped
  });
});

describe("stepFootageSec", () => {
  it("uses gaps between step positions, and the last step's own duration", () => {
    expect(
      stepFootageSec([
        { videoTime: 0, durationMs: 9999 },
        { videoTime: 2, durationMs: 9999 },
        { videoTime: 7, durationMs: 3000 }, // last: falls back to durationMs
      ])
    ).toEqual([2, 5, 3]);
  });
});

describe("groupStepsForLyrics", () => {
  it("groups consecutive steps until each group reaches the minimum span", () => {
    // 2+2+2 -> [0,1,2] hits 6>=5.5; 2+2 -> [3,4] is 4<5.5 so folds trailing in
    expect(groupStepsForLyrics([2, 2, 2, 2, 2], 5.5)).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
  });
  it("keeps a long step as its own group and folds a short tail into the last", () => {
    expect(groupStepsForLyrics([6, 1, 1], 5.5)).toEqual([[0], [1, 2]]);
  });
  it("returns a single group when nothing reaches the threshold", () => {
    expect(groupStepsForLyrics([1, 1, 2], 5.5)).toEqual([[0, 1, 2]]);
  });
  it("handles an empty list", () => {
    expect(groupStepsForLyrics([], 5.5)).toEqual([]);
  });
});

describe("groupedLyricSteps", () => {
  it("joins each group's names and scripts into one indexed entry", () => {
    const steps = [
      { name: "open", script: "goto('/')" },
      { name: "search", script: "fill('q')" },
      { name: "buy", script: "click('pay')" },
    ];
    expect(groupedLyricSteps(steps, [[0, 1], [2]])).toEqual([
      { index: 0, name: "open → search", script: "goto('/')\nfill('q')" },
      { index: 1, name: "buy", script: "click('pay')" },
    ]);
  });
});

describe("normalizeTitle", () => {
  it("turns a literal backslash-n into a real newline (for two-line titles)", () => {
    expect(normalizeTitle("SHE FORGOT\\nEVERYTHING")).toBe(
      "SHE FORGOT\nEVERYTHING"
    );
  });

  describe("titleMaxChars", () => {
    // 720p title card: fontSize = height/12 = 60.
    const W = 1280;
    const SIZE = 60;

    it("wraps an all-caps title that the old estimate let run off-frame", () => {
      // Regression: "AN APA_DECOUPLE_PAY_METHOD EXPOSÉ" is 33 chars and the old
      // formula allowed 33, so it stayed on one line and rendered past both
      // edges of the frame.
      const title =
        "BACKSTAGE AT THE PAYMENT RAIL\nAN APA_DECOUPLE_PAY_METHOD EXPOSÉ";
      const max = titleMaxChars(title, W, SIZE);
      expect(max).toBeLessThan(33);
      for (const line of wrapTitle(title, max)) {
        expect(line.length).toBeLessThanOrEqual(max);
      }
    });

    it("allows more characters for mixed-case than for all-caps", () => {
      expect(titleMaxChars("a quiet lowercase title", W, SIZE)).toBeGreaterThan(
        titleMaxChars("A LOUD UPPERCASE TITLE", W, SIZE)
      );
    });

    it("leaves room for the scrim border, not just the margin", () => {
      // The naive estimate — margin only, mixed-case ratio — must be an
      // overestimate of what actually fits.
      const naive = Math.floor((W * 0.82) / (SIZE * 0.52));
      expect(titleMaxChars("A LOUD UPPERCASE TITLE", W, SIZE)).toBeLessThan(
        naive
      );
    });

    it("never returns a uselessly small width", () => {
      expect(titleMaxChars("WIDE", 320, 200)).toBeGreaterThanOrEqual(8);
    });
    // wrapTitle then splits it into two lines.
    expect(wrapTitle(normalizeTitle("A\\nB"), 40)).toEqual(["A", "B"]);
  });
  it("leaves a real newline and plain title untouched (trimmed)", () => {
    expect(normalizeTitle("THE\nCAPER")).toBe("THE\nCAPER");
    expect(normalizeTitle("  PLAIN TITLE  ")).toBe("PLAIN TITLE");
  });
});

describe("speechText", () => {
  it("turns verse slash/pipe separators into spoken pauses", () => {
    expect(speechText("roses are red / violets are blue")).toBe(
      "roses are red, violets are blue"
    );
    expect(speechText("dawn|dusk|night")).toBe("dawn, dusk, night");
    expect(speechText("a // b")).toBe("a, b");
  });
  it("does not leave doubled commas or stray spaces", () => {
    expect(speechText("one , / two")).toBe("one, two");
    expect(speechText("  keep   it  tidy  ")).toBe("keep it tidy");
  });
  it("leaves ordinary prose untouched", () => {
    expect(speechText("The quick brown fox jumps.")).toBe(
      "The quick brown fox jumps."
    );
  });
});

describe("songHoldSec", () => {
  it("floors short lines and scales with word count", () => {
    expect(songHoldSec("two words")).toBe(3.5); // floor
    expect(songHoldSec("")).toBe(3.5);
    // 10 words → 10/2.5 + 1 = 5s
    expect(
      songHoldSec("one two three four five six seven eight nine ten")
    ).toBe(5);
  });
  it("caps very long lines", () => {
    expect(songHoldSec(Array.from({ length: 40 }, () => "x").join(" "))).toBe(
      6.5
    );
  });
});

describe("layoutSongCues", () => {
  it("leaves well-spread lines at their natural times", () => {
    const cues = layoutSongCues(
      [
        { start: 2, text: "a" },
        { start: 6, text: "b" },
        { start: 10, text: "c" },
      ],
      30
    );
    expect(cues.map((c) => c.start)).toEqual([2, 6, 10]);
    // Non-last hold to the next start; last gets the tail (3s default).
    expect(cues[0]?.end).toBe(6);
    expect(cues[2]?.end).toBe(13);
  });

  it("pushes bunched lines apart so they never overlap", () => {
    const cues = layoutSongCues(
      [
        { start: 2, text: "a" },
        { start: 9, text: "b" },
        { start: 9.1, text: "c" },
        { start: 9.2, text: "d" },
      ],
      40,
      { minDurSec: 1.4 }
    );
    // Each cue starts at or after the previous end — no overlap.
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]?.start).toBeGreaterThanOrEqual(cues[i - 1]?.end ?? 0);
    }
    // The bunched trio is spaced by the minimum display duration.
    expect(cues[2]?.start).toBeCloseTo(10.4, 5);
    expect(cues[3]?.start).toBeCloseTo(11.8, 5);
  });

  it("clamps to the video end and drops lines with no room left", () => {
    const cues = layoutSongCues(
      [
        { start: 1, text: "a" },
        { start: 1.1, text: "b" },
        { start: 1.2, text: "c" },
      ],
      3,
      { minDurSec: 1.4, tailSec: 3 }
    );
    expect(cues.every((c) => c.end <= 3)).toBe(true);
    // Only the lines that fit before the 3s end survive.
    expect(cues.length).toBeLessThan(3);
  });
});

describe("lyricsPathFor", () => {
  it("swaps the video extension for .lyrics.txt", () => {
    expect(lyricsPathFor("/s/abc/video.webm")).toBe("/s/abc/video.lyrics.txt");
    expect(lyricsPathFor("/s/abc/clip.mp4")).toBe("/s/abc/clip.lyrics.txt");
  });
});

describe("sayCommand", () => {
  it("defaults to `say` and honors $DAILIES_SAY_COMMAND", () => {
    expect(sayCommand({})).toBe("say");
    expect(sayCommand({ DAILIES_SAY_COMMAND: "/usr/local/bin/mysay" })).toBe(
      "/usr/local/bin/mysay"
    );
    expect(sayCommand({ DAILIES_SAY_COMMAND: "  " })).toBe("say");
  });
});

describe("customSaySynth", () => {
  it("passes the text as the only arg and writes to $DAILIES_SAY_OUTPUT", async () => {
    // A stand-in TTS command: it carries its own arg, reads the text from "$1",
    // and writes to the env-provided output path — exactly the custom contract.
    const synth = customSaySynth(
      'printf "%s" "$1" > "$DAILIES_SAY_OUTPUT" # --some-flag'
    );
    const out = path.join(os.tmpdir(), `dailies-customsay-${process.pid}.txt`);
    try {
      await synth.run("hello from dailies", out);
      expect(readFileSync(out, "utf8")).toBe("hello from dailies");
    } finally {
      rmSync(out, { force: true });
    }
  });
});

describe("voiceCredit", () => {
  it("formats the oMLX, Gemini, and say/custom cases", () => {
    expect(voiceCredit("omlx-tts", "omlx:Qwen3-TTS")).toBe(
      "Voice — oMLX Qwen3-TTS"
    );
    expect(voiceCredit("gemini-tts", "gemini:Charon")).toBe(
      "Voice — Charon (Google Gemini)"
    );
    expect(voiceCredit(undefined, "Ava (Premium)")).toBe(
      "Voice — Ava (Premium)"
    );
    expect(voiceCredit(undefined, "")).toBe("Voice — system speech");
  });
});

describe("captionBandPx", () => {
  it("scales the band with the frame", () => {
    expect(captionBandPx(720)).toBe(130);
    expect(captionBandPx(1080)).toBe(194);
  });

  it("never goes below a two-line minimum on a small frame", () => {
    expect(captionBandPx(200)).toBe(96);
  });

  it("falls back to the minimum when the probe failed", () => {
    // Padding by 0 would silently put captions back over the recording, which
    // is the whole thing this band exists to prevent.
    expect(captionBandPx(undefined)).toBe(96);
    expect(captionBandPx(0)).toBe(96);
    expect(captionBandPx(Number.NaN)).toBe(96);
  });
});

describe("subtitleStyle", () => {
  it("pins PlayRes to the real frame so sizes are in pixels", () => {
    // Without this libass scales against its own default resolution and the
    // same FontSize renders at wildly different sizes per frame — which put two
    // lines taller than the band, half of them over the recording.
    const style = subtitleStyle(850, 130, 1280);
    expect(style).toContain("PlayResY=850");
    // PlayResX is the REAL width, not frameHeight * 16/9. The band makes the
    // padded frame taller than the recording, so it is never 16:9 — the old
    // derivation gave 1511 here, and 1888 for a 1440x900 capture.
    expect(style).toContain("PlayResX=1280");
  });

  it("stops libass adding a line of its own", () => {
    // The caption box is exactly two lines and MarginV is sized for exactly
    // two, so a line libass re-wrapped would put a third row over the recording.
    expect(subtitleStyle(850, 130, 1280)).toContain("WrapStyle=2");
  });

  it("puts two lines at the top of the band, inside it", () => {
    const band = 130;
    const style = subtitleStyle(850, band, 1280);
    const size = Number(/FontSize=(\d+)/.exec(style)?.[1]);
    const margin = Number(/MarginV=(\d+)/.exec(style)?.[1]);

    // Bottom-anchored, because Alignment=8 is not an option: measured against the
    // subtitles filter it centres the caption over the recording and ignores
    // MarginV entirely. So the margin is the clearance BELOW the text, and two
    // lines of ink (~2 * FontSize) have to fit above it without leaving the band.
    expect(style).toContain("Alignment=2");
    expect(margin + 2 * size).toBeLessThanOrEqual(band);
    // Sitting at the TOP means little band left above the text.
    expect(band - (margin + 2 * size)).toBeLessThanOrEqual(
      Math.round(band * 0.2)
    );
  });

  it("sizes the margin for the box, which is what top-aligns a short cue", () => {
    // A one-line cue is padded to the same two-line box (padCaptionBox), so the
    // clearance below the box is all that varies — never the first line's y.
    // Measured at 1440x900 before the padding: a one-line cue's first line
    // started 62px below the band top, a two-line cue's at 20px.
    const band = captionBandPx(900);
    const style = subtitleStyle(900 + band, band, 1440);
    const size = Number(/FontSize=(\d+)/.exec(style)?.[1]);
    const margin = Number(/MarginV=(\d+)/.exec(style)?.[1]);
    expect(band - margin - 2 * size).toBeLessThanOrEqual(
      Math.round(band * 0.1)
    );
  });

  it("leaves a seek bar's worth of empty band under the text", () => {
    // The whole point: a player draws its scrubber and timecode along the bottom
    // edge, so the last row of text has to stay well clear of it.
    const band = 130;
    const style = subtitleStyle(850, band, 1280);
    const size = Number(/FontSize=(\d+)/.exec(style)?.[1]);
    const margin = Number(/MarginV=(\d+)/.exec(style)?.[1]);

    expect(margin).toBeGreaterThanOrEqual(size);
  });

  it("stays legible on a small frame", () => {
    const size = Number(
      /FontSize=(\d+)/.exec(subtitleStyle(240, 96, 320))?.[1]
    );
    expect(size).toBeGreaterThanOrEqual(14);
  });
});

describe("captionFontPx", () => {
  it("scales with the band", () => {
    expect(captionFontPx(captionBandPx(720))).toBe(34);
    expect(captionFontPx(captionBandPx(900))).toBe(42);
  });

  it("is the same size subtitleStyle renders at", () => {
    // The chars-per-line budget is a multiple of this, so a drift between the
    // two would put a caption line over the frame width.
    const band = captionBandPx(900);
    const style = subtitleStyle(900 + band, band, 1440);
    expect(style).toContain(`FontSize=${captionFontPx(band)}`);
  });

  it("stays legible on a tiny band", () => {
    expect(captionFontPx(10)).toBe(14);
  });
});

describe("buildModelCredits", () => {
  it("always credits narration, then voice, then any music/title art used", () => {
    expect(
      buildModelCredits({
        voiceLabel: "omlx:M",
        ttsId: "omlx-tts",
        musicId: "archive-music",
        titleArtId: "gemini-image",
      })
    ).toEqual([
      "Narration — Claude (Anthropic)",
      "Voice — oMLX M",
      "Music — archive.org (Creative Commons)",
      "Title art — Nano Banana (Google Gemini)",
    ]);
  });

  it("prefers a specific image credit over the generic tool line", () => {
    expect(
      buildModelCredits({
        voiceLabel: "Samantha",
        ttsId: undefined,
        musicId: undefined,
        titleArtId: "wikimedia-image",
        titleArtCredit:
          "Title art — Jane Doe (Wikimedia Commons, CC BY-SA 4.0)",
      })
    ).toContain("Title art — Jane Doe (Wikimedia Commons, CC BY-SA 4.0)");
  });

  it("falls back to the generic tool line when no specific credit is given", () => {
    expect(
      buildModelCredits({
        voiceLabel: "Samantha",
        ttsId: undefined,
        musicId: undefined,
        titleArtId: "wikimedia-image",
      })
    ).toContain("Title art — Wikimedia Commons (CC)");
  });

  it("does not credit the built-in local gradient as title art", () => {
    expect(
      buildModelCredits({
        voiceLabel: "Samantha",
        ttsId: undefined,
        musicId: undefined,
        titleArtId: "local-gradient",
      })
    ).toEqual(["Narration — Claude (Anthropic)", "Voice — Samantha"]);
  });

  it("drops the generic music line when a dedicated Music credit already names it", () => {
    // A resolved provider.credit() (the "Music" section) credits the score
    // richly; the generic "Music — <tool>" line would be a second credit.
    expect(
      buildModelCredits({
        voiceLabel: "omlx:M",
        ttsId: "omlx-tts",
        musicId: "acestep-music",
        titleArtId: undefined,
        hasMusicCredit: true,
      })
    ).toEqual(["Narration — Claude (Anthropic)", "Voice — oMLX M"]);
  });

  it("omits music and title art when none were used", () => {
    expect(
      buildModelCredits({
        voiceLabel: "Samantha",
        ttsId: undefined,
        musicId: undefined,
        titleArtId: undefined,
      })
    ).toEqual(["Narration — Claude (Anthropic)", "Voice — Samantha"]);
  });

  it("credits lyrics (not narration) and drops the voice line in song mode", () => {
    expect(
      buildModelCredits({
        voiceLabel: "ignored",
        ttsId: "omlx-tts",
        musicId: "acestep-music",
        titleArtId: undefined,
        song: true,
      })
    ).toEqual(["Lyrics — Claude (Anthropic)", "Music — ACE-Step 1.5 (local)"]);
  });
});

describe("parseLyricsJson", () => {
  it("parses {title, steps:[{index, lyric}]} into ordered lines", () => {
    const raw =
      '{"title":"THE BUILD","steps":[{"index":0,"lyric":"we open the door"},{"index":1,"lyric":"we ship it green"}]}';
    expect(parseLyricsJson(raw)).toEqual({
      title: "THE BUILD",
      lines: [
        { index: 0, text: "we open the door" },
        { index: 1, text: "we ship it green" },
      ],
    });
  });

  it("strips code fences, tolerates a preamble, and drops blank lines", () => {
    const fence = "```";
    const body =
      '{"title":"X","steps":[{"index":0,"lyric":"la"},{"index":1,"lyric":"  "}]}';
    expect(parseLyricsJson(`${fence}json\n${body}\n${fence}`)).toEqual({
      title: "X",
      lines: [{ index: 0, text: "la" }],
    });
    expect(parseLyricsJson(`Here you go: ${body}`)).toEqual({
      title: "X",
      lines: [{ index: 0, text: "la" }],
    });
  });

  it("rejects a bad title, a missing/empty steps array, or malformed entries", () => {
    expect(parseLyricsJson('{"title":"x"}')).toBeNull();
    expect(parseLyricsJson('{"steps":[{"index":0,"lyric":"a"}]}')).toBeNull();
    expect(
      parseLyricsJson('{"title":"","steps":[{"index":0,"lyric":"a"}]}')
    ).toBeNull();
    // All lines blank → no usable line survives.
    expect(
      parseLyricsJson('{"title":"x","steps":[{"index":0,"lyric":"  "}]}')
    ).toBeNull();
    expect(parseLyricsJson('{"title":"x","steps":[{"index":0}]}')).toBeNull();
    expect(parseLyricsJson('{"title":"x","steps":"nope"}')).toBeNull();
    expect(parseLyricsJson("not json")).toBeNull();
    expect(parseLyricsJson("")).toBeNull();
  });
});

describe("buildLyricsPrompt", () => {
  it("asks for one short singable line per step, as strict per-step JSON", () => {
    const prompt = buildLyricsPrompt({
      direction: "80s power ballad",
      videoSeconds: 12,
      steps: [
        { index: 0, name: "open", script: "await page.goto('/')" },
        { index: 1, name: "login" },
      ],
    });
    expect(prompt).toContain("80s power ballad");
    expect(prompt).toContain(
      '{"title": string, "steps": [{"index": number, "lyric": string}]}'
    );
    // One line per step, count called out.
    expect(prompt).toContain("2 lines total");
    expect(prompt).toContain("0. open");
    expect(prompt).toContain("1. login");
    // No spoken narration in song mode.
    expect(prompt).toContain("there is no spoken narration");
  });

  it("holds lines short and singable regardless of section length (ACE-Step best practice)", () => {
    // A long overall runtime with few sections used to ask for very long lines
    // (words scaled with the per-section window), which ACE-Step sings sparsely.
    // The line budget is now fixed and short no matter the length.
    const short = buildLyricsPrompt({
      direction: "epic",
      videoSeconds: 12,
      steps: [{ index: 0, name: "open" }],
    });
    const long = buildLyricsPrompt({
      direction: "epic",
      videoSeconds: 600,
      steps: [{ index: 0, name: "open" }],
    });
    // Same short line guidance either way — length never inflates the line.
    expect(short).toContain("6–10 syllables");
    expect(long).toContain("6–10 syllables");
    expect(long).toContain(
      "Do NOT make a line longer just because its section is long"
    );
    // The old "sung in Ns" per-section budget is gone.
    expect(long).not.toMatch(/sung in roughly/);
  });
});

describe("extractCaptions", () => {
  it("returns [] for empty or caption-free scripts", () => {
    expect(extractCaptions(undefined)).toEqual([]);
    expect(extractCaptions("await page.humanClick('#go')")).toEqual([]);
  });

  it("pulls text from every showCaption call, across quote styles", () => {
    const script = [
      `await page.showCaption("double quoted");`,
      `await page.showCaption('single quoted');`,
      "await page.showCaption(`template literal`);",
    ].join("\n");
    expect(extractCaptions(script)).toEqual([
      "double quoted",
      "single quoted",
      "template literal",
    ]);
  });

  it("unescapes embedded quotes and ignores the durationMs option", () => {
    const script = `await page.showCaption("she said \\"hi\\"", { durationMs: 5000 });`;
    expect(extractCaptions(script)).toEqual(['she said "hi"']);
  });
});

describe("wrapTitle", () => {
  it("greedily word-wraps to the char limit", () => {
    expect(wrapTitle("THE GREAT PULL REQUEST CAPER", 12)).toEqual([
      "THE GREAT",
      "PULL REQUEST",
      "CAPER",
    ]);
  });

  it("honors explicit newlines as forced breaks", () => {
    expect(wrapTitle("ACT ONE\nThe Setup", 100)).toEqual([
      "ACT ONE",
      "The Setup",
    ]);
  });

  it("keeps an over-long single word whole", () => {
    expect(wrapTitle("SUPERCALIFRAGILISTIC", 8)).toEqual([
      "SUPERCALIFRAGILISTIC",
    ]);
  });

  it("never returns an empty array", () => {
    expect(wrapTitle("", 10)).toEqual([""]);
  });
});

describe("wrapCaption", () => {
  it("leaves a short caption on a single line", () => {
    expect(wrapCaption("Our operative approaches.", 48)).toBe(
      "Our operative approaches."
    );
  });

  it("wraps a longer caption onto two lines", () => {
    const out = wrapCaption(
      "The operative enters the stolen credentials and waits for the redirect.",
      30,
      2
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(31); // 30 + room for the ellipsis
    }
  });

  it("truncates with an ellipsis when it would exceed two lines", () => {
    const out = wrapCaption(
      "This narration is far too long to ever fit within a mere two short caption lines on screen.",
      20,
      2
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(out.endsWith("…")).toBe(true);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });

  it("returns an empty string for blank input", () => {
    expect(wrapCaption("   ", 48)).toBe("");
  });
});

describe("captionLineMax", () => {
  const budgetFor = (w: number, h: number) =>
    captionLineMax(w, captionFontPx(captionBandPx(h)));

  it("uses far more of the frame than the old width-only budget", () => {
    // Both of these were 48 before, because the budget only looked at the width.
    // Measured on burned frames, 48 chars of prose filled ~55% of a 1440x900
    // frame — the "captions should use more of the width" report.
    //
    // The 1280x720 default computes 63 and takes the readability cap instead;
    // 1440x900 is width-limited at 58.
    expect(budgetFor(1280, 720)).toBe(60);
    expect(budgetFor(1440, 900)).toBe(58);
  });

  it("shrinks when the frame is taller for its width, not just narrower", () => {
    // The font comes from the band, the band from the HEIGHT — so a 4:3 capture
    // has a bigger font in the same width and must take fewer characters. A
    // width-only budget gave all three of these the same 48 and overflowed the
    // last one.
    expect(budgetFor(1440, 900)).toBe(58);
    expect(budgetFor(1440, 1080)).toBe(48);
    expect(budgetFor(1280, 1024)).toBe(45);
  });

  it("caps a very wide frame for readability", () => {
    // Two lines of the cap still hold the ~95-char narration maximum, and a
    // longer single line stops being readable.
    expect(budgetFor(3440, 1440)).toBe(60);
  });

  it("floors a tiny frame so it shows words rather than an ellipsis", () => {
    expect(captionLineMax(120, 40)).toBe(12);
  });

  it("falls back to the cap when the probe gave nothing", () => {
    expect(captionLineMax(undefined, undefined)).toBe(60);
    expect(captionLineMax(0, 34)).toBe(60);
    expect(captionLineMax(1280, 0)).toBe(60);
    expect(captionLineMax(Number.NaN, 34)).toBe(60);
  });

  it("keeps the widest prose inside the frame at the budget it returns", () => {
    // The invariant the measurements pin down: budget * (widest prose px/char)
    // must stay under the frame width, or libass would have to re-wrap the line.
    // 0.528 * FontSize is measured all-caps prose; the auto-wrap threshold is
    // ~98% of the frame.
    for (const [w, h] of [
      [1280, 720],
      [1440, 900],
      [1440, 1080],
      [800, 600],
    ]) {
      const font = captionFontPx(captionBandPx(h as number));
      const widest = budgetFor(w as number, h as number) * 0.528 * font;
      expect(widest).toBeLessThan((w as number) * 0.95);
    }
  });
});

describe("changeScaleHint", () => {
  it("sizes by length/energy without imposing a format", () => {
    expect(changeScaleHint(1, 10)).toContain("very small");
    expect(changeScaleHint(45, 7788)).toContain("large");
    // Format-agnostic: never names a film/trailer that could fight the theme.
    expect(changeScaleHint(45, 7788)).not.toMatch(/film|trailer|epic movie/);
  });

  it("scales through the middle tiers", () => {
    expect(changeScaleHint(2, 200)).toContain("small");
    expect(changeScaleHint(7, 600)).toContain("medium");
  });
});

describe("titleStyle", () => {
  it("maps categories to accent colors (white default)", () => {
    expect(titleStyle(undefined).color).toBe("white");
    expect(titleStyle("commercial").color).toBe("0xFFD400");
  });

  it("resolves font to an installed file or undefined (cross-platform)", () => {
    const font = titleStyle("movie").font;
    expect(font === undefined || existsSync(font)).toBe(true);
  });
});

describe("parseInstalledVoices", () => {
  it("keeps the full `-v` name, quality tag, and locale per line", () => {
    const stdout = [
      "Ava (Premium)       en_US    # Hello! My name is Ava.",
      "Samantha            en_US    # Hello! My name is Samantha.",
      "Daniel (Enhanced)   en_GB    # Hello! My name is Daniel.",
    ].join("\n");
    const voices = parseInstalledVoices(stdout);

    const ava = voices.find((v) => v.name === "Ava");
    // The "(Premium)" suffix IS part of the usable -v name — passing the bare
    // name selects the compact variant.
    expect(ava?.full).toBe("Ava (Premium)");
    expect(ava?.quality).toBe("Premium");
    expect(ava?.locale).toBe("en_US");

    const samantha = voices.find((v) => v.name === "Samantha");
    expect(samantha?.full).toBe("Samantha");
    expect(samantha?.quality).toBe("Default");

    const daniel = voices.find((v) => v.name === "Daniel");
    expect(daniel?.full).toBe("Daniel (Enhanced)");
    expect(daniel?.quality).toBe("Enhanced");
    expect(daniel?.locale).toBe("en_GB");
  });

  it("ignores blank lines and returns an empty array for empty input", () => {
    expect(parseInstalledVoices("")).toEqual([]);
    expect(parseInstalledVoices("\n\n  \n")).toEqual([]);
  });
});

describe("pickVoice", () => {
  const original = process.env.DAILIES_SAY_VOICE;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.DAILIES_SAY_VOICE;
    } else {
      process.env.DAILIES_SAY_VOICE = original;
    }
  });

  const parse = (lines: string[]) => parseInstalledVoices(lines.join("\n"));

  it("never picks a robotic base voice when a premium one is installed", () => {
    delete process.env.DAILIES_SAY_VOICE;
    const voices = parse([
      "Ava (Premium)       en_US    # Hello!",
      "Samantha            en_US    # Hello!",
    ]);
    // Only one premium voice, so the pick is deterministic regardless of random.
    for (let i = 0; i < 10; i++) {
      expect(pickVoice(voices)).toBe("Ava (Premium)");
    }
  });

  it("prefers Premium over Enhanced, US English over other English", () => {
    delete process.env.DAILIES_SAY_VOICE;
    const voices = parse([
      "Daniel (Enhanced)   en_GB    # Hello!",
      "Serena (Premium)    en_GB    # Hello!",
      "Ava (Premium)       en_US    # Hello!",
    ]);
    for (let i = 0; i < 10; i++) {
      expect(pickVoice(voices)).toBe("Ava (Premium)");
    }
  });

  it("falls through to an enhanced voice when no premium exists", () => {
    delete process.env.DAILIES_SAY_VOICE;
    const voices = parse([
      "Daniel (Enhanced)   en_US    # Hello!",
      "Samantha            en_US    # Hello!",
    ]);
    expect(pickVoice(voices)).toBe("Daniel (Enhanced)");
  });

  it("honors an explicit $DAILIES_SAY_VOICE override", () => {
    process.env.DAILIES_SAY_VOICE = "Karen (Premium)";
    expect(pickVoice(parse(["Ava (Premium)  en_US  # Hi"]))).toBe(
      "Karen (Premium)"
    );
  });

  it("falls back to Samantha when nothing is installed", () => {
    delete process.env.DAILIES_SAY_VOICE;
    expect(pickVoice([])).toBe("Samantha");
  });
});

describe("parseFilterNames", () => {
  it("extracts filter names from `ffmpeg -filters` rows", () => {
    const stdout = [
      "Filters:",
      "  T. adelay            A->A       Delay one or more audio channels.",
      "  .. amix              N->A       Audio mixing.",
      "  T. drawtext          V->V       Draw text on top of video frames.",
      "  .. concat            N->N       Concatenate audio and video streams.",
    ].join("\n");
    const names = parseFilterNames(stdout);
    expect(names.has("adelay")).toBe(true);
    expect(names.has("amix")).toBe(true);
    expect(names.has("drawtext")).toBe(true);
    expect(names.has("concat")).toBe(true);
  });

  it("omits filters absent from a minimal build", () => {
    const stdout = [
      "  T. adelay            A->A       Delay one or more audio channels.",
      "  .. amix              N->A       Audio mixing.",
    ].join("\n");
    const names = parseFilterNames(stdout);
    expect(names.has("drawtext")).toBe(false);
    expect(names.has("subtitles")).toBe(false);
  });

  it("ignores header and legend lines without an I/O column", () => {
    expect(parseFilterNames("Filters:\n  Legend without arrows\n").size).toBe(
      0
    );
  });
});

describe("planRetime", () => {
  it("freezes a step whose narration outruns its footage, and shifts later steps", () => {
    // Two steps 3s apart in an 8s video; narration is 12s and 11s.
    const plan = planRetime({
      stepTimes: [1, 4],
      clipDurSec: [12, 11],
      totalSec: 8,
    });
    expect(plan.leadSec).toBe(1); // [0,1) preserved before the first step
    // footage: step0 = 4-1 = 3, step1 = 8-4 = 4
    expect(plan.footage).toEqual([3, 4]);
    // hold = max(0, dur - footage): 12-3=9, 11-4=7
    expect(plan.holds).toEqual([9, 7]);
    // starts: step0 begins after the lead; step1 after step0's full slot (3+9)
    expect(plan.starts).toEqual([1, 1 + 3 + 9]);
    // each slot is long enough for its narration (no overlap)
    const [start0 = 0, start1 = 0] = plan.starts;
    expect(start1 - start0).toBeGreaterThanOrEqual(12);
  });

  it("adds no hold when footage already covers the narration", () => {
    const plan = planRetime({
      stepTimes: [0, 5],
      clipDurSec: [2, 1],
      totalSec: 10,
    });
    expect(plan.holds).toEqual([0, 0]);
    expect(plan.starts).toEqual([0, 5]);
  });

  it("handles a step with no narration (zero duration)", () => {
    const plan = planRetime({
      stepTimes: [1, 4],
      clipDurSec: [0, 6],
      totalSec: 8,
    });
    expect(plan.holds[0]).toBe(0);
    expect(plan.holds[1]).toBe(2); // 6 - (8-4)=2
  });

  it("inserts a leading still pad before each step's action", () => {
    // Same as the first case but with a 0.5s start pad before each step.
    const plan = planRetime({
      stepTimes: [1, 4],
      clipDurSec: [12, 11],
      totalSec: 8,
      startPadSec: 0.5,
    });
    expect(plan.footage).toEqual([3, 4]);
    expect(plan.holds).toEqual([9, 7]);
    // step0 action starts after the lead + its pad; step1 after step0's full slot
    // (pad + footage + hold) + its own pad.
    expect(plan.starts).toEqual([1 + 0.5, 1 + 0.5 + 3 + 9 + 0.5]);
  });

  it("floors the gap between consecutive lines with gapSec (but not after the last)", () => {
    // Two back-to-back lines that each exactly fill their footage: with no gap the
    // next line would start the instant the previous ends. A 0.6s gap adds a beat
    // to every non-last step's hold.
    const plan = planRetime({
      stepTimes: [0, 3],
      clipDurSec: [3, 4], // step0 line == footage (3s); step1 is last
      totalSec: 7,
      gapSec: 0.6,
    });
    // step0: max(0, 3-3+0.6) = 0.6 gap-hold; step1 (last): max(0, 4-4+0) = 0
    expect(plan.holds).toEqual([0.6, 0]);
    // the second line now starts 0.6s after the first ends (3 + 0.6)
    const [s0 = 0, s1 = 0] = plan.starts;
    expect(s1 - (s0 + 3)).toBeCloseTo(0.6, 5);
  });

  it("adds no extra hold for gapSec when footage already leaves that much slack", () => {
    // step0 footage 5s, line only 2s → 3s of natural gap already, well over 0.6s.
    const plan = planRetime({
      stepTimes: [0, 5],
      clipDurSec: [2, 1],
      totalSec: 10,
      gapSec: 0.6,
    });
    expect(plan.holds).toEqual([0, 0]);
    expect(plan.starts).toEqual([0, 5]);
  });
});

describe("planRetime — onset-anchored (song step-sync)", () => {
  it("clips overruns and freeze-pads underruns to hit each onset window", () => {
    const plan = planRetime({
      stepTimes: [0, 3, 7],
      clipDurSec: [],
      totalSec: 10,
      onsets: [5, 12, 18],
      bodyEnd: 25,
    });
    expect(plan.leadSec).toBe(5); // instrumental lead before the first line
    expect(plan.starts).toEqual([5, 12, 18]); // each step starts at its onset
    // footage = min(natural, window): [min(3,7), min(4,6), min(3,7)]
    expect(plan.footage).toEqual([3, 4, 3]);
    // hold = window - footage: [7-3, 6-4, 7-3]
    expect(plan.holds).toEqual([4, 2, 4]);
  });
  it("hard-cuts a step whose footage overruns its window (tail clipped, no drift)", () => {
    const plan = planRetime({
      stepTimes: [0],
      clipDurSec: [],
      totalSec: 20,
      onsets: [2],
      bodyEnd: 5,
    });
    expect(plan.footage).toEqual([3]); // 20s of footage clipped to the 3s window
    expect(plan.holds).toEqual([0]);
    expect(plan.starts).toEqual([2]);
  });
});

describe("orderGroupLyrics", () => {
  const groups = [[0, 1], [2], [3, 4, 5]];

  it("maps each lyric line back onto its group's steps", () => {
    const { lineByGroup, ordered } = orderGroupLyrics(groups, [
      { index: 0, text: "the login screen waits" },
      { index: 1, text: "a password typed in haste" },
      { index: 2, text: "and the dashboard blooms" },
    ]);
    expect(ordered).toEqual([
      { firstStep: 0, stepIdxs: [0, 1], text: "the login screen waits" },
      { firstStep: 2, stepIdxs: [2], text: "a password typed in haste" },
      { firstStep: 3, stepIdxs: [3, 4, 5], text: "and the dashboard blooms" },
    ]);
    expect(lineByGroup.get(1)).toBe("a password typed in haste");
  });

  it("drops groups the model left without a line, keeping the rest in group order", () => {
    const { ordered } = orderGroupLyrics(groups, [
      { index: 2, text: "only the last verse" },
      { index: 0, text: "and the first" },
    ]);
    // Ordered by GROUP ordinal, not by the model's reply order.
    expect(ordered.map((o) => o.text)).toEqual([
      "and the first",
      "only the last verse",
    ]);
    expect(ordered.map((o) => o.firstStep)).toEqual([0, 3]);
  });

  it("returns nothing for no lines", () => {
    expect(orderGroupLyrics(groups, []).ordered).toEqual([]);
  });
});

describe("planSongTiming — no vocal region (untranscribed)", () => {
  const groups = [[0, 1], [2]];
  const lineByGroup = new Map([
    [0, "a short line"],
    [1, "another short line"],
  ]);

  it("holds each group long enough to sing its line, split across its steps", () => {
    const timing = planSongTiming({
      clipCues: [],
      groups,
      lineByGroup,
      lineCount: 2,
      maxCueSec: 8,
      region: null,
      sourceLabel: "",
      stepCount: 3,
    });
    expect(timing.alignedCues).toEqual([]);
    expect(timing.trimStartSec).toBe(0);
    expect(timing.onsets).toBeUndefined();
    expect(timing.bodyEnd).toBeUndefined();
    // songHoldSec("a short line") floors at 3.5, so the group minimum (7) wins
    // and is split across that group's two steps; the one-step group gets 7.
    expect(timing.holdDurSec).toEqual([3.5, 3.5, 7]);
    expect(timing.note).toContain("vocal timing not detected");
  });

  it("leaves a step whose group got no line at the small default", () => {
    const timing = planSongTiming({
      clipCues: [],
      groups: [[0], [1]],
      lineByGroup: new Map([[1, "only the second group sings"]]),
      lineCount: 1,
      maxCueSec: 8,
      region: null,
      sourceLabel: "",
      stepCount: 2,
    });
    expect(timing.holdDurSec[0]).toBe(3.5);
    expect(timing.holdDurSec[1]).toBe(7);
  });
});

describe("planSongTiming — vocal region", () => {
  const groups = [[0], [1]];
  const lineByGroup = new Map([
    [0, "first line"],
    [1, "second line"],
  ]);

  it("rebases cues to the trim, splits the body evenly, and onset-anchors", () => {
    const timing = planSongTiming({
      clipCues: [
        { start: 10, end: 14, text: "first line" },
        { start: 14, end: 18, text: "second line" },
      ],
      groups,
      lineByGroup,
      lineCount: 2,
      maxCueSec: 8,
      region: { start: 8, end: 20 },
      sourceLabel: "the detected vocals",
      stepCount: 2,
    });
    expect(timing.trimStartSec).toBe(8);
    expect(timing.alignedCues).toEqual([
      { start: 2, end: 6, text: "first line" },
      { start: 6, end: 10, text: "second line" },
    ]);
    // bodyLen = 20 - 8 = 12, split across 2 steps.
    expect(timing.holdDurSec).toEqual([6, 6]);
    expect(timing.bodyEnd).toBe(12); // last cue end + 2
    expect(timing.onsets).toEqual([2, 6]); // each step starts when its line is sung
    expect(timing.note).toBe(
      "captions aligned to the detected vocals (2/2 lines sung)"
    );
  });

  it("caps a cue whose end runs past maxCueSec (a long instrumental gap)", () => {
    const timing = planSongTiming({
      clipCues: [{ start: 0, end: 25, text: "first line" }],
      groups: [[0]],
      lineByGroup: new Map([[0, "first line"]]),
      lineCount: 1,
      maxCueSec: 8,
      region: { start: 0, end: 30 },
      sourceLabel: "the model's own lyric timestamps",
      stepCount: 1,
    });
    expect(timing.alignedCues).toEqual([
      { start: 0, end: 8, text: "first line" },
    ]);
  });

  it("floors a cue straddling the trim point and drops one entirely before it", () => {
    const timing = planSongTiming({
      clipCues: [
        { start: 1, end: 3, text: "dropped" },
        { start: 4, end: 9, text: "clamped" },
      ],
      groups: [[0]],
      lineByGroup: new Map([[0, "clamped"]]),
      lineCount: 2,
      maxCueSec: 8,
      region: { start: 5, end: 20 },
      sourceLabel: "the detected vocals",
      stepCount: 1,
    });
    // "dropped" ends before the trim (3 - 5 < 0); "clamped" starts at 4 - 5 = -1
    // and is floored to 0.
    expect(timing.alignedCues).toEqual([{ start: 0, end: 4, text: "clamped" }]);
    expect(timing.note).toBe(
      "captions aligned to the detected vocals (1/2 lines sung)"
    );
  });

  it("skips the onset anchor when no cue survives the rebase", () => {
    const timing = planSongTiming({
      clipCues: [{ start: 1, end: 2, text: "first line" }],
      groups,
      lineByGroup,
      lineCount: 2,
      maxCueSec: 8,
      region: { start: 10, end: 22 },
      sourceLabel: "the detected vocals",
      stepCount: 2,
    });
    expect(timing.alignedCues).toEqual([]);
    expect(timing.onsets).toBeUndefined();
    expect(timing.bodyEnd).toBeUndefined();
    // The even split still stands, so the body stays long enough for the song.
    expect(timing.holdDurSec).toEqual([6, 6]);
  });

  it("floors a tiny region so the body still clears the song intro", () => {
    const timing = planSongTiming({
      clipCues: [],
      groups: [[0]],
      lineByGroup,
      lineCount: 1,
      maxCueSec: 8,
      region: { start: 0, end: 1 },
      sourceLabel: "the detected vocals",
      stepCount: 1,
    });
    expect(timing.holdDurSec).toEqual([6]); // Math.max(6, 1 - 0)
  });
});

describe("mapLimit", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

  it("returns results in INPUT order, not completion order", async () => {
    const out = await mapLimit([30, 20, 10, 0], 4, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:20", "2:10", "3:0"]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
        return n * 2;
      }
    );
    expect(peak).toBe(3);
    expect(out).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  });

  it("runs everything serially at a limit of 1", async () => {
    const order: number[] = [];
    await mapLimit([0, 1, 2], 1, async (n) => {
      order.push(n);
      await tick();
      order.push(n);
      return n;
    });
    // A serial pass never interleaves: each item's start/finish are adjacent.
    expect(order).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it("treats a zero or negative limit as one", async () => {
    await expect(mapLimit([1, 2], 0, async (n) => n)).resolves.toEqual([1, 2]);
    await expect(mapLimit([1, 2], -5, async (n) => n)).resolves.toEqual([1, 2]);
  });

  it("handles an empty list without running anything", async () => {
    let calls = 0;
    const out = await mapLimit([], 4, async () => {
      calls++;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("rethrows the LOWEST-index failure and starts nothing more", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([0, 1, 2, 3, 4, 5, 6, 7], 2, async (n) => {
        started.push(n);
        await tick();
        if (n === 1 || n === 0) {
          throw new Error(`boom ${n}`);
        }
        return n;
      })
    ).rejects.toThrow("boom 0");
    // Both in-flight items ran; nothing past them was scheduled.
    expect(started).toEqual([0, 1]);
  });

  it("lets in-flight work settle before rejecting (no late rejections)", async () => {
    let settled = 0;
    await expect(
      mapLimit([0, 1, 2, 3], 4, async (n) => {
        await new Promise((resolve) => setTimeout(resolve, n * 4));
        settled++;
        if (n === 0) {
          throw new Error("first failed");
        }
        return n;
      })
    ).rejects.toThrow("first failed");
    expect(settled).toBe(4);
  });
});

describe("ttsConcurrency", () => {
  it("defaults to a modest bound, never above the machine's parallelism", () => {
    const value = ttsConcurrency({});
    expect(value).toBeGreaterThanOrEqual(1);
    expect(value).toBeLessThanOrEqual(4);
    expect(value).toBeLessThanOrEqual(os.availableParallelism());
  });

  it("honors $DAILIES_TTS_CONCURRENCY, including 1 for the old serial pass", () => {
    expect(ttsConcurrency({ DAILIES_TTS_CONCURRENCY: "1" })).toBe(1);
    expect(ttsConcurrency({ DAILIES_TTS_CONCURRENCY: "12" })).toBe(12);
    expect(ttsConcurrency({ DAILIES_TTS_CONCURRENCY: "2.9" })).toBe(2);
  });

  it("ignores a junk or out-of-range override", () => {
    const fallback = ttsConcurrency({});
    expect(ttsConcurrency({ DAILIES_TTS_CONCURRENCY: "nope" })).toBe(fallback);
    expect(ttsConcurrency({ DAILIES_TTS_CONCURRENCY: "0" })).toBe(fallback);
    expect(ttsConcurrency({ DAILIES_TTS_CONCURRENCY: "-3" })).toBe(fallback);
  });
});

describe("narrationJobs", () => {
  const steps = [
    { name: "a", durationMs: 1000, videoTime: 0 },
    { name: "b", durationMs: 1000, videoTime: 1 },
    { name: "c", durationMs: 1000, videoTime: 2 },
  ];

  it("keeps the enumerated step index as the clip key", () => {
    const jobs = narrationJobs(
      steps,
      new Map([
        [0, "first line"],
        [2, "third line"],
      ])
    );
    expect(jobs.map((j) => j.index)).toEqual([0, 2]);
    expect(jobs.map((j) => j.text)).toEqual(["first line", "third line"]);
    expect(jobs.map((j) => j.step.name)).toEqual(["a", "c"]);
  });

  it("skips steps whose narration is missing or blank", () => {
    const jobs = narrationJobs(
      steps,
      new Map([
        [0, "   "],
        [1, ""],
        [2, "  kept  "],
      ])
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.text).toBe("kept");
  });

  it("returns nothing when the model narrated no step", () => {
    expect(narrationJobs(steps, new Map())).toEqual([]);
  });
});
