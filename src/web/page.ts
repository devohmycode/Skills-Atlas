/**
 * The web interface: one self-contained page (no external request, so it works offline), served
 * by `server.ts`. Written with String.raw so that the script keeps its backslashes; it must not
 * contain backticks or dollar-brace sequences inside its browser script.
 *
 * Design: an atlas. Themes are regions of a map, each with its own hue (same lightness in OKLCH),
 * shown as a legend on the left and as a margin rule on every skill; everything else stays quiet.
 * DIN (Bahnschrift on Windows, DIN Alternate on macOS), the typeface of maps and road signs,
 * sets titles and figures.
 */
import { groupByRepository } from '../catalog/groups.js';
import { createSearchIndex, sortSkills } from '../catalog/query.js';
import { PALETTE } from '../ui/palette.js';

export const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skills Atlas</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='13' fill='%230E0D0B'/%3E%3Cpath d='M16 6l3 10-3 10-3-10z' fill='%238BD5F5'/%3E%3C/svg%3E">
<script>
  // Theme before the first paint: light, dark, or the system's (no attribute).
  try {
    var saved = localStorage.getItem('atlas-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {}
</script>
<style>
:root {
  --paper: ${PALETTE.foreground}; --sheet: #F7F3EA; --sheet-2: #EEE8DC; --ink: ${PALETTE.background}; --ink-2: #5E584F; --ink-3: #6F675B;
  --rule: #D7CFC0; --rule-2: #B7AC99; --accent: #366586; --accent-ink: #FFFFFF;
  --add: #356541; --remove: #A23D38; --official: #6E4DB0; --gold: #876117;
  --blue: ${PALETTE.accent}; --lavender: ${PALETTE.lavender}; --pink: ${PALETTE.pink};
  --brand-gradient: linear-gradient(120deg, var(--blue), var(--lavender) 52%, var(--pink));
  --region-l: 0.53; --region-c: 0.10;
  --shadow: 0 1px 0 rgba(14,13,11,.04), 0 8px 24px -12px rgba(14,13,11,.18);
  --display: "Bahnschrift", "DIN Alternate", "DIN 2014", "D-DIN", "Barlow", "Roboto Condensed", system-ui, sans-serif;
  --text: system-ui, "Segoe UI Variable Text", "Segoe UI", -apple-system, Roboto, "Helvetica Neue", sans-serif;
  --mono: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: ${PALETTE.background}; --sheet: #171511; --sheet-2: #211E19; --ink: ${PALETTE.foreground}; --ink-2: #B8B0A3; --ink-3: ${PALETTE.muted};
    --rule: #302B24; --rule-2: #5D5549; --accent: ${PALETTE.accent}; --accent-ink: ${PALETTE.background};
    --add: ${PALETTE.success}; --remove: ${PALETTE.danger}; --official: ${PALETTE.lavender}; --gold: ${PALETTE.gold};
    --region-l: 0.76; --region-c: 0.10;
    --shadow: 0 1px 0 rgba(0,0,0,.3), 0 12px 32px -12px rgba(0,0,0,.6);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper: ${PALETTE.background}; --sheet: #171511; --sheet-2: #211E19; --ink: ${PALETTE.foreground}; --ink-2: #B8B0A3; --ink-3: ${PALETTE.muted};
  --rule: #302B24; --rule-2: #5D5549; --accent: ${PALETTE.accent}; --accent-ink: ${PALETTE.background};
  --add: ${PALETTE.success}; --remove: ${PALETTE.danger}; --official: ${PALETTE.lavender}; --gold: ${PALETTE.gold};
  --region-l: 0.76; --region-c: 0.10;
  --shadow: 0 1px 0 rgba(0,0,0,.3), 0 12px 32px -12px rgba(0,0,0,.6);
  color-scheme: dark;
}

* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--paper); color: var(--ink);
  font: 14px/1.5 var(--text); -webkit-font-smoothing: antialiased;
  display: flex; flex-direction: column;
}
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
[hidden] { display: none !important; }
.figure { font-family: var(--display); font-variant-numeric: tabular-nums; }

/* ---- header ------------------------------------------------------------------------------ */
header {
  display: grid; grid-template-columns: 250px minmax(0, 1fr) auto; align-items: center; gap: 20px;
  padding: 14px 24px; border-bottom: 1px solid var(--rule); background: var(--paper);
}
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand svg { flex: none; color: var(--accent); }
.brand-mark { display: grid; place-content: center; width: 42px; height: 42px; border-radius: 12px; background: ${PALETTE.background}; }
.brand-mark svg { color: var(--blue); }
.brand-mark circle, .brand-mark path { stroke: url(#brand-gradient); }
.brand-mark path:first-of-type { fill: url(#brand-gradient); }
.brand h1 { margin: 0; font: 600 21px/1 var(--display); letter-spacing: .01em; }
.search { position: relative; }
.search input {
  width: 100%; height: 42px; padding: 0 14px 0 42px; border: 1px solid var(--rule-2); border-radius: 21px;
  background: var(--sheet); outline: none; font-size: 15px; transition: border-color .15s, box-shadow .15s;
}
.search input::placeholder { color: var(--ink-3); }
.search input:focus { border-color: var(--accent); box-shadow: 0 0 0 4px color-mix(in oklab, var(--accent) 18%, transparent); }
.search svg { position: absolute; left: 15px; top: 50%; transform: translateY(-50%); color: var(--ink-3); pointer-events: none; }
.tools { display: flex; align-items: center; gap: 10px; }
.segmented { display: inline-flex; padding: 3px; gap: 2px; border: 1px solid var(--rule-2); border-radius: 10px; background: var(--sheet); }
.segmented button {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px;
  border: 0; border-radius: 7px; background: none; color: var(--ink-2); font-size: 13px;
}
.segmented button:hover { color: var(--ink); background: var(--sheet-2); }
.segmented button[aria-pressed="true"] { background: var(--ink); color: var(--paper); }
.segmented.icons button { width: 32px; padding: 0; justify-content: center; }
.toggle {
  display: inline-flex; align-items: center; gap: 7px; height: 38px; padding: 0 12px;
  border: 1px solid var(--rule-2); border-radius: 10px; background: var(--sheet); color: var(--ink-2); font-size: 13px;
}
.toggle:hover { color: var(--ink); }
.toggle[aria-pressed="true"] { color: var(--official); border-color: color-mix(in oklab, var(--official) 55%, transparent); background: color-mix(in oklab, var(--official) 9%, var(--sheet)); }

/* ---- layout ------------------------------------------------------------------------------ */
main { flex: 1; display: grid; grid-template-columns: 250px minmax(0, 1fr) 360px; min-height: 0; }
nav, .list, aside { overflow: auto; min-height: 0; }

/* ---- legend (themes) --------------------------------------------------------------------- */
nav { padding: 18px 12px 24px 16px; }
nav h2, aside h2 { margin: 0 0 10px 10px; font: 600 13px/1.2 var(--display); color: var(--ink-2); letter-spacing: .02em; }
nav button {
  --swatch: oklch(var(--region-l) var(--region-c) var(--hue, 200));
  display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; align-items: center; gap: 10px; width: 100%;
  border: 0; background: none; padding: 6px 10px; border-radius: 8px; text-align: left; color: var(--ink-2);
}
nav button::before { content: ""; width: 12px; height: 12px; border-radius: 3px; background: var(--swatch); transition: transform .15s; }
nav button:hover { background: var(--sheet); color: var(--ink); }
nav button[aria-current="true"] { background: color-mix(in oklab, var(--swatch) 16%, var(--sheet)); color: var(--ink); font-weight: 600; }
nav button[aria-current="true"]::before { transform: scale(1.25); }
nav button .n { font-family: var(--display); font-size: 12.5px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
nav button.all::before { background: conic-gradient(from 0deg, oklch(var(--region-l) var(--region-c) 30), oklch(var(--region-l) var(--region-c) 150), oklch(var(--region-l) var(--region-c) 270), oklch(var(--region-l) var(--region-c) 30)); border-radius: 50%; }
nav button.mine::before { background: var(--accent); border-radius: 50%; }
nav button.recommended::before { content: '★'; background: none; color: var(--gold); line-height: 12px; font-size: 17px; }
nav button[data-theme="trending"]::before { content: '🔥'; background: none; line-height: 12px; font-size: 13px; }
nav .sep { height: 1px; background: var(--rule); margin: 8px 10px; }

/* ---- skill list -------------------------------------------------------------------------- */
.list { padding: 18px 24px 48px; }
.list-head { display: flex; align-items: baseline; gap: 12px; margin: 0 2px 12px; }
.list-head strong { font: 600 26px/1 var(--display); }
.list-head span { color: var(--ink-2); }
.rows { background: var(--sheet); border: 1px solid var(--rule); border-radius: 14px; overflow: hidden; }
.row {
  --region: oklch(var(--region-l) var(--region-c) var(--hue, 200));
  position: relative; display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 2px 14px;
  padding: 13px 18px 13px 22px; border-top: 1px solid var(--rule); cursor: pointer; outline: none;
  content-visibility: auto; contain-intrinsic-size: auto 94px;
}
.row:first-child { border-top: 0; }
.row::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--region); opacity: .85; }
.row:hover { background: var(--sheet-2); }
.row:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.row.add { background: color-mix(in oklab, var(--add) 8%, var(--sheet)); }
.row.drop { background: color-mix(in oklab, var(--remove) 8%, var(--sheet)); }
.pin {
  appearance: none; margin: 2px 0 0; width: 18px; height: 18px; border-radius: 50%;
  border: 1.5px solid var(--rule-2); background: var(--sheet); display: grid; place-content: center; cursor: pointer;
}
.pin::after { content: ""; width: 8px; height: 8px; border-radius: 50%; transform: scale(0); transition: transform .12s; background: var(--accent); }
.pin:checked { border-color: var(--accent); }
.pin:checked::after { transform: scale(1); }
.pin:indeterminate { border-color: var(--accent); }
.pin:indeterminate::after { transform: scale(1); height: 2px; border-radius: 1px; }
.row.add .pin { border-color: var(--add); }
.row.add .pin::after { background: var(--add); }
.row.drop .pin { border-color: var(--remove); border-style: dashed; }
.title { display: flex; align-items: baseline; gap: 4px 10px; flex-wrap: wrap; min-width: 0; }
.name { font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
.source { color: var(--ink-3); font-size: 12.5px; text-decoration: none; overflow-wrap: anywhere; }
a.source:hover { color: var(--accent); text-decoration: underline; }
.tag { font-size: 12px; white-space: nowrap; }
.tag.official { color: var(--official); }
.tag.recommended { color: var(--gold); }
.tag.installed { color: var(--accent); }
.tag.drop { color: var(--remove); font-weight: 600; }
.desc {
  grid-column: 2 / 3; margin: 3px 0 0; color: var(--ink-2); font-size: 13px; max-width: 78ch;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.reason { grid-column: 2 / 3; margin: 5px 0 0; color: var(--ink-2); font-size: 12px; max-width: 78ch; }
.reason::before { content: '★ '; color: var(--gold); }
.pop { grid-row: 1 / 3; grid-column: 3; text-align: right; line-height: 1.15; padding-top: 1px; }
.pop b { display: block; font: 600 17px/1.1 var(--display); font-variant-numeric: tabular-nums; }
.pop span { font-size: 11.5px; color: var(--ink-3); }
.pop .growth { display: block; color: var(--add); font-weight: 600; }
.more {
  display: block; margin: 18px auto 0; height: 38px; padding: 0 18px; border-radius: 19px;
  border: 1px solid var(--rule-2); background: var(--sheet); color: var(--ink);
}
.more:hover { border-color: var(--accent); color: var(--accent); }
.empty { padding: 56px 24px; text-align: center; color: var(--ink-2); }
.repo { border-top: 1px solid var(--rule); }
.repo:first-child { border-top: 0; }
.repo-head {
  display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 2px 14px; align-items: baseline;
  padding: 14px 18px 14px 22px; cursor: pointer; list-style: none; outline: none; background: var(--sheet-2);
}
.repo-head::-webkit-details-marker { display: none; }
.repo-head:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.repo-head .name::before { content: '★ '; color: var(--gold); }
.repo-head .reason::before { content: none; }
.repo-head .fold { grid-column: 3; color: var(--ink-3); font-size: 12.5px; white-space: nowrap; }
.repo-head .fold::after { content: ' ▸'; }
.repo[open] .repo-head .fold::after { content: ' ▾'; }
.repo .row { padding-left: 40px; }

/* ---- changes panel ----------------------------------------------------------------------- */
aside { background: var(--sheet); border-left: 1px solid var(--rule); display: flex; flex-direction: column; overflow: hidden; }
.panel-body { flex: 1; overflow: auto; padding: 20px 20px 8px; }
.panel-foot { padding: 14px 20px 18px; border-top: 1px solid var(--rule); background: var(--sheet); }
aside h2 { margin: 22px 0 10px; }
aside h2:first-child { margin-top: 0; }
.lede { margin: 0 0 12px; font: 500 17px/1.35 var(--display); max-width: 26ch; }
.intro { margin: 0; color: var(--ink-2); max-width: 36ch; }
.intro-art { display: block; margin: 14px 0 0; color: var(--rule-2); }
.tally { display: flex; gap: 18px; margin-bottom: 12px; }
.tally div { display: flex; flex-direction: column; }
.tally b { font: 600 30px/1 var(--display); font-variant-numeric: tabular-nums; }
.tally span { font-size: 12px; color: var(--ink-2); }
.tally .plus b { color: var(--add); }
.tally .minus b { color: var(--remove); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chips button {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 28px; padding: 0 6px 0 11px;
  border: 1px solid var(--rule-2); border-radius: 14px; background: var(--sheet); font-size: 12.5px;
}
.chips button span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chips button.plus { border-color: color-mix(in oklab, var(--add) 45%, transparent); }
.chips button.minus { border-color: color-mix(in oklab, var(--remove) 45%, transparent); color: var(--remove); }
.chips button:hover { background: var(--sheet-2); }
.chips .x { display: grid; place-content: center; width: 18px; height: 18px; border-radius: 50%; color: var(--ink-3); }
.chips button:hover .x { background: var(--rule); color: var(--ink); }
.link { border: 0; background: none; color: var(--accent); padding: 0; font-size: 12.5px; }
.link:hover { text-decoration: underline; }
.details-text { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 45vh; overflow: auto; }
.head-row { display: flex; justify-content: space-between; align-items: baseline; }
.head-row h2 { margin-bottom: 10px; }
.choice {
  display: grid; grid-template-columns: 18px 1fr; gap: 10px; padding: 10px 12px; margin-bottom: 6px;
  border: 1px solid var(--rule); border-radius: 10px; cursor: pointer;
}
.choice:hover { border-color: var(--rule-2); background: var(--sheet-2); }
.choice:has(input:checked) { border-color: var(--accent); background: color-mix(in oklab, var(--accent) 7%, var(--sheet)); }
.choice input { margin: 3px 0 0; accent-color: var(--accent); }
.choice b { font-weight: 600; }
.choice small { display: block; color: var(--ink-2); font-size: 12px; overflow-wrap: anywhere; }
.agents-search { width: 100%; height: 34px; padding: 0 12px; margin-bottom: 8px; border: 1px solid var(--rule-2); border-radius: 8px; background: var(--paper); outline: none; }
.agents-search:focus { border-color: var(--accent); }
.agents { max-height: 232px; overflow: auto; border: 1px solid var(--rule); border-radius: 10px; }
.agents label { display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-top: 1px solid var(--rule); cursor: pointer; }
.agents label:first-child { border-top: 0; }
.agents label:hover { background: var(--sheet-2); }
.agents input { accent-color: var(--accent); margin: 0; }
.agents .id { color: var(--ink-3); font-size: 12px; }
.agents .found { margin-left: auto; font-size: 11.5px; color: var(--add); }
.agents p { margin: 10px 12px; color: var(--ink-2); }
pre {
  margin: 0; padding: 10px 12px; background: var(--paper); border: 1px solid var(--rule); border-radius: 10px;
  font: 11.5px/1.55 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 150px; overflow: auto; color: var(--ink-2);
}
.warn { margin: 0 0 10px; color: var(--remove); font-size: 13px; }
#catalog-health { margin: 0; padding: 10px 24px; border-bottom: 1px solid var(--rule); color: var(--gold); }
#pack-health { color: var(--ink-2); }
.primary {
  width: 100%; height: 46px; border: 0; border-radius: 12px; background: var(--brand-gradient); color: ${PALETTE.background};
  font: 600 16px/1 var(--display); letter-spacing: .02em; transition: filter .15s, transform .1s;
}
.primary:hover:not(:disabled) { filter: brightness(1.08); }
.primary:active:not(:disabled) { transform: translateY(1px); }
.primary:disabled { opacity: .4; cursor: not-allowed; }

/* ---- progress dialog --------------------------------------------------------------------- */
dialog {
  border: 1px solid var(--rule); border-radius: 18px; padding: 0; width: min(620px, calc(100vw - 32px));
  background: var(--sheet); color: var(--ink); box-shadow: var(--shadow);
}
dialog[open] { animation: rise .22s ease-out; }
@keyframes rise { from { opacity: 0; transform: translateY(8px) scale(.99); } }
dialog::backdrop { background: color-mix(in oklab, var(--paper) 40%, rgba(5,12,20,.55)); backdrop-filter: blur(2px); }
.dlg { padding: 22px 24px 20px; }
.dlg h3 { margin: 0 0 6px; font: 600 22px/1.2 var(--display); }
.dlg .sub { margin: 0 0 14px; color: var(--ink-2); }
.task { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 2px 12px; padding: 12px 0; border-top: 1px solid var(--rule); }
.task .skills { grid-column: 2 / 4; color: var(--ink-2); font-size: 12.5px; overflow-wrap: anywhere; }
.task .err { grid-column: 2 / 4; margin-top: 6px; color: var(--remove); }
.task .phase { font-size: 12.5px; color: var(--ink-2); }
.task .phase.ok { color: var(--add); } .task .phase.ko { color: var(--remove); }
.dot { width: 16px; height: 16px; margin-top: 2px; border-radius: 50%; display: grid; place-content: center; font-size: 11px; font-weight: 700; }
.dot.wait { border: 1.5px dashed var(--rule-2); }
.dot.spin { border: 2px solid var(--rule); border-top-color: var(--accent); animation: spin .8s linear infinite; }
.dot.ok { background: var(--add); color: var(--sheet); }
.dot.ko { background: var(--remove); color: var(--sheet); }
@keyframes spin { to { transform: rotate(360deg); } }
.dlg footer { display: flex; justify-content: flex-end; margin-top: 14px; }
.dlg footer .primary { width: auto; height: 40px; padding: 0 22px; font-size: 15px; }
#pack-form label { display: block; margin: 0 0 4px; color: var(--ink-2); font-size: 13px; }
#pack-form footer { gap: 10px; align-items: center; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation-duration: 1ms !important; animation-iteration-count: 1 !important; }
}
@media (max-width: 1180px) {
  header { grid-template-columns: auto minmax(0, 1fr) auto; }
  main { grid-template-columns: 210px minmax(0, 1fr) 320px; }
}
@media (max-width: 880px) {
  header { grid-template-columns: 1fr auto; padding: 12px 16px; gap: 12px; }
  .search { grid-column: 1 / -1; grid-row: 2; }
  .toggle .label { display: none; }
  main { grid-template-columns: minmax(0, 1fr); align-content: start; overflow: auto; }
  nav { display: flex; gap: 4px; overflow-x: auto; padding: 10px 16px; border-bottom: 1px solid var(--rule); }
  nav h2, nav .sep { display: none; }
  nav button { flex: none; width: max-content; grid-template-columns: 12px max-content max-content; white-space: nowrap; }
  .list { overflow: visible; padding: 14px 16px 24px; }
  .row { grid-template-columns: 22px minmax(0, 1fr); }
  .pop { grid-row: auto; grid-column: 2; text-align: left; }
  .pop b { display: inline; font-size: 13px; }
  aside { border-left: 0; border-top: 1px solid var(--rule); overflow: visible; }
  .panel-body { overflow: visible; }
  .panel-foot { position: sticky; bottom: 0; }
}
</style>
</head>
<body>
<header>
  <div class="brand">
    <span class="brand-mark"><svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
      <defs><linearGradient id="brand-gradient" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${PALETTE.accent}"/><stop offset=".52" stop-color="${PALETTE.lavender}"/><stop offset="1" stop-color="${PALETTE.pink}"/></linearGradient></defs>
      <circle cx="17" cy="17" r="15" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <circle cx="17" cy="17" r="10" fill="none" stroke="currentColor" stroke-width="1" opacity=".45"/>
      <path d="M17 4.5l3.2 12.5L17 29.5l-3.2-12.5z" fill="currentColor"/>
      <path d="M4.5 17h4M25.5 17h4" stroke="currentColor" stroke-width="1.5"/>
    </svg></span>
    <h1>Skills Atlas</h1>
  </div>
  <label class="search">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <input id="q" type="search" autocomplete="off" spellcheck="false">
  </label>
  <div class="tools">
    <div class="segmented" id="sort" role="group"></div>
    <button id="official" class="toggle" aria-pressed="false"><span aria-hidden="true">◆</span><span class="label"></span></button>
    <div class="segmented icons" id="theme" role="group">
      <button data-theme="light" aria-pressed="false"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>
      <button data-theme="dark" aria-pressed="false"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg></button>
      <button data-theme="system" aria-pressed="false"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg></button>
    </div>
  </div>
</header>
<p id="catalog-health" class="warn" role="status" hidden></p>
<main>
  <nav id="themes" aria-label="Themes"></nav>
  <section class="list">
    <div class="list-head"><strong id="count" class="figure"></strong><span id="where"></span></div>
    <p id="pack-health" class="warn" role="status" hidden></p>
    <div class="rows" id="rows" role="list"></div>
    <button class="more" id="more" hidden></button>
  </section>
  <aside id="panel"><div class="panel-body" id="panel-body"></div><div class="panel-foot" id="panel-foot" hidden></div></aside>
</main>
<dialog id="pack-dialog" aria-labelledby="pack-title"><form class="dlg" id="pack-form"></form></dialog>
<dialog id="progress" aria-live="polite"><div class="dlg" id="progress-body"></div></dialog>
<dialog id="details" aria-labelledby="details-title"><div class="dlg"><h3 id="details-title"></h3><div id="details-body" aria-live="polite"></div><footer><button class="primary" id="details-close"></button></footer></div></dialog>
<script>
(function () {
  'use strict';
  ${sortSkills}
  ${createSearchIndex}
  var token = location.hash.slice(1);
  var M = {};
  var S = null;               // server state: themes, agents, installed, defaults…
  var installedById = new Map();
  var searchInstalled = createSearchIndex([]);
  var hues = {};              // theme id -> hue on the map
  var adds = new Map();       // id -> skill, to install
  var retryRemaining = false;
  var removes = new Set();    // installed ids to uninstall
  var auditOverrides = new Set(), previewSeq = 0;
  var opts = { scope: 'project', method: 'symlink', agents: new Set() };
  var view = { q: '', sort: '', official: false, theme: '', items: [], total: 0, counts: {}, all: 0 };
  var showAllAgents = false, agentFilter = '', planTimer = 0, planSeq = 0, queryTimer = 0, querySeq = 0;
  var fmt = new Intl.NumberFormat(), compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  var PAGE = 100;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /** Message with {placeholders} filled in. */
  function tr(key, vars) {
    var s = M[key] || key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split('{' + k + '}').join(vars[k]); });
    return s;
  }
  function api(path, body) {
    var init = { headers: { 'x-atlas-token': token } };
    if (body) { init.method = 'POST'; init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function (res) {
      if (res.ok) return res;
      return res.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || res.statusText); });
    });
  }
  function apiJson(path, body) { return api(path, body).then(function (r) { return r.json(); }); }

  // ---- theme switch: light, dark or the system's, remembered in this browser ----------------
  function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'system'; }
  function setTheme(name) {
    if (name === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', name);
    try { localStorage.setItem('atlas-theme', name); } catch (e) {}
    renderThemeSwitch();
  }
  function renderThemeSwitch() {
    var cur = currentTheme();
    Array.prototype.forEach.call($('theme').querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.theme === cur));
      var label = M['theme_' + b.dataset.theme] || b.dataset.theme;
      b.title = label; b.setAttribute('aria-label', label);
    });
  }
  $('theme').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b) setTheme(b.dataset.theme);
  });

  // ---- selection -------------------------------------------------------------------------
  function isChecked(id) { return installedById.has(id) ? !removes.has(id) : adds.has(id); }
  function toggle(skill) {
    if (!skill) return;
    auditOverrides.delete(skill.id);
    // A retained partial install is already listed as installed: unticking drops the retry.
    if (adds.has(skill.id)) adds.delete(skill.id);
    else if (installedById.has(skill.id)) { if (removes.has(skill.id)) removes.delete(skill.id); else removes.add(skill.id); }
    else adds.set(skill.id, skill);
    updateRow(skill.id); renderPanel();
    if (grouped()) updateRepoPin(repoKey(skill));
  }
  function grouped() { return view.theme === 'recommended'; }

  // ---- list ------------------------------------------------------------------------------
  function hueStyle(themeId) {
    if (themeId === 'other' || !(themeId in hues)) return '--hue:220;--region-c:0.015';
    return '--hue:' + hues[themeId];
  }
  function popularity(s) {
    // In Trending, what made it trend: the installs gained since the previous snapshot.
    var rise = view.theme === 'trending' && s.growth ? '<span class="growth">↑ +' + esc(compact.format(s.growth)) + '</span>' : '';
    if (s.installs) return '<b>' + esc(compact.format(s.installs)) + '</b><span>' + esc(M.installs) + '</span>' + rise;
    if (s.stars) return '<b>' + esc(compact.format(s.stars)) + '</b><span>' + esc(M.stars) + '</span>';
    return s.rank != null ? '<b>#' + esc(fmt.format(s.rank)) + '</b><span>skills.sh</span>' : '';
  }
  function githubUrl(s) {
    return /^[\w.-]+\/[\w.-]+$/.test(s.source) && !s.source.split('/').some(function (part) { return part === '.' || part === '..'; })
      ? 'https://github.com/' + s.source : '';
  }

  function rowHtml(s) {
    var inst = installedById.get(s.id);
    var on = isChecked(s.id);
    var cls = inst ? (on ? '' : ' drop') : (on ? ' add' : '');
    var tags = '';
    if (s.official) tags += '<span class="tag official">◆ ' + esc(M.official) + '</span>';
    if (s.recommendation) tags += '<span class="tag recommended" title="' + esc(themeName('recommended')) + '">★</span>';
    if (inst) tags += on
      ? '<span class="tag installed">● ' + esc(tr('installedIn', { where: inst.scopes.map(function (x) { return M[x]; }).join(' + ') })) + '</span>'
      : '<span class="tag drop">' + esc(M.willRemove) + '</span>';
    var url = githubUrl(s);
    var source = url ? '<a class="source" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" title="g · ' + esc(M.github) + '">' + esc(s.source) + '</a>'
                     : '<span class="source">' + esc(s.source) + '</span>';
    return '<div class="row' + cls + '" role="listitem" tabindex="0"' + (url ? ' aria-keyshortcuts="g"' : '') + ' data-id="' + esc(s.id) + '" style="' + hueStyle(s.themes && s.themes[0]) + '">' +
      '<input class="pin" type="checkbox" tabindex="-1"' + (on ? ' checked' : '') + ' aria-label="' + esc(s.name) + '">' +
      '<div class="title"><span class="name">' + esc(s.name) + '</span>' + source + tags +
      '<button class="link" data-preview="' + esc(s.id) + '" aria-haspopup="dialog">' + esc(M.details) + '</button></div>' +
      '<div class="pop">' + popularity(s) + '</div>' +
      '<p class="desc">' + esc(s.description || M.noDescription) + '</p></div>';
  }

  // ---- recommended repositories ------------------------------------------------------------
  /** Opened repository groups, kept across reloads of the list. */
  var openRepos = new Set();
  function repoKey(s) { return s.source.toLowerCase(); }
  /** Recommended skills by repository, in the curated order; each keeps the list's order. */
  // The terminal's own grouping, embedded: both interfaces group the same way.
  ${groupByRepository}
  function repoChecked(list) { return list.every(function (s) { return isChecked(s.id); }); }
  function groupsHtml(items) {
    return groupByRepository(items).map(function (g) {
      var key = g.source, list = g.skills, first = list[0];
      return '<details class="repo" data-repo="' + esc(key) + '"' + (openRepos.has(key) ? ' open' : '') + '>' +
        '<summary class="repo-head" role="listitem"><input class="pin" type="checkbox" tabindex="-1" data-repo-pin' +
        (repoChecked(list) ? ' checked' : '') + ' aria-label="' + esc(first.source) + '">' +
        '<div class="title"><span class="name">' + esc(first.source) + '</span></div>' +
        '<span class="fold">' + esc(tr('repoSkills', { n: fmt.format(list.length) })) + '</span>' +
        (first.recommendation ? '<p class="reason">' + esc(first.recommendation.reason) + '</p>' : '') +
        '</summary>' + list.map(rowHtml).join('') + '</details>';
    }).join('');
  }
  function repoSkills(key) {
    return Array.from(shown.values()).filter(function (s) { return repoKey(s) === key; });
  }
  function updateRepoPin(key) {
    var pin = $('rows').querySelector('[data-repo="' + CSS.escape(key) + '"] [data-repo-pin]');
    if (!pin) return;
    var list = repoSkills(key), on = list.filter(function (s) { return isChecked(s.id); }).length;
    pin.checked = on === list.length;
    // Some of its skills only: neither ticked nor empty, like ◐ in the terminal.
    pin.indeterminate = on > 0 && on < list.length;
  }
  /** Ticks every skill of the repository, or unticks them all when they all are. */
  function toggleRepo(key) {
    var list = repoSkills(key), on = repoChecked(list);
    list.forEach(function (s) { if (isChecked(s.id) === on) toggle(s); });
    updateRepoPin(key);
  }

  var shown = new Map();
  function updateRow(id) {
    var s = shown.get(id), row = $('rows').querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (!s || !row) return;
    var inst = installedById.get(id), on = isChecked(id);
    row.classList.toggle('add', !inst && on);
    row.classList.toggle('drop', !!inst && !on);
    row.querySelector('.pin').checked = on;
    if (inst) {
      var tag = row.querySelector('.tag.installed, .tag.drop');
      tag.className = 'tag ' + (on ? 'installed' : 'drop');
      tag.textContent = on ? '● ' + tr('installedIn', { where: inst.scopes.map(function (x) { return M[x]; }).join(' + ') }) : M.willRemove;
    }
  }
  function renderRows(append, newItems) {
    var focused = document.activeElement && document.activeElement.classList.contains('row') ? document.activeElement.dataset.id : null;
    if (append) {
      newItems.forEach(function (s) { shown.set(s.id, s); });
      $('rows').insertAdjacentHTML('beforeend', newItems.map(rowHtml).join(''));
    } else {
      shown = new Map(view.items.map(function (s) { return [s.id, s]; }));
      $('rows').innerHTML = !view.items.length ? '<div class="empty">' + esc(M.noMatch) + '</div>'
        : grouped() ? groupsHtml(view.items) : view.items.map(rowHtml).join('');
      // Markup cannot set the partial state: it is a property.
      if (grouped()) groupByRepository(view.items).forEach(function (g) { updateRepoPin(g.source); });
    }
    $('rows').hidden = false;
    $('count').textContent = fmt.format(view.total);
    $('where').textContent = view.theme ? tr('resultsIn', { theme: themeName(view.theme) }) : M.resultsAll;
    var theme = S.themes.find(function (th) { return th.id === view.theme; });
    var pack = theme && theme.pack;
    $('pack-health').hidden = !pack;
    $('pack-health').textContent = pack ? tr('packAvailability', { available: pack.available, total: pack.total }) +
      (pack.missing.length ? ' ' + tr('packMissing', { ids: pack.missing.join(', ') }) : '') : '';
    var more = $('more');
    more.disabled = false;
    more.hidden = view.items.length >= view.total;
    more.textContent = tr('loadMore', { n: fmt.format(Math.min(PAGE, view.total - view.items.length)) });
    if (focused) { var el = $('rows').querySelector('[data-id="' + CSS.escape(focused) + '"]'); if (el) el.focus(); }
  }
  $('rows').addEventListener('click', function (e) {
    if (e.target.closest('a')) return;
    var preview = e.target.closest('[data-preview]');
    if (preview) { previewSkill(shown.get(preview.dataset.preview), preview); return; }
    var pin = e.target.closest('[data-repo-pin]');
    // The checkbox of a repository ticks its skills instead of opening the group.
    if (pin) {
      e.preventDefault();
      var key = pin.closest('.repo').dataset.repo;
      toggleRepo(key);
      // The browser restores a checkbox whose click was cancelled, after this handler.
      setTimeout(function () { updateRepoPin(key); });
      return;
    }
    var row = e.target.closest('.row');
    if (row) toggle(shown.get(row.dataset.id));
  });
  $('rows').addEventListener('toggle', function (e) {
    var key = e.target.dataset && e.target.dataset.repo;
    if (!key) return;
    if (e.target.open) openRepos.add(key); else openRepos.delete(key);
  }, true);
  $('rows').addEventListener('keydown', function (e) {
    var head = e.target.closest('.repo-head');
    if (head && e.key === ' ') { e.preventDefault(); toggleRepo(head.parentElement.dataset.repo); return; }
    var row = e.target.closest('.row');
    if (!row) return;
    if ((e.target.closest('a') || e.target.closest('button')) && (e.key === 'Enter' || e.key === ' ')) return;
    if ((e.target.tagName === 'INPUT' || e.target.isContentEditable) && e.key !== ' ' && e.key !== 'Enter') return;
    if (e.key === 'p' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); previewSkill(shown.get(row.dataset.id), row); }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(shown.get(row.dataset.id)); }
    else if (e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var url = githubUrl(shown.get(row.dataset.id));
      if (url) { e.preventDefault(); window.open(url, '_blank', 'noopener,noreferrer'); }
    }
    else if (e.key === 'ArrowDown' && row.nextElementSibling) { e.preventDefault(); row.nextElementSibling.focus(); }
    else if (e.key === 'ArrowUp' && row.previousElementSibling) { e.preventDefault(); row.previousElementSibling.focus(); }
  });

  function installedMatches() {
    return searchInstalled(view.q, view.sort || (view.q.trim() ? undefined : 'installs')).filter(function (s) { return !view.official || s.official; });
  }

  function riskHtml(result) {
    if (result.error) return '<p class="warn">' + esc(M.auditUnread) + ': ' + esc(result.error) + '</p>';
    if (!result.risks.length) return '<p>' + esc(M.noRisk) + '</p>';
    return '<ul>' + result.risks.map(function (r) {
      return '<li>' + esc((M.riskLevels || {})[r.level] || r.level) + ': ' + esc((M.risks || {})[r.rule] || r.label) +
        ' (' + esc((r.file || 'SKILL.md') + (r.line ? ':' + r.line : '')) + ')<pre class="details-text">' + esc(r.excerpt) + '</pre></li>';
    }).join('') + '</ul>';
  }
  function previewSkill(skill, trigger) {
    if (!skill) return;
    var dlg = $('details'), seq = ++previewSeq;
    $('details-title').textContent = skill.id;
    $('details-body').textContent = M.previewLoading;
    $('details-close').textContent = M.close;
    dlg.onclose = function () { ++previewSeq; if (trigger) trigger.focus(); };
    $('details-close').onclick = function () { dlg.close(); };
    dlg.showModal();
    return apiJson('/api/preview?id=' + encodeURIComponent(skill.id) + '&scope=' + opts.scope).then(function (r) {
      if (seq !== previewSeq) return;
      $('details-body').innerHTML = (r.collisions || []).map(function (c) { return '<p class="warn">' + esc(c.message) + '</p>'; }).join('') +
        riskHtml(r) + (r.markdown == null ? '' : '<pre class="details-text">' + esc(r.markdown) + '</pre>');
    }).catch(function (err) {
      if (seq === previewSeq) $('details-body').textContent = M.previewUnavailable + ': ' + err.message;
    });
  }

  /** Installed skills are few and known here; the catalog is searched by the server, a page at a time. */
  function load(append) {
    var seq = ++querySeq;
    var local = view.theme === 'installed';
    $('more').disabled = true;
    // For installed skills the server only gives the theme counts of the search.
    var p = new URLSearchParams({ q: view.q, sort: view.sort, official: view.official ? '1' : '0', theme: local ? '' : view.theme,
      offset: String(append ? view.items.length : 0), limit: String(local ? 1 : grouped() ? 500 : PAGE) });
    return apiJson('/api/skills?' + p).then(function (r) {
      if (seq !== querySeq) return;
      view.counts = r.counts; view.all = r.all;
      if (local) {
        var list = installedMatches();
        view.items = list; view.total = list.length;
      } else {
        view.items = append ? view.items.concat(r.items) : r.items;
        view.total = r.total;
      }
      renderRows(append && !local, r.items); renderThemes();
      if (!append) document.querySelector('.list').scrollTop = 0;
    }).catch(function (err) { if (seq === querySeq) { $('more').disabled = false; fail(err); } });
  }
  $('more').addEventListener('click', function () { load(true); });

  // ---- legend ----------------------------------------------------------------------------
  function themeName(id) {
    if (!id) return M.allThemes;
    var th = S.themes.filter(function (x) { return x.id === id; })[0];
    return th ? th.label : id;
  }
  function renderThemes() {
    var installedCount = installedMatches().length;
    var cur = function (id) { return view.theme === id ? ' aria-current="true"' : ''; };
    var html = '<h2>' + esc(M.legend) + '</h2>' +
      '<button class="all" data-theme=""' + cur('') + '><span>' + esc(M.allThemes) + '</span><span class="n">' + fmt.format(view.all) + '</span></button>';
    if (S.installed.length) {
      html += '<button class="mine" data-theme="installed"' + cur('installed') + '><span>' + esc(themeName('installed')) +
        '</span><span class="n">' + fmt.format(installedCount) + '</span></button>';
    }
    var recommended = S.themes.some(function (th) { return th.id === 'recommended'; });
    if (recommended) html += '<button class="recommended" data-theme="recommended"' + cur('recommended') + ' title="' + esc(M.recommendedHint) + '"><span>' +
      esc(themeName('recommended')) + '</span><span class="n">' + fmt.format(view.counts.recommended || 0) + '</span></button>';
    html += '<div class="sep"></div>';
    S.themes.forEach(function (th) {
      if (th.id === 'installed' || th.id === 'recommended') return;
      html += '<button data-theme="' + esc(th.id) + '"' + cur(th.id) + (th.description ? ' title="' + esc(th.description) + '"' : '') + ' style="' + hueStyle(th.id) + '"><span>' +
        esc(th.label) + '</span><span class="n">' + fmt.format(view.counts[th.id] || 0) + '</span></button>';
    });
    $('themes').innerHTML = html;
  }
  $('themes').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    view.theme = b.dataset.theme;
    load(false);
  });

  // ---- personal packs --------------------------------------------------------------------
  function packSelection() {
    return S.installed.filter(function (s) { return s.catalog && !removes.has(s.id); }).map(function (s) { return s.id; }).concat(Array.from(adds.keys()));
  }
  function packButton() {
    return '<button class="link" data-act="save-pack"' + (!S.canSavePacks || !packSelection().length ? ' disabled' : '') + '>' + esc(M.savePack) + '</button>' +
      (!S.canSavePacks ? '<p class="intro">' + esc(M.packDemo) + '</p>' : '');
  }
  var packIds = [], savingPack = false;
  function openPack() {
    if (!S.canSavePacks || savingPack) return;
    packIds = packSelection();
    if (!packIds.length) return;
    $('pack-form').innerHTML = '<h3 id="pack-title">' + esc(M.savePack) + '</h3><p class="sub">' + esc(tr('packHint', { n: packIds.length })) + '</p>' +
      '<label for="pack-id">' + esc(M.packId) + '</label><input class="agents-search" id="pack-id" required pattern="[a-z0-9][a-z0-9-]*" autocomplete="off">' +
      '<label for="pack-name">' + esc(M.packName) + '</label><input class="agents-search" id="pack-name" required maxlength="60">' +
      '<label for="pack-description">' + esc(M.packDescription) + '</label><input class="agents-search" id="pack-description" required>' +
      '<p class="warn" id="pack-error" role="alert"></p><footer><button type="button" class="link" id="pack-cancel">' + esc(M.close) +
      '</button><button type="submit" class="primary" id="pack-save">' + esc(M.savePack) + '</button></footer>';
    $('pack-cancel').onclick = function () { $('pack-dialog').close(); };
    $('pack-dialog').showModal();
    $('pack-id').focus();
  }
  function savePackSelection() {
    if (!S.canSavePacks || savingPack) return;
    savingPack = true;
    $('pack-save').disabled = true;
    $('pack-error').textContent = '';
    return apiJson('/api/packs', { id: $('pack-id').value, name: $('pack-name').value,
      description: $('pack-description').value, skills: packIds }).then(function (r) {
      return apiJson('/api/state').then(function (st) {
        setState(st); view.theme = 'pack:' + r.pack.id;
        $('pack-dialog').close(); renderPanel(); return load(false);
      });
    }).catch(function (err) { $('pack-error').textContent = err.message; }).finally(function () {
      savingPack = false; $('pack-save').disabled = false;
    });
  }
  $('pack-form').addEventListener('submit', function (e) { e.preventDefault(); savePackSelection(); });

  // ---- changes panel ---------------------------------------------------------------------
  function selectedAgents() { return S.agents.filter(function (a) { return opts.agents.has(a.id); }).map(function (a) { return a.id; }); }

  function renderPanel() {
    var nAdd = adds.size, nRm = removes.size;
    var h = '';
    if (!nAdd && !nRm) {
      h = '<p class="lede">' + esc(M.tagline) + '</p><p class="intro">' + esc(M.selectionEmpty) + '</p>' +
        '<svg class="intro-art" width="220" height="90" viewBox="0 0 220 90" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">' +
        '<path d="M8 70c30-26 52 8 84-14s46-40 78-22 34 20 44 14"/><path d="M8 82c34-24 56 6 88-12s48-34 80-18 30 18 38 14" opacity=".6"/>' +
        '<path d="M20 56c24-20 44 4 70-12s40-30 66-18" opacity=".35"/><circle cx="156" cy="34" r="4" fill="currentColor"/></svg>';
      $('panel-body').innerHTML = h + packButton();
      $('panel-foot').hidden = true;
      return;
    }
    h += '<div class="head-row"><h2>' + esc(M.selection) + '</h2><button class="link" data-act="clear">' + esc(M.clear) + '</button></div>' +
      '<div class="tally">' +
      (nAdd ? '<div class="plus"><b>+' + nAdd + '</b><span>' + esc(M.toInstall) + '</span></div>' : '') +
      (nRm ? '<div class="minus"><b>−' + nRm + '</b><span>' + esc(M.toRemove) + '</span></div>' : '') +
      '</div><div class="chips">';
    adds.forEach(function (s) {
      h += '<button class="plus" data-add="' + esc(s.id) + '" title="' + esc(tr('undo', { name: s.id })) + '"><span>' + esc(s.name) + '</span><span class="x" aria-hidden="true">×</span></button>';
    });
    removes.forEach(function (id) {
      var s = installedById.get(id);
      h += '<button class="minus" data-rm="' + esc(id) + '" title="' + esc(tr('undo', { name: id })) + '"><span>' + esc(s ? s.name : id) + '</span><span class="x" aria-hidden="true">×</span></button>';
    });
    h += '</div>' + packButton();
    if (nAdd) {
      h += '<h2>' + esc(M.scopeTitle) + '</h2>' +
        choice('scope', 'project', M.scopeProject, tr('scopeProjectHint', { cwd: S.cwd })) +
        choice('scope', 'global', M.scopeGlobal, M.scopeGlobalHint);
      var list = S.agents.filter(function (a) {
        var hit = !agentFilter || (a.id + ' ' + a.name).toLowerCase().indexOf(agentFilter) >= 0;
        return hit && (showAllAgents || agentFilter || a.detected || opts.agents.has(a.id));
      });
      h += '<div class="head-row"><h2>' + esc(M.agentsTitle) + ' <span class="figure" style="color:var(--ink-3)">' + opts.agents.size + '</span></h2>' +
        '<button class="link" data-act="all-agents">' + esc(showAllAgents ? M.showDetected : M.showAllAgents) + '</button></div>' +
        '<input class="agents-search" id="agent-filter" type="search" placeholder="' + esc(M.agentsFilter) + '" value="' + esc(agentFilter) + '">' +
        '<div class="agents">' + (list.length ? list.map(function (a) {
          return '<label><input type="checkbox" data-agent="' + esc(a.id) + '"' + (opts.agents.has(a.id) ? ' checked' : '') + '>' +
            '<span>' + esc(a.name) + ' <span class="id">' + esc(a.id) + '</span></span>' +
            (a.detected ? '<span class="found">' + esc(M.detected) + '</span>' : '') + '</label>';
        }).join('') : '<p>' + esc(M.noAgent) + '</p>') + '</div>';
      h += '<h2>' + esc(M.methodTitle) + '</h2>' +
        choice('method', 'symlink', M.symlink, M.symlinkHint) + choice('method', 'copy', M.copy, M.copyHint);
    }
    h += '<div id="audit"></div><h2>' + esc(M.commands) + '</h2><pre id="plan">…</pre>';
    var focusFilter = document.activeElement && document.activeElement.id === 'agent-filter';
    var scroll = $('panel-body').scrollTop;
    $('panel-body').innerHTML = h;
    $('panel-body').scrollTop = scroll;
    if (focusFilter) { var f = $('agent-filter'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
    var blocked = nAdd && !opts.agents.size;
    $('panel-foot').hidden = false;
    $('panel-foot').innerHTML = (blocked ? '<p class="warn">' + esc(M.needAgent) + '</p>' : '') +
      '<button class="primary" id="apply" data-act="apply" disabled>' + esc(retryRemaining ? M.retryRemaining : tr('applyN', { n: nAdd + nRm })) + '</button>';
    schedulePlan();
  }
  function choice(name, value, label, hint) {
    return '<label class="choice"><input type="radio" name="' + name + '" value="' + value + '"' + (opts[name] === value ? ' checked' : '') + '>' +
      '<span><b>' + esc(label) + '</b><small>' + esc(hint) + '</small></span></label>';
  }
  function body(retry) {
    var b = { install: Array.from(adds.keys()), remove: Array.from(removes), auditOverrides: Array.from(auditOverrides).filter(function (id) { return adds.has(id); }), options: { agents: selectedAgents(), scope: opts.scope, method: opts.method } };
    if (retry === undefined ? retryRemaining : retry) b.retry = true;
    return b;
  }
  /** Command preview, computed by the server with the same code as the terminal. */
  function schedulePlan() {
    clearTimeout(planTimer);
    var seq = ++planSeq;
    if (!adds.size && !removes.size) return;
    if (adds.size && !opts.agents.size) { var p0 = $('plan'); if (p0) p0.textContent = '—'; return; }
    planTimer = setTimeout(function () {
      apiJson('/api/plan', body()).then(function (r) {
        var p = $('plan');
        if (!p || seq !== planSeq) return;
        p.textContent = r.commands.map(function (c) { return '$ ' + c; }).join('\n');
        var h = (r.collisions || []).map(function (c) { return '<p class="warn">' + esc(c.message) + '</p>'; }).join('');
        if (r.audit) {
          if (!r.audit.enabled) h += '<p class="warn">' + esc(M.auditOff) + '</p>';
          r.audit.results.forEach(function (a) {
            h += '<h3>' + esc(a.id) + '</h3>' + riskHtml(a);
            if (a.risks.some(function (x) { return x.level === 'high'; })) h += '<label><input type="checkbox" data-override="' + esc(a.id) + '"' +
              (auditOverrides.has(a.id) ? ' checked' : '') + '> ' + esc(M.auditToggle) + ': ' + esc(a.id) + '</label>';
          });
        }
        if ((r.blocked || []).length) h += '<p class="warn">' + esc(M.auditBlocked) + '</p>';
        $('audit').innerHTML = h;
        $('apply').disabled = (r.blocked || []).length > 0;
      }).catch(function (err) { var p = $('plan'); if (p && seq === planSeq) p.textContent = err.message; });
    }, 150);
  }

  $('panel').addEventListener('click', function (e) {
    var t = e.target.closest('[data-act],[data-add],[data-rm]');
    if (!t) return;
    var changed = [];
    if (t.dataset.add) { adds.delete(t.dataset.add); auditOverrides.delete(t.dataset.add); changed.push(t.dataset.add); }
    else if (t.dataset.rm) { removes.delete(t.dataset.rm); changed.push(t.dataset.rm); }
    else if (t.dataset.act === 'clear') { changed = Array.from(adds.keys()).concat(Array.from(removes)); adds.clear(); removes.clear(); auditOverrides.clear(); }
    else if (t.dataset.act === 'all-agents') showAllAgents = !showAllAgents;
    else if (t.dataset.act === 'save-pack') return openPack();
    else if (t.dataset.act === 'apply') return apply();
    changed.forEach(updateRow); renderPanel();
  });
  $('panel').addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset.override) { if (t.checked) auditOverrides.add(t.dataset.override); else auditOverrides.delete(t.dataset.override); }
    if (t.name === 'scope' || t.name === 'method') opts[t.name] = t.value;
    else if (t.dataset.agent) { if (t.checked) opts.agents.add(t.dataset.agent); else opts.agents.delete(t.dataset.agent); }
    renderPanel();
  });
  $('panel').addEventListener('input', function (e) {
    if (e.target.id !== 'agent-filter') return;
    agentFilter = e.target.value.trim().toLowerCase();
    renderPanel();
  });

  // ---- apply -----------------------------------------------------------------------------
  function apply() {
    if (!retryRemaining) return run(false);
    return refresh().then(function () {
      retryRemaining = false;
      if (adds.size || removes.size) return run(true);
    }).catch(fail);
  }
  function run(retry) {
    var dlg = $('progress'), tasks = [], review = null, end;
    var out = $('progress-body');
    function render(end) {
      var h = '<h3>' + esc(end ? (end.ok ? M.summaryOk : M.summaryFailed) : M.progressTitle) + '</h3>' +
        '<p class="sub">' + esc(end ? (end.ok ? M.summaryOkHint : M.summaryFailedHint) : M.applying) + '</p>';
      if (review) {
        h += review.collisions.map(function (c) { return '<p class="warn">' + esc(c.message) + '</p>'; }).join('');
        if (!review.audit.enabled) h += '<p class="warn">' + esc(M.auditOff) + '</p>';
        h += review.audit.results.map(function (a) { return '<h4>' + esc(a.id) + '</h4>' + riskHtml(a); }).join('');
      }
      tasks.forEach(function (t) {
        var dot = t.done ? (t.ok ? '<span class="dot ok">✓</span>' : '<span class="dot ko">!</span>')
                         : (t.started ? '<span class="dot spin"></span>' : '<span class="dot wait"></span>');
        var phase = t.done ? (t.ok ? 'done' : 'failed') : t.phase;
        h += '<div class="task">' + dot + '<strong>' + esc(t.kind === 'remove' ? M.uninstall : t.source) + '</strong>' +
          '<span class="phase ' + (t.done ? (t.ok ? 'ok' : 'ko') : '') + '">' + esc(M['phase_' + phase]) + '</span>' +
          '<span class="skills">' + esc(t.skills.join(', ')) + '</span>' +
          (t.results || []).filter(function (r) { return r.status === 'failed' || r.status === 'skipped'; }).map(function (r) {
            return '<pre class="err">' + esc((r.name || '') + ': ' + (r.error || r.reason || M.phase_failed)) + '</pre>';
          }).join('') +
          (t.error ? '<pre class="err">' + esc(t.error) + '</pre>' : '') + '</div>';
      });
      if (end && end.error) h += '<p class="warn">' + esc(end.error) + '</p>';
      if (end) h += '<footer><button class="primary" id="close">' + esc(M.close) + '</button></footer>';
      out.innerHTML = h;
      var c = $('close');
      if (c) { c.onclick = function () { dlg.close(); }; c.focus(); }
    }
    render(null);
    dlg.showModal();
    dlg.oncancel = function (e) { if (!$('close')) e.preventDefault(); };
    return api('/api/apply', body(retry)).then(function (res) {
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) { if (!end) throw new Error(M.interrupted); return; }
          buf += dec.decode(chunk.value, { stream: true });
          var lines = buf.split('\n'); buf = lines.pop();
          lines.filter(Boolean).forEach(function (line) {
            var ev = JSON.parse(line);
            if (ev.type === 'audit') review = ev;
            else if (ev.type === 'start') tasks[ev.i] = { kind: ev.kind, source: ev.source, skills: ev.skills, started: true, phase: 'fetching' };
            else if (ev.type === 'phase') tasks[ev.i].phase = ev.phase;
            else if (ev.type === 'done') { tasks[ev.i].done = true; tasks[ev.i].ok = ev.ok; tasks[ev.i].error = ev.error; tasks[ev.i].results = ev.results; }
            if (ev.type === 'end') end = ev; else render(null);
          });
          return pump();
        });
      }
      return pump();
    }).catch(function (err) { end = { ok: false, error: err.message }; }).then(function () {
      return refresh().catch(function (err) {
        end = { ok: false, error: [end && end.error, err.message].filter(Boolean).join('\n') };
      });
    }).then(function () {
      retryRemaining = !!(adds.size || removes.size);
      if (retryRemaining) end.ok = false;
      renderPanel();
      render(end);
    });
  }

  /** Whether every selected agent has the skill in the selected scope, per the scan of the disk. */
  function covered(id) {
    var inst = installedById.get(id), agents = selectedAgents();
    var have = inst && inst.agentsByScope && inst.agentsByScope[opts.scope];
    return !!have && agents.length > 0 && agents.every(function (a) { return have.indexOf(a) >= 0; });
  }
  /**
   * Clear only requests achieved on disk; a failed state fetch leaves intent intact. An install
   * stays selected until each requested agent has it, whatever the command reported.
   */
  function refresh() {
    return apiJson('/api/state').then(function (st) {
      setState(st);
      adds.forEach(function (s, id) { if (covered(id)) adds.delete(id); });
      removes.forEach(function (id) { if (!installedById.has(id)) removes.delete(id); });
      auditOverrides.forEach(function (id) { if (!adds.has(id)) auditOverrides.delete(id); });
      if (!adds.size && !removes.size) retryRemaining = false;
      renderPanel();
      return load(false);
    });
  }

  // ---- boot ------------------------------------------------------------------------------
  function setState(st) {
    S = st;
    searchInstalled = createSearchIndex(st.installed);
    var failed = Object.keys(st.sources || {}).filter(function (name) { return st.sources[name].status === 'error'; });
    $('catalog-health').hidden = !failed.length;
    $('catalog-health').textContent = failed.length ? tr('catalogPartial', { sources: failed.join(', ') }) : '';
    installedById = new Map(st.installed.map(function (s) { return [s.id, s]; }));
    // Regions of the map: hues spread evenly over the themes, in catalog order.
    var regions = st.themes.filter(function (th) { return th.id !== 'installed' && th.id !== 'recommended' && th.id !== 'other'; });
    regions.forEach(function (th, i) { hues[th.id] = Math.round(200 + i * 360 / regions.length) % 360; });
  }
  function fail(err) {
    $('rows').innerHTML = '<div class="empty">' + esc(tr('error', { msg: err.message || String(err) })) + '</div>';
  }

  apiJson('/api/state').then(function (st) {
    M = st.messages;
    document.documentElement.lang = st.lang;
    var locale = st.locale || 'en-US';
    fmt = new Intl.NumberFormat(locale);
    compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
    setState(st);
    opts.scope = st.defaults.scope; opts.method = st.defaults.method;
    opts.agents = new Set(st.defaults.agents);
    $('q').placeholder = M.searchPlaceholder;
    $('q').setAttribute('aria-label', M.searchPlaceholder);
    $('sort').innerHTML = '<button data-sort="installs" aria-pressed="true">' + esc(M.sortInstalls) + '</button>' +
      '<button data-sort="name" aria-pressed="false">' + esc(M.sortName) + '</button>';
    $('sort').setAttribute('aria-label', M.sortLabel);
    $('theme').setAttribute('aria-label', M.themeLabel);
    $('official').querySelector('.label').textContent = M.officialOnly;
    $('official').title = M.officialOnly;
    $('themes').setAttribute('aria-label', M.legend);
    renderThemeSwitch();
    renderPanel();
    return load(false);
  }).catch(function (err) {
    document.body.innerHTML = '<p style="padding:40px;text-align:center">' + esc(err.message) + '</p>';
  });

  $('q').addEventListener('input', function (e) {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(function () {
      view.q = e.target.value.trim();
      $('sort').setAttribute('aria-label', view.q && !view.sort ? M.sortRelevance : M.sortLabel);
      Array.prototype.forEach.call($('sort').children, function (x) { x.setAttribute('aria-pressed', String(x.dataset.sort === (view.sort || (view.q ? '' : 'installs')))); });
      load(false);
    }, 120);
  });
  $('sort').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    view.sort = b.dataset.sort;
    $('sort').setAttribute('aria-label', M.sortLabel);
    Array.prototype.forEach.call($('sort').children, function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    load(false);
  });
  $('official').addEventListener('click', function (e) {
    view.official = !view.official;
    e.currentTarget.setAttribute('aria-pressed', String(view.official));
    load(false);
  });
  document.addEventListener('keydown', function (e) {
    var tag = document.activeElement && document.activeElement.tagName;
    if (e.key === '/' && tag !== 'INPUT') { e.preventDefault(); $('q').focus(); }
  });
})();
</script>
</body>
</html>
`;
