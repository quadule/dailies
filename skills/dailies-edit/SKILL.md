---
name: dailies-edit
description: Edit a recorded Dailies video after the fact — change or add captions, cut out a section, speed up or slow down a stretch, hold (pause) on a frame longer, add a text-to-speech voice-over, or swap in a recorded voice — then re-render the video and report. No re-recording. Use when the user wants to change a finished Dailies recording. Trigger phrases — "edit the video", "change the caption", "cut out the login part", "speed through the setup", "play this part at normal speed", "pause longer on this screen", "add a voice-over", "make it say X instead", "use my recording instead of the robot voice".
allowed-tools:
  - Bash(dailies:*)
  - Bash(npx dailies-cli:*)
license: MIT
metadata:
  author: dailies
  version: 0.6.0
  category: workflow
  tags:
    - dailies
    - video
    - editing
    - captions
    - narration
---

# Dailies edit (change a finished recording)

Edit a session's `cut.json`, render it, and check the result. Find the session with
`npx dailies-cli session list` when the user hasn't named one.

1. Read `~/.dailies/sessions/<id>/cut.json` and the session's `results.json` (step names and
   scripts) so you know what happens where.
2. Make the change the user asked for, and only that. Keep every time in source seconds (see
   below) — never convert to the rendered video's times.
3. Run `npx dailies-cli cut render <id>`. Read its warnings and the timeline it prints; fix an
   overlap or a dropped item rather than leaving it for the user to find.
4. Tell the user what changed and where the video is (`report.html` in the session directory
   shows it with the steps).

<!-- dailies:snippet rule-cut-editing cli=npx-cli -->
A finished recording can be edited after the fact — no re-recording. `session end` writes
`~/.dailies/sessions/<id>/cut.json`, an edit file seeded with the run's captions and step
positions. Change it, then run `npx dailies-cli cut render <id>` to rebuild the video and the report.

- Every time in the file is in seconds into the condensed recording (the source), NOT into the
  rendered video. Edits never shift each other: a cut at 10s doesn't change where a caption at
  20s is written down. Use `steps[].at` to find your way around; editing `steps` changes nothing.
- `captions`: `{ "start", "end", "text" }` — text in the band under the video, no voice. One
  short sentence each (~100 characters); a longer one is cut off with an ellipsis.
- `cuts`: `{ "start", "end" }` — remove that stretch of footage. Anything placed inside a cut is
  dropped, with a warning.
- `holds`: `{ "at", "seconds" }` — freeze the frame at `at` for that long; everything after plays
  later. A hold at the end of the video extends the last frame.
- `speedups`: `{ "start", "end", "rate" }` — play that stretch `rate` times faster, a whole number
  from 2 to 8. A caption over it stays up for its full length while the picture runs fast. The
  seed already speeds up steps run with `--skim` and, when the run showed captions, long
  stretches with none; delete an entry to play it at real speed, or change its rate.
- `narration`: `{ "at", "text" }` — a spoken line starting at `at`, voiced by text-to-speech.
  While it plays its text is shown as the caption; add `"caption": "…"` to show different text,
  or `"caption": ""` to show none. To use a recorded voice instead of TTS, add
  `"audio": "<file>"` (a path relative to the session directory, e.g. `cut/line1.m4a`); `text`
  is then what the line says, for the caption.
- `voice`: `{ "narrator", "name", "speed" }` — who reads the TTS lines (`say`, `omlx`,
  `elevenlabs` or `gemini`), which of their voices, and a pace from 0.5 to 2. Left empty, the
  first render picks a voice and writes it back here, so later renders keep sounding the same.
- Lines don't move the picture. If a line is still speaking when the next one starts, the render
  warns and names the hold that would fix it; if the last line runs past the end, the final
  frame is held for it automatically.
- Rendering is cheap to repeat. Voiced lines are cached under the session's `cut/` folder, so
  re-rendering only voices lines whose text or voice changed. The render prints where every step
  and line landed in the new video — check it against what was asked.
<!-- dailies:end rule-cut-editing -->
