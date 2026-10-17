// Small DOM helpers for the editor's views: an element builder, icons, and a
// keyed list that updates elements in place (so a drag's pointer capture and
// a focused control survive a re-render).

type Child = Node | string | false | null | undefined;

type Handlers = {
  [E in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[E]) => void;
};

export interface Props {
  attrs?: Record<string, string>;
  class?: string;
  on?: Handlers;
  text?: string;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props & Partial<Omit<HTMLElementTagNameMap[K], "style">> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const { attrs, class: className, on, text, ...rest } = props;
  const node = document.createElement(tag);
  Object.assign(node, rest);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  for (const [name, value] of Object.entries(attrs ?? {})) {
    node.setAttribute(name, value);
  }
  for (const [event, handler] of Object.entries(on ?? {})) {
    node.addEventListener(event, handler as EventListener);
  }
  for (const child of children) {
    if (child) {
      node.append(child);
    }
  }
  return node;
}

// A button: type="button", and an accessible name even when it shows only an
// icon.
export function button(
  label: string,
  onClick: () => void,
  opts: {
    class?: string;
    icon?: IconName;
    iconOnly?: boolean;
    title?: string;
  } = {}
): HTMLButtonElement {
  const node = h("button", {
    type: "button",
    class: opts.class ?? "btn",
    on: { click: onClick },
  });
  if (opts.icon) {
    node.append(icon(opts.icon));
  }
  if (opts.iconOnly) {
    node.setAttribute("aria-label", label);
    node.title = opts.title ?? label;
  } else {
    node.append(h("span", { text: label }));
    if (opts.title) {
      node.title = opts.title;
    }
  }
  return node;
}

const SVG = "http://www.w3.org/2000/svg";

// 16px outline icons, drawn with currentColor at a 1.5 stroke.
const ICONS = {
  play: "M5 3.5v9l7-4.5z",
  pause: "M5.5 3.5v9M10.5 3.5v9",
  frameBack: "M10.5 4 6 8l4.5 4M4 4v8",
  frameForward: "M5.5 4 10 8l-4.5 4M12 4v8",
  stepBack: "M12 4 7.5 8l4.5 4M7.5 4 3 8l4.5 4",
  stepForward: "M4 4l4.5 4L4 12M8.5 4 13 8l-4.5 4",
  undo: "M6 4 3 7l3 3M3 7h6.5a3.5 3.5 0 0 1 0 7H7",
  redo: "M10 4l3 3-3 3M13 7H6.5a3.5 3.5 0 0 0 0 7H9",
  plus: "M8 3.5v9M3.5 8h9",
  minus: "M3.5 8h9",
  fit: "M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3",
  trash: "M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8.5h5l.5-8.5",
  copy: "M5.5 5.5V3h7.5v7.5h-2.5M3 5.5h7.5V13H3z",
  stop: "M4.5 4.5h7v7h-7z",
  upload: "M8 10.5V3M5 6l3-3 3 3M3 10.5V13h10v-2.5",
  record: "M8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
} as const;

// Icons drawn as a filled shape rather than a stroke.
const FILLED: ReadonlySet<IconName> = new Set(["play", "record"]);

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("ico");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name]);
  if (FILLED.has(name)) {
    path.setAttribute("fill", "currentColor");
  } else {
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
  }
  svg.append(path);
  return svg;
}

// Swap a button's icon in place.
export function setIcon(target: Element, name: IconName): void {
  const old = target.querySelector("svg.ico");
  const next = icon(name);
  if (old) {
    old.replaceWith(next);
  } else {
    target.prepend(next);
  }
}

const keyedChildren = new WeakMap<HTMLElement, Map<string, HTMLElement>>();

// Make `container` hold one element per key, in order: existing elements are
// updated in place, new keys created, gone keys removed.
export function keyed(
  container: HTMLElement,
  keys: readonly string[],
  create: (key: string) => HTMLElement,
  update: (el: HTMLElement, key: string) => void
): void {
  const old = keyedChildren.get(container) ?? new Map<string, HTMLElement>();
  const next = new Map<string, HTMLElement>();
  for (const key of keys) {
    const el = old.get(key) ?? create(key);
    update(el, key);
    next.set(key, el);
    if (el.parentElement !== container) {
      container.append(el);
    }
  }
  for (const [key, el] of old) {
    if (!next.has(key)) {
      el.remove();
    }
  }
  keyedChildren.set(container, next);
}

// A field is something the user is typing in: keyboard shortcuts leave it
// alone.
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
