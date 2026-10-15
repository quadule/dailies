- Direction is a budget. The camera helpers — `page.showSpotlight`, `page.circle`,
  `page.underline`, `page.pointAt`, `page.highlightText`, `page.lookAt` — each cost real seconds of
  film, and they only work by CONTRAST: once a step they tell a viewer where to look; on every
  interaction they tell them nothing. Budget about ONE emphasis per step, on its most important
  moment. A step with no subtle moment needs none — `humanClick` / `humanFill` already glide the
  cursor, settle and ripple.
- Use an effect only when the thing would otherwise be MISSED: it is small (a 14px validation
  message), off to one side (a badge in a table row), one of many alike (the third row's toggle), or
  it CHANGED rather than appeared (a total recalculating, a button turning enabled). If the eye is
  already on it — the only thing on screen, or what you just clicked — skip it.
- Pick by what the thing IS:
  - `showSpotlight(target)` — the surroundings are the problem (a dense page, a busy table, a
    twelve-field form): the surround darkens and only the target stays. The default and strongest
    choice, and the closest Dailies gets to a zoom (a real zoom would move where clicks land).
  - `highlightText(target)` — the WORDS matter: an error message, an amount, an ID, a status. Use
    it instead of a spotlight whenever the thing to read is a phrase.
  - `circle(target)` — the shape or position matters: an icon, an avatar, a chart region, an
    unlabeled control.
  - `underline(target)` — the lightest: a heading or label you are about to talk about.
  - `pointAt(target)` — a quick "there" when the eye needs moving but nothing held.
  - `lookAt(target)` — no emphasis, just the cursor resting a beat longer. The right choice far
    more often than the others.
- Hold before you act, not after: spotlight the field, THEN fill it; highlight the error, THEN
  explain it. An effect after the interaction it should set up just delays the run.
- Pair one effect with one caption saying DIFFERENT things: the effect says where to look, the
  caption why it matters. A caption that just names the spotlighted thing says it twice.
- A hold is the cheapest effect. When a result lands — a success flash, a total updating, a new
  row — rest on it with `lookAt` on what changed, or a caption (its span is never trimmed), rather
  than a bare `waitForTimeout`: a still page with nothing pointed at is dead footage that `session
  end` condenses away.
- Don't direct a failure. When a step fails or an assertion doesn't hold, caption what went wrong
  and leave effects off — a flourish over a broken flow reads as celebrating it.
