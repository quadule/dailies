- Direction is a budget, not a garnish. The camera helpers — `page.showSpotlight`,
  `page.circle`, `page.underline`, `page.pointAt`, `page.highlightText`, `page.lookAt` — each
  cost real seconds of a film someone has to sit through, and they only work by CONTRAST. Used
  once a step they tell a viewer where to look; used on every interaction they tell them
  nothing, and the run reads as a slideshow of flourishes. Budget roughly ONE deliberate
  emphasis per step, on the step's single most important moment. A step with no subtle moment
  needs no effect at all — `humanClick` and `humanFill` already glide the cursor, settle, and
  ripple, which is enough to follow an ordinary action.
- Reach for an effect only when the thing you want seen would otherwise be MISSED — because it
  is small (a 14px validation message), off to one side (a badge in a table row), one of many
  near-identical things (the third row's toggle), or because it CHANGED rather than appeared
  (a total recalculating, a button flipping enabled). If a viewer's eye is already on it —
  it's the only thing on screen, or it's what you just clicked — skip the effect.
- Pick by what the thing IS, not by variety:
  - `showSpotlight(target)` — the surroundings are the problem. A dense page, a busy table, a
    form with twelve fields: the aperture closes and the surround darkens, so everything except
    the target drops away. This is the default choice and the strongest one. It is also as
    close to a ZOOM as Dailies gets on purpose — a real page zoom would move where clicks
    land, so the push is sold with light instead of scale.
  - `highlightText(target)` — the WORDS matter. An error message, an amount, an ID, a status.
    The browser paints its own selection highlight, so the specific text is unambiguous. Use
    this rather than a spotlight whenever the thing to read is a phrase.
  - `circle(target)` — the shape or position matters, not the text. An icon, an avatar, a chart
    region, a control with no label worth reading.
  - `underline(target)` — a heading or label you are about to talk about; the lightest of the
    four, good for "this section" without stopping the run.
  - `pointAt(target)` — a quick "there" when you need the eye moved but nothing held.
  - `lookAt(target)` — no emphasis at all, just the cursor resting on something a beat longer.
    The right choice far more often than the others.
- Hold before you act, not after. An effect earns its place by preparing the viewer for the
  next thing: spotlight the field, THEN fill it; highlight the error, THEN explain it. Firing
  an effect after the interaction it was meant to set up just delays the run.
- Pair one effect with one caption, and let them say DIFFERENT things. The effect says where to
  look; the caption says why it matters. Two captions on one moment, or an effect with a
  caption that just names the thing you spotlighted, is the same information twice.
- A hold IS an effect, and the cheapest one. After a result lands — a success flash, a total
  updating, a row appearing — the run should rest on it rather than moving straight to the next
  click. Prefer `lookAt` on the thing that changed, or a caption (whose span is protected from
  being trimmed), over a bare `waitForTimeout`: a still page with nothing pointed at is dead
  footage, and `session end` condenses exactly that away.
- Don't direct a failure. When a step fails or an assertion doesn't hold, caption what went
  wrong and leave the effects off — a flourish over a broken flow reads as celebrating it, and
  the evidence (trace, video, console) is what matters there, not the framing.
