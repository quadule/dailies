import type { CaptionEvent } from "dailies-protocol";
import type { ManifestStep } from "./manifest.js";

// How the report's Steps tab reads a long run: as chapters a person would name,
// not as one flat list of every command the agent sent. Every step index below
// points into manifest.steps.
export type ChapterItem =
  // One step, shown as its own row.
  | { kind: "step"; index: number }
  // A run of failed steps and the step that finally got past them. The failures
  // stay as evidence, folded behind the step that worked.
  | { kind: "attempts"; failed: number[]; outcome: number }
  // Consecutive steps recorded with `run --skim` (setup, detours), folded shut.
  | { kind: "skim"; items: ChapterItem[] };

export interface Chapter {
  items: ChapterItem[];
  // Further captions shown during the chapter's opening step, after the title.
  notes: string[];
  // Every step in the chapter, in order.
  steps: number[];
  // The caption that opened this chapter. Undefined for the steps before the
  // first caption, and for the single chapter of a run with no captions.
  title?: string;
}

// The step each caption appeared during: the last step that started at or
// before it. A caption fires a moment after its step starts, and one that lands
// between two steps belongs with the step before it, not the one after. A
// caption shown before the first step belongs to the first step.
export function captionsByStep(
  steps: ManifestStep[],
  captions: CaptionEvent[]
): Map<number, string[]> {
  const starts = steps.map((s) => Date.parse(s.startedAt));
  const timed = captions
    .map((c) => ({ at: Date.parse(c.at), text: c.text.trim() }))
    .filter((c) => !Number.isNaN(c.at) && c.text)
    .sort((a, b) => a.at - b.at);
  const byStep = new Map<number, string[]>();
  if (steps.length === 0) {
    return byStep;
  }
  for (const caption of timed) {
    let owner = 0;
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i] ?? Number.NaN;
      if (!Number.isNaN(start) && start <= caption.at) {
        owner = i;
      }
    }
    byStep.set(owner, [...(byStep.get(owner) ?? []), caption.text]);
  }
  return byStep;
}

export function itemSteps(item: ChapterItem): number[] {
  switch (item.kind) {
    case "step":
      return [item.index];
    case "attempts":
      return [...item.failed, item.outcome];
    default:
      return item.items.flatMap(itemSteps);
  }
}

// A step item that failed and nothing in the chapter recovered from. These are
// the failures a reviewer has to look at, so they are never folded away.
export function isUnrecoveredFailure(
  item: ChapterItem,
  steps: ManifestStep[]
): boolean {
  return item.kind === "step" && steps[item.index]?.status === "fail";
}

// Retries rarely share a name (sign-i9 fails, type-i9-signature fails,
// check-signature-dialog works), so they are grouped by position: a run of
// failed steps plus the next step to pass. A run with nothing after it in the
// chapter stays as plain failed rows.
function groupAttempts(
  indices: number[],
  steps: ManifestStep[]
): ChapterItem[] {
  const items: ChapterItem[] = [];
  let failed: number[] = [];
  for (const index of indices) {
    if (steps[index]?.status === "fail") {
      failed.push(index);
      continue;
    }
    if (failed.length > 0) {
      items.push({ failed, kind: "attempts", outcome: index });
      failed = [];
    } else {
      items.push({ index, kind: "step" });
    }
  }
  for (const index of failed) {
    items.push({ index, kind: "step" });
  }
  return items;
}

// Fold runs of two or more skimmed items. A lone skimmed step stays a row: a
// fold that hides one row saves nothing.
function foldSkims(items: ChapterItem[], steps: ManifestStep[]): ChapterItem[] {
  const skimmable = (item: ChapterItem) =>
    !isUnrecoveredFailure(item, steps) &&
    itemSteps(item).every((i) => steps[i]?.skim);
  const out: ChapterItem[] = [];
  let run: ChapterItem[] = [];
  const flush = () => {
    if (run.length >= 2) {
      out.push({ items: run, kind: "skim" });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const item of items) {
    if (skimmable(item)) {
      run.push(item);
    } else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

// Group a run's steps into chapters. A step that showed a caption opens a
// chapter titled by that caption, and the uncaptioned steps after it fold under
// it. A run with no captions is one untitled chapter.
export function buildChapters(
  steps: ManifestStep[],
  captions: CaptionEvent[]
): Chapter[] {
  const byStep = captionsByStep(steps, captions);
  const groups: { title?: string; notes: string[]; steps: number[] }[] = [];
  steps.forEach((_, index) => {
    const shown = byStep.get(index);
    const current = groups.at(-1);
    if (shown || !current) {
      groups.push({
        notes: shown?.slice(1) ?? [],
        steps: [index],
        title: shown?.[0],
      });
    } else {
      current.steps.push(index);
    }
  });
  return groups.map((group) => ({
    ...group,
    items: foldSkims(groupAttempts(group.steps, steps), steps),
  }));
}
