import path from "node:path";
import { formatDurationMs } from "dailies-cli-kit";
import { type CaptionEvent, sessionStepSlug } from "dailies-protocol";
import {
  buildChapters,
  type Chapter,
  type ChapterItem,
  isUnrecoveredFailure,
  itemSteps,
} from "./chapters.js";
import type { SessionManifest } from "./manifest.js";
import type { ConsoleEntry } from "./parse-console.js";
import type { HarSummary } from "./parse-har.js";

export interface RenderContext {
  // What the run showed on screen. Each caption opens a chapter in the Steps tab.
  captions?: CaptionEvent[];
  consoleEntries: ConsoleEntry[];
  parsedHar: HarSummary;
  screenshots: Record<string, string>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Duration formatting is shared with the CLI's `status`/`session list` output.
const fmtMs = formatDurationMs;

function fmtBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Step output is counted in characters (what the agent read back), not bytes.
function fmtChars(chars: number): string {
  if (chars < 1000) {
    return `${chars} chars`;
  }
  if (chars < 1_000_000) {
    return `${(chars / 1000).toFixed(1)}k chars`;
  }
  return `${(chars / 1_000_000).toFixed(2)}M chars`;
}

function fmtClock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso;
  }
  return new Date(ms).toLocaleString();
}

// "High-Contrast Precision": centered single column, big title, lime status pill,
// and a horizontal tab nav with a lime active underline. Self-contained — inlined
// CSS + a tiny vanilla tab/steps/gallery script (no fonts/CDN/framework). Surfaces
// are white on #f9f9f9, depth comes from 1px outlines + tonal wells (no shadows),
// and the lime accent (#e4f222) is reserved for status and the active tab.
const STYLE = `
:root{
  --surface:#f9f9f9; --card:#fff; --well:#f3f3f3; --well-2:#eeeeee;
  --ink:#1a1c1c; --ink-strong:#0a0a0a; --muted:#5f5e5e; --faint:#84856f;
  --line:#e5e5e5; --line-2:#d3d3c2;
  --primary:#e4f222; --on-primary:#0a0a0a;
  --pass:#2f6f12; --fail:#ba1a1a; --fail-bg:#ffdad6; --on-fail:#93000a;
  --warn:#8a5d00; --warn-bg:#fbf3e0;
  --r-sm:2px; --r:4px; --r-md:6px; --r-lg:8px; --r-full:9999px;
}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);
  font:16px/1.5 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
.page{max-width:1200px;margin:0 auto;padding:48px 64px 96px}
/* header */
.rhead{text-align:center;margin-bottom:30px}
.crumb{color:var(--muted);font-size:14px;font-weight:500;letter-spacing:.01em}
.crumb .sep{margin:0 8px;color:var(--faint)}
.title{font-size:clamp(28px,5vw,48px);line-height:1.08;font-weight:700;letter-spacing:-.02em;
  margin:14px 0 20px;color:var(--ink);word-break:break-word}
.status-row{display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap}
.dur{color:var(--muted);font-size:16px}
.verdict-reason{text-align:center;color:var(--muted);font-size:14px;margin-top:8px;font-style:italic}
/* badges */
.badge{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:var(--r-full);
  font-size:13px;font-weight:700;letter-spacing:.04em;border:1px solid transparent;white-space:nowrap}
.badge .ico{flex:0 0 auto;display:block}
.badge.sm{padding:3px 10px;font-size:11px;gap:5px;letter-spacing:.02em;text-transform:capitalize}
.badge.passed,.badge.pass{background:var(--primary);color:var(--on-primary);border-color:#cdd900}
.badge.failed,.badge.fail{background:var(--fail-bg);color:var(--on-fail);border-color:#f3c4c0}
.badge.aborted{background:var(--warn-bg);color:var(--warn);border-color:#ecdcae}
/* tabs */
.tabs{display:flex;justify-content:center;flex-wrap:wrap;gap:28px;
  border-bottom:1px solid var(--line);margin-bottom:40px}
.tab{appearance:none;border:0;background:transparent;font:inherit;font-size:15px;font-weight:600;
  color:var(--muted);cursor:pointer;padding:0 2px 14px;border-bottom:3px solid transparent;margin-bottom:-1px}
.tab:hover{color:var(--ink)}
.tab.is-active{color:var(--ink);border-bottom-color:var(--primary)}
/* panels */
.panel.is-hidden{display:none}
/* kpis */
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--r-md);padding:22px 24px}
.kpi .n{font-size:30px;font-weight:700;letter-spacing:-.02em;line-height:1.1;color:var(--ink);font-variant-numeric:tabular-nums}
.kpi .n.fail{color:var(--fail)}
.kpi .l{margin-top:6px;color:var(--muted);font-size:14px;font-weight:500}
/* card */
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;margin-bottom:24px}
.card-h{display:flex;align-items:center;gap:10px;padding:16px 24px;border-bottom:1px solid var(--line)}
h2{font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0}
.card-h .count{margin-left:auto;color:var(--faint);font-size:13px;font-variant-numeric:tabular-nums}
.empty{color:var(--faint);font-style:italic;padding:40px 24px;text-align:center}
/* steps view toggle */
.card-h .viewtoggle{margin-left:auto;display:flex;gap:3px;background:var(--well);
  border:1px solid var(--line);border-radius:var(--r-full);padding:3px}
.card-h .viewtoggle+.count{margin-left:0}
.vbtn{appearance:none;border:0;background:transparent;font:inherit;font-size:12px;font-weight:600;
  color:var(--muted);padding:3px 12px;border-radius:var(--r-full);cursor:pointer;white-space:nowrap}
.vbtn:hover{color:var(--ink)}
.vbtn.is-active{background:var(--card);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line-2)}
/* steps (merged list/timeline + expandable detail) */
.step{border-bottom:1px solid var(--line)}
.step:last-child{border-bottom:0}
.step>summary{list-style:none;cursor:pointer}
.step>summary::-webkit-details-marker{display:none}
.srow{display:flex;align-items:center;gap:14px;padding:15px 24px}
.srow:hover{background:rgba(228,242,34,.06)}
.dot{flex:0 0 auto;width:9px;height:9px;border-radius:50%;background:var(--line-2);box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)}
.dot.pass{background:var(--primary)}
.dot.fail{background:var(--fail);box-shadow:none}
.sname{font-weight:600;letter-spacing:-.005em;min-width:0;word-break:break-word}
.smeta{margin-left:auto;color:var(--faint);font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}
.shotlink{appearance:none;border:0;background:transparent;padding:4px;border-radius:var(--r);
  color:var(--faint);cursor:pointer;display:inline-flex;align-items:center}
.shotlink:hover{color:var(--ink);background:var(--well-2)}
.chev{flex:0 0 auto;color:var(--faint);display:inline-flex;transition:transform .15s ease}
.step[open] .chev{transform:rotate(180deg)}
.step.flash>summary .srow{animation:stepflash 1.4s ease-out}
@keyframes stepflash{0%{background:rgba(228,242,34,.45)}100%{background:transparent}}
.sbody{border-top:1px dashed var(--line);background:var(--surface)}
.sbody .empty{padding:18px 24px}
/* chapters: one per caption, folding the steps the caption narrated */
.chapter{border-bottom:1px solid var(--line)}
.chapter:last-child{border-bottom:0}
.chapter>summary,.fold>summary{list-style:none;cursor:pointer}
.chapter>summary::-webkit-details-marker,.fold>summary::-webkit-details-marker{display:none}
.crow{display:flex;align-items:center;gap:14px;padding:16px 24px}
.crow:hover,.frow:hover{background:rgba(228,242,34,.06)}
.ctitle{font-weight:600;min-width:0;word-break:break-word}
.ctitle.untitled{color:var(--muted);font-style:italic;font-weight:500}
.cnote{padding:0 24px 12px 47px;margin-top:-8px;color:var(--muted);font-size:14px}
.chapter[open] .crow .chev,.fold[open]>summary .chev{transform:rotate(180deg)}
.cbody{border-top:1px solid var(--line);box-shadow:inset 3px 0 0 var(--line-2)}
.cbody .step,.cbody .fold{border-bottom:1px solid var(--line)}
.cbody>:last-child{border-bottom:0}
.dot.retry,.bar.retry{background:var(--warn)}
/* folds: retries and skimmed steps, shut until asked for */
.frow{display:flex;align-items:center;gap:14px;padding:11px 24px;color:var(--muted);font-size:14px}
.fname{font-weight:500;min-width:0}
.frow .dot{width:7px;height:7px}
.fbody{border-top:1px dashed var(--line);box-shadow:inset 3px 0 0 var(--well-2)}
.fbody .step:last-child{border-bottom:0}
.attempts{border-bottom:1px solid var(--line)}
.attempts>.fold,.attempts>.step{border-bottom:0}
.stag{flex:0 0 auto;color:var(--muted);background:var(--well-2);border-radius:var(--r-full);
  padding:1px 8px;font-size:11px;font-weight:600;letter-spacing:.02em}
/* timeline mode: same rows, bars instead of plain labels */
.steps .track{display:none}
.steps.view-timeline .sname,.steps.view-timeline .ctitle{flex:0 0 200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.steps.view-timeline .track{display:block;position:relative;flex:1;height:14px;background:var(--well);border-radius:var(--r-full)}
.steps.view-timeline .smeta{margin-left:0;flex:0 0 auto;width:84px;text-align:right}
.steps.view-timeline .crow .smeta,.steps.view-timeline .frow .smeta{width:170px}
.bar{position:absolute;top:0;height:14px;border-radius:var(--r-full);min-width:4px}
.bar.pass{background:var(--primary)}
.bar.fail{background:var(--fail)}
/* screenshots gallery */
.gallery{margin:0}
.stage{position:relative;background:var(--well);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;
  display:flex;align-items:center;justify-content:center;min-height:200px}
.stage img{display:block;max-width:100%;max-height:62vh;width:auto;height:auto}
.navbtn{position:absolute;top:50%;transform:translateY(-50%);z-index:2;width:38px;height:38px;
  display:flex;align-items:center;justify-content:center;border-radius:var(--r-full);
  border:1px solid var(--line-2);background:rgba(255,255,255,.92);color:var(--ink);cursor:pointer;padding:0}
.navbtn:hover{border-color:var(--ink-strong)}
.navbtn.prev{left:12px}
.navbtn.next{right:12px}
#shot-cap{display:flex;align-items:baseline;justify-content:center;gap:10px;
  color:var(--muted);font-size:14px;font-weight:500;margin:14px 0 20px;word-break:break-word}
.caplink{appearance:none;border:0;background:transparent;font:inherit;font-weight:600;padding:0;
  color:var(--ink);cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px}
.caplink:hover{color:var(--ink-strong);text-decoration-style:solid}
.shot-pos{color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.thumbs{display:flex;flex-wrap:wrap;gap:12px;justify-content:center}
.thumb{padding:0;border:2px solid transparent;border-radius:var(--r);background:var(--well);
  cursor:pointer;overflow:hidden;width:132px;height:84px}
.thumb img{display:block;width:100%;height:100%;object-fit:cover}
.thumb:hover{border-color:var(--line-2)}
.thumb.is-active{border-color:var(--primary)}
/* tables */
table{width:100%;border-collapse:collapse;font-size:14px}
thead th{text-align:left;padding:11px 24px;color:var(--faint);font-weight:600;font-size:11px;
  letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid var(--line)}
tbody td{padding:11px 24px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:rgba(228,242,34,.05)}
tr.err td{background:var(--fail-bg)}
.tag{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
.chip{display:inline-block;background:var(--well-2);border-radius:var(--r-full);padding:2px 10px;
  font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--ink)}
.num{font-variant-numeric:tabular-nums;color:var(--ink)}
.url,.src{color:var(--muted);word-break:break-all}
.truncate{max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* videos */
.vids{padding:18px 24px;display:flex;flex-direction:column;gap:24px}
.vid video{display:block;width:100%;max-width:760px;border:1px solid var(--line);border-radius:var(--r-md);background:#000}
.vmeta{display:flex;gap:12px;align-items:center;margin-top:8px;font-size:13px}
/* artifacts */
.art{padding:18px 24px;border-bottom:1px solid var(--line)}
.art:last-child{border-bottom:0}
.art-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.art .k{font-weight:600;min-width:120px}
.sz{color:var(--faint);font-size:12px;font-variant-numeric:tabular-nums}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:1px solid var(--line-2);
  border-radius:var(--r);background:var(--card);color:var(--ink);text-decoration:none;font-size:13px;font-weight:600}
.btn:hover{border-color:var(--ink-strong)}
.hint{font-size:13px;color:var(--muted);margin-top:8px}
code{background:var(--well-2);border:1px solid var(--line);border-radius:var(--r-sm);padding:2px 7px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
/* per-step script */
.scriptbox{margin:0;padding:14px 24px;border-bottom:1px solid var(--line)}
.scriptbox summary{cursor:pointer;font-weight:700;font-size:11px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--muted)}
.scriptbox pre{margin:12px 0 2px;background:var(--well-2);border:1px solid var(--line);border-radius:var(--r);
  padding:14px 16px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:12px;line-height:1.55;color:var(--ink);white-space:pre-wrap;word-break:break-word}
.cmd-params{color:var(--muted);word-break:break-word}
.cmd-err{margin-top:4px;color:var(--on-fail);font-size:12px}
/* responsive: desktop → tablet → mobile (narrower rules come last so they win) */
@media (max-width:1024px){
  .page{padding:40px 32px 80px}
  .tabs{gap:22px}
}
@media (max-width:880px){
  .page{padding:32px 16px 64px}
  .tabs{gap:18px;justify-content:flex-start;flex-wrap:nowrap;overflow-x:auto}
  .tab{white-space:nowrap}
  .kpis{grid-template-columns:repeat(2,1fr)}
  .steps.view-timeline .sname,.steps.view-timeline .ctitle{flex-basis:120px}
  .card-h,thead th,tbody td,.srow,.crow,.frow,.vids,.art,.scriptbox{padding-left:16px;padding-right:16px}
}
@media (max-width:480px){
  .kpis{grid-template-columns:1fr}
  .title{margin:10px 0 16px}
}
`;

const TAB_SCRIPT = `
(function(){
  var tabs=document.querySelectorAll('[data-tab]');
  var panels=document.querySelectorAll('.panel');
  // Old deep links (#execution / #commands) now live inside the Steps panel.
  var aliases={execution:'steps',commands:'steps'};
  var active='summary';
  function show(id){
    id=aliases[id]||id;
    if(!document.getElementById('panel-'+id)){id='summary';}
    active=id;
    for(var i=0;i<panels.length;i++){panels[i].classList.toggle('is-hidden',panels[i].id!=='panel-'+id);}
    for(var j=0;j<tabs.length;j++){tabs[j].classList.toggle('is-active',tabs[j].getAttribute('data-tab')===id);}
  }
  for(var k=0;k<tabs.length;k++){
    tabs[k].addEventListener('click',function(){var id=this.getAttribute('data-tab');show(id);history.replaceState(null,'','#'+id);});
  }
  show((location.hash||'').replace('#',''));

  // Steps: list <-> timeline toggle.
  var stepsBox=document.getElementById('steps-list');
  var vbtns=document.querySelectorAll('.vbtn');
  for(var v=0;v<vbtns.length;v++){
    vbtns[v].addEventListener('click',function(){
      if(stepsBox){stepsBox.classList.toggle('view-timeline',this.getAttribute('data-view')==='timeline');}
      for(var w=0;w<vbtns.length;w++){vbtns[w].classList.toggle('is-active',vbtns[w]===this);}
    });
  }

  // Screenshot gallery: index-based model with thumbs, on-screen prev/next,
  // and arrow keys while the panel is visible.
  var thumbs=[].slice.call(document.querySelectorAll('.thumb'));
  var main=document.getElementById('shot-main');
  var capLink=document.getElementById('shot-cap-link');
  var capPos=document.getElementById('shot-pos');
  var current=0;
  function showShot(i){
    if(thumbs.length===0||!main){return;}
    current=((i%thumbs.length)+thumbs.length)%thumbs.length;
    var t=thumbs[current];
    var img=t.querySelector('img');
    if(img){main.src=img.getAttribute('src');main.alt=t.getAttribute('data-cap')||'';}
    if(capLink){capLink.textContent=t.getAttribute('data-cap')||'';capLink.setAttribute('data-goto-step',t.getAttribute('data-step')||'');}
    if(capPos){capPos.textContent=(current+1)+' / '+thumbs.length;}
    for(var n=0;n<thumbs.length;n++){thumbs[n].classList.toggle('is-active',n===current);}
  }
  thumbs.forEach(function(t,i){t.addEventListener('click',function(){showShot(i);});});
  var prev=document.getElementById('shot-prev');
  var next=document.getElementById('shot-next');
  if(prev){prev.addEventListener('click',function(){showShot(current-1);});}
  if(next){next.addEventListener('click',function(){showShot(current+1);});}
  document.addEventListener('keydown',function(e){
    if(active!=='screenshots'||thumbs.length===0){return;}
    if(e.key==='ArrowLeft'){showShot(current-1);e.preventDefault();}
    else if(e.key==='ArrowRight'){showShot(current+1);e.preventDefault();}
  });

  // Step -> screenshot: camera button inside a step row jumps the gallery.
  var shotBtns=document.querySelectorAll('[data-goto-shot]');
  for(var s=0;s<shotBtns.length;s++){
    shotBtns[s].addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();
      var slug=this.getAttribute('data-goto-shot');
      show('screenshots');history.replaceState(null,'','#screenshots');
      for(var i=0;i<thumbs.length;i++){
        if(thumbs[i].getAttribute('data-slug')===slug){showShot(i);break;}
      }
    });
  }
  // Screenshot -> step: the caption links back to its step, expanded.
  if(capLink){
    capLink.addEventListener('click',function(){
      var step=document.getElementById(this.getAttribute('data-goto-step')||'');
      if(!step){return;}
      show('steps');history.replaceState(null,'','#steps');
      // Open the step and every chapter or fold around it, or it stays hidden.
      for(var d=step;d;d=d.parentElement){if(d.tagName==='DETAILS'){d.open=true;}}
      step.classList.remove('flash');
      void step.offsetWidth;
      step.classList.add('flash');
      step.scrollIntoView({block:'center'});
    });
  }
  showShot(0);
})();
`;

const TABS: [string, string][] = [
  ["summary", "Summary"],
  ["steps", "Steps"],
  ["screenshots", "Screenshots"],
  ["console", "Console"],
  ["network", "Network"],
  ["artifacts", "Artifacts"],
];

const CAMERA_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
const CHEVRON_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const ARROW_LEFT_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
const ARROW_RIGHT_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

function statusIcon(status: string): string {
  let inner: string;
  if (status === "passed") {
    inner =
      '<path d="M4.5 8.3l2.4 2.3 4.6-4.9" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>';
  } else if (status === "failed") {
    inner =
      '<path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>';
  } else {
    inner =
      '<path d="M5 8h6" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>';
  }
  return `<svg class="ico" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/>${inner}</svg>`;
}

function renderHeader(m: SessionManifest): string {
  return `
  <header class="rhead">
    <div class="crumb">Dailies <span class="sep">›</span> ${escapeHtml(m.id)}</div>
    <h1 class="title">${escapeHtml(m.name ?? m.id)}</h1>
    <div class="status-row">
      <span class="badge ${m.status}">${statusIcon(m.status)}${m.status.toUpperCase()}</span>
      <span class="dur">${fmtMs(m.durationMs)} duration</span>
    </div>${
      m.verdictReason
        ? `\n    <div class="verdict-reason">${escapeHtml(m.verdictReason)}</div>`
        : ""
    }
  </header>`;
}

function renderTabs(): string {
  const buttons = TABS.map(
    ([id, label], i) =>
      `<button class="tab${i === 0 ? " is-active" : ""}" data-tab="${id}">${label}</button>`
  ).join("");
  return `<nav class="tabs">${buttons}</nav>`;
}

function renderEnvironment(m: SessionManifest): string {
  const flags = Object.entries(m.capture)
    .filter(([, on]) => on)
    .map(([k]) => k)
    .join(" · ");
  return `
    <div class="card">
      <div class="card-h"><h2>Environment</h2></div>
      <table><tbody>
        <tr><td class="tag" style="width:150px">Status</td><td><span class="badge sm ${m.status}">${m.status}</span></td></tr>
        <tr><td class="tag">Browser</td><td>${escapeHtml(m.environment.browser)} · ${m.environment.headless ? "headless" : "headed"}</td></tr>
        <tr><td class="tag">Playwright</td><td class="mono">${escapeHtml(m.environment.playwrightVersion)}</td></tr>
        <tr><td class="tag">Platform</td><td class="mono">${escapeHtml(m.environment.platform)}</td></tr>
        <tr><td class="tag">Captured</td><td>${escapeHtml(flags || "none")}</td></tr>
        <tr><td class="tag">Started</td><td class="num">${escapeHtml(fmtClock(m.createdAt))}</td></tr>
        <tr><td class="tag">Ended</td><td class="num">${escapeHtml(fmtClock(m.endedAt))}</td></tr>
        <tr><td class="tag">Duration</td><td class="num">${fmtMs(m.durationMs)}</td></tr>${renderOutputRow(m)}
      </tbody></table>
    </div>`;
}

// What the agent read back from its steps and peeks — the run's main context
// cost after the skills themselves. Omitted for sessions that predate it.
function renderOutputRow(m: SessionManifest): string {
  const { outputChars, peeks = 0 } = m.summary;
  if (outputChars === undefined) {
    return "";
  }
  const steps = `${m.summary.stepsTotal} step${m.summary.stepsTotal === 1 ? "" : "s"}`;
  const looks = `${peeks} peek${peeks === 1 ? "" : "s"}`;
  return `
        <tr><td class="tag">Step output</td><td class="num">${fmtChars(outputChars)} printed by ${steps} and ${looks}</td></tr>`;
}

function renderSummary(m: SessionManifest): string {
  const s = m.summary;
  const cells: [string, string, string][] = [
    [String(s.stepsTotal), "Steps", ""],
    [String(s.stepsPassed), "Passed", ""],
    [String(s.stepsFailed), "Failed", s.stepsFailed > 0 ? "fail" : ""],
    [fmtMs(m.durationMs), "Duration", ""],
    [
      String(s.consoleErrors),
      "Console errors",
      s.consoleErrors > 0 ? "fail" : "",
    ],
    [
      String(s.networkFailures),
      "Network failures",
      s.networkFailures > 0 ? "fail" : "",
    ],
  ];
  const kpis = cells
    .map(
      ([value, label, cls]) =>
        `<div class="kpi"><div class="n ${cls}">${value}</div><div class="l">${label}</div></div>`
    )
    .join("");
  return `
  <section class="panel" id="panel-summary">
    <div class="kpis">${kpis}</div>
    ${renderEnvironment(m)}
  </section>`;
}

function renderActionRow(
  action: SessionManifest["steps"][number]["actions"][number]
): string {
  const params = action.params ? escapeHtml(action.params) : "";
  const err = action.error
    ? `<div class="cmd-err">${escapeHtml(action.error)}</div>`
    : "";
  const time = action.durationMs === undefined ? "—" : fmtMs(action.durationMs);
  return `<tr class="${action.error ? "err" : ""}"><td><span class="chip">${escapeHtml(action.apiName)}</span></td><td class="mono cmd-params">${params}${err}</td><td class="num">${time}</td></tr>`;
}

// The expandable body of one step: the script that was sent plus the
// Playwright actions recovered from the trace.
function renderStepBody(step: SessionManifest["steps"][number]): string {
  const hasScript = Boolean(step.script?.trim());
  const scriptBlock = hasScript
    ? `<details class="scriptbox"><summary>Script</summary><pre>${escapeHtml(step.script ?? "")}</pre></details>`
    : "";
  const actions =
    step.actions.length > 0
      ? `<table><thead><tr><th style="width:220px">Action</th><th>Params</th><th style="width:88px">Time</th></tr></thead><tbody>${step.actions
          .map(renderActionRow)
          .join("")}</tbody></table>`
      : "";
  const error = step.error
    ? `<div class="cmd-err">${escapeHtml(step.error)}</div>`
    : "";
  if (!(hasScript || actions || error)) {
    return '<div class="empty">No script or Playwright actions recorded for this step. Enable trace capture to record actions.</div>';
  }
  return `${error}${scriptBlock}${actions}`;
}

type Step = SessionManifest["steps"][number];

interface StepsView {
  // Each step's timeline bar, as percentages of the run.
  bars: { off: number; w: number }[];
  m: SessionManifest;
  screenshots: Record<string, string>;
}

// Where each step's bar sits on the run's timeline. A step with an unparseable
// start falls back to the summed durations before it.
function stepBars(m: SessionManifest): { off: number; w: number }[] {
  const t0 = Date.parse(m.createdAt);
  const span = Math.max(m.durationMs, 1);
  const MIN_W = 1.5;
  let cursor = 0;
  return m.steps.map((step) => {
    const start = Date.parse(step.startedAt);
    let off: number;
    if (Number.isNaN(start) || Number.isNaN(t0)) {
      off = (cursor / span) * 100;
    } else {
      off = ((start - t0) / span) * 100;
    }
    // Advance the fallback cursor for EVERY step (not just invalid ones)
    // so an invalid-timestamp step following valid ones lands after them,
    // not stacked at offset 0.
    cursor += step.durationMs;
    off = Math.min(Math.max(off, 0), 100);
    let w = Math.max((step.durationMs / span) * 100, MIN_W);
    if (off + w > 100) {
      w = Math.max(100 - off, MIN_W);
    }
    return { off, w };
  });
}

function bar(cls: string, off: number, w: number): string {
  return `<span class="track"><span class="bar ${cls}" style="left:${off.toFixed(2)}%;width:${w.toFixed(2)}%"></span></span>`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// How long a group of steps took on the wall clock, first start to last end —
// including the time between steps, which is most of a long run. Falls back to
// the summed step durations when a timestamp won't parse.
function wallMs(steps: Step[]): number {
  const first = steps[0];
  const last = steps.at(-1);
  const start = Date.parse(first?.startedAt ?? "");
  const end = Date.parse(last?.startedAt ?? "") + (last?.durationMs ?? 0);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return steps.reduce((sum, s) => sum + s.durationMs, 0);
  }
  return Math.max(0, end - start);
}

function renderStepRow(view: StepsView, i: number): string {
  const step = view.m.steps[i];
  const at = view.bars[i];
  if (!(step && at)) {
    return "";
  }
  const slug = sessionStepSlug(step.name);
  const n = step.actions.length;
  const note =
    (n > 0 ? ` · ${plural(n, "action")}` : "") +
    (step.outputChars === undefined
      ? ""
      : ` · ${fmtChars(step.outputChars)} out`);
  const shotBtn = view.screenshots[slug]
    ? `<button class="shotlink" data-goto-shot="${escapeHtml(slug)}" title="View screenshot" aria-label="View screenshot">${CAMERA_ICON}</button>`
    : "";
  const skim = step.skim ? '<span class="stag">skim</span>' : "";
  const vtime =
    typeof step.videoTime === "number" ? step.videoTime.toFixed(3) : "";
  return `
      <details class="step" id="step-${i}" data-vtime="${vtime}">
        <summary>
          <div class="srow">
            <span class="dot ${step.status}"></span>
            <span class="sname">${escapeHtml(step.name)}</span>${skim}
            ${bar(step.status, at.off, at.w)}
            <span class="smeta">exit ${step.exitCode} · ${fmtMs(step.durationMs)}${note}</span>
            ${shotBtn}
            <span class="chev">${CHEVRON_ICON}</span>
          </div>
        </summary>
        <div class="sbody">${renderStepBody(step)}</div>
      </details>`;
}

// A folded run of rows: its summary stands in for every row inside it.
function renderFold(
  cls: string,
  dot: string,
  label: string,
  meta: string,
  body: string
): string {
  return `
      <details class="fold ${cls}">
        <summary>
          <div class="frow">
            <span class="dot ${dot}"></span>
            <span class="fname">${label}</span>
            <span class="smeta">${meta}</span>
            <span class="chev">${CHEVRON_ICON}</span>
          </div>
        </summary>
        <div class="fbody">${body}</div>
      </details>`;
}

function renderItem(view: StepsView, item: ChapterItem): string {
  const stepsOf = (indices: number[]) =>
    indices.flatMap((i) => view.m.steps[i] ?? []);
  switch (item.kind) {
    case "step":
      return renderStepRow(view, item.index);
    case "attempts": {
      const failed = stepsOf(item.failed);
      const fold = renderFold(
        "retries",
        "fail",
        `${plural(failed.length, "failed attempt")} before this step`,
        fmtMs(wallMs(failed)),
        item.failed.map((i) => renderStepRow(view, i)).join("")
      );
      return `<div class="attempts">${fold}${renderStepRow(view, item.outcome)}</div>`;
    }
    default: {
      const inner = item.items.flatMap(itemSteps);
      return renderFold(
        "skimmed",
        "",
        `${plural(inner.length, "skimmed step")}`,
        fmtMs(wallMs(stepsOf(inner))),
        item.items.map((it) => renderItem(view, it)).join("")
      );
    }
  }
}

function hasRetries(items: ChapterItem[]): boolean {
  return items.some(
    (it) =>
      it.kind === "attempts" || (it.kind === "skim" && hasRetries(it.items))
  );
}

// A chapter is a collapsed header — its caption, how many steps, how long —
// over its rows. It opens on its own only when it holds a failure nothing
// recovered from, since that is what a reviewer came to find.
function renderChapter(view: StepsView, chapter: Chapter): string {
  const steps = chapter.steps.flatMap((i) => view.m.steps[i] ?? []);
  const failed = chapter.items.filter((it) =>
    isUnrecoveredFailure(it, view.m.steps)
  ).length;
  const retried = hasRetries(chapter.items);
  let status = "pass";
  if (failed > 0) {
    status = "fail";
  } else if (retried) {
    status = "retry";
  }
  const first = view.bars[chapter.steps[0] ?? -1];
  const last = view.bars[chapter.steps.at(-1) ?? -1];
  const track =
    first && last
      ? bar(status, first.off, Math.max(last.off + last.w - first.off, 1.5))
      : "";
  const start = steps.find((s) => typeof s.videoTime === "number")?.videoTime;
  const ctime =
    typeof start === "number" ? ` data-ctime="${start.toFixed(3)}"` : "";
  const extras = [
    failed > 0 ? `${failed} failed` : "",
    retried && failed === 0 ? "retried" : "",
  ].filter(Boolean);
  const meta = [plural(steps.length, "step"), fmtMs(wallMs(steps)), ...extras]
    .map(escapeHtml)
    .join(" · ");
  const notes = chapter.notes
    .map((n) => `<div class="cnote">${escapeHtml(n)}</div>`)
    .join("");
  const title = chapter.title ?? "Before the first caption";
  return `
    <details class="chapter"${ctime}${failed > 0 ? " open" : ""}>
      <summary>
        <div class="crow">
          <span class="dot ${status}"></span>
          <span class="ctitle${chapter.title ? "" : " untitled"}">${escapeHtml(title)}</span>
          ${track}
          <span class="smeta">${meta}</span>
          <span class="chev">${CHEVRON_ICON}</span>
        </div>${notes}
      </summary>
      <div class="cbody">${chapter.items.map((it) => renderItem(view, it)).join("")}</div>
    </details>`;
}

// One panel for the whole run. A step that showed a caption opens a chapter
// titled by it, so a long run reads as the handful of things it set out to
// show; retries and skimmed setup fold shut inside their chapter. Every step is
// still an expandable row carrying both the list line and its timeline bar
// (toggled via the List/Timeline switch) and opens to its script, error and
// Playwright actions.
function renderSteps(
  m: SessionManifest,
  screenshots: Record<string, string>,
  captions: CaptionEvent[]
): string {
  const view: StepsView = { bars: stepBars(m), m, screenshots };
  const chapters = buildChapters(m.steps, captions);
  const titled = chapters.some((c) => c.title);
  let body: string;
  if (m.steps.length === 0) {
    body = '<div class="empty">No steps recorded.</div>';
  } else if (titled) {
    body = chapters.map((c) => renderChapter(view, c)).join("");
  } else {
    body = chapters
      .flatMap((c) => c.items)
      .map((it) => renderItem(view, it))
      .join("");
  }
  const chapterToggle = titled
    ? '<button class="vbtn" id="chapters-toggle" type="button">Expand all</button>'
    : "";
  const chapterCount = titled ? ` · ${plural(chapters.length, "chapter")}` : "";
  return `
  <section class="panel is-hidden" id="panel-steps">
    <div class="card">
      <div class="card-h">
        <h2>Steps</h2>
        <div class="viewtoggle" role="group" aria-label="Steps view">
          <button class="vbtn is-active" data-view="list">List</button>
          <button class="vbtn" data-view="timeline">Timeline</button>
        </div>
        ${chapterToggle}
        <button class="vbtn" id="scripts-toggle" type="button">Show scripts</button>
        <span class="count">${m.summary.stepsPassed}/${m.summary.stepsTotal} passed · ${fmtMs(m.durationMs)}${chapterCount}</span>
      </div>
      <div class="steps" id="steps-list">${body}</div>
    </div>
  </section>`;
}

function renderScreenshots(
  m: SessionManifest,
  screenshots: Record<string, string>
): string {
  const items = m.steps
    .map((step, i) => ({
      cap: step.name,
      slug: sessionStepSlug(step.name),
      step: `step-${i}`,
      src: screenshots[sessionStepSlug(step.name)],
    }))
    .filter(
      (it): it is { cap: string; slug: string; step: string; src: string } =>
        Boolean(it.src)
    );
  const first = items[0];
  if (!first) {
    return `
  <section class="panel is-hidden" id="panel-screenshots">
    <div class="card"><div class="empty">No screenshots captured.</div></div>
  </section>`;
  }
  const thumbs = items
    .map(
      (it, i) =>
        `<button class="thumb${i === 0 ? " is-active" : ""}" data-cap="${escapeHtml(it.cap)}" data-slug="${escapeHtml(it.slug)}" data-step="${it.step}"><img alt="${escapeHtml(it.cap)}" src="${escapeHtml(it.src)}"/></button>`
    )
    .join("");
  const nav =
    items.length > 1
      ? `<button class="navbtn prev" id="shot-prev" aria-label="Previous screenshot">${ARROW_LEFT_ICON}</button>
      <button class="navbtn next" id="shot-next" aria-label="Next screenshot">${ARROW_RIGHT_ICON}</button>`
      : "";
  return `
  <section class="panel is-hidden" id="panel-screenshots">
    <figure class="gallery">
      <div class="stage">
        ${nav}
        <img alt="${escapeHtml(first.cap)}" id="shot-main" src="${escapeHtml(first.src)}"/>
      </div>
      <figcaption id="shot-cap">
        <button class="caplink" id="shot-cap-link" data-goto-step="${first.step}" title="Open this step">${escapeHtml(first.cap)}</button>
        <span class="shot-pos" id="shot-pos">1 / ${items.length}</span>
      </figcaption>
      <div class="thumbs">${thumbs}</div>
    </figure>
  </section>`;
}

// The persistent left column: the recording itself, always visible while the
// reviewer works through the tabs on the right. The first video carries
// id="report-video" so the Steps timeline can seek/sync to it.
function renderVideoColumn(m: SessionManifest): string {
  const videos = m.artifacts.videos;
  if (videos.length === 0) {
    return '<div class="empty">No video captured.</div>';
  }
  return videos
    .map((v, i) => {
      const p = escapeHtml(v.path);
      const id = i === 0 ? ' id="report-video"' : "";
      return `<div class="vid"><video${id} controls preload="metadata" src="./${p}"></video><div class="vmeta"><span class="url">${p}</span><span class="sz">${fmtBytes(v.bytes)}</span></div></div>`;
    })
    .join("");
}

function renderConsole(entries: ConsoleEntry[]): string {
  let body: string;
  if (entries.length === 0) {
    body = '<div class="empty">No console output captured.</div>';
  } else {
    const rows = entries
      .map((e) => {
        const isErr = e.kind === "pageerror" || e.type === "error";
        const label = e.kind === "pageerror" ? "pageerror" : (e.type ?? "log");
        const text = e.message ?? e.text ?? "";
        const src = e.url ? `${e.url}${e.line ? `:${e.line}` : ""}` : "";
        return `<tr class="${isErr ? "err" : ""}"><td><span class="chip">${escapeHtml(label)}</span></td><td class="mono">${escapeHtml(text)}</td><td class="src truncate">${escapeHtml(src)}</td></tr>`;
      })
      .join("");
    body = `<table><thead><tr><th style="width:120px">Type</th><th>Message</th><th style="width:220px">Source</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  return `
  <section class="panel is-hidden" id="panel-console">
    <div class="card">
      <div class="card-h"><h2>Console</h2><span class="count">${entries.length} message${entries.length === 1 ? "" : "s"}</span></div>
      ${body}
    </div>
  </section>`;
}

function renderNetwork(har: HarSummary): string {
  // `slowest` is derived from `entries` (a slice of it), so it is empty whenever
  // entries is — the old `entries.length > 0 ? entries : slowest` fallback could
  // never fire. Render the full entry list directly.
  const list = har.entries;
  let body: string;
  if (list.length === 0) {
    body = '<div class="empty">No network activity captured.</div>';
  } else {
    const rows = list
      .map(
        (r) =>
          `<tr class="${r.status === 0 || r.status >= 400 ? "err" : ""}"><td class="num">${r.status || "—"}</td><td><span class="chip">${escapeHtml(r.method)}</span></td><td class="num">${fmtMs(r.durationMs)}</td><td class="url truncate">${escapeHtml(r.url)}</td></tr>`
      )
      .join("");
    body = `<table><thead><tr><th style="width:72px">Status</th><th style="width:96px">Method</th><th style="width:88px">Time</th><th>URL</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  return `
  <section class="panel is-hidden" id="panel-network">
    <div class="card">
      <div class="card-h"><h2>Network</h2><span class="count">${har.total} request${har.total === 1 ? "" : "s"} · ${har.failed} failed</span></div>
      ${body}
    </div>
  </section>`;
}

function renderArtifacts(m: SessionManifest): string {
  const items: string[] = [];
  if (m.artifacts.trace) {
    const p = escapeHtml(m.artifacts.trace.path);
    items.push(
      `<div class="art"><div class="art-row"><span class="k">Trace</span><a class="btn" href="./${p}">${p}</a><span class="sz">${fmtBytes(m.artifacts.trace.bytes)}</span></div><div class="hint">View with <code>npx playwright show-trace ./${p}</code></div></div>`
    );
  }
  if (m.artifacts.har) {
    const p = escapeHtml(m.artifacts.har.path);
    items.push(
      `<div class="art"><div class="art-row"><span class="k">Network HAR</span><a class="btn" href="./${p}">${p}</a><span class="sz">${fmtBytes(m.artifacts.har.bytes)}</span></div></div>`
    );
  }
  if (m.artifacts.console) {
    const p = escapeHtml(m.artifacts.console.path);
    items.push(
      `<div class="art"><div class="art-row"><span class="k">Console log</span><a class="btn" href="./${p}">${p}</a><span class="sz">${fmtBytes(m.artifacts.console.bytes)}</span></div></div>`
    );
  }
  for (const attachment of m.artifacts.attachments ?? []) {
    const p = escapeHtml(attachment.path);
    const label = escapeHtml(path.basename(attachment.path));
    const isHtml = /\.html?$/i.test(attachment.path);
    const target = isHtml ? ` target="_blank" rel="noopener"` : "";
    items.push(
      `<div class="art"><div class="art-row"><span class="k">${label}</span><a class="btn" href="./${p}"${target}>${p}</a><span class="sz">${fmtBytes(attachment.bytes)}</span></div></div>`
    );
  }
  items.push(
    `<div class="art"><div class="art-row"><span class="k">Results index</span><a class="btn" href="./results.json">results.json</a></div><div class="hint">Machine-readable record referencing every artifact — for tooling and viewers.</div></div>`
  );
  return `
  <section class="panel is-hidden" id="panel-artifacts">
    <div class="card">
      <div class="card-h"><h2>Artifacts</h2></div>
      ${items.join("")}
    </div>
  </section>`;
}

// Two-column layout (mirrors the server viewer): a persistent left column with
// the recording, a right column with the tabbed detail. Overrides the centered
// single-column width from STYLE; sticky keeps the video in view while the
// right column scrolls, and the columns stack on narrow screens.
const LAYOUT_STYLE = `
.page{max-width:1280px}
.layout{display:flex;align-items:flex-start;gap:8px}
.leftcol{position:sticky;top:16px;flex:0 0 46%;max-width:680px;padding:20px 8px 20px 24px}
.rightcol{flex:1 1 auto;min-width:0}
.leftcol .vid{margin:0}
.leftcol video{display:block;width:100%;border:1px solid var(--line);border-radius:var(--r-md);background:#000}
.leftcol .vmeta{display:flex;justify-content:space-between;gap:12px;color:var(--faint);font-size:12px;margin-top:8px}
.step.is-playing>summary .srow,.chapter.is-playing>summary .crow,.fold.is-playing>summary .frow{background:rgba(228,242,34,.18)}
.chapter[data-ctime]>summary{cursor:pointer}
.step[data-vtime]>summary{cursor:pointer}
@media(max-width:900px){.layout{flex-direction:column}.leftcol{position:static;flex-basis:auto;max-width:none;width:100%;padding:16px}}
`;

// Sync the Steps timeline to the persistent video: click a step to seek there,
// and highlight the step under the playhead as it plays. Plus a page-wide
// Show/Hide-scripts toggle. Self-contained; appended after the tab script so it
// doesn't entangle with it.
const SYNC_SCRIPT = `(function(){
  var video=document.getElementById('report-video');
  var steps=[].slice.call(document.querySelectorAll('.step[data-vtime]'));
  var marks=steps.map(function(s){return {el:s,t:parseFloat(s.getAttribute('data-vtime'))};})
    .filter(function(m){return !isNaN(m.t);});
  function seek(t){
    if(isNaN(t))return;
    try{video.currentTime=t;}catch(e){}
    if(video.play){var p=video.play();if(p&&p.catch)p.catch(function(){});}
  }
  if(video){
    steps.forEach(function(s){
      var sum=s.querySelector('summary');
      if(!sum)return;
      sum.addEventListener('click',function(){seek(parseFloat(s.getAttribute('data-vtime')));});
    });
    // Opening a chapter plays it from its first step; closing it leaves the video alone.
    [].slice.call(document.querySelectorAll('.chapter[data-ctime]')).forEach(function(c){
      var sum=c.querySelector('summary');
      if(!sum)return;
      sum.addEventListener('click',function(){if(!c.open)seek(parseFloat(c.getAttribute('data-ctime')));});
    });
    // Highlight the playing step, and the chapter and fold around it, since those may be shut.
    var lit=[];
    video.addEventListener('timeupdate',function(){
      var ct=video.currentTime,cur=null;
      for(var i=0;i<marks.length;i++){if(marks[i].t<=ct+0.05)cur=marks[i];else break;}
      for(var j=0;j<lit.length;j++)lit[j].classList.remove('is-playing');
      lit=[];
      for(var d=cur&&cur.el;d;d=d.parentElement){if(d.tagName==='DETAILS'){d.classList.add('is-playing');lit.push(d);}}
    });
  }
  var chapterToggle=document.getElementById('chapters-toggle');
  if(chapterToggle){
    chapterToggle.addEventListener('click',function(){
      var chapters=[].slice.call(document.querySelectorAll('.chapter'));
      var open=chapters.some(function(c){return !c.open;});
      chapters.forEach(function(c){c.open=open;});
      chapterToggle.textContent=open?'Collapse all':'Expand all';
    });
  }
  var toggle=document.getElementById('scripts-toggle');
  if(toggle){
    toggle.addEventListener('click',function(){
      var boxes=[].slice.call(document.querySelectorAll('.scriptbox'));
      var open=boxes.some(function(b){return !b.open;});
      boxes.forEach(function(b){b.open=open;});
      toggle.textContent=open?'Hide scripts':'Show scripts';
    });
  }
})();`;

// Self-contained report. Small data (screenshots base64, console, network
// summary) is inlined; heavy artifacts (trace.zip, *.webm) are linked relatively
// to siblings in the session dir.
export function renderReport(
  manifest: SessionManifest,
  ctx: RenderContext
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Dailies report — ${escapeHtml(manifest.name ?? manifest.id)}</title>
<style>${STYLE}${LAYOUT_STYLE}</style>
</head>
<body>
<div class="page">
${renderHeader(manifest)}
<div class="layout">
<aside class="leftcol">${renderVideoColumn(manifest)}</aside>
<div class="rightcol">
${renderTabs()}
<main>
${renderSummary(manifest)}
${renderSteps(manifest, ctx.screenshots, ctx.captions ?? [])}
${renderScreenshots(manifest, ctx.screenshots)}
${renderConsole(ctx.consoleEntries)}
${renderNetwork(ctx.parsedHar)}
${renderArtifacts(manifest)}
</main>
</div>
</div>
</div>
<script>${TAB_SCRIPT}</script>
<script>${SYNC_SCRIPT}</script>
</body>
</html>
`;
}
