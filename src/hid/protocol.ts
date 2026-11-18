// Peak60 / Cerakey HID protocol: 64-byte output reports with report ID 0.
// Byte 0 = command category, byte 1 = sub-command. Reverse-engineered from the
// lab.cerakey.com bundle (see FORMAT.md, "HID protocol"); every builder here
// mirrors the official one byte for byte.
//
// Only the commands needed to write a config are implemented. Firmware upgrade,
// factory reset, calibration and the other dangerous commands are deliberately
// absent, and assertSafe() refuses them even if someone builds one by hand.

import type { AdvancedKeys, LightBase, MacroAction, Performance, Rgb } from "../types";

export const REPORT_SIZE = 64;

export const Cat = {
  Device: 1,
  Global: 2,
  LayoutAndKey: 3,
  Performance: 4,
  Lighting: 5,
  HigherKey: 6,
  Macro: 7,
} as const;

const GLOBAL_SYSTEM_SETTING = 4;
const RW_WRITE = 2;
const KEY_SET_KEYCODE = 4;
const PERF_SET = 2;
const LIGHT_AREA_KEYBOARD = 0;
const LIGHT_CONFIG_BASE = 0;
const LIGHT_PROTOCOL_CUSTOM = 4;
const MACRO_SET_MODE = 2;
const MACRO_SET_DATA = 4;

const RW_READ = 1;
const GLOBAL_DOUBLE_LIGHTING_QUERY = 10;
const KEY_GET_LAYOUT = 1;
const KEY_GET_DEFAULT_LAYOUT = 6;
const PERF_GET = 1;
const LIGHT_PROTOCOL_READBACK = 3;
const MACRO_GET_MODE = 1;
const MACRO_GET_DATA = 3;

/** Category -> allowed sub-commands. Anything else is refused before it reaches the device. */
const ALLOWED: Record<number, number[]> = {
  [Cat.Device]: [1, 2, 3], // protocol / info / feature queries (read-only)
  [Cat.Global]: [GLOBAL_SYSTEM_SETTING, GLOBAL_DOUBLE_LIGHTING_QUERY], // Win/Mac mode (read + write), lamp-type query
  [Cat.LayoutAndKey]: [KEY_GET_LAYOUT, KEY_SET_KEYCODE, KEY_GET_DEFAULT_LAYOUT],
  [Cat.Performance]: [PERF_GET, PERF_SET],
  [Cat.Lighting]: [RW_READ, RW_WRITE, LIGHT_PROTOCOL_READBACK, LIGHT_PROTOCOL_CUSTOM],
  [Cat.HigherKey]: [RW_READ, RW_WRITE],
  [Cat.Macro]: [MACRO_GET_MODE, MACRO_SET_MODE, MACRO_GET_DATA, MACRO_SET_DATA],
};

export function assertSafe(p: Uint8Array): void {
  if (p.length !== REPORT_SIZE) throw new Error(`Packet must be ${REPORT_SIZE} bytes, got ${p.length}`);
  const subs = ALLOWED[p[0]];
  if (!subs || !subs.includes(p[1])) {
    throw new Error(`Refusing to send command ${p[0]}/${p[1]}: not on the editor's allowlist`);
  }
}

const u16 = (v: number): [number, number] => {
  const n = Math.trunc(v) & 0xffff;
  return [n & 255, (n >> 8) & 255];
};
/** mm -> µm, rounded like the official decimal.js multiply(…, 1000).toFixed(3). */
const um = (mm: number | undefined): [number, number] => u16(Math.round((mm ?? 0) * 1000));

export function packet(bytes: number[]): Uint8Array {
  if (bytes.length > REPORT_SIZE) throw new Error(`Payload too long (${bytes.length} > ${REPORT_SIZE})`);
  const out = new Uint8Array(REPORT_SIZE);
  bytes.forEach((b, i) => (out[i] = b & 255));
  return out;
}

// ---------- device info (read-only) ----------
export const getDeviceProtocol = (): Uint8Array => packet([Cat.Device, 1]);
export const getDeviceInfo = (): Uint8Array => packet([Cat.Device, 2]);

export function parseDeviceInfo(t: Uint8Array): { type: number; subType: number; appVersion: string; sn: string } {
  return {
    type: t[2],
    subType: t[3],
    appVersion: Array.from(t.slice(8, 12)).join("."),
    sn: Array.from(t.slice(17, 29)).join(""),
  };
}

// ---------- global ----------
export const setSystemType = (os: "WIN" | "MAC"): Uint8Array =>
  packet([Cat.Global, GLOBAL_SYSTEM_SETTING, RW_WRITE, os === "MAC" ? 1 : 0]);

// ---------- keymap ----------
/** layer 0-3 = fn0-fn3 of whichever OS was last selected with setSystemType. */
export const setKeyCode = (layer: number, row: number, col: number, keycode: number): Uint8Array =>
  packet([Cat.LayoutAndKey, KEY_SET_KEYCODE, layer, row, col, ...u16(keycode)]);

// ---------- performance ----------
export function setPerformance(row: number, col: number, p: Performance): Uint8Array {
  return packet([
    Cat.Performance, PERF_SET, row, col, p.mode ?? 0,
    ...um(p.normalPress), ...um(p.normalRelease), ...um(p.rtFirstTouch), ...um(p.rtPress), ...um(p.rtRelease),
    ...um(p.pressDeadStroke), ...um(p.releaseDeadStroke),
    p.axis || 0,
    0, // calibrate: the official import always sends 0
    ...u16(p.axisV2Id || 0), ...u16(p.axisRangeMax || 0), ...u16(p.axisCoefficient || 0),
  ]);
}

// ---------- lighting ----------
const DIRECTION: Record<string, number> = { Forward: 0, Backward: 1 };
const DOUBLE_OPEN: Record<string, number> = { Close: 0, OpenDown: 1, OpenUp: 2, Open: 3 };

export function setLightingBase(light: LightBase, lamp = "SingleLighting"): Uint8Array {
  const open = lamp === "DoubleLighting" ? (DOUBLE_OPEN[light.open] ?? 0) : light.open === "Open" ? 1 : 0;
  return packet([
    Cat.Lighting, RW_WRITE, LIGHT_AREA_KEYBOARD, LIGHT_CONFIG_BASE,
    open, light.mode, light.luminance, light.speed, DIRECTION[light.direction] ?? 0, light.selectStaticColor,
  ]);
}

/** Per-key colours, 15 keys per packet over the flattened 6x21 grid (pages 0-8). */
export function setLightingCustomPage(grid: Rgb[][], page: number): Uint8Array {
  const flat = grid.flat().slice(page * 15, page * 15 + 15);
  const bytes = [Cat.Lighting, LIGHT_PROTOCOL_CUSTOM, LIGHT_AREA_KEYBOARD, page];
  for (const c of flat) bytes.push(c.B, c.G, c.R, c.isCustom ? 255 : 0);
  return packet(bytes);
}
export const lightingPageCount = (grid: Rgb[][]): number => Math.ceil(grid.flat().length / 15);

// ---------- macros ----------
export function setMacroMode(m: { macroId: number; valid: boolean; actNum: number; repNum: number; mode: number }): Uint8Array {
  return packet([Cat.Macro, MACRO_SET_MODE, m.macroId, m.valid ? 1 : 0, ...u16(m.actNum), ...u16(m.repNum), m.mode]);
}

export function encodeMacroAction(a: MacroAction): number[] {
  if (a.delay > 32767 || a.delay < 0) throw new Error("Macro delay must be 0-32767 ms");
  if (a.keyCode > 65535 || a.keyCode < 0) throw new Error("Macro keycode must be 0-65535");
  const f = (((a.status === 1 ? 1 : 0) << 31) | (a.delay << 16) | (a.keyCode & 0xffff)) >>> 0;
  return [f & 255, (f >>> 8) & 255, (f >>> 16) & 255, (f >>> 24) & 255];
}

/** Up to 15 actions per packet; `offset` is the chunk index. */
export function setMacroData(macroId: number, offset: number, actions: MacroAction[]): Uint8Array {
  if (actions.length > 15) throw new Error("At most 15 macro actions per packet");
  return packet([Cat.Macro, MACRO_SET_DATA, macroId, offset, ...actions.flatMap(encodeMacroAction)]);
}

// ---------- advanced keys ----------
const head = (row: number, col: number, type: number): number[] => [Cat.HigherKey, RW_WRITE, row, col, type];

/**
 * Packets for one key's advanced binding, converted from the config-file shape the
 * same way the official import does. SOCD and RS return two packets (one per key).
 */
export function setAdvancedKey(row: number, col: number, adv: AdvancedKeys | undefined): Uint8Array[] {
  const t = Number(adv?.advancedType);
  if (!adv || !Number.isInteger(t) || t < 1 || t > 7) return [packet(head(row, col, 0))];
  const need = <T>(v: T | null | undefined, name: string): T => {
    if (v == null) throw new Error(`Key r${row} c${col}: advancedType ${t} needs "${name}" data`);
    return v;
  };
  const kc = (a: number[] | undefined, n: number): number[] => Array.from({ length: n }, (_, i) => a?.[i] ?? 0);
  switch (t) {
    case 1: { // DKS
      const d = need(adv.dks, "dks");
      return [packet([...head(row, col, 1), ...kc(d.dks, 4).flatMap(u16), ...kc(d.trps, 4), ...um(d.db), ...um(d.db2)])];
    }
    case 2: { // MPT
      const d = need(adv.mpt, "mpt");
      return [packet([...head(row, col, 2), ...kc(d.dks, 3).flatMap(u16), ...kc(d.dbs, 3).flatMap(v => um(v))])];
    }
    case 3: { // MT (mod-tap)
      const d = need(adv.mt, "mt").mt;
      return [packet([...head(row, col, 3), ...kc(d.dksAll, 2).flatMap(u16), ...u16(d.delay)])];
    }
    case 4: { // TGL. The official import passes `delay` where the builder reads `time`
      // and so always sends 0; this sends the stored delay instead.
      const d = need(adv.tgl, "tgl").tgl;
      return [packet([...head(row, col, 4), ...u16(d.kc), ...u16(d.delay)])];
    }
    case 5: { // END
      const d = need(adv.end, "end").end;
      return [packet([...head(row, col, 5), ...kc(d.dks, 2).flatMap(u16), ...u16(d.delay)])];
    }
    case 6: { // SOCD: one packet per key, keycodes swapped, priority mode mirrored
      const s = need(adv.socd, "socd");
      const d = s.socd;
      const [k0, k1] = [u16(d.kcs?.[0] ?? 0), u16(d.kcs?.[1] ?? 0)];
      const modes: Record<number, [number, number]> = { 0: [0, 0], 1: [1, 2], 2: [2, 1], 3: [3, 3] };
      const [m0, m1] = modes[s.socdMode] ?? [0, 0];
      return [
        packet([...head(row, col, 6), d.row2, d.col2, ...k0, ...k1, ...u16(d.delay), m0]),
        packet([...head(d.row2, d.col2, 6), row, col, ...k1, ...k0, ...u16(d.delay), m1]),
      ];
    }
    case 7: { // RS
      const d = need(adv.rs, "rs").rs;
      const [k0, k1] = [u16(d.kcs?.[0] ?? 0), u16(d.kcs?.[1] ?? 0)];
      return [
        packet([...head(row, col, 7), d.row2, d.col2, ...k0, ...k1, ...u16(d.delay)]),
        packet([...head(d.row2, d.col2, 7), row, col, ...k1, ...k0, ...u16(d.delay)]),
      ];
    }
  }
  return [packet(head(row, col, 0))];
}

// =====================================================================================
// Reading. Every reply echoes the request's first bytes, and its payload uses the same
// layout as the matching write packet. Parsers mirror the official *Result/*Data functions.
// =====================================================================================

const le16 = (t: Uint8Array, i: number): number => t[i] | (t[i + 1] << 8);
const mm = (t: Uint8Array, i: number): number => Math.round(le16(t, i)) / 1000;
/** Keycodes from a row reply: 30 u16 slots from byte 4, of which the first 21 are columns. */
const rowCodes = (t: Uint8Array): number[] => Array.from({ length: 21 }, (_, i) => le16(t, 4 + 2 * i));

export const getSystemType = (): Uint8Array => packet([Cat.Global, GLOBAL_SYSTEM_SETTING, RW_READ]);
export const parseSystemType = (t: Uint8Array): "WIN" | "MAC" => (t[3] === 1 ? "MAC" : "WIN");

export const getDoubleLighting = (): Uint8Array => packet([Cat.Global, GLOBAL_DOUBLE_LIGHTING_QUERY, 0]);
export const parseDoubleLighting = (t: Uint8Array): boolean => t[3] === 1;

/** One matrix row of one layer, for the currently active OS mode. */
export const getKeyLayout = (layer: number, row: number): Uint8Array => packet([Cat.LayoutAndKey, KEY_GET_LAYOUT, layer, row]);
export const parseKeyLayout = (t: Uint8Array): { layer: number; row: number; codes: number[] } => ({ layer: t[2], row: t[3], codes: rowCodes(t) });

/** Factory keycodes for one row; doesn't depend on the active OS mode. */
export const getDefaultKeyLayout = (os: "WIN" | "MAC", layer: number, row: number): Uint8Array =>
  packet([Cat.LayoutAndKey, KEY_GET_DEFAULT_LAYOUT, ((os === "MAC" ? 1 : 0) << 4) | layer, row]);
export const parseDefaultKeyLayout = (t: Uint8Array): { os: "WIN" | "MAC"; layer: number; row: number; codes: number[] } =>
  ({ os: t[2] >> 4 === 1 ? "MAC" : "WIN", layer: t[2] & 15, row: t[3], codes: rowCodes(t) });

export const getPerformance = (row: number, col: number): Uint8Array => packet([Cat.Performance, PERF_GET, row, col]);
export function parsePerformance(t: Uint8Array): Pick<Performance,
  "mode" | "normalPress" | "normalRelease" | "rtFirstTouch" | "rtPress" | "rtRelease" | "pressDeadStroke" | "releaseDeadStroke" |
  "axis" | "calibrate" | "axisV2Id" | "axisRangeMax" | "axisCoefficient"> {
  return {
    mode: t[4], normalPress: mm(t, 5), normalRelease: mm(t, 7), rtFirstTouch: mm(t, 9), rtPress: mm(t, 11), rtRelease: mm(t, 13),
    pressDeadStroke: mm(t, 15), releaseDeadStroke: mm(t, 17), axis: t[19], calibrate: t[20],
    axisV2Id: le16(t, 21), axisRangeMax: le16(t, 23), axisCoefficient: le16(t, 25),
  };
}

export const getAdvancedKey = (row: number, col: number): Uint8Array => packet([Cat.HigherKey, RW_READ, row, col, 0]);
/** Converts a reply into the config-file shape, as the official getDks/getMpt/… do. */
export function parseAdvancedKey(t: Uint8Array): AdvancedKeys {
  const base: AdvancedKeys = { advancedType: "", value: 0, dks: null, mpt: null, mt: null, tgl: null, end: null, socd: null, macro: null };
  const kcs = (from: number, n: number) => Array.from({ length: n }, (_, i) => le16(t, from + 2 * i));
  switch (t[4]) {
    case 1: return { ...base, advancedType: 1, dks: { dks: kcs(5, 4), trps: [t[13], t[14], t[15], t[16]], db: mm(t, 17), db2: mm(t, 19) } };
    case 2: return { ...base, advancedType: 2, mpt: { dks: kcs(5, 3), dbs: [mm(t, 11), mm(t, 13), mm(t, 15)] } };
    case 3: return { ...base, advancedType: 3, mt: { mt: { delay: le16(t, 9), dksAll: kcs(5, 2) } } };
    case 4: return { ...base, advancedType: 4, tgl: { tgl: { kc: le16(t, 5), delay: le16(t, 7) } } };
    case 5: return { ...base, advancedType: 5, end: { end: { dks: kcs(5, 2), delay: le16(t, 9) } } };
    case 6: return { ...base, advancedType: 6, socd: { socd: { row2: t[5], col2: t[6], kcs: kcs(7, 2), delay: le16(t, 11) }, socdMode: t[13] } };
    case 7: return { ...base, advancedType: 7, rs: { rs: { row2: t[5], col2: t[6], kcs: kcs(7, 2), delay: le16(t, 11) } } };
    default: return base;
  }
}

export const getLightingBase = (): Uint8Array => packet([Cat.Lighting, RW_READ, LIGHT_AREA_KEYBOARD, LIGHT_CONFIG_BASE]);
export function parseLightingBase(t: Uint8Array, lamp = "SingleLighting"): LightBase {
  const dbl = Object.keys(DOUBLE_OPEN).find(k => DOUBLE_OPEN[k] === t[4]);
  return {
    area: "Keyboard",
    open: lamp === "DoubleLighting" ? (dbl ?? "Open") : t[4] === 0 ? "Close" : "Open",
    mode: t[5], luminance: t[6], speed: t[7], direction: t[8] === 1 ? "Backward" : "Forward", selectStaticColor: t[9],
  };
}

export const getLightingCustomPage = (page: number): Uint8Array => packet([Cat.Lighting, LIGHT_PROTOCOL_READBACK, LIGHT_AREA_KEYBOARD, page]);
export function parseLightingCustomPage(t: Uint8Array): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 4; i + 3 < 64; i += 4) out.push({ R: t[i + 2], G: t[i + 1], B: t[i], isCustom: t[i + 3] === 255 });
  return out;
}

export const getMacroMode = (macroId: number): Uint8Array => packet([Cat.Macro, MACRO_GET_MODE, macroId]);
export const parseMacroMode = (t: Uint8Array): { macroId: number; valid: boolean; actNum: number; repNum: number; mode: number } =>
  ({ macroId: t[2], valid: t[3] === 1, actNum: le16(t, 4), repNum: le16(t, 6), mode: t[8] });

export const getMacroData = (macroId: number, offset: number): Uint8Array => packet([Cat.Macro, MACRO_GET_DATA, macroId, offset]);
export function parseMacroData(t: Uint8Array): MacroAction[] {
  const out: MacroAction[] = [];
  for (let i = 4; i + 3 < 64; i += 4) {
    const v = (t[i] | (t[i + 1] << 8) | (t[i + 2] << 16) | (t[i + 3] << 24)) >>> 0;
    out.push({ status: (v >>> 31) & 1, delay: (v >>> 16) & 32767, keyCode: v & 65535 });
  }
  return out;
}
