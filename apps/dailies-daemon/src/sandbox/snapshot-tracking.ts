import {
  type AriaSnapshotNode,
  renderAriaSnapshotAsYaml,
} from "./playwright-internals.js";

type SnapshotStatus = "same" | "descendants" | "changed";

function snapshotStatus(
  same: boolean,
  descendantsOnly: boolean
): SnapshotStatus {
  if (same) {
    return "same";
  }
  return descendantsOnly ? "descendants" : "changed";
}

function matchPreviousChild(
  child: AriaSnapshotNode,
  oldChild: AriaSnapshotNode | string | undefined,
  previousByRef: Map<string, AriaSnapshotNode>
): AriaSnapshotNode | undefined {
  if (child.ref) {
    return previousByRef.get(child.ref);
  }
  return typeof oldChild === "string" ? undefined : oldChild;
}

function indexRefs(
  nodes: (AriaSnapshotNode | string)[],
  refs = new Map<string, AriaSnapshotNode>()
): Map<string, AriaSnapshotNode> {
  for (const node of nodes) {
    if (typeof node === "string") {
      continue;
    }
    if (node.ref) {
      refs.set(node.ref, node);
    }
    indexRefs(node.children ?? [], refs);
  }
  return refs;
}

function sameProperties(a: AriaSnapshotNode, b: AriaSnapshotNode): boolean {
  const keys = Object.keys(a).filter((key) => key !== "children");
  return (
    keys.length === Object.keys(b).filter((key) => key !== "children").length &&
    keys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]))
  );
}

function snapshotDiff(
  current: AriaSnapshotNode[],
  previous: AriaSnapshotNode[]
): AriaSnapshotNode[] {
  const previousByRef = indexRefs(previous);
  const statuses = new Map<AriaSnapshotNode, SnapshotStatus>();

  const compare = (
    node: AriaSnapshotNode,
    before: AriaSnapshotNode | undefined
  ): boolean => {
    const children = node.children ?? [];
    const oldChildren = before?.children ?? [];
    let same =
      before !== undefined &&
      sameProperties(node, before) &&
      children.length === oldChildren.length;
    let descendantsOnly = same;
    for (const [index, child] of children.entries()) {
      const oldChild = oldChildren[index];
      if (typeof child === "string") {
        same = same && child === oldChild;
        descendantsOnly = descendantsOnly && child === oldChild;
        continue;
      }
      const oldNode = matchPreviousChild(child, oldChild, previousByRef);
      const unchanged = compare(child, oldNode);
      if (!oldNode || oldNode !== oldChild || !(unchanged || child.ref)) {
        descendantsOnly = false;
      }
      same = same && unchanged && oldNode === oldChild;
    }
    statuses.set(node, snapshotStatus(same, descendantsOnly));
    return same;
  };

  for (const [index, node] of current.entries()) {
    compare(node, node.ref ? previousByRef.get(node.ref) : previous[index]);
  }

  const compact = (node: AriaSnapshotNode): AriaSnapshotNode => {
    if (node.ref && statuses.get(node) === "same") {
      return { role: `ref=${node.ref} [unchanged]` };
    }
    return {
      ...node,
      ...(node.children
        ? {
            children: node.children.map((child) =>
              typeof child === "string" ? child : compact(child)
            ),
          }
        : {}),
    };
  };

  const changed: AriaSnapshotNode[] = [];
  const collect = (node: AriaSnapshotNode): void => {
    const status = statuses.get(node);
    if (status === "same") {
      return;
    }
    if (status === "descendants") {
      for (const child of node.children ?? []) {
        if (typeof child !== "string") {
          collect(child);
        }
      }
      return;
    }
    const result = compact(node);
    changed.push({
      ...result,
      role: node.role === "text" ? "text" : `<changed> ${node.role}`,
    });
  };
  for (const node of current) {
    collect(node);
  }
  // Root insertions, removals and reordering have no surviving parent to show
  // their new order. Re-render the roots so an empty diff never hides a change.
  if (
    previous.length !== current.length ||
    current.some((node, index) => node.ref !== previous[index]?.ref)
  ) {
    return current.length
      ? current.map((node) => ({ ...node, role: `<changed> ${node.role}` }))
      : [{ role: "<changed> fragment" }];
  }
  return changed;
}

// Playwright 1.63 exposes structured snapshots but no longer owns track keys.
// Key by the server's document object: it survives fresh sandbox connections,
// changes on navigation, and can be collected when its page closes.
export class SnapshotTracker {
  private readonly documents = new WeakMap<
    object,
    Map<string, AriaSnapshotNode[]>
  >();

  render(document: object, key: string, snapshot: AriaSnapshotNode[]): string {
    let tracks = this.documents.get(document);
    if (!tracks) {
      tracks = new Map();
      this.documents.set(document, tracks);
    }
    const previous = tracks.get(key);
    tracks.set(key, snapshot);
    return renderAriaSnapshotAsYaml(
      previous ? snapshotDiff(snapshot, previous) : snapshot
    );
  }
}
