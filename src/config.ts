// Layout, keycode labels and config accessors shared by the UI and the HID writer.
import { KEYCODES } from "./keycodes";
import type { AdvancedKeys, KeyConfig, KeyboardConfig, KeySlot, KeycodeValue, LayerKey, OsKey, Performance, Rgb } from "./types";

export interface LayoutKey {
  r: number;
  c: number;
  x: number;
  y: number;
  w: number;
}

/** Peak60 61-key ANSI: matrix row/col -> position in key units. Row 0 and cols 14-20 are unused. */
export const LAYOUT: LayoutKey[] = (() => {
  const rows: [number, [number, number][]][] = [
    [1, [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [13, 2]]],
    [2, [[0, 1.5], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [13, 1.5]]],
    [3, [[0, 1.75], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1], [13, 2.25]]],
    [4, [[0, 2.25], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1], [13, 2.75]]],
    [5, [[0, 1.25], [1, 1.25], [2, 1.25], [6, 6.25], [10, 1.25], [11, 1.25], [12, 1.25], [13, 1.25]]],
  ];
  const out: LayoutKey[] = [];
  rows.forEach(([r, keys], y) => {
    let x = 0;
    for (const [c, w] of keys) {
      out.push({ r, c, x, y, w });
      x += w;
    }
  });
  return out;
})();

export const ADV_TYPES: Record<number, string> = { 1: "DKS", 2: "MPT", 3: "MT", 4: "TGL", 5: "END", 6: "SOCD", 7: "RS" };
export const EMPTY_ADV: AdvancedKeys = {
  advancedType: "", value: 0, dks: null, mpt: null, mt: null, tgl: null, end: null, socd: null, macro: null,
};
/** Names from the official bundle's lighting enum; the Peak60 may not use all of them. */
export const LIGHT_MODES: Record<number, string> = {
  0: "Static / off", 1: "Ripple", 2: "Ebb & flow", 3: "Ripple gently", 4: "Rotating storm", 5: "Lucky rainbow",
  6: "Shining rainbow", 7: "Shining", 8: "Moving window", 9: "Wave transformation", 10: "Shift", 11: "Sine curve",
  12: "Cloud flow", 13: "Blooming", 14: "Rainbow", 15: "Rainfall", 16: "Jump",
};
export const MACRO_MODES = [
  "Click: repeat N times (re-click ignored)",
  "Click: repeat N times (re-click restarts)",
  "Click: repeat N times (re-click stops now)",
  "Click: repeat N times (re-click stops after current)",
  "Hold: repeat, release: stop now",
  "Hold: repeat, release: stop after current",
];
export const MOD_BITS: [string, number][] = [["Ctrl", 1], ["Shift", 2], ["Alt", 4], ["Win/Cmd", 8]];
export const FN1 = 61697;
export const MACRO_BASE = 62720;

export const id = (r: number, c: number): string => `${r}-${c}`;

export function codeOf(v: KeycodeValue | null | undefined): number {
  if (v && typeof v === "object") return v.keycode ?? 0;
  return typeof v === "number" ? v : 0;
}

export const layerKey = (layer: number): LayerKey => `fn${layer}` as LayerKey;

export function slot(key: KeyConfig | undefined, os: OsKey, layer: number): KeySlot | undefined {
  return key?.customKeys?.[os]?.[layerKey(layer)];
}
export function bindOf(key: KeyConfig | undefined, os: OsKey, layer: number): number | null {
  const s = slot(key, os, layer);
  return s ? codeOf(s.bindKeyValue) : null;
}
export function defaultOf(key: KeyConfig | undefined, os: OsKey, layer: number): number | null {
  const s = slot(key, os, layer);
  return s ? codeOf(s.defaultKeycode) : null;
}
export function activeOs(cfg: KeyboardConfig | null): OsKey {
  return String(cfg?.system?.currentKeyboardSystem || "WIN").toLowerCase() === "mac" ? "mac" : "win";
}

export const isCombo = (code: number): boolean => code > 4096 && code < 8192;
export function comboParts(code: number): { mods: string[]; key: number } {
  const t = code - 4096;
  const m = (t >> 8) & 255;
  return { mods: MOD_BITS.filter(([, b]) => m & b).map(([n]) => n), key: t & 255 };
}
export function label(code: number | null): string {
  if (code == null) return "?";
  if (isCombo(code)) {
    const p = comboParts(code);
    return p.mods.map(m => m.split("/")[0]).join("+") + "+" + (KEYCODES[p.key]?.l ?? String(p.key));
  }
  return KEYCODES[code]?.l ?? "0x" + code.toString(16).toUpperCase();
}
export function describe(code: number | null): string {
  if (code == null) return "";
  if (isCombo(code)) return "Combo: " + label(code);
  return KEYCODES[code]?.d ?? `Unknown code ${code}`;
}

export function advTypeNum(key: KeyConfig | undefined): number {
  const t = Number(key?.advancedKeys?.advancedType);
  return Number.isInteger(t) && ADV_TYPES[t] ? t : 0;
}
export const advType = (key: KeyConfig | undefined): string | null => ADV_TYPES[advTypeNum(key)] ?? null;
export const isRT = (pf: Performance | undefined): boolean => !!(pf && (pf.isRt || pf.mode === 1));

export function lightArea(cfg: KeyboardConfig): string | undefined {
  const areas = Object.keys(cfg.v2light || {});
  return areas.includes("Keyboard") ? "Keyboard" : areas[0];
}
export function keyColor(cfg: KeyboardConfig, key: KeyConfig | undefined, r: number, c: number): Rgb | null {
  const area = lightArea(cfg);
  const v = (area ? cfg.v2light[area]?.customLight?.[r]?.[c] : undefined) ?? key?.customLight;
  return v && v.isCustom ? v : null;
}

/** Keeps macro bookkeeping fields consistent with its action list. */
export function macroFix(m: { data: unknown[]; actNum: number; valid: boolean; repNum: number }): void {
  m.data ||= [];
  m.actNum = m.data.length;
  m.valid = m.data.length > 0;
  if (!m.repNum) m.repNum = 1;
}
