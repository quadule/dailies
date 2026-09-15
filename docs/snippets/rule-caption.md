- Captions carry the narration the video can't: WHY you're doing something, what a viewer should
  watch for, or why a result matters. Reach for `await page.showCaption("…")` generously to explain
  intent — open each meaningful step or section with a one-line "why" rather than saving captions
  only for detours. The bar is "would a viewer understand the reason without me here?", not "is this
  strictly necessary?".
- Don't echo the screen, though: a caption that restates an action ("Click Submit") or repeats the
  step name is noise. Caption the reasoning, the precondition, or what to watch for — never the
  click itself.
- Always caption a deviation from what was asked — when you improvise a workaround, set up a
  precondition, or take an unrequested path to reach the feature under test. In a non-interactive
  run no one is watching live, so a one-line "doing X because Y" is what tells a later viewer the
  detour was deliberate, not a mistake.
- Keep each caption to ONE short sentence — it must fit two lines on screen (~100 characters).
  Split a longer thought across captions on successive steps. `{ durationMs }` sets how long it
  holds, but it is a FLOOR, not a cap: a caption is always given enough time to be read, and the
  video under it is protected from being trimmed away, however still the page is.
- Nothing is drawn into the page while recording. The caption is stored as timed data and rendered
  at `session end`, so the same recording can be finished plain, cinematic or song without
  re-recording — and in a cinematic cut your text also feeds the narration as your stated intent.
  Write captions exactly the same way whatever the run will become.
- Want a music video instead of spoken narration? `session end --song` scores the whole run with
  one AI-generated song whose lyrics are written about the steps, captions timed to the singing.
  The random theme is the
  point, so do NOT pass `--prompt` on your own initiative — omit it and let it draw. Pass
  `--prompt "<their words>"` only when the user asked for a specific genre or vibe, and pass their
  words through rather than inventing a theme for them. `--no-captions` drops the burned lyric
  subtitles. Needs the `claude`
  CLI plus a lyrics-capable music model — a local/remote ACE-Step server (`$DAILIES_ACESTEP_URL`) or
  a Gemini key. Captions are timed to the actual vocals when a transcriber is found on PATH
  (autodetected, English-only: `whisperx` → `mlx_whisper` → whisper.cpp `whisper-cli`; models come
  from the HuggingFace cache); override with `$DAILIES_TRANSCRIBER`, `$DAILIES_WHISPER_CLI`,
  `$DAILIES_WHISPER_MODEL`. For the tightest timing, point `$DAILIES_TRANSCRIBE_URL` at an
  OpenAI-compatible server (e.g. a local Whisper-Large-v3-Turbo; `$DAILIES_TRANSCRIBE_MODEL` /
  `$DAILIES_TRANSCRIBE_API_KEY`) — it wins over the CLI backends. `$DAILIES_SONG_FILE` reuses a generated song. The voice/music env vars ($DAILIES_SAY_COMMAND, $DAILIES_OMLX_URL, …) are listed in
  `dailies session end --help`.
