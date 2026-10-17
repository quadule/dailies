// The editor's state: the cut being edited, what is selected, the in/out
// marks, whether the cut differs from cut.json on disk, and the undo history
// (JSON snapshots of the cut). DOM-free; the views subscribe to changes.

import { type Cut, type CutVoice, formatCut } from "../../cut.js";

export type ItemKind = "caption" | "line" | "cut" | "speedup" | "hold";

export interface Selection {
  index: number;
  kind: ItemKind;
}

export interface Marks {
  in?: number;
  out?: number;
}

export interface Change {
  cut: boolean;
  marks: boolean;
  // The saved/unsaved state or the undo history changed.
  saved: boolean;
  selection: boolean;
}

interface Snapshot {
  cut: string;
  selection?: Selection;
}

const HISTORY_LIMIT = 200;

// The list in a cut that holds items of a kind.
export function itemsOf(cut: Cut, kind: ItemKind): unknown[] {
  switch (kind) {
    case "caption":
      return cut.captions;
    case "line":
      return cut.narration;
    case "cut":
      return cut.cuts;
    case "speedup":
      return cut.speedups;
    default:
      return cut.holds;
  }
}

function sameSelection(a?: Selection, b?: Selection): boolean {
  return a?.kind === b?.kind && a?.index === b?.index;
}

function sameVoice(a: CutVoice, b: CutVoice): boolean {
  const key = (v: CutVoice) =>
    JSON.stringify([v.narrator ?? null, v.name ?? null, v.speed ?? null]);
  return key(a) === key(b);
}

// How cut.json came to change under the editor.
export interface DiskChange {
  // A render wrote it, pinning the voice it used (render.ts pinVoice) — or a
  // line voiced ahead of a render (POST /api/voice), which pins the same way.
  rendered?: boolean;
}

export class EditorState {
  cut: Cut;
  marks: Marks = {};
  selection: Selection | undefined;

  // formatCut of the cut on disk: stable key order, times to the millisecond,
  // so a change that rounds away isn't "unsaved".
  private saved: string;
  private readonly undoStack: Snapshot[] = [];
  private readonly redoStack: Snapshot[] = [];
  // The snapshot from before a gesture (a drag, typing in a field) began; the
  // whole gesture becomes one undo step when it ends.
  private gesture: Snapshot | undefined;
  private readonly listeners = new Set<(change: Change) => void>();

  constructor(cut: Cut) {
    this.cut = structuredClone(cut);
    this.saved = formatCut(cut);
  }

  get dirty(): boolean {
    return formatCut(this.cut) !== this.saved;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  subscribe(listener: (change: Change) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // One edit. `mutate` changes the cut in place and may return the item to
  // select. Outside a gesture it is its own undo step.
  edit(mutate: (cut: Cut) => Selection | undefined): void {
    const before = this.snapshot();
    const selected = mutate(this.cut);
    const changed = JSON.stringify(this.cut) !== before.cut;
    if (changed && !this.gesture) {
      this.pushUndo(before);
    }
    const selection = selected
      ? !sameSelection(selected, this.selection)
      : false;
    if (selected) {
      this.selection = selected;
    }
    if (changed || selection) {
      this.emit({ cut: changed, selection, saved: changed, marks: false });
    }
  }

  // Start a gesture: the edits until end() undo as one.
  begin(): void {
    this.gesture ??= this.snapshot();
  }

  end(): void {
    const start = this.gesture;
    this.gesture = undefined;
    if (start && start.cut !== JSON.stringify(this.cut)) {
      this.pushUndo(start);
      this.emit({ cut: false, selection: false, saved: true, marks: false });
    }
  }

  undo(): void {
    this.travel(this.undoStack, this.redoStack);
  }

  redo(): void {
    this.travel(this.redoStack, this.undoStack);
  }

  select(selection: Selection | undefined): void {
    if (sameSelection(selection, this.selection)) {
      return;
    }
    this.selection = selection;
    this.emit({ cut: false, selection: true, saved: false, marks: false });
  }

  // Remove the selected item. Returns false when nothing is selected.
  removeSelected(): boolean {
    const selection = this.selection;
    if (!selection) {
      return false;
    }
    this.edit((cut) => {
      itemsOf(cut, selection.kind).splice(selection.index, 1);
      return;
    });
    this.selection = undefined;
    this.emit({ cut: false, selection: true, saved: false, marks: false });
    return true;
  }

  setMarks(marks: Marks): void {
    this.marks = marks;
    this.emit({ cut: false, selection: false, saved: false, marks: true });
  }

  // The server saved `saved` (normalized: times to the millisecond) from the
  // cut that was `sent`. Take its normalized form unless the cut was edited
  // while the save was in flight; either way it is now what's on disk.
  markSaved(saved: Cut, sent: string): void {
    const unchanged = JSON.stringify(this.cut) === sent;
    if (unchanged) {
      this.cut = structuredClone(saved);
    }
    this.saved = formatCut(saved);
    this.emit({ cut: unchanged, selection: false, saved: true, marks: false });
  }

  // cut.json changed on disk under us: take it as the saved cut. Undo
  // history stays; it holds snapshots, not diffs. After a render, see
  // pinVoice.
  load(cut: Cut, change: DiskChange = {}): void {
    if (change.rendered) {
      this.pinVoice(cut.voice);
    }
    this.cut = structuredClone(cut);
    this.saved = formatCut(cut);
    this.dropStaleSelection();
    this.emit({ cut: true, selection: true, saved: true, marks: false });
  }

  // Note that disk holds `disk` without touching the local edits — except,
  // after a render, the voice it pinned (see pinVoice).
  setDisk(disk: Cut, change: DiskChange = {}): void {
    const voiced = change.rendered === true && this.pinVoice(disk.voice, true);
    this.saved = formatCut(disk);
    this.emit({ cut: voiced, selection: false, saved: true, marks: false });
  }

  // A render pinned `pinned`, the voice it used, into cut.json. Wherever the
  // voice it started from (the saved cut's) still stands — every undo and
  // redo snapshot, a gesture's start and, with `current`, the cut being
  // edited — it becomes the pinned one, so an undo doesn't unpin it and a
  // save of that undo doesn't send the next render to a fresh voice that
  // re-voices every line. A voice changed on purpose stays as it was.
  // Returns whether the cut being edited changed.
  private pinVoice(pinned: CutVoice, current = false): boolean {
    const from = (JSON.parse(this.saved) as Cut).voice;
    if (sameVoice(from, pinned)) {
      return false;
    }
    const patch = (snapshot: Snapshot) => {
      const cut = JSON.parse(snapshot.cut) as Cut;
      if (sameVoice(cut.voice, from)) {
        cut.voice = structuredClone(pinned);
        snapshot.cut = JSON.stringify(cut);
      }
    };
    for (const snapshot of [...this.undoStack, ...this.redoStack]) {
      patch(snapshot);
    }
    if (this.gesture) {
      patch(this.gesture);
    }
    if (current && sameVoice(this.cut.voice, from)) {
      this.cut.voice = structuredClone(pinned);
      return true;
    }
    return false;
  }

  private snapshot(): Snapshot {
    return {
      cut: JSON.stringify(this.cut),
      ...(this.selection ? { selection: { ...this.selection } } : {}),
    };
  }

  private pushUndo(snapshot: Snapshot): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > HISTORY_LIMIT) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  private travel(from: Snapshot[], to: Snapshot[]): void {
    const target = from.pop();
    if (!target) {
      return;
    }
    this.gesture = undefined;
    to.push(this.snapshot());
    this.cut = JSON.parse(target.cut) as Cut;
    this.selection = target.selection;
    this.dropStaleSelection();
    this.emit({ cut: true, selection: true, saved: true, marks: false });
  }

  private dropStaleSelection(): void {
    const s = this.selection;
    if (s && s.index >= itemsOf(this.cut, s.kind).length) {
      this.selection = undefined;
    }
  }

  private emit(change: Change): void {
    for (const listener of this.listeners) {
      listener(change);
    }
  }
}
