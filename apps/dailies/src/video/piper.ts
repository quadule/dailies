// Local TTS via Piper (github.com/OHF-Voice/piper1-gpl): a fast neural TTS that
// runs on the CPU from one binary plus one voice model — the Linux answer to
// macOS `say`. Same contract as omlx.ts (write a finished file to `outPath` or
// throw), wrapped by the caller so a failure degrades instead of failing the run.
//
// The binary is `piper-tts` from a distro package and `piper` from a pip
// install. A bare `piper` on PATH is often something else entirely (Arch's
// `piper` is a GTK app for gaming mice), so a PATH match must answer `--help`
// with Piper's ONNX model flag before it is used. $DAILIES_PIPER names the
// command outright and is trusted as given.
//
// A voice is two files, `<name>.onnx` and `<name>.onnx.json`. Downloads land
// flat in one folder (`python3 -m piper.download_voices <name> --data-dir
// <dir>`); distro packages use Hugging Face's nested layout
// (`en/en_US/lessac/medium/en_US-lessac-medium.onnx`), so a voices folder is
// searched a few levels deep. This module never downloads anything: with the
// binary and no voice it says which command would fetch one, and where to.
//
// PRIVACY: everything runs on this machine — the text goes to a child process's
// stdin and nowhere else.

import { constants, type Dirent } from "node:fs";
import { access, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "dailies-logger";
import {
  type Echo,
  ProcessError,
  run,
  VERSION_PROBE_TIMEOUT_MS,
} from "../util/process.js";
import { formatCommand, shellQuote, singleQuote } from "../util/shell.js";
import type { TtsProvider } from "./providers.js";

export const PIPER_TTS_ID = "piper-tts";

// The voice Piper's own docs use, and the one the download hint names — so it
// is also the first pick when it is installed.
export const DEFAULT_PIPER_VOICE = "en_US-lessac-medium";

// Where distro packages (Arch's piper-voices-*) install voices.
export const SYSTEM_PIPER_VOICES_DIR = "/usr/share/piper-voices";

// Commands tried on PATH when $DAILIES_PIPER is unset, in order.
const PATH_COMMANDS = ["piper-tts", "piper"] as const;

// How many folders below a voices folder a voice may sit. The nested Hugging
// Face layout uses four (<lang>/<locale>/<speaker>/<quality>/); one more for
// slack, and no further, so a voices folder pointed at somewhere large doesn't
// turn into a walk of the whole disk.
const MAX_FOLDER_DEPTH = 5;

// Loading a model takes well under a second on a laptop CPU and a line takes
// about as long again; this is the budget for a long line on a slow machine.
const SPEAK_TIMEOUT_MS = 120_000;

// A WAV header alone is 44 bytes; anything that small holds no speech.
const MIN_WAV_BYTES = 1024;

// Piper reads at about 185 words a minute (measured on en_US-lessac-medium),
// already voiceover pace, so its audio is not sped up afterwards — unlike the
// hosted voices (see ttsTempo in speech.ts). $DAILIES_TTS_TEMPO still applies.
const PIPER_TEMPO = 1;

// One voice model on disk.
export interface PiperVoice {
  config: string;
  model: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Pure parts (unit-tested).
// ---------------------------------------------------------------------------

function byCodePoint(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function depth(file: string): number {
  return file.split(/[\\/]/).length;
}

// The voices folders to search, in order. $DAILIES_PIPER_VOICES replaces the
// search outright (exact, like the other pins); otherwise the user's data folder
// ($XDG_DATA_HOME, else ~/.local/share), then the distro's.
export function piperVoiceDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const override = env.DAILIES_PIPER_VOICES?.trim();
  if (override) {
    return [path.resolve(override)];
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  // The XDG spec says a relative value is invalid and must be ignored.
  const dataHome =
    xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "share");
  return [path.join(dataHome, "piper-voices"), SYSTEM_PIPER_VOICES_DIR];
}

// The voices in a folder listing (paths relative to it, or absolute): every
// `.onnx` whose `.onnx.json` is listed beside it. A name found twice keeps the
// shallower copy (then the first in code-point order). Sorted by name.
export function piperVoicesInListing(
  files: readonly string[]
): { name: string; model: string }[] {
  const listed = new Set(files);
  const models = files
    .filter((file) => file.endsWith(".onnx") && listed.has(`${file}.json`))
    .sort((a, b) => depth(a) - depth(b) || byCodePoint(a, b));
  const byName = new Map<string, string>();
  for (const model of models) {
    const name = path.basename(model, ".onnx");
    if (!byName.has(name)) {
      byName.set(name, model);
    }
  }
  return [...byName]
    .map(([name, model]) => ({ name, model }))
    .sort((a, b) => byCodePoint(a.name, b.name));
}

// The voice to use when none is named: the default voice when installed, else
// the first US-English medium-quality voice, else the first voice of all.
// Deterministic (no draw), so two renders of one cut pick the same voice.
export function pickPiperVoice(names: readonly string[]): string | undefined {
  if (names.includes(DEFAULT_PIPER_VOICE)) {
    return DEFAULT_PIPER_VOICE;
  }
  const sorted = [...names].sort(byCodePoint);
  return sorted.find((name) => /^en_US-.+-medium$/.test(name)) ?? sorted[0];
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

// A $DAILIES_PIPER_VOICE value names a model file rather than a voice name.
export function isPiperVoicePath(ref: string): boolean {
  return ref.endsWith(".onnx") || looksLikePath(ref);
}

// The command line for one line of speech; the text goes in on stdin. `-f` is
// never optional: without it Piper plays the audio aloud when ffplay exists.
export function piperArgs(voice: PiperVoice, outPath: string): string[] {
  return ["-m", voice.model, "-c", voice.config, "-f", outPath];
}

// Piper speaks each stdin line as its own utterance; one line of narration is
// one utterance.
export function piperText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// The provider label: `piper:<voice>`. A voice found by name is labelled by
// name; one given as a path keeps the path, so pinning the label's voice back
// into $DAILIES_PIPER_VOICE finds the same model again.
export function piperLabel(ref: string): string {
  return `piper:${ref}`;
}

// The voice's display name from a label: "piper:en_US-lessac-medium" and
// "piper:/voices/en_US-lessac-medium.onnx" both give "en_US-lessac-medium".
export function piperVoiceName(label: string): string {
  const ref = label.replace(/^piper:/, "").trim();
  return isPiperVoicePath(ref) ? path.basename(ref, ".onnx") : ref;
}

// The exact command that downloads a voice into a folder.
export function piperDownloadCommand(voice: string, dir: string): string {
  return `python3 -m piper.download_voices ${shellQuote(voice)} --data-dir ${shellQuote(dir)}`;
}

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    await access(file, constants.X_OK);
    return info.isFile();
  } catch {
    return false;
  }
}

async function onPath(
  name: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      if (await isExecutableFile(file)) {
        return file;
      }
    }
  }
  return;
}

// Does this command answer `--help` like Piper TTS? Both the Python CLI and
// the older C++ binary describe their model flag as an ONNX file.
async function speaksLikePiper(command: string): Promise<boolean> {
  let output: string;
  try {
    const { stdout, stderr } = await run(
      command,
      ["--help"],
      VERSION_PROBE_TIMEOUT_MS
    );
    output = stdout + stderr;
  } catch (err) {
    output = err instanceof ProcessError ? err.stdout + err.stderr : "";
  }
  return /onnx/i.test(output);
}

type CommandSearch =
  | { command: string }
  // `loud`: Piper was asked for ($DAILIES_PIPER) and can't be used, which is
  // worth a note even when nothing pins the narrator to it.
  | { missing: string; loud: boolean };

export async function findPiperCommand(
  env: NodeJS.ProcessEnv
): Promise<CommandSearch> {
  const explicit = env.DAILIES_PIPER?.trim();
  if (explicit) {
    const file = looksLikePath(explicit)
      ? path.resolve(explicit)
      : await onPath(explicit, env);
    if (file && (await isExecutableFile(file))) {
      return { command: file };
    }
    return {
      missing: `DAILIES_PIPER is set to ${explicit}, which is not an executable`,
      loud: true,
    };
  }
  for (const name of PATH_COMMANDS) {
    const file = await onPath(name, env);
    if (file && (await speaksLikePiper(file))) {
      return { command: file };
    }
  }
  return { missing: "Piper isn't installed", loud: false };
}

// Every file name under `dir`, relative to it, at most `folders` folders down.
// Symlinked files count (a folder of links to a shared voice works); symlinked
// folders are not followed, so a link cycle can't loop the walk.
async function listFiles(
  dir: string,
  folders = MAX_FOLDER_DEPTH
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(entry.name);
    } else if (entry.isDirectory() && folders > 0) {
      const nested = await listFiles(path.join(dir, entry.name), folders - 1);
      files.push(...nested.map((file) => path.join(entry.name, file)));
    }
  }
  return files;
}

// Every voice in the search folders; a name in an earlier folder wins.
async function installedVoices(dirs: readonly string[]): Promise<PiperVoice[]> {
  const found = new Map<string, PiperVoice>();
  for (const dir of dirs) {
    for (const { name, model } of piperVoicesInListing(await listFiles(dir))) {
      if (!found.has(name)) {
        const file = path.join(dir, model);
        found.set(name, { name, model: file, config: `${file}.json` });
      }
    }
  }
  return [...found.values()].sort((a, b) => byCodePoint(a.name, b.name));
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

type VoiceSearch = { voice: PiperVoice; ref: string } | { problem: string };

// Resolve the session voice: $DAILIES_PIPER_VOICE (a name or a model path)
// when set — exactly that one, or a problem — else pickPiperVoice's choice.
export async function findPiperVoice(
  env: NodeJS.ProcessEnv,
  home: string = os.homedir()
): Promise<VoiceSearch> {
  const dirs = piperVoiceDirs(env, home);
  const where = dirs.join(" or ");
  const downloadDir = dirs[0] ?? SYSTEM_PIPER_VOICES_DIR;
  const named = env.DAILIES_PIPER_VOICE?.trim();
  if (named && isPiperVoicePath(named)) {
    const model = path.resolve(named);
    if (!model.endsWith(".onnx")) {
      return {
        problem: `DAILIES_PIPER_VOICE (${named}) must be a voice name or the path to its .onnx file`,
      };
    }
    const config = `${model}.json`;
    for (const file of [model, config]) {
      if (!(await exists(file))) {
        return {
          problem: `DAILIES_PIPER_VOICE points at ${model}, but ${file} doesn't exist`,
        };
      }
    }
    return {
      voice: { name: path.basename(model, ".onnx"), model, config },
      ref: model,
    };
  }
  const voices = await installedVoices(dirs);
  const name = named || pickPiperVoice(voices.map((voice) => voice.name));
  const voice = voices.find((v) => v.name === name);
  if (voice) {
    return { voice, ref: voice.name };
  }
  if (named) {
    return {
      problem: `the voice ${named} isn't in ${where}; download it with: ${piperDownloadCommand(named, downloadDir)}`,
    };
  }
  return {
    problem: `it has no voice in ${where}; download one with: ${piperDownloadCommand(DEFAULT_PIPER_VOICE, downloadDir)}`,
  };
}

// ---------------------------------------------------------------------------
// The provider.
// ---------------------------------------------------------------------------

// Speak one line into `outPath`. Piper writes its WAV in place as it goes, so
// it writes to a sibling and the finished file is renamed over `outPath`: a
// failed or interrupted run never leaves a partial file where a clip belongs.
async function speak(args: {
  command: string;
  voice: PiperVoice;
  text: string;
  outPath: string;
  echo?: Echo;
}): Promise<void> {
  const { command, voice, outPath, echo } = args;
  const text = piperText(args.text);
  if (!text) {
    throw new Error("Piper was given no words to speak");
  }
  const partial = `${outPath}.part-${process.pid}.wav`;
  const argv = piperArgs(voice, partial);
  echo?.(
    `$ printf '%s\\n' ${singleQuote(text)} | ${formatCommand(command, piperArgs(voice, outPath))}`
  );
  try {
    await run(command, argv, SPEAK_TIMEOUT_MS, { input: `${text}\n` });
    const size = (await stat(partial)).size;
    if (size < MIN_WAV_BYTES) {
      throw new Error(`Piper ${voice.name} wrote no audio (${size} bytes)`);
    }
    await rename(partial, outPath);
  } finally {
    await rm(partial, { force: true });
  }
}

function createPiperProvider(args: {
  command: string;
  voice: PiperVoice;
  ref: string;
  echo?: Echo;
}): TtsProvider {
  const { command, voice, ref, echo } = args;
  return {
    id: PIPER_TTS_ID,
    label: piperLabel(ref),
    tempo: PIPER_TEMPO,
    synthesize: (text, outPath) =>
      speak({ command, voice, text, outPath, echo }),
  };
}

export interface PiperResolution {
  notes: string[];
  tts?: TtsProvider;
  // Why Piper can't voice the run although it was asked for or installed (no
  // voice, an unknown voice name, a bad $DAILIES_PIPER). Unset when Piper is
  // simply not installed — that isn't a problem until someone pins it.
  unavailable?: string;
}

// Resolve the Piper narrator, or the reason there isn't one. The voice is read
// from the environment here, when the provider is made — a render pins a cut's
// voice through $DAILIES_PIPER_VOICE only for the resolve.
export async function resolvePiperProviders(opts: {
  env: NodeJS.ProcessEnv;
  log: Logger;
  echo?: Echo;
  home?: string;
}): Promise<PiperResolution> {
  const { env, log, echo } = opts;
  const found = await findPiperCommand(env);
  if ("missing" in found) {
    return found.loud
      ? {
          notes: [`Piper skipped — ${found.missing}.`],
          unavailable: found.missing,
        }
      : { notes: [] };
  }
  const search = await findPiperVoice(env, opts.home);
  if ("problem" in search) {
    return {
      notes: [`Piper (${found.command}) can't narrate — ${search.problem}`],
      unavailable: search.problem,
    };
  }
  log.debug(
    { command: found.command, voice: search.voice.model },
    "Piper TTS provider enabled"
  );
  return {
    tts: createPiperProvider({
      command: found.command,
      voice: search.voice,
      ref: search.ref,
      echo,
    }),
    notes: [
      `Piper TTS enabled (${search.voice.name}) — narration is synthesized on this machine and never leaves it.`,
    ],
  };
}
