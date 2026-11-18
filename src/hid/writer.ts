// Turns a config into the ordered list of packets that writes it to the keyboard,
// following the official importConfiguration flow (performance, Win and Mac keymaps,
// advanced keys, then lighting, then macros). Pure and testable: nothing here talks
// to the device. runPlan() sends a plan through a KeyboardDevice.
import { codeOf, layerKey, lightArea } from "../config";
import type { KeyConfig, KeyboardConfig, Macro, OsKey, Performance } from "../types";
import type { KeyboardDevice } from "./device";
import * as P from "./protocol";

export type Section = "system" | "performance" | "keymap" | "advanced" | "lighting" | "macros";

export interface Step {
  section: Section;
  label: string;
  packet: Uint8Array;
}

export interface PlanOptions {
  /** If given, only things that differ from it are written. */
  baseline?: KeyboardConfig | null;
  sections?: Section[];
}

const ALL: Section[] = ["performance", "keymap", "advanced", "lighting", "macros"];
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const perfWire = (p: Performance) => Array.from(P.setPerformance(0, 0, p));
const wire = (ps: Uint8Array[]) => ps.map(x => Array.from(x));
const OS_LIST: [OsKey, "WIN" | "MAC"][] = [["win", "WIN"], ["mac", "MAC"]];

export function buildWritePlan(cfg: KeyboardConfig, opts: PlanOptions = {}): Step[] {
  const base = opts.baseline ?? null;
  const want = new Set(opts.sections ?? ALL);
  const keys = cfg.keyboards.flat();
  const baseKeys = new Map<string, KeyConfig>((base?.keyboards.flat() ?? []).map(k => [`${k.row}-${k.col}`, k]));
  const steps: Step[] = [];
  const at = (k: KeyConfig) => `r${k.row} c${k.col}`;

  if (want.has("performance")) {
    for (const k of keys) {
      const b = baseKeys.get(`${k.row}-${k.col}`);
      if (b && same(perfWire(b.performance), perfWire(k.performance))) continue;
      steps.push({ section: "performance", label: `Actuation ${at(k)}`, packet: P.setPerformance(k.row, k.col, k.performance) });
    }
  }

  if (want.has("keymap")) {
    // The keymap packet has no OS field: it writes to whichever OS mode is active,
    // so switch mode, write that OS's four layers, then restore the file's OS.
    let switched = false;
    for (const [os, sys] of OS_LIST) {
      const layerSteps: Step[] = [];
      for (const k of keys) {
        const b = baseKeys.get(`${k.row}-${k.col}`);
        for (let layer = 0; layer < 4; layer++) {
          const s = k.customKeys?.[os]?.[layerKey(layer)];
          if (!s) continue;
          const code = codeOf(s.bindKeyValue);
          const bs = b?.customKeys?.[os]?.[layerKey(layer)];
          if (bs && codeOf(bs.bindKeyValue) === code) continue; // compare keycodes: files mix 5 and {keycode: 5}
          layerSteps.push({ section: "keymap", label: `${sys} Fn${layer} ${at(k)}`, packet: P.setKeyCode(layer, k.row, k.col, code) });
        }
      }
      if (layerSteps.length) {
        steps.push({ section: "system", label: `Switch to ${sys} mode`, packet: P.setSystemType(sys) });
        steps.push(...layerSteps);
        switched = true;
      }
    }
    const cur = String(cfg.system.currentKeyboardSystem).toUpperCase() === "MAC" ? "MAC" : "WIN";
    if (switched || (base && !same(base.system.currentKeyboardSystem, cfg.system.currentKeyboardSystem))) {
      steps.push({ section: "system", label: `Restore ${cur} mode`, packet: P.setSystemType(cur) });
    }
  }

  if (want.has("advanced")) {
    for (const k of keys) {
      const b = baseKeys.get(`${k.row}-${k.col}`);
      const pk = P.setAdvancedKey(k.row, k.col, k.advancedKeys);
      // Compare encoded packets: files and keyboard reads shape the same binding differently.
      if (b && same(wire(P.setAdvancedKey(b.row, b.col, b.advancedKeys)), wire(pk))) continue;
      pk.forEach((packet, i) => steps.push({ section: "advanced", label: `Advanced ${at(k)}${pk.length > 1 ? ` (${i + 1}/2)` : ""}`, packet }));
    }
  }

  if (want.has("lighting")) {
    const area = lightArea(cfg);
    const L = area ? cfg.v2light[area] : undefined;
    const bL = area && base ? base.v2light?.[area] : undefined;
    if (L?.light && (!bL?.light || !same(wire([P.setLightingBase(bL.light, bL.lamp)]), wire([P.setLightingBase(L.light, L.lamp)])))) {
      steps.push({ section: "lighting", label: "Lighting effect", packet: P.setLightingBase(L.light, L.lamp) });
    }
    if (L?.customLight) {
      for (let page = 0; page < P.lightingPageCount(L.customLight); page++) {
        const pk = P.setLightingCustomPage(L.customLight, page);
        if (bL?.customLight && same(Array.from(P.setLightingCustomPage(bL.customLight, page)), Array.from(pk))) continue;
        steps.push({ section: "lighting", label: `Key colours ${page + 1}/${P.lightingPageCount(L.customLight)}`, packet: pk });
      }
    }
  }

  if (want.has("macros")) {
    const baseMacros = new Map<number, Macro>((base?.macro?.v2list ?? []).map(m => [m.macroId, m]));
    for (const m of cfg.macro?.v2list ?? []) {
      const b = baseMacros.get(m.macroId);
      if (b && same(b, { ...m, name: b.name })) continue; // names aren't stored on the device
      steps.push({ section: "macros", label: `Macro M${m.macroId} settings`, packet: P.setMacroMode(m) });
      const data = m.data ?? [];
      for (let off = 0; off * 15 < data.length; off++) {
        steps.push({ section: "macros", label: `Macro M${m.macroId} actions ${off + 1}`, packet: P.setMacroData(m.macroId, off, data.slice(off * 15, off * 15 + 15)) });
      }
    }
  }
  return steps;
}

export function summarize(steps: Step[]): Record<Section, number> {
  const out = { system: 0, performance: 0, keymap: 0, advanced: 0, lighting: 0, macros: 0 } as Record<Section, number>;
  for (const s of steps) out[s.section]++;
  return out;
}

export interface RunResult {
  sent: number;
  failed: { step: Step; error: string }[];
  aborted: boolean;
}

/** Sends every step in order. A failed step is recorded and the rest still run, as in the official import. */
export async function runPlan(
  dev: KeyboardDevice,
  steps: Step[],
  onProgress: (done: number, total: number, step: Step) => void,
  signal?: AbortSignal,
): Promise<RunResult> {
  const res: RunResult = { sent: 0, failed: [], aborted: false };
  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted) { res.aborted = true; break; }
    onProgress(i, steps.length, steps[i]);
    try {
      await dev.send(steps[i].packet);
      res.sent++;
    } catch (e) {
      res.failed.push({ step: steps[i], error: (e as Error).message });
      if (res.failed.length >= 5 && res.sent === 0) { res.aborted = true; break; } // keyboard not answering at all
    }
  }
  if (steps.length) onProgress(steps.length, steps.length, steps[steps.length - 1]);
  return res;
}
