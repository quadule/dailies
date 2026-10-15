- Captions carry the narration the video can't: WHY you're doing something, what to watch for, or
  why a result matters. Use `await page.showCaption("…")` generously — open each meaningful step or
  section with a one-line "why". The bar is "would a viewer understand the reason without me
  here?", not "is this strictly necessary?".
- Don't echo the screen: a caption that restates an action ("Click Submit") or the step name is
  noise. Caption the reasoning, the precondition, or what to watch for — never the click itself.
- Always caption a deviation from what was asked — a workaround, a precondition you set up, an
  unrequested path to the feature. No one is watching live, so a one-line "doing X because Y" tells
  a later viewer the detour was deliberate.
- Keep each caption to ONE short sentence that fits two lines on screen (~100 characters); split a
  longer thought across successive steps. `{ durationMs }` is a FLOOR, not a cap: a caption always
  gets time to be read, and the video under it is never trimmed away.
- Nothing is drawn into the page while recording. Captions are stored as timed data and rendered at
  `session end`, so one recording can be finished plain, cinematic or song — and in a cinematic cut
  your text also feeds the narration. Write captions the same way whatever the run will become.
- `session end --song` scores the run with one AI-generated song whose lyrics are about the steps,
  captions timed to the singing. The random theme is the point: do NOT pass `--prompt` on your own
  initiative. Pass `--prompt "<their words>"` only when the user asked for a genre or vibe, using
  their words rather than a theme you invent. `--no-captions` drops the burned lyric subtitles. It
  needs a text provider and a lyrics-capable music model; `session end --help` lists the providers,
  transcribers and environment variables.
- Dailies picks who voices, scores and paints the cut from what's configured. When the user names a
  provider for a slot, pass it through on `session end`: `--narrator
  <elevenlabs|gemini|omlx|say>`, `--music <elevenlabs|gemini|acestep|archive|none>` (also the
  singer with `--song`), `--image <elevenlabs|gemini|local|wikimedia|gradient|none>`. Each pins
  that slot (names like "Lyria" or "ACE-Step" work as aliases) and implies `--cinematic`. Leave off
  any provider the user didn't mention — a pinned provider that isn't set up fails loudly.
