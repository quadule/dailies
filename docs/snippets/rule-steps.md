- LOOK with a peek, not a step: `{{cli}} run --session "$id" --peek` runs a script against the live
  page and records nothing — no step, no screenshot, no report entry. Snapshots, `page.url()`,
  `evaluate` and locator reads all work; clicks, typing, navigation, scrolling, captions and
  effects are refused, because footage between steps is cut from the film. A step is something a
  viewer watches happen; a peek is you reading the screen.
- Size steps the way a viewer would name them: "fill in the W-4", "sign Section 1", "invite the
  worker" — not one step per radio button or field. A step can fill a whole form and submit it.
  Five steps for five answers on one page is five rows a reviewer scrolls past, and five more
  model round trips. Split only where you need to read the result before deciding what to do.
- End a step by logging only what the next decision needs — the URL, a heading, a `{ track }` diff,
  or a scoped `ariaSnapshot()` of what you will act on next — so the next look is often
  unnecessary. Don't end steps with a whole-page outline out of habit: after a navigation `{ track
  }` resets and returns the whole page again, and each outline is tens of thousands of characters
  you then read.
- Mark setup and detours with `--skim`: signing in, flipping a setting, finishing unrelated
  onboarding to reach the feature, filling a form only because the flow demands it. The finished
  video fast-forwards through a run of skimmed steps, captions and all. Leave it off the steps
  that show the thing under test. Uncaptioned stretches are sped up too, so caption the moments
  that matter.
