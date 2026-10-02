// Render a session's cut.json into its video: slice the clean condensed source
// at the cuts and holds, voice the narration lines (TTS, or a recorded file),
// mix them in, burn the captions, then re-time the steps and rebuild the report.
//
// Re-runnable by design. The source is the `*.precinematic.webm` sidecar, which
// no render ever writes to, and each voiced line is cached under `cut/` keyed by
// its text and voice — so changing one caption re-encodes the video but voices
// nothing, and changing one line voices only that line.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { sessionDir } from "dailies-daemon-client";
import { SESSION_VIDEO_DIR } from "dailies-protocol";
import { promotePrimaryVideo } from "../commands/session-end.js";
import { logger } from "../logger.js";
import { writeSessionReport } from "../report/load-and-render.js";
import { endResultFromDisk } from "../session/artifacts.js";
import { readSessionRecord, updateSessionRecord } from "../session/registry.js";
import { type Echo, mapLimit } from "../util/process.js";
import { findFfmpeg } from "../video/condense.js";
import {
  audioDurationSec,
  availableFilters,
  ENCODE_TIMEOUT_MS,
  FFMPEG_BASE_ARGS,
  type ProbedVideo,
  probeDurationSec,
  probeVideo,
  run,
} from "../video/ffmpeg.js";
import type { NarratorChoice } from "../video/media-preferences.js";
import {
  buildAudioMix,
  captionBandPx,
  captionFontPx,
  escapeSubtitlesPath,
  precinematicVideoPath,
  resolveMedia,
  subtitleStyle,
  ttsConcurrency,
} from "../video/narrate.js";
import {
  resolveSpeech,
  type SpeechSynth,
  sayCommand,
  speechText,
  ttsTempo,
} from "../video/speech.js";
import { buildSrt, captionLineMax } from "../video/srt.js";
import {
  type Cut,
  type CutLine,
  type CutPlan,
  cutVideoFilter,
  extendTail,
  layoutLines,
  mapTime,
  type OutputCue,
  outputCaptions,
  planCut,
} from "./cut.js";
import { readCut, writeCut } from "./cut-file.js";

// Voiced lines and normalized recordings, kept between renders. Outside video/
// so the artifact scanner never mistakes a clip for a recording.
export const CUT_CACHE_DIR = "cut";

// Spoken lines are normalized to one loudness so a TTS line and a voice memo
// recorded on a laptop mic sit at the same level. -16 LUFS is the usual target
// for speech meant to be played on a laptop or phone.
const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11";

// Breathing room after the last line when the picture has to be extended to fit
// it, so the voice doesn't stop on the final frame.
const TAIL_PAD_SEC = 0.5;

// The environment variable each narrator reads its voice from.
const VOICE_ENV: Record<NarratorChoice, string> = {
  say: "DAILIES_SAY_VOICE",
  omlx: "DAILIES_OMLX_TTS_VOICE",
  elevenlabs: "DAILIES_ELEVENLABS_VOICE",
  gemini: "DAILIES_TTS_VOICE",
};

// Which narrator a TTS provider is, from its id ("gemini-tts" → gemini).
export function narratorOf(ttsId: string): NarratorChoice | undefined {
  const prefix = ttsId.split("-")[0];
  return prefix === "omlx" || prefix === "elevenlabs" || prefix === "gemini"
    ? prefix
    : undefined;
}

// The voice a provider label names: "gemini:Charon" → Charon,
// "omlx:model/voice" → voice, "omlx:model" → none (the model's default).
export function voiceFromLabel(label: string): string | undefined {
  const afterColon = label.includes(":")
    ? label.slice(label.indexOf(":") + 1)
    : label;
  if (label.startsWith("omlx:")) {
    const slash = afterColon.indexOf("/");
    return slash >= 0 ? afterColon.slice(slash + 1) || undefined : undefined;
  }
  return afterColon || undefined;
}

interface Voice {
  name?: string;
  narrator: NarratorChoice;
  synth: SpeechSynth;
}

// Resolve who voices the TTS lines. A voice named in the cut is pinned through
// that narrator's own environment variable, so the provider code that picks a
// voice is the same one the cinematic pass uses. No silent fallback to a second
// voice: half a video in one voice and half in another is worse than an error.
async function resolveVoice(
  cut: Cut,
  ffmpeg: string,
  notes: string[],
  echo: Echo
): Promise<Voice | { error: string }> {
  const { narrator, name } = cut.voice;
  if (narrator && name) {
    process.env[VOICE_ENV[narrator]] = name;
  }
  // resolveMedia's notes are about music and title art, which a cut doesn't
  // use; only the voice notes from resolveSpeech below are worth showing.
  const selection = await resolveMedia({
    ffmpeg,
    log: logger,
    echo,
    notes: [],
    preferences: { narrator, music: "none", image: "none" },
  });
  if (selection.skip) {
    return { error: selection.skip };
  }
  const tts = selection.providers.tts;
  if (tts) {
    return {
      narrator: narratorOf(tts.id) ?? narrator ?? "say",
      name: voiceFromLabel(tts.label),
      synth: {
        ext: "wav",
        run: (text, out) => tts.synthesize(text, out),
        tempo: ttsTempo(process.env, tts.tempo),
      },
    };
  }
  const speech = await resolveSpeech(selection.providers, notes, echo);
  if (!speech?.say) {
    return {
      error:
        "no voice available for the narration — use macOS, set ELEVENLABS_API_KEY or GEMINI_API_KEY, run an oMLX TTS server, or point DAILIES_SAY_COMMAND at a say-compatible tool",
    };
  }
  // A custom $DAILIES_SAY_COMMAND labels itself with its own command line; that
  // is not a voice name, so only a real `say` voice gets pinned.
  const pinned =
    process.env.DAILIES_SAY_VOICE?.trim() ||
    (sayCommand() === "say" ? speech.sayLabel : "");
  return { narrator: "say", name: pinned || undefined, synth: speech.say };
}

function cacheKey(parts: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

// Transcode a spoken line to the mix format: stereo 44.1k AAC, loudness
// normalized, optionally sped up. Written under a temporary name and renamed
// into place: the cache treats "the file exists" as "the clip is good", so an
// interrupted encode must never leave a partial clip at the cached path.
async function normalizeClip(args: {
  ffmpeg: string;
  input: string;
  outPath: string;
  tempo: number;
  echo: Echo;
}): Promise<void> {
  const filters = [
    ...(Math.abs(args.tempo - 1) > 0.001
      ? [`atempo=${args.tempo.toFixed(3)}`]
      : []),
    LOUDNORM,
  ];
  const partial = `${args.outPath}.part.m4a`;
  try {
    await run(
      args.ffmpeg,
      [
        ...FFMPEG_BASE_ARGS,
        "-i",
        args.input,
        "-af",
        filters.join(","),
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "aac",
        partial,
      ],
      ENCODE_TIMEOUT_MS,
      args.echo
    );
    await rename(partial, args.outPath);
  } finally {
    await rm(partial, { force: true });
  }
}

interface VoicedLine {
  durationSec: number;
  line: CutLine;
  m4aPath: string;
}

interface ClipJob {
  clip: string;
  line: CutLine;
  // A recorded file to normalize; absent for a TTS line.
  src?: string;
}

// A recorded line's clip is keyed by the file, so replacing the recording (a
// new size or mtime) re-normalizes it.
async function findRecordings(
  cut: Cut,
  dir: string,
  cacheDir: string
): Promise<Map<CutLine, { src: string; clip: string }> | { error: string }> {
  const recorded = new Map<CutLine, { src: string; clip: string }>();
  for (const line of cut.narration) {
    if (!line.audio) {
      continue;
    }
    const src = path.resolve(dir, line.audio);
    const info = await stat(src).catch(() => undefined);
    if (!info?.isFile()) {
      return { error: `narration audio "${line.audio}" was not found` };
    }
    const key = cacheKey(["rec", src, info.size, info.mtimeMs]);
    recorded.set(line, { src, clip: path.join(cacheDir, `rec-${key}.m4a`) });
  }
  return recorded;
}

// Make one line's clip if the cache doesn't already have it.
async function produceClip(args: {
  job: ClipJob;
  voice: Voice | undefined;
  speed: number;
  ffmpeg: string;
  echo: Echo;
}): Promise<void> {
  const { job, voice, speed, ffmpeg, echo } = args;
  if (existsSync(job.clip)) {
    return;
  }
  if (job.src) {
    await normalizeClip({
      ffmpeg,
      input: job.src,
      outPath: job.clip,
      tempo: 1,
      echo,
    });
    return;
  }
  if (!voice) {
    throw new Error(`no voice resolved for the line "${job.line.text}"`);
  }
  const raw = `${job.clip}.raw.${voice.synth.ext}`;
  try {
    await voice.synth.run(speechText(job.line.text), raw);
    await normalizeClip({
      ffmpeg,
      input: raw,
      outPath: job.clip,
      tempo: (voice.synth.tempo ?? 1) * speed,
      echo,
    });
  } finally {
    await rm(raw, { force: true });
  }
}

// Produce a clip for every narration line: the cached one when its text and
// voice are unchanged, otherwise a fresh TTS render or a normalized copy of the
// recorded file. Resolves the TTS voice only when a line actually needs it.
async function voiceLines(args: {
  cut: Cut;
  dir: string;
  ffmpeg: string;
  notes: string[];
  echo: Echo;
  progress: (message: string) => void;
}): Promise<
  { voiced: VoicedLine[]; voice?: Voice; used: Set<string> } | { error: string }
> {
  const { cut, dir, ffmpeg, notes, echo, progress } = args;
  const cacheDir = path.join(dir, CUT_CACHE_DIR);
  await mkdir(cacheDir, { recursive: true });
  const speed = cut.voice.speed ?? 1;
  const recorded = await findRecordings(cut, dir, cacheDir);
  if (!(recorded instanceof Map)) {
    return recorded;
  }

  // A TTS clip is keyed by its words and the voice that spoke them. A voice
  // pinned in the cut is known up front, so a fully cached render resolves no
  // provider at all; otherwise the voice is resolved once, here.
  const spoken = cut.narration.filter((line) => !recorded.has(line));
  const ttsClip = (line: CutLine, v: { narrator?: string; name?: string }) =>
    path.join(
      cacheDir,
      `tts-${cacheKey(["tts", v.narrator, v.name ?? "", speed, speechText(line.text)])}.m4a`
    );
  const pinned = cut.voice.narrator ? cut.voice : undefined;
  const cached =
    pinned !== undefined &&
    spoken.every((line) => existsSync(ttsClip(line, pinned)));
  let voice: Voice | undefined;
  if (spoken.length > 0 && !cached) {
    const resolved = await resolveVoice(cut, ffmpeg, notes, echo);
    if ("error" in resolved) {
      return resolved;
    }
    voice = resolved;
  }
  const keyVoice = voice ?? pinned ?? {};

  const jobs: ClipJob[] = cut.narration.map((line) => ({
    line,
    ...(recorded.get(line) ?? { clip: ttsClip(line, keyVoice) }),
  }));
  const pending = jobs.filter((job) => !existsSync(job.clip)).length;
  if (pending > 0) {
    const who = voice?.name ? ` (${voice.name})` : "";
    progress(`voicing ${pending} line${pending === 1 ? "" : "s"}${who}…`);
  }
  await mapLimit(jobs, ttsConcurrency(), (job) =>
    produceClip({ job, voice, speed, ffmpeg, echo })
  );

  const voiced: VoicedLine[] = [];
  for (const job of jobs) {
    const durationSec = await audioDurationSec(ffmpeg, job.clip);
    if (!durationSec) {
      return {
        error: `could not read the audio for the line "${job.line.text}"`,
      };
    }
    voiced.push({ line: job.line, m4aPath: job.clip, durationSec });
  }
  return {
    voiced,
    voice,
    used: new Set(jobs.map((job) => path.basename(job.clip))),
  };
}

// Delete cached clips no line uses any more, so the cache tracks the cut.
async function pruneCache(dir: string, used: Set<string>): Promise<void> {
  const cacheDir = path.join(dir, CUT_CACHE_DIR);
  const names = await readdir(cacheDir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => !used.has(name))
      .map((name) => rm(path.join(cacheDir, name), { force: true }))
  );
}

// Pin the voice the first time one is resolved, so every later render — and
// every later edited line — uses the same voice rather than a fresh pick.
async function pinVoice(
  sessionId: string,
  cut: Cut,
  voice: Voice | undefined
): Promise<void> {
  if (
    !voice ||
    (voice.narrator === cut.voice.narrator && voice.name === cut.voice.name)
  ) {
    return;
  }
  cut.voice = {
    ...cut.voice,
    narrator: voice.narrator,
    ...(voice.name ? { name: voice.name } : {}),
  };
  await writeCut(sessionId, cut);
}

interface CutSource {
  cut: Cut;
  dir: string;
  ffmpeg: string;
  probed: ProbedVideo;
  // The clean condensed cut every render starts from.
  source: string;
  sourceDurationSec: number;
  videoPath: string;
}

async function loadCutSource(
  sessionId: string
): Promise<CutSource | { error: string }> {
  const record = await readSessionRecord(sessionId);
  if (record.status === "active") {
    return {
      error: `Session "${sessionId}" is still recording — run \`dailies session end ${sessionId}\` first.`,
    };
  }
  const read = await readCut(sessionId);
  if ("error" in read) {
    return read;
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    return {
      error:
        "ffmpeg not found — install ffmpeg (brew install ffmpeg) or set $DAILIES_FFMPEG",
    };
  }
  const dir = sessionDir(sessionId);
  const videoPath = path.join(dir, SESSION_VIDEO_DIR, read.cut.video);
  if (!existsSync(videoPath)) {
    return {
      error: `the cut's video "${read.cut.video}" is not in ${dir}/video`,
    };
  }
  // When condense found nothing to trim and nothing was burned, the video
  // itself is still clean — preserve it before the first render overwrites it.
  const source = precinematicVideoPath(videoPath);
  if (!existsSync(source)) {
    await copyFile(videoPath, source);
  }
  const probed = await probeVideo(ffmpeg, source);
  const sourceDurationSec = await probeDurationSec(ffmpeg, source);
  if (!(probed && sourceDurationSec)) {
    return { error: `could not read ${source}` };
  }
  return {
    cut: read.cut,
    dir,
    ffmpeg,
    probed,
    source,
    sourceDurationSec,
    videoPath,
  };
}

// Write the .srt sidecar (or remove a stale one) and say whether this ffmpeg
// can burn it.
async function writeCaptions(args: {
  ffmpeg: string;
  srtPath: string;
  cues: OutputCue[];
  probed: ProbedVideo;
  notes: string[];
}): Promise<boolean> {
  const { ffmpeg, srtPath, cues, probed, notes } = args;
  if (cues.length === 0) {
    await rm(srtPath, { force: true });
    return false;
  }
  const lineMax = captionLineMax(
    probed.width,
    captionFontPx(captionBandPx(probed.height))
  );
  await writeFile(srtPath, buildSrt(cues, lineMax), "utf8");
  if ((await availableFilters(ffmpeg)).has("subtitles")) {
    return true;
  }
  notes.push(
    "captions not burned — this ffmpeg has no `subtitles` filter; the .srt is written alongside the video"
  );
  return false;
}

// The whole render as one ffmpeg call: the cut/hold filter, the caption band
// and burn, and the voice mix, encoded once. Returns null when there is nothing
// to do but copy the source (no edits, no captions, no voice). Pure → tested.
//
// One pass matters for speed and quality. Encoding each piece, joining them,
// then re-encoding to burn captions and mix audio decoded and encoded the
// footage twice; measured on a 29s 1440x900 cut, that was about 3 minutes
// against 17s for the same output in one pass.
export function singlePassArgs(args: {
  source: string;
  videoFilter: string;
  burn?: { srtPath: string; bandPx: number; style: string };
  clips: { path: string; offsetSec: number }[];
  durationSec: number;
  outPath: string;
}): string[] | null {
  const { source, videoFilter, burn, clips, durationSec, outPath } = args;
  const videoChain = [
    videoFilter,
    ...(burn
      ? [
          `pad=iw:ih+${burn.bandPx}:0:0:color=black`,
          `subtitles='${escapeSubtitlesPath(burn.srtPath)}':force_style='${burn.style}'`,
        ]
      : []),
  ]
    .filter(Boolean)
    .join(",");
  if (!videoChain && clips.length === 0) {
    return null;
  }
  const graph = [
    ...(videoChain ? [`[0:v]${videoChain}[vout]`] : []),
    ...(clips.length > 0
      ? [
          buildAudioMix(
            clips.map((c) => ({ delayMs: Math.round(c.offsetSec * 1000) }))
          ),
        ]
      : []),
  ];
  return [
    ...FFMPEG_BASE_ARGS,
    "-i",
    source,
    ...clips.flatMap((c) => ["-i", c.path]),
    "-filter_complex",
    graph.join(";"),
    "-map",
    videoChain ? "[vout]" : "0:v",
    ...(videoChain ? ["-c:v", "libvpx", "-b:v", "1M"] : ["-c:v", "copy"]),
    // WebM takes Opus, not the clips' AAC.
    ...(clips.length > 0 ? ["-map", "[aout]", "-c:a", "libopus"] : ["-an"]),
    // amix runs as long as its longest input; the picture sets the length.
    "-t",
    durationSec.toFixed(3),
    outPath,
  ];
}

// Re-time the steps and rebuild the report. precinematicVideoTime is the step's
// place in the clean source; it is stamped before videoTime is overwritten with
// the output position, so a later render (or a cinematic pass) still knows
// where each step is in the source.
async function retimeAndReport(
  sessionId: string,
  cut: Cut,
  plan: CutPlan
): Promise<{ name: string; at: number }[]> {
  const updated = await updateSessionRecord(sessionId, (r) => {
    for (const step of r.steps) {
      const src = step.precinematicVideoTime ?? step.videoTime;
      if (src !== undefined) {
        step.precinematicVideoTime = src;
        step.videoTime = mapTime(plan, src).out;
      }
    }
  });
  const endResult = await endResultFromDisk(updated);
  await promotePrimaryVideo(endResult, cut.video);
  await writeSessionReport(sessionId, updated, endResult);
  return updated.steps.flatMap((s) =>
    s.videoTime === undefined ? [] : [{ name: s.name, at: s.videoTime }]
  );
}

export interface CutRenderResult {
  // Where everything landed in the rendered video (output seconds), so the
  // editor can check each edit did what was asked without watching it.
  captions: OutputCue[];
  cuts: { start: number; end: number; outAt: number }[];
  durationSec: number;
  holds: { at: number; seconds: number; outAt: number }[];
  lines: { at: number; text: string; outStart: number; durationSec: number }[];
  notes: string[];
  sourceDurationSec: number;
  steps: { name: string; at: number }[];
  videoPath: string;
  warnings: string[];
}

export async function renderCut(args: {
  sessionId: string;
  progress: (message: string) => void;
  echo: Echo;
}): Promise<CutRenderResult | { error: string }> {
  const { sessionId, progress, echo } = args;
  const loaded = await loadCutSource(sessionId);
  if ("error" in loaded) {
    return loaded;
  }
  const { cut, dir, ffmpeg, probed, source, videoPath } = loaded;
  const notes: string[] = [];
  const warnings: string[] = [];
  let plan = planCut(cut, {
    durationSec: loaded.sourceDurationSec,
    fps: probed.frameRate,
  });
  warnings.push(...plan.warnings);

  const voicing = await voiceLines({ cut, dir, ffmpeg, notes, echo, progress });
  if ("error" in voicing) {
    return voicing;
  }
  await pinVoice(sessionId, cut, voicing.voice);

  const { placed, overrunSec } = layoutLines({
    plan,
    lines: voicing.voiced,
    warnings,
  });
  if (overrunSec > 0) {
    plan = extendTail(plan, overrunSec + TAIL_PAD_SEC);
    notes.push(
      `the last line ran past the end, so the final frame is held ${(overrunSec + TAIL_PAD_SEC).toFixed(1)}s longer`
    );
  }
  const cues = outputCaptions({
    plan,
    captions: cut.captions,
    lines: placed,
    warnings,
  });

  const srtPath = `${videoPath}.captions.srt`;
  const burn = await writeCaptions({ ffmpeg, srtPath, cues, probed, notes });
  const clipFor = new Map(voicing.voiced.map((v) => [v.line, v.m4aPath]));
  const bandPx = captionBandPx(probed.height);
  // Beside the video, not in the OS temp dir, so the rename into place never
  // crosses filesystems.
  const rendered = `${videoPath}.cut.webm`;
  const ffmpegArgs = singlePassArgs({
    source,
    videoFilter: cutVideoFilter(plan),
    burn: burn
      ? {
          srtPath,
          bandPx,
          style: subtitleStyle(probed.height + bandPx, bandPx, probed.width),
        }
      : undefined,
    clips: placed.map((p) => ({
      path: clipFor.get(p.line) as string,
      offsetSec: p.outStart,
    })),
    durationSec: plan.outDurationSec,
    outPath: rendered,
  });
  try {
    if (ffmpegArgs) {
      progress("rendering…");
      await run(ffmpeg, ffmpegArgs, ENCODE_TIMEOUT_MS, echo);
    } else {
      await copyFile(source, rendered);
    }
    await rename(rendered, videoPath);
  } finally {
    await rm(rendered, { force: true });
  }
  await pruneCache(dir, voicing.used);

  progress("rebuilding the report…");
  const steps = await retimeAndReport(sessionId, cut, plan);
  return {
    videoPath,
    captions: cues,
    cuts: cut.cuts.map((c) => ({ ...c, outAt: mapTime(plan, c.start).out })),
    holds: cut.holds.flatMap((h) => {
      const mapped = mapTime(plan, h.at);
      return mapped.removed ? [] : [{ ...h, outAt: mapped.out }];
    }),
    sourceDurationSec: plan.sourceDurationSec,
    durationSec: plan.outDurationSec,
    steps,
    lines: placed.map((p) => ({
      at: p.line.at,
      text: p.line.text,
      outStart: p.outStart,
      durationSec: p.durationSec,
    })),
    notes,
    warnings,
  };
}
