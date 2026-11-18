// Peak60 (Cerakey HE60) config editor: UI.
import "./style.css";
import {
  ADV_TYPES, EMPTY_ADV, FN1, LAYOUT, LIGHT_MODES, MACRO_BASE, MACRO_MODES, MOD_BITS,
  activeOs, advType, bindOf, defaultOf, describe, id, isRT, keyColor, label, lightArea, macroFix, slot,
} from "./config";
import { ENV_PASSPHRASE, MissingPassphraseError, decryptText, encryptConfig, isEncryptedFile } from "./crypto";
import { KeyboardDevice, hex, hidSupported } from "./hid/device";
import { identityOf, readConfig } from "./hid/reader";
import { buildWritePlan, runPlan, summarize, type Section, type Step } from "./hid/writer";
import { KEY_GROUPS } from "./keycodes";
import { PRESETS, previewColours, type PresetGroup } from "./presets";
import type { KeyConfig, KeyboardConfig, OsKey, Performance, Rgb } from "./types";

// ---------- state ----------
// Not in the source: from .env (VITE_CERAKEY_PASSPHRASE) or entered once in the app.
let passphrase = ENV_PASSPHRASE;
try { passphrase = localStorage.getItem("cerakey.passphrase") || ENV_PASSPHRASE; } catch { /* storage blocked */ }

function savePassphrase(value: string): void {
  passphrase = value.trim() || ENV_PASSPHRASE;
  try {
    if (value.trim()) localStorage.setItem("cerakey.passphrase", value.trim());
    else localStorage.removeItem("cerakey.passphrase");
  } catch { /* storage blocked */ }
  updatePassphraseUi();
}
/** Asks for the passphrase; returns null if the user cancels. Doesn't save it. */
function promptPassphrase(why: string): string | null {
  const v = window.prompt(`${why}\n\nEnter the Cerakey file passphrase. It isn't included with this editor; see the README.\nIt's remembered in this browser only.`, "");
  return v?.trim() ? v.trim() : null;
}
function updatePassphraseUi(): void {
  const missing = !passphrase;
  const exp = $opt<HTMLButtonElement>("#exportBtn");
  if (exp) exp.title = missing ? "Needs the Cerakey file passphrase (you'll be asked for it)" : "Encrypted file for lab.cerakey.com";
  const note = $opt("#passNote");
  if (note) note.hidden = !missing;
}

let cfg: KeyboardConfig | null = null;
/** What the keyboard is assumed to hold: the file as opened, then whatever was last written. */
let baseline: KeyboardConfig | null = null;
let keyIndex: Record<string, KeyConfig> = {};
let os: OsKey = "win";
let layer = 0;
let tab = "keymap";
let selected = new Set<string>();
let undoStack: string[] = [];
let curMacro = 0;
let device: KeyboardDevice | null = null;

const $ = <T extends HTMLElement = HTMLElement>(s: string, el: ParentNode = document): T => el.querySelector<T>(s)!;
const $opt = <T extends HTMLElement = HTMLElement>(s: string, el: ParentNode = document): T | null => el.querySelector<T>(s);
const $$ = <T extends HTMLElement = HTMLElement>(s: string, el: ParentNode = document): T[] => [...el.querySelectorAll<T>(s)];
const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const fmt = (v: unknown): string => (typeof v === "number" ? String(+v.toFixed(3)) : "—");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const C = (): KeyboardConfig => cfg!;

let toastTimer = 0;
function toast(msg: string, kind: "" | "ok" | "err" = ""): void {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), kind === "err" ? 6000 : 2600);
}

// ---------- config helpers ----------
function reindex(): void {
  keyIndex = {};
  for (const k of cfg?.keyboards.flat() ?? []) keyIndex[id(k.row, k.col)] = k;
}
const keyAt = (r: number, c: number): KeyConfig | undefined => keyIndex[id(r, c)];
const selKeys = (): KeyConfig[] => [...selected].map(s => keyIndex[s]).filter(Boolean);
const curSlot = (k: KeyConfig) => slot(k, os, layer);

// ---------- mutation / undo ----------
function mutate(fn: () => void): void {
  undoStack.push(JSON.stringify(cfg));
  if (undoStack.length > 80) undoStack.shift();
  fn();
  reindex();
  $<HTMLButtonElement>("#undoBtn").disabled = false;
  render();
  scheduleAutoWrite();
}
function undo(): void {
  const prev = undoStack.pop();
  if (!prev) return;
  cfg = JSON.parse(prev) as KeyboardConfig;
  reindex();
  $<HTMLButtonElement>("#undoBtn").disabled = !undoStack.length;
  render();
  scheduleAutoWrite();
  toast("Undone");
}

// ---------- file I/O ----------
/** Replaces the open config. `baseline` is what the keyboard is assumed to hold. */
function loadConfig(next: KeyboardConfig): void {
  cfg = next;
  baseline = clone(next);
  undoStack = [];
  selected.clear();
  curMacro = 0;
  os = activeOs(cfg);
  reindex();
  $("#dropZone").hidden = true;
  $("#editor").hidden = false;
  $<HTMLButtonElement>("#exportBtn").disabled = $<HTMLButtonElement>("#exportPlainBtn").disabled = false;
  $<HTMLButtonElement>("#undoBtn").disabled = true;
  updateDeviceUi();
  render();
}
/** True when the open config has edits the keyboard hasn't received. */
const hasUnwrittenChanges = (): boolean => !!cfg && buildWritePlan(cfg, { baseline }).length > 0;

async function openFile(file: File): Promise<void> {
  try {
    const text = await file.text();
    let next: KeyboardConfig;
    if (!isEncryptedFile(text)) {
      next = decryptText(text, passphrase);
    } else {
      // Try the configured passphrase, then let the user enter one (once more after a wrong
      // try). A typed passphrase is only remembered after it actually decrypts the file.
      let candidate = passphrase || promptPassphrase(`"${file.name}" is encrypted.`);
      if (!candidate) return;
      for (let attempt = 0; ; attempt++) {
        try {
          next = decryptText(text, candidate);
          if (candidate !== passphrase) savePassphrase(candidate);
          break;
        } catch (e) {
          if (e instanceof MissingPassphraseError || attempt >= 1) throw e;
          candidate = promptPassphrase(`Couldn't decrypt "${file.name}" with that passphrase.`);
          if (!candidate) throw e;
        }
      }
    }
    if (hasUnwrittenChanges() && !confirm("Opening this file discards the edits you haven't written to the keyboard. Continue?")) return;
    loadConfig(next);
    toast(`Loaded ${file.name}`, "ok");
  } catch (e) {
    toast((e as Error).message, "err");
  }
}
function download(text: string, name: string, type = "application/json"): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function confirmProblems(action: string): boolean {
  const problems = validate();
  return !problems.length || confirm(`Possible problems:\n\n• ${problems.join("\n• ")}\n\n${action} anyway?`);
}
function exportEncrypted(): void {
  if (!confirmProblems("Export")) return;
  if (!passphrase) {
    const v = promptPassphrase("Exporting an encrypted file for lab.cerakey.com.");
    if (!v) return toast("Not exported: no passphrase. Use Export decrypted for a plain JSON copy.", "err");
    savePassphrase(v);
  }
  try {
    download(JSON.stringify(encryptConfig(C(), passphrase)), "keyboard_config.json");
  } catch (e) {
    return toast((e as Error).message, "err");
  }
  toast("Exported keyboard_config.json", "ok");
}
const exportPlain = (): void => download(JSON.stringify(C(), null, 2), "keyboard_config.decrypted.json");

function validate(): string[] {
  const out: string[] = [];
  for (const o of ["win", "mac"] as const) {
    if (!LAYOUT.some(p => bindOf(keyAt(p.r, p.c), o, 0) === FN1)) {
      out.push(`No key on the ${o === "win" ? "Windows" : "Mac"} base layer is bound to Fn1, so you may lose access to the Fn layer.`);
    }
  }
  for (const p of LAYOUT) {
    const pf = keyAt(p.r, p.c)?.performance;
    if (!pf) continue;
    const vals = [pf.normalPress, pf.rtFirstTouch, pf.rtPress, pf.rtRelease, pf.pressDeadStroke, pf.releaseDeadStroke];
    if (vals.some(v => typeof v !== "number" || v < 0 || v > 4)) out.push(`Key ${label(bindOf(keyAt(p.r, p.c), os, 0))} has a travel value outside 0–4 mm.`);
  }
  return out;
}

// ---------- rendering ----------
function render(): void {
  if (!cfg) return;
  renderInfo();
  $$("#osSeg button").forEach(b => b.classList.toggle("on", b.dataset.os === os));
  $$("#layerSeg button").forEach(b => b.classList.toggle("on", Number(b.dataset.layer) === layer));
  $$("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  $("#selCount").textContent = selected.size ? `${selected.size} selected` : "";
  renderKeyboard();
  renderPanel();
}

function renderInfo(): void {
  const c = C();
  const s = c.system;
  const pv = c.protocolVersion as { mainVersion?: number; subVersion?: number } | undefined;
  $("#info").innerHTML = ([
    ["Keyboard", s.keyboardName], ["VID:PID", `${s.vid}:${s.pid}`], ["Firmware", c.firmwareVersion],
    ["Protocol", pv && typeof pv === "object" ? `${pv.mainVersion}.${pv.subVersion}` : pv], ["Format", c.version],
    ["OS on import", s.currentKeyboardSystem],
  ] as [string, unknown][]).map(([k, v]) => `<span>${esc(k)}: <b>${esc(v ?? "—")}</b></span>`).join("");
}

function renderKeyboard(): void {
  const U = 54, G = 5;
  const width = 15 * U + 14 * G, height = 5 * U + 4 * G;
  let html = `<div class="kb-inner" style="width:${width}px;height:${height}px">`;
  for (const p of LAYOUT) {
    const key = keyAt(p.r, p.c);
    if (!key) continue;
    const code = bindOf(key, os, layer);
    const def = defaultOf(key, os, layer);
    const trans = layer > 0 && code === 1;
    const lbl = trans ? label(bindOf(key, os, 0)) : label(code);
    let sub = "";
    if (tab === "performance") {
      const pf = key.performance;
      sub = isRT(pf) ? `RT ${fmt(pf.rtPress)}/${fmt(pf.rtRelease)}` : `${fmt(pf.normalPress)}mm`;
    } else if (trans) sub = "▽ trans";
    const cls = ["key", selected.has(id(p.r, p.c)) && "sel", code !== def && "changed", trans && "trans"].filter(Boolean).join(" ");
    const col = tab === "lighting" ? keyColor(C(), key, p.r, p.c) : null;
    const adv = advType(key);
    html += `<div class="${cls}" data-id="${id(p.r, p.c)}" title="${esc(describe(code))}  [r${p.r} c${p.c}]"
      style="left:${p.x * (U + G)}px;top:${p.y * (U + G)}px;width:${p.w * U + (p.w - 1) * G}px;height:${U}px">
      <div class="lbl${lbl.length > 7 ? " long" : ""}">${esc(lbl)}</div><div class="sub">${esc(sub)}</div>
      ${adv ? `<span class="tag">${adv}</span>` : ""}
      ${col ? `<span class="swatch" style="background:rgb(${col.R},${col.G},${col.B})"></span>` : ""}</div>`;
  }
  $("#keyboard").innerHTML = html + "</div>";
}

const needSel = (html: string): string =>
  selected.size ? html : `<p class="muted">Select one or more keys on the keyboard above.</p>`;

function renderPanel(): void {
  const p = $("#panel");
  const panels: Record<string, () => string> = {
    presets: presetPanel, keymap: keymapPanel, performance: perfPanel, lighting: lightPanel, advanced: advPanel, macros: macroPanel, raw: rawPanel,
  };
  p.innerHTML = (panels[tab] ?? keymapPanel)();
  bindPanel();
}

// ----- presets -----
const GROUP_NOTES: Record<PresetGroup, string> = {
  Actuation: "Applies to all 61 keys. Rapid Trigger values stay at or above 0.1 mm.",
  Lighting: "Sets per-key colours and turns lighting on. If the colours don't show, switch to a static effect in the Lighting tab.",
  Keymap: "Applies to the Windows and Mac keymaps.",
};
function miniKeyboard(p: (typeof PRESETS)[number]): string {
  return `<div class="mini-kb">${previewColours(C(), p).map(k =>
    `<i style="left:${(k.x / 15) * 100}%;top:${(k.y / 5) * 100 + 2}%;width:calc(${(k.w / 15) * 100}% - 2px);height:17%;${k.rgb ? `background:rgb(${k.rgb.R},${k.rgb.G},${k.rgb.B})` : ""}"></i>`).join("")}</div>`;
}
function presetPanel(): string {
  const groups: PresetGroup[] = ["Actuation", "Lighting", "Keymap"];
  return groups.map(g => `<div class="preset-group"><h3>${g} <small>${esc(GROUP_NOTES[g])}</small></h3><div class="preset-grid">
    ${PRESETS.filter(p => p.group === g).map(p => `<div class="preset">
      ${g === "Lighting" ? miniKeyboard(p) : ""}
      <b>${esc(p.name)}</b><p>${esc(p.desc)}</p>
      <button class="btn small primary" data-act="preset" data-preset="${p.id}">Apply</button></div>`).join("")}
  </div></div>`).join("") + `<p class="note">Every preset can be undone with Ctrl+Z.${autoWrite && device ? " Auto-write is on, so the keyboard updates as soon as you apply one." : ""}</p>`;
}

// ----- keymap -----
function keymapPanel(): string {
  const keys = selKeys();
  const k0 = keys[0];
  const cur = k0 ? bindOf(k0, os, layer) : null;
  const layerName = layer === 0 ? "Base" : "Fn" + layer;
  const basicOpts = KEY_GROUPS.Basic.map(c => `<option value="${c}">${esc(label(c))}</option>`).join("");
  const left = needSel(`
    <div class="card">
      <h3>${keys.length === 1 ? `Key r${k0.row} c${k0.col}` : `${keys.length} keys`} · ${layerName} · ${os === "win" ? "Windows" : "macOS"}</h3>
      ${keys.length === 1 ? `<p>Current: <b>${esc(label(cur))}</b> <span class="muted">(${esc(describe(cur))}, code ${cur})</span><br>
        Default: <b>${esc(label(defaultOf(k0, os, layer)))}</b></p>` : ""}
      <div class="row">
        <button class="btn small" data-act="reset">Reset to default</button>
        ${layer > 0 ? `<button class="btn small" data-act="assign" data-code="1">Transparent</button>` : ""}
        <button class="btn small" data-act="assign" data-code="0">None</button>
      </div>
      ${keys.some(k => advType(k)) ? `<div class="warnbox">A selected key has an advanced-key binding (see the Advanced tab). That binding may take priority over the keymap.</div>` : ""}
    </div>
    <div class="card">
      <h3>Shortcut (modifier + key)</h3>
      <div class="mods">${MOD_BITS.map(([n, b]) => `<label><input type="checkbox" class="modbox" value="${b}" ${b === 1 ? "checked" : ""}> ${n}</label>`).join("")}</div>
      <div class="row" style="margin-top:10px"><select id="comboKey">${basicOpts}</select>
        <button class="btn small primary" data-act="combo">Apply</button></div>
      <p class="note">Only left-side modifiers can be combined (firmware limit).</p>
    </div>
    <div class="card">
      <h3>Raw keycode</h3>
      <div class="row"><input type="number" id="rawCode" min="0" max="65535" value="${cur ?? 0}">
        <button class="btn small" data-act="raw">Apply</button></div>
    </div>`);
  const groups = Object.entries(KEY_GROUPS).map(([g, codes]) => `
    <div class="group" data-group="${esc(g)}"><div class="group-title">${esc(g)}</div><div class="chips">
    ${codes.map(c => `<button class="chip${c === cur ? " cur" : ""}" data-code="${c}" data-search="${esc((label(c) + " " + describe(c) + " " + g).toLowerCase())}" title="${esc(describe(c))} (${c})">${esc(label(c))}</button>`).join("")}
    </div></div>`).join("");
  return `<div class="cols"><div>${left}</div><div>
    <input type="text" class="picker-search" id="pickSearch" placeholder="Search keys (e.g. f5, vol, mouse, macro)…">
    <div id="picker">${groups}</div></div></div>`;
}
function assign(code: number): void {
  const keys = selKeys();
  if (!keys.length) return toast("Select a key first", "err");
  mutate(() => {
    for (const k of keys) {
      const s = curSlot(k);
      if (!s) continue;
      s.bindKeyValue = code;
      if (layer === 0 && os === activeOs(cfg)) k.keyValue = code;
    }
  });
}

// ----- performance -----
const PF_FIELDS = ["normalPress", "rtFirstTouch", "rtPress", "rtRelease", "pressDeadStroke", "releaseDeadStroke"] as const;
function perfPanel(): string {
  const keys = selKeys();
  const pf = (keys[0]?.performance ?? {}) as Partial<Performance>;
  const f = (name: (typeof PF_FIELDS)[number], lbl: string, help: string) =>
    `<label class="field"><span>${lbl}</span><span><input type="number" step="0.01" min="0" max="4" data-pf="${name}" value="${pf[name] ?? 0}"> mm ${help ? `<span class="muted"> ${help}</span>` : ""}</span></label>`;
  const rt = isRT(pf as Performance);
  return needSel(`<div class="cols"><div class="card">
    <h3>${keys.length === 1 ? `Key r${keys[0].row} c${keys[0].col}` : `${keys.length} keys`}: values loaded from the first selected key</h3>
    <label class="field"><span>Mode</span><span><select data-pf="mode">
      <option value="0" ${!rt ? "selected" : ""}>Normal (single actuation point)</option>
      <option value="1" ${rt ? "selected" : ""}>Rapid Trigger</option></select></span></label>
    ${f("normalPress", "Actuation point", "")}
    ${f("rtFirstTouch", "RT first trigger", "(RT mode)")}
    ${f("rtPress", "RT press sensitivity", "(RT mode)")}
    ${f("rtRelease", "RT release sensitivity", "(RT mode)")}
    ${f("pressDeadStroke", "Top dead zone", "")}
    ${f("releaseDeadStroke", "Bottom dead zone", "")}
    <div class="row"><button class="btn primary" data-act="perfApply">Apply to ${keys.length} key${keys.length > 1 ? "s" : ""}</button></div>
    <p class="note">Stored in mm and sent to the keyboard ×1000 (µm). The lab editor's typical range is 0.1–4.0 mm.</p>
  </div><div class="card"><h3>Overview</h3>${perfSummary()}</div></div>`);
}
function perfSummary(): string {
  const groups: Record<string, string[]> = {};
  for (const p of LAYOUT) {
    const pf = keyAt(p.r, p.c)?.performance;
    if (!pf) continue;
    const sig = isRT(pf)
      ? `RT · first ${fmt(pf.rtFirstTouch)} · press ${fmt(pf.rtPress)} · release ${fmt(pf.rtRelease)}`
      : `Normal · ${fmt(pf.normalPress)} mm`;
    (groups[`${sig} · dz ${fmt(pf.pressDeadStroke)}/${fmt(pf.releaseDeadStroke)}`] ||= []).push(label(bindOf(keyAt(p.r, p.c), os, 0)));
  }
  return `<table class="grid"><tr><th>Setting</th><th>Keys</th></tr>${Object.entries(groups).map(([s, ks]) =>
    `<tr><td>${esc(s)}</td><td>${ks.length > 12 ? ks.length + " keys" : esc(ks.join(", "))}</td></tr>`).join("")}</table>`;
}

// ----- lighting -----
function lightPanel(): string {
  const area = lightArea(C());
  const L = area ? C().v2light[area]?.light : undefined;
  if (!L) return `<p class="muted">No lighting data in this file.</p>`;
  const modeOpts = Object.entries(LIGHT_MODES).map(([v, n]) => `<option value="${v}" ${Number(v) === L.mode ? "selected" : ""}>${v} · ${esc(n)}</option>`).join("");
  const keys = selKeys();
  const c0 = keys.length ? keyColor(C(), keys[0], keys[0].row, keys[0].col) : null;
  const hexc = c0 ? "#" + [c0.R, c0.G, c0.B].map(v => v.toString(16).padStart(2, "0")).join("") : "#4f9dff";
  return `<div class="cols"><div class="card">
    <h3>Effect (${esc(area)})</h3>
    <label class="field"><span>Lighting</span><span><select data-light="open">
      ${["Open", "Close"].map(v => `<option ${L.open === v ? "selected" : ""}>${v}</option>`).join("")}</select></span></label>
    <label class="field"><span>Mode</span><span><select data-light="mode">${modeOpts}</select></span></label>
    <label class="field"><span>Brightness</span><span><input type="range" min="0" max="100" data-light="luminance" value="${L.luminance}"> <b>${L.luminance}</b></span></label>
    <label class="field"><span>Speed</span><span><input type="range" min="0" max="100" data-light="speed" value="${L.speed}"> <b>${L.speed}</b></span></label>
    <label class="field"><span>Direction</span><span><select data-light="direction">
      ${["Forward", "Backward"].map(v => `<option ${L.direction === v ? "selected" : ""}>${v}</option>`).join("")}</select></span></label>
    <label class="field"><span>Palette color index</span><span><input type="number" min="0" max="7" data-light="selectStaticColor" value="${L.selectStaticColor}"></span></label>
    <p class="note">Mode names come from the official editor's code and may not match what the Peak60 shows. The number is what the keyboard stores. Per-key colors are used by the custom-lighting mode.</p>
  </div><div class="card">
    <h3>Per-key color</h3>
    ${needSel(`<div class="row"><input type="color" id="keyColor" value="${hexc}">
      <button class="btn primary small" data-act="colorApply">Apply to ${keys.length} key${keys.length > 1 ? "s" : ""}</button>
      <button class="btn small" data-act="colorClear">Clear selected</button></div>`)}
    <div class="row"><button class="btn small danger" data-act="colorClearAll">Clear all custom colors</button></div>
    <p class="note">The colored strip under each key shows its custom color.</p>
  </div></div>`;
}
function setColor(keys: KeyConfig[], rgb: [number, number, number] | null): void {
  const area = lightArea(C());
  const grid = area ? C().v2light[area]?.customLight : undefined;
  for (const k of keys) {
    const v: Rgb = rgb ? { R: rgb[0], G: rgb[1], B: rgb[2], isCustom: true } : { R: 0, G: 0, B: 0, isCustom: false };
    if (grid?.[k.row]) grid[k.row][k.col] = { ...v };
    k.customLight = { ...v };
  }
}

// ----- advanced -----
function advPanel(): string {
  const list = LAYOUT.map(p => keyAt(p.r, p.c)).filter((k): k is KeyConfig => !!k && !!advType(k));
  const k0 = selKeys()[0];
  const summary = list.length
    ? `<table class="grid"><tr><th>Key</th><th>Type</th><th></th></tr>${list.map(k =>
      `<tr><td>${esc(label(bindOf(k, os, 0)))} <span class="muted">r${k.row} c${k.col}</span></td><td>${advType(k)}</td>
       <td><button class="btn small" data-act="advSelect" data-id="${id(k.row, k.col)}">Select</button></td></tr>`).join("")}</table>`
    : `<p class="muted">No advanced keys (DKS / MPT / MT / TGL / END / SOCD / RS) are set in this config.</p>`;
  const types = Object.entries(ADV_TYPES).map(([n, t]) => `${n} ${t}`).join(", ");
  return `<div class="cols"><div class="card"><h3>Keys with advanced bindings</h3>${summary}</div>
    <div class="card">${k0 ? `<h3>r${k0.row} c${k0.col} · ${advType(k0) || "none"}</h3>
      <p class="note">Shown as raw JSON. Shapes per type: DKS {dks:{dks:[4 kc], trps:[4], db, db2}} · MPT {mpt:{dks:[3 kc], dbs:[3 mm]}} · MT {mt:{mt:{delay, dksAll:[2 kc]}}} · TGL {tgl:{tgl:{kc, delay}}} · END {end:{end:{dks:[2 kc], delay}}} · SOCD {socd:{socd:{row2,col2,kcs:[2],delay}, socdMode}} · RS {rs:{rs:{row2,col2,kcs:[2],delay}}}. advancedType: ${types}.</p>
      <textarea id="advJson" style="min-height:220px">${esc(JSON.stringify(k0.advancedKeys, null, 2))}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn primary small" data-act="advSave">Save JSON</button>
        <button class="btn small danger" data-act="advClear">Remove advanced binding</button></div>`
      : `<p class="muted">Select a key to view or edit its advanced binding.</p>`}</div></div>`;
}

// ----- macros -----
function macroPanel(): string {
  const list = C().macro?.v2list || [];
  if (!list.length) return `<p class="muted">No macro data in this file.</p>`;
  const m = list[curMacro] || list[0];
  const boundTo = LAYOUT.flatMap(p => {
    const k = keyAt(p.r, p.c);
    return (["win", "mac"] as const).flatMap(o => [0, 1, 2, 3].filter(l => bindOf(k, o, l) === MACRO_BASE + m.macroId)
      .map(l => `${label(bindOf(k, o, 0))} (${o}, ${l ? "Fn" + l : "base"})`));
  });
  const keyOpts = (c: number) => [...KEY_GROUPS.Basic, ...KEY_GROUPS.Media, ...KEY_GROUPS.Mouse]
    .map(v => `<option value="${v}" ${v === c ? "selected" : ""}>${esc(label(v))}</option>`).join("");
  const rows = (m.data || []).map((a, i) => `<tr data-i="${i}">
    <td class="muted">${i + 1}</td>
    <td><select data-ma="status"><option value="1" ${a.status === 1 ? "selected" : ""}>▼ Down</option><option value="0" ${a.status !== 1 ? "selected" : ""}>▲ Up</option></select></td>
    <td><select data-ma="keyCode">${keyOpts(a.keyCode)}</select></td>
    <td><input type="number" min="0" max="32767" data-ma="delay" value="${a.delay}"> ms</td>
    <td><button class="btn small" data-act="mUp">↑</button> <button class="btn small" data-act="mDown">↓</button> <button class="btn small danger" data-act="mDel">✕</button></td></tr>`).join("");
  return `<div class="cols"><div class="card"><h3>Macros</h3><div class="macro-list">
    ${list.map((x, i) => `<button data-macro="${i}" class="${i === curMacro ? "on" : ""}"><span>${esc(x.name)}</span><span class="badge">${(x.data || []).length} actions</span></button>`).join("")}
    </div><p class="note">To trigger a macro, bind a key to <b>M${m.macroId}</b> (Keymap tab → Macro group).</p></div>
    <div class="card">
      <label class="field"><span>Name</span><span><input type="text" data-mf="name" value="${esc(m.name)}"></span></label>
      <label class="field"><span>Playback</span><span><select data-mf="mode">${MACRO_MODES.map((n, i) => `<option value="${i}" ${m.mode === i ? "selected" : ""}>${n}</option>`).join("")}</select></span></label>
      <label class="field"><span>Repeat count (N)</span><span><input type="number" min="1" max="9999" data-mf="repNum" value="${m.repNum || 1}"></span></label>
      <p class="note">Bound to: ${boundTo.length ? esc(boundTo.join(", ")) : "no key"}</p>
      <table class="grid"><tr><th>#</th><th>Action</th><th>Key</th><th>Delay after</th><th></th></tr>${rows ||
        `<tr><td colspan="5" class="muted">No actions yet.</td></tr>`}</table>
      <div class="row" style="margin-top:10px">
        <select id="tapKey">${keyOpts(4)}</select>
        <button class="btn small primary" data-act="mTap">+ Tap (down + up)</button>
        <button class="btn small" data-act="mAdd">+ Single action</button>
        <button class="btn small danger" data-act="mClear">Clear</button>
      </div>
      <p class="note">Each action waits "delay after" ms (max 32767) before the next one. Macro names are only stored in the file, not on the keyboard.</p>
    </div></div>`;
}

// ----- raw -----
function rawPanel(): string {
  return `<div class="warnbox">Edits the whole decrypted config directly. Keep the <code>system.pid</code> and <code>system.vid</code> values, or the official editor and the keyboard writer will reject it.</div>
    <textarea id="rawJson" spellcheck="false">${esc(JSON.stringify(cfg, null, 1))}</textarea>
    <div class="row" style="margin-top:10px">
      <button class="btn primary" data-act="rawApply">Apply JSON</button>
      <span class="muted">File passphrase:</span><input type="password" id="passInput" value="${esc(passphrase)}" placeholder="${ENV_PASSPHRASE ? "from .env" : "not set"}" autocomplete="off" style="width:220px">
      <button class="btn small" data-act="passSave">Save passphrase</button>
      <label class="muted">OS on import: <select id="sysSel">${["WIN", "MAC"].map(v => `<option ${C().system?.currentKeyboardSystem === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    </div>`;
}

// ---------- panel events ----------
function bindPanel(): void {
  const p = $("#panel");
  const search = $opt<HTMLInputElement>("#pickSearch", p);
  search?.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    $$(".chip", p).forEach(ch => (ch.hidden = !!q && !ch.dataset.search!.includes(q)));
    $$(".group", p).forEach(g => (g.hidden = !$$(".chip", g).some(ch => !ch.hidden)));
  });
  $$<HTMLInputElement | HTMLSelectElement>("[data-light]", p).forEach(el => el.addEventListener("change", () => {
    const area = lightArea(C())!;
    const k = el.dataset.light!;
    const numeric = (el as HTMLInputElement).type === "range" || (el as HTMLInputElement).type === "number" || k === "mode";
    mutate(() => { (C().v2light[area].light as unknown as Record<string, unknown>)[k] = numeric ? Number(el.value) : el.value; });
  }));
  $$<HTMLInputElement | HTMLSelectElement>("[data-mf]", p).forEach(el => el.addEventListener("change", () => {
    mutate(() => {
      const m = C().macro.v2list[curMacro] as unknown as Record<string, unknown>;
      const k = el.dataset.mf!;
      m[k] = k === "name" ? el.value : Number(el.value);
      macroFix(C().macro.v2list[curMacro]);
    });
  }));
  $$<HTMLInputElement | HTMLSelectElement>("[data-ma]", p).forEach(el => el.addEventListener("change", () => {
    const i = Number(el.closest("tr")!.dataset.i);
    mutate(() => {
      const m = C().macro.v2list[curMacro];
      (m.data[i] as unknown as Record<string, number>)[el.dataset.ma!] = Number(el.value);
      macroFix(m);
    });
  }));
  $opt<HTMLSelectElement>("#sysSel", p)?.addEventListener("change", e =>
    mutate(() => { C().system.currentKeyboardSystem = (e.target as HTMLSelectElement).value; }));
}

function onPanelClick(e: Event): void {
  const t = e.target as HTMLElement;
  const chip = t.closest<HTMLElement>(".chip");
  if (chip) return assign(Number(chip.dataset.code));
  const mb = t.closest<HTMLElement>("[data-macro]");
  if (mb) { curMacro = Number(mb.dataset.macro); return renderPanel(); }
  const b = t.closest<HTMLElement>("[data-act]");
  if (!b) return;
  const act = b.dataset.act!;
  const keys = selKeys();
  switch (act) {
    case "assign": return assign(Number(b.dataset.code));
    case "preset": {
      const p = PRESETS.find(x => x.id === b.dataset.preset);
      if (!p) return;
      mutate(() => p.apply(C()));
      return toast(`Applied "${p.name}"`, "ok");
    }
    case "reset":
      return mutate(() => keys.forEach(k => {
        const s = curSlot(k);
        if (!s) return;
        s.bindKeyValue = defaultOf(k, os, layer) ?? 0;
        if (layer === 0 && os === activeOs(cfg)) k.keyValue = defaultOf(k, os, layer) ?? 0;
      }));
    case "raw": {
      const v = Number($<HTMLInputElement>("#rawCode").value);
      if (!Number.isInteger(v) || v < 0 || v > 65535) return toast("Keycode must be 0–65535", "err");
      return assign(v);
    }
    case "combo": {
      const mods = $$<HTMLInputElement>(".modbox").filter(x => x.checked).reduce((a, x) => a | Number(x.value), 0);
      if (!mods) return toast("Pick at least one modifier", "err");
      return assign(4096 | (mods << 8) | Number($<HTMLSelectElement>("#comboKey").value));
    }
    case "perfApply": {
      const vals: Record<string, number> = {};
      for (const el of $$<HTMLInputElement | HTMLSelectElement>("[data-pf]")) {
        const v = Number(el.value);
        if (el.dataset.pf !== "mode" && (!(v >= 0) || v > 4)) return toast(`${el.closest("label")!.firstElementChild!.textContent}: must be 0–4 mm`, "err");
        vals[el.dataset.pf!] = v;
      }
      if (vals.mode === 1 && (!vals.rtPress || !vals.rtRelease)) return toast("RT press/release sensitivity must be > 0", "err");
      if (vals.mode === 0 && !vals.normalPress) return toast("Actuation point must be > 0", "err");
      // Only `mode` reaches the keyboard; isRt is kept in step for the official editor's UI.
      mutate(() => keys.forEach(k => Object.assign(k.performance, vals, { isRt: vals.mode === 1 })));
      return toast(`Updated ${keys.length} key(s)`, "ok");
    }
    case "colorApply": {
      const h = $<HTMLInputElement>("#keyColor").value;
      const rgb = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
      return mutate(() => setColor(keys, rgb));
    }
    case "colorClear": return mutate(() => setColor(keys, null));
    case "colorClearAll": return mutate(() => setColor(Object.values(keyIndex), null));
    case "advSelect": selected = new Set([b.dataset.id!]); return render();
    case "advSave": {
      let v: unknown;
      try { v = JSON.parse($<HTMLTextAreaElement>("#advJson").value); } catch (err) { return toast("Invalid JSON: " + (err as Error).message, "err"); }
      const k = keys[0];
      return mutate(() => { k.advancedKeys = v as KeyConfig["advancedKeys"]; });
    }
    case "advClear": { const k = keys[0]; return mutate(() => { k.advancedKeys = { ...EMPTY_ADV }; }); }
    case "mTap": case "mAdd": case "mClear": case "mUp": case "mDown": case "mDel": {
      const i = Number(b.closest("tr")?.dataset.i);
      return mutate(() => {
        const m = C().macro.v2list[curMacro];
        m.data ||= [];
        const kc = Number($opt<HTMLSelectElement>("#tapKey")?.value || 4);
        if (act === "mTap") m.data.push({ status: 1, delay: 30, keyCode: kc }, { status: 0, delay: 30, keyCode: kc });
        if (act === "mAdd") m.data.push({ status: 1, delay: 30, keyCode: kc });
        if (act === "mClear") m.data = [];
        if (act === "mDel") m.data.splice(i, 1);
        if (act === "mUp" && i > 0) [m.data[i - 1], m.data[i]] = [m.data[i], m.data[i - 1]];
        if (act === "mDown" && i < m.data.length - 1) [m.data[i + 1], m.data[i]] = [m.data[i], m.data[i + 1]];
        macroFix(m);
      });
    }
    case "rawApply": {
      let v: KeyboardConfig;
      try { v = JSON.parse($<HTMLTextAreaElement>("#rawJson").value) as KeyboardConfig; } catch (err) { return toast("Invalid JSON: " + (err as Error).message, "err"); }
      if (!v.keyboards || !v.system) return toast("JSON must contain keyboards and system", "err");
      mutate(() => { cfg = v; });
      return toast("Applied", "ok");
    }
    case "passSave": {
      savePassphrase($<HTMLInputElement>("#passInput").value);
      return toast(passphrase ? "Passphrase saved in this browser" : "Passphrase cleared", "ok");
    }
  }
}

// ---------- keyboard selection ----------
let dragging = false, dragAdd = true;
function onKeyDown(e: MouseEvent): void {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".key");
  if (!el) return;
  e.preventDefault();
  const k = el.dataset.id!;
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    dragAdd = !selected.has(k);
    if (dragAdd) selected.add(k); else selected.delete(k);
  } else {
    selected = new Set([k]);
    dragAdd = true;
  }
  dragging = true;
  render();
}
function onKeyEnter(e: MouseEvent): void {
  if (!dragging) return;
  const el = (e.target as HTMLElement).closest<HTMLElement>(".key");
  if (!el) return;
  const k = el.dataset.id!;
  if (dragAdd && !selected.has(k)) { selected.add(k); render(); }
  else if (!dragAdd && selected.has(k)) { selected.delete(k); render(); }
}

// ---------- keyboard device ----------
function updateDeviceUi(): void {
  const st = $("#devStatus");
  st.textContent = device ? `${device.name} connected` : hidSupported() ? "No keyboard" : "WebHID unavailable";
  st.classList.toggle("on", !!device);
  $("#connectBtn").textContent = device ? "Disconnect" : "Connect keyboard";
  $<HTMLButtonElement>("#connectBtn").disabled = !hidSupported();
  $<HTMLButtonElement>("#readBtn").disabled = $<HTMLButtonElement>("#readBtn2").disabled = !hidSupported();
  $<HTMLButtonElement>("#writeBtn").disabled = !device || !cfg;
  refreshAutoStatus();
}

async function connect(prompt: boolean): Promise<void> {
  try {
    device = await KeyboardDevice.connect(prompt);
    if (device) {
      const info = await device.info().catch(() => null);
      toast(info ? `Connected: ${device.name}, firmware ${info.appVersion}, protocol ${info.protocol}` : `Connected: ${device.name}`, "ok");
      updateDeviceUi();
      void autoWriteNow();
    } else if (prompt) toast("No keyboard selected");
  } catch (e) {
    if ((e as DOMException)?.name !== "NotFoundError") toast((e as Error).message, "err");
    device = null;
  }
  updateDeviceUi();
}
async function disconnect(): Promise<void> {
  await device?.close().catch(() => undefined);
  device = null;
  updateDeviceUi();
}

// ---------- read from keyboard ----------
let reading = false;
async function readFromKeyboard(): Promise<void> {
  if (reading || writing || autoBusy) return toast("The keyboard is busy; try again in a moment", "err");
  if (!device) await connect(true);
  if (!device) return;
  if (hasUnwrittenChanges() && !confirm("Reading from the keyboard replaces the open config, including edits you haven't written. Continue?")) return;
  const dlg = $<HTMLDialogElement>("#readDlg");
  const prog = $("#readProgress");
  $("#readResult").innerHTML = "";
  $("#readClose").hidden = true;
  dlg.showModal();
  reading = true;
  try {
    const t0 = performance.now();
    const next = await readConfig(device, identityOf(device), (done, total, what) => {
      ($(".bar", prog) as HTMLElement).style.width = `${Math.min(100, (100 * done) / total)}%`;
      $(".ptext", prog).textContent = what;
    });
    loadConfig(next);
    dlg.close();
    toast(`Read ${next.system.keyboardName} (firmware ${next.firmwareVersion}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`, "ok");
  } catch (e) {
    $("#readResult").innerHTML = `<p class="result-err">Couldn't read the keyboard: ${esc((e as Error).message)}</p>
      <p class="note">Close lab.cerakey.com and any other tab using the keyboard, then try again. The open config was not changed.</p>`;
    $("#readClose").hidden = false;
  } finally {
    reading = false;
  }
}

// ---------- auto-write ----------
let autoWrite = false;
try { autoWrite = localStorage.getItem("cerakey.autoWrite") === "1"; } catch { /* storage blocked */ }
let autoTimer = 0;
let autoBusy = false;
let autoPending = false;

function setAutoStatus(text: string, kind: "" | "ok" | "busy" | "err" = "", title = ""): void {
  const el = $<HTMLButtonElement>("#autoStatus");
  el.hidden = !autoWrite;
  el.textContent = text;
  el.className = "auto-status " + kind;
  el.title = title || text;
}
function refreshAutoStatus(): void {
  $<HTMLInputElement>("#autoWrite").checked = autoWrite;
  if (!autoWrite) return setAutoStatus("");
  if (!device) return setAutoStatus("Waiting for keyboard");
  if (!cfg) return setAutoStatus("Waiting for a file");
  if (!autoBusy) setAutoStatus("Watching for changes", "ok");
}
function scheduleAutoWrite(delay = 350): void {
  if (!autoWrite || !device || !cfg) return;
  clearTimeout(autoTimer);
  setAutoStatus("Change pending…", "busy");
  // Short debounce so a burst of edits (undo spam, several quick clicks) becomes one write.
  autoTimer = window.setTimeout(() => void autoWriteNow(), delay);
}
async function autoWriteNow(): Promise<void> {
  if (!autoWrite || !device || !cfg) return refreshAutoStatus();
  if (autoBusy || writing || reading) { autoPending = true; return; }
  const s = C().system;
  if (s.vid !== device.vendorId || s.pid !== device.productId) {
    return setAutoStatus("Paused: file is for a different keyboard", "err");
  }
  const problems = validate();
  if (problems.length) return setAutoStatus("Paused: " + problems[0], "err", problems.join("\n") + "\n\nFix this, then click to retry.");
  const snapshot = clone(C());
  const steps = buildWritePlan(snapshot, { baseline });
  if (!steps.length) return setAutoStatus("In sync", "ok");
  autoBusy = true;
  setAutoStatus(`Writing ${steps.length} change${steps.length > 1 ? "s" : ""}…`, "busy");
  const res = await runPlan(device, steps, (done, total) => {
    if (done < total) setAutoStatus(`Writing ${done + 1}/${total}…`, "busy");
  });
  autoBusy = false;
  if (!res.failed.length && !res.aborted) {
    baseline = snapshot;
    setAutoStatus(`Saved ✓ ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`, "ok",
      `${res.sent} packet${res.sent > 1 ? "s" : ""} written`);
  } else {
    const first = res.failed[0];
    setAutoStatus(`Write failed (${res.failed.length}). Click to retry`, "err", first ? `${first.step.label}: ${first.error}` : "Stopped");
    toast(`Auto-write failed: ${first ? first.error : "stopped"}`, "err");
  }
  if (autoPending) { autoPending = false; void autoWriteNow(); }
}
function toggleAutoWrite(on: boolean): void {
  if (on) {
    let acked = false;
    try { acked = localStorage.getItem("cerakey.autoWriteAck") === "1"; } catch { /* storage blocked */ }
    if (!acked && !confirm("Auto-write sends each change to the keyboard as soon as you make it.\n\n" +
      "It only sends what differs from the file as you opened it (or as last written), so it assumes the keyboard " +
      "currently matches that file. If you're not sure, cancel and do one \"Write to keyboard… → The whole file\" first.\n\nTurn on auto-write?")) {
      $<HTMLInputElement>("#autoWrite").checked = false;
      return;
    }
    try { localStorage.setItem("cerakey.autoWriteAck", "1"); } catch { /* storage blocked */ }
  }
  autoWrite = on;
  try { localStorage.setItem("cerakey.autoWrite", on ? "1" : "0"); } catch { /* storage blocked */ }
  refreshAutoStatus();
  if (on) void autoWriteNow(); // send anything already pending
  if (tab === "presets") renderPanel();
}

const SECTIONS: [Section, string][] = [
  ["keymap", "Keymaps (Win + Mac, all layers)"], ["performance", "Actuation / RT"], ["advanced", "Advanced keys"],
  ["lighting", "Lighting"], ["macros", "Macros"],
];
let writing: AbortController | null = null;
let lastLog: string[] = [];

function writeOpts(): { baseline: KeyboardConfig | null; sections: Section[] } {
  const all = ($opt<HTMLInputElement>('input[name="scope"]:checked')?.value ?? "changes") === "all";
  const sections = $$<HTMLInputElement>("#writeBody .secs input:checked").map(x => x.value as Section);
  return { baseline: all ? null : baseline, sections };
}
function planSummaryHtml(steps: Step[]): string {
  if (!steps.length) return `<p class="muted">Nothing to write: the keyboard should already match.</p>`;
  const s = summarize(steps);
  const parts = (Object.entries(s) as [Section, number][]).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`);
  const secs = Math.max(1, Math.round(steps.length * 0.012));
  return `<p><b>${steps.length}</b> packets (${parts.join(", ")}), about ${secs} s.</p>`;
}
function refreshPlan(): void {
  const steps = buildWritePlan(C(), writeOpts());
  $("#planSummary").innerHTML = planSummaryHtml(steps);
  $<HTMLButtonElement>("#writeStart").disabled = !steps.length;
}

function openWriteDialog(): void {
  if (!cfg || !device) return;
  const dlg = $<HTMLDialogElement>("#writeDlg");
  const s = C().system;
  const mismatch = s.vid !== device.vendorId || s.pid !== device.productId;
  $("#writeResult").innerHTML = "";
  $("#writeProgress").hidden = true;
  $("#logBtn").hidden = true;
  $("#writeCancel").textContent = "Close";
  if (mismatch) {
    $("#writeBody").innerHTML = `<div class="warnbox">This file is for VID:PID <b>${s.vid}:${s.pid}</b> but the connected keyboard is
      <b>${device.vendorId}:${device.productId}</b>. Writing is blocked, as in the official editor.</div>`;
    $<HTMLButtonElement>("#writeStart").disabled = true;
    dlg.showModal();
    return;
  }
  const problems = validate();
  $("#writeBody").innerHTML = `
    <p class="muted">Sends the config to <b>${esc(device.name)}</b> the same way lab.cerakey.com's import does. The keyboard keeps the settings after it's unplugged.</p>
    <label class="opt"><input type="radio" name="scope" value="changes" checked>
      <span>Only my changes<small>Everything edited since the file was opened or last written. Assumes the keyboard currently matches that file.</small></span></label>
    <label class="opt"><input type="radio" name="scope" value="all">
      <span>The whole file<small>Rewrites every key, layer, light and macro. Use this if the keyboard might differ from the file.</small></span></label>
    <fieldset><legend>Include</legend><div class="secs">
      ${SECTIONS.map(([v, n]) => `<label><input type="checkbox" value="${v}" checked> ${n}</label>`).join("")}</div></fieldset>
    <div id="planSummary"></div>
    ${problems.length ? `<div class="warnbox">${problems.map(esc).join("<br>")}</div>` : ""}
    <p class="note">Keep the keyboard plugged in until this finishes. Keymaps are written by briefly switching the keyboard between Windows and Mac mode; it's set back to <b>${esc(s.currentKeyboardSystem)}</b> at the end.</p>`;
  $$("#writeBody input").forEach(i => i.addEventListener("change", refreshPlan));
  refreshPlan();
  dlg.showModal();
}

async function startWrite(): Promise<void> {
  if (!cfg || !device || writing) return;
  if (autoBusy) return toast("Auto-write is busy; try again in a moment", "err");
  const steps = buildWritePlan(C(), writeOpts());
  if (!steps.length) return;
  const snapshot = clone(C());
  writing = new AbortController();
  $<HTMLButtonElement>("#writeStart").disabled = true;
  $$<HTMLInputElement>("#writeBody input").forEach(i => (i.disabled = true));
  $("#writeCancel").textContent = "Stop";
  $("#writeResult").innerHTML = "";
  const prog = $("#writeProgress");
  prog.hidden = false;
  lastLog = [`# Peak60 write log ${new Date().toISOString()}`, `# device ${device.vendorId}:${device.productId}`];
  device.onTraffic = (dir, bytes) => lastLog.push(`${dir === "out" ? ">>" : "<<"} ${hex(bytes)}`);
  const res = await runPlan(device, steps, (done, total, step) => {
    ($(".bar", prog) as HTMLElement).style.width = `${(100 * done) / total}%`;
    $(".ptext", prog).textContent = done < total ? `${done}/${total} · ${step.label}` : `${total}/${total} · done`;
    if (done < total) lastLog.push(`# ${step.label}`);
  }, writing.signal);
  device.onTraffic = null;
  writing = null;
  $("#writeCancel").textContent = "Close";
  $("#logBtn").hidden = false;
  if (!res.failed.length && !res.aborted) {
    baseline = snapshot;
    $("#writeResult").innerHTML = `<p class="result-ok">Done: ${res.sent} packets written and acknowledged.</p>`;
    toast("Keyboard updated", "ok");
  } else {
    $("#writeResult").innerHTML = `<p class="result-err">${res.aborted ? "Stopped" : "Finished with errors"}: ${res.sent} sent, ${res.failed.length} failed.
      The keyboard may be partly updated; run "The whole file" again to be sure.</p>
      ${res.failed.length ? `<ul class="faillist">${res.failed.slice(0, 50).map(f => `<li>${esc(f.step.label)}: ${esc(f.error)}</li>`).join("")}</ul>` : ""}`;
  }
  $$<HTMLInputElement>("#writeBody input").forEach(i => (i.disabled = false));
  refreshPlan();
  if (autoPending) { autoPending = false; void autoWriteNow(); } else refreshAutoStatus();
}

// ---------- wiring ----------
function init(): void {
  $<HTMLInputElement>("#fileInput").addEventListener("change", e => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) void openFile(f);
    input.value = "";
  });
  $("#exportBtn").addEventListener("click", exportEncrypted);
  $("#exportPlainBtn").addEventListener("click", exportPlain);
  $("#undoBtn").addEventListener("click", undo);
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) {
      e.preventDefault();
      undo();
    }
  });
  $("#osSeg").addEventListener("click", e => { const b = (e.target as HTMLElement).closest("button"); if (b) { os = b.dataset.os as OsKey; render(); } });
  $("#layerSeg").addEventListener("click", e => { const b = (e.target as HTMLElement).closest("button"); if (b) { layer = Number(b.dataset.layer); render(); } });
  $("#tabs").addEventListener("click", e => { const b = (e.target as HTMLElement).closest("button"); if (b) { tab = b.dataset.tab!; render(); } });
  $("#selAll").addEventListener("click", () => { selected = new Set(LAYOUT.map(p => id(p.r, p.c)).filter(k => keyIndex[k])); render(); });
  $("#selNone").addEventListener("click", () => { selected.clear(); render(); });
  $("#panel").addEventListener("click", onPanelClick);
  const kb = $("#keyboard");
  kb.addEventListener("mousedown", onKeyDown);
  kb.addEventListener("mouseover", onKeyEnter);
  window.addEventListener("mouseup", () => (dragging = false));

  const dz = $("#dropZone");
  (["dragenter", "dragover"] as const).forEach(t => window.addEventListener(t, e => { e.preventDefault(); dz.classList.add("over"); }));
  (["dragleave", "drop"] as const).forEach(t => window.addEventListener(t, e => { e.preventDefault(); dz.classList.remove("over"); }));
  window.addEventListener("drop", e => { const f = e.dataTransfer?.files?.[0]; if (f) void openFile(f); });

  // device
  $("#connectBtn").addEventListener("click", () => void (device ? disconnect() : connect(true)));
  $("#writeBtn").addEventListener("click", openWriteDialog);
  $("#readBtn").addEventListener("click", () => void readFromKeyboard());
  $("#readBtn2").addEventListener("click", () => void readFromKeyboard());
  $("#readClose").addEventListener("click", () => $<HTMLDialogElement>("#readDlg").close());
  $<HTMLDialogElement>("#readDlg").addEventListener("cancel", e => { if (reading) e.preventDefault(); });
  $<HTMLInputElement>("#autoWrite").addEventListener("change", e => toggleAutoWrite((e.target as HTMLInputElement).checked));
  $("#autoStatus").addEventListener("click", () => { if ($("#autoStatus").classList.contains("err")) void autoWriteNow(); });
  $("#writeStart").addEventListener("click", () => void startWrite());
  $("#writeCancel").addEventListener("click", () => { if (writing) writing.abort(); else $<HTMLDialogElement>("#writeDlg").close(); });
  $<HTMLDialogElement>("#writeDlg").addEventListener("cancel", e => { if (writing) e.preventDefault(); });
  $("#logBtn").addEventListener("click", () => download(lastLog.join("\n") + "\n", "peak60-write-log.txt", "text/plain"));
  if (hidSupported()) {
    navigator.hid.addEventListener("disconnect", e => { if (device && e.device === device.hid) { device = null; updateDeviceUi(); toast("Keyboard disconnected", "err"); } });
    void connect(false); // reconnect silently if permission was granted before
  }
  updateDeviceUi();
  updatePassphraseUi();
}
init();
