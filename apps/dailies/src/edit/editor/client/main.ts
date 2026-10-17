// The browser editor's client — a deliberately small placeholder that proves
// the pipeline end to end: it loads the session over the API, plays the
// source, lists what the cut holds, saves the cut back and renders it. The
// full editor (timeline, live preview, caption and narration editing,
// microphone recording) replaces this file; the HTTP contract it uses is in
// ../contract.ts and AGENTS.md.
//
// It imports the cut model straight from ../../cut.ts: planCut and mapTime
// are pure, so the preview computes output times exactly as the renderer will.

import { type CutPlan, mapTime, planCut } from "../../cut.js";
import {
  EDITOR_HEADER,
  EDITOR_HEADER_VALUE,
  type EditorSession,
  type RenderStatus,
  type SaveCutResponse,
} from "../contract.js";

const POLL_MS = 1000;
const app = document.getElementById("app") as HTMLElement;

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      [EDITOR_HEADER]: EDITOR_HEADER_VALUE,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `${method} ${url} failed (${res.status})`);
  }
  return data;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = ""
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) {
    node.className = className;
  }
  return node;
}

// m:ss.s, the way `dailies cut render` prints a position.
function clock(sec: number): string {
  const tenths = Math.round(Math.max(0, sec) * 10);
  const seconds = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
  return `${Math.floor(tenths / 600)}:${seconds}`;
}

function section(title: string, ...children: Node[]): HTMLElement {
  const box = el("section");
  box.append(el("h2", title), ...children);
  return box;
}

function list(items: string[], empty: string): HTMLElement {
  if (items.length === 0) {
    return el("p", empty, "muted");
  }
  const ul = el("ul");
  ul.append(...items.map((text) => el("li", text)));
  return ul;
}

function stepList(
  session: EditorSession,
  plan: CutPlan,
  video: HTMLVideoElement
): HTMLElement {
  const ol = el("ol", "", "steps");
  for (const step of session.steps) {
    const out = mapTime(plan, step.at);
    const button = el(
      "button",
      `${clock(step.at)}  ${step.name}${step.ok ? "" : " (failed)"}`
    );
    button.type = "button";
    button.title = out.removed
      ? "Cut from the video"
      : `At ${clock(out.out)} in the video`;
    button.addEventListener("click", () => {
      video.currentTime = step.at;
    });
    const li = el("li");
    li.append(button);
    ol.append(li);
  }
  return ol;
}

function renderPanel(): {
  panel: HTMLElement;
  show: (status: RenderStatus, videoUrl?: string) => void;
} {
  const panel = el("section", "", "render");
  const show = (status: RenderStatus, videoUrl?: string) => {
    const result = status.state === "done" ? status.result : undefined;
    const lines = [
      ...status.progress,
      ...(status.error ? [`Error: ${status.error}`] : []),
      ...(result?.notes ?? []),
      ...(result?.warnings ?? []).map((w) => `Warning: ${w}`),
    ];
    panel.replaceChildren(el("h2", `Render: ${status.state}`), list(lines, ""));
    if (result && videoUrl) {
      const video = el("video");
      video.controls = true;
      video.src = videoUrl;
      panel.append(
        el("p", `Rendered ${clock(result.durationSec)} of video.`),
        video
      );
    }
  };
  return { panel, show };
}

// Follow the render until it settles, then show the new video (its URL
// changes with every render, so the session is fetched again for it).
async function pollRender(
  show: (status: RenderStatus, videoUrl?: string) => void,
  report: (message: string) => void
): Promise<void> {
  try {
    const status = await api<RenderStatus>("GET", "/api/render");
    if (status.state === "running") {
      show(status);
      setTimeout(() => void pollRender(show, report), POLL_MS);
      return;
    }
    const session = await api<EditorSession>("GET", "/api/session");
    show(status, session.video.url);
  } catch (err) {
    report(`Lost track of the render: ${(err as Error).message}`);
  }
}

function view(session: EditorSession): void {
  const plan = planCut(session.cut, session.source);
  const video = el("video");
  video.controls = true;
  video.src = "/source.webm";
  const status = el("p", "", "status");
  status.setAttribute("role", "status");
  const { panel, show } = renderPanel();
  const report = (message: string) => {
    status.textContent = message;
  };

  const save = el("button", "Save cut");
  save.type = "button";
  save.addEventListener("click", async () => {
    try {
      await api<SaveCutResponse>("PUT", "/api/cut", session.cut);
      report("Saved cut.json.");
    } catch (err) {
      report(`Not saved: ${(err as Error).message}`);
    }
  });
  const renderButton = el("button", "Render");
  renderButton.type = "button";
  renderButton.addEventListener("click", async () => {
    try {
      show(await api<RenderStatus>("POST", "/api/render"));
      setTimeout(() => void pollRender(show, report), POLL_MS);
    } catch (err) {
      report(`Not rendered: ${(err as Error).message}`);
    }
  });
  const actions = el("div", "", "actions");
  actions.append(save, renderButton, status);

  app.replaceChildren(
    el("h1", session.name ?? session.id),
    el(
      "p",
      `${session.id} · ${clock(plan.sourceDurationSec)} of footage → ${clock(plan.outDurationSec)} of video`,
      "muted"
    ),
    video,
    actions,
    section("Steps", stepList(session, plan, video)),
    section(
      "Captions",
      list(
        session.cut.captions.map(
          (c) => `${clock(c.start)}–${clock(c.end)}  ${c.text}`
        ),
        "No captions."
      )
    ),
    section(
      "Narration",
      list(
        session.cut.narration.map(
          (l) => `${clock(l.at)}  ${l.text}${l.audio ? ` (${l.audio})` : ""}`
        ),
        "No narration."
      )
    ),
    panel
  );
  void pollRender(show, report);
}

function failed(err: unknown): void {
  app.replaceChildren(el("p", `Error: ${(err as Error).message}`, "error"));
}

api<EditorSession>("GET", "/api/session").then(view, failed);
