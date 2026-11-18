// Reads the keyboard's full configuration into the same shape lab.cerakey.com exports,
// following the official client's read flow (keymaps for both OSes, factory defaults,
// per-key performance, advanced keys, lighting, macros).
import { LAYOUT } from "../config";
import type { KeyConfig, KeyboardConfig, Macro, Rgb } from "../types";
import type { KeyboardDevice } from "./device";
import * as P from "./protocol";

export interface Sender {
  send(p: Uint8Array): Promise<Uint8Array>;
}

const ROWS = 6, COLS = 21, LAYERS = 4, MACROS = 16;

/** Sends a read and checks the reply echoes the request header; retries a mismatched reply twice. */
async function request(dev: Sender, p: Uint8Array, echo = 2): Promise<Uint8Array> {
  let last: Uint8Array | null = null;
  for (let i = 0; i < 3; i++) {
    last = await dev.send(p);
    if (Array.from(p.slice(0, echo)).every((b, j) => last![j] === b)) return last;
  }
  const h = (u: Uint8Array) => Array.from(u.slice(0, 4), x => x.toString(16).padStart(2, "0")).join(" ");
  throw new Error(`Unexpected reply to ${h(p)}: got ${h(last!)}`);
}

function emptyKey(row: number, col: number): KeyConfig {
  const slot = () => ({ keyValue: -1, bindKeyValue: 0, defaultKeycode: 0 });
  const layers = () => ({ fn0: slot(), fn1: slot(), fn2: slot(), fn3: slot() });
  return {
    col, row, keyValue: 0,
    customLight: { R: 0, G: 0, B: 0, isCustom: false },
    performance: {
      isGlobalTriggering: true, globalTriggeringValue: 0, isRt: false, isSingle: false,
      normalPress: 0, normalRelease: 0, rtFirstTouch: 0, rtPress: 0, rtRelease: 0, axis: 0, mode: 0,
      pressDeadStroke: 0, releaseDeadStroke: 0, advancedKeyMode: 0, calibrationData: 0, calibrations: null,
      calibrate: 0, travels: 0, axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0,
    },
    advancedKeys: { advancedType: "", value: 0, dks: null, mpt: null, mt: null, tgl: null, end: null, socd: null, macro: null },
    customKeys: { win: layers(), mac: layers() },
  };
}

export interface DeviceIdentity {
  vendorId: number;
  productId: number;
  productName: string;
  usagePage?: number;
  usage?: number;
}

export async function readConfig(
  dev: Sender,
  id: DeviceIdentity,
  onProgress: (done: number, total: number, what: string) => void = () => undefined,
): Promise<KeyboardConfig> {
  const total = 2 + 1 + 2 * LAYERS * ROWS + 2 + 2 * LAYERS * ROWS + 2 * LAYOUT.length + 2 + 9 + MACROS;
  let done = 0;
  const step = async (p: Uint8Array, what: string, echo = 2) => {
    onProgress(done, total, what);
    const r = await request(dev, p, echo);
    done++;
    return r;
  };

  // device info
  const pv = await step(P.getDeviceProtocol(), "Device info");
  const di = P.parseDeviceInfo(await step(P.getDeviceInfo(), "Device info"));
  const original = P.parseSystemType(await step(P.getSystemType(), "Current OS mode"));

  const keys: KeyConfig[][] = Array.from({ length: ROWS }, (_, r) => Array.from({ length: COLS }, (_, c) => emptyKey(r, c)));

  // Keymaps. The layout read returns whatever OS mode is active, so read the current one,
  // switch to the other, read it, then switch back (the official client does the same).
  const order: ("WIN" | "MAC")[] = original === "WIN" ? ["WIN", "MAC"] : ["MAC", "WIN"];
  try {
    for (const [i, sys] of order.entries()) {
      if (i > 0) await step(P.setSystemType(sys), `Switch to ${sys} mode`);
      const os = sys === "MAC" ? "mac" : "win";
      for (let layer = 0; layer < LAYERS; layer++) {
        for (let row = 0; row < ROWS; row++) {
          const res = P.parseKeyLayout(await step(P.getKeyLayout(layer, row), `${sys} Fn${layer} row ${row + 1}`, 4));
          res.codes.forEach((code, col) => (keys[row][col].customKeys[os][`fn${layer}` as "fn0"].bindKeyValue = code));
        }
      }
    }
  } finally {
    await step(P.setSystemType(original), `Restore ${original} mode`).catch(() => undefined);
  }

  // factory defaults
  for (const sys of ["WIN", "MAC"] as const) {
    const os = sys === "MAC" ? "mac" : "win";
    for (let layer = 0; layer < LAYERS; layer++) {
      for (let row = 0; row < ROWS; row++) {
        const res = P.parseDefaultKeyLayout(await step(P.getDefaultKeyLayout(sys, layer, row), `Factory keymap ${sys} Fn${layer}`, 4));
        res.codes.forEach((code, col) => (keys[row][col].customKeys[os][`fn${layer}` as "fn0"].defaultKeycode = code));
      }
    }
  }
  const cur = original === "MAC" ? "mac" : "win";
  for (const row of keys) for (const k of row) k.keyValue = k.customKeys[cur].fn0.bindKeyValue as number;

  // Performance and advanced keys for every physical key (by layout, not by keycode, so a
  // key you've bound to "None" still keeps its actuation).
  for (const { r, c } of LAYOUT) {
    const pf = P.parsePerformance(await step(P.getPerformance(r, c), `Actuation r${r} c${c}`));
    Object.assign(keys[r][c].performance, pf, { isRt: pf.mode === 1 });
  }
  for (const { r, c } of LAYOUT) {
    keys[r][c].advancedKeys = P.parseAdvancedKey(await step(P.getAdvancedKey(r, c), `Advanced key r${r} c${c}`, 4));
  }

  // lighting
  let lamp = "SingleLighting";
  try {
    if (P.parseDoubleLighting(await step(P.getDoubleLighting(), "Lighting type"))) lamp = "DoubleLighting";
  } catch { done++; /* older firmware: single lighting */ }
  const light = P.parseLightingBase(await step(P.getLightingBase(), "Lighting effect", 3), lamp);
  const colours: Rgb[] = [];
  for (let page = 0; page < 9; page++) {
    colours.push(...P.parseLightingCustomPage(await step(P.getLightingCustomPage(page), `Key colours ${page + 1}/9`)));
  }
  const grid: Rgb[][] = Array.from({ length: ROWS }, (_, r) => colours.slice(r * COLS, r * COLS + COLS));
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) keys[r][c].customLight = { ...grid[r][c] };

  // macros
  const macros: Macro[] = [];
  for (let id = 0; id < MACROS; id++) {
    const m = P.parseMacroMode(await step(P.getMacroMode(id), `Macro M${id}`, 3));
    const data = [];
    for (let off = 0; off * 15 < m.actNum; off++) {
      data.push(...P.parseMacroData(await step(P.getMacroData(id, off), `Macro M${id} actions`, 4)));
    }
    macros.push({ name: `Macro${id}`, macroId: id, mode: m.mode, valid: m.valid, actNum: m.actNum, repNum: m.repNum, data: data.slice(0, m.actNum) });
  }
  onProgress(total, total, "Done");

  return {
    keyboards: keys,
    macro: { v2list: macros },
    v2light: { Keyboard: { light, area: "Keyboard", lamp, customLight: grid } },
    system: {
      isAxisStatus: "v1", rateOfReturn: 0, topDeadBandSwitch: 0,
      pid: id.productId, vid: id.vendorId, keyboardName: id.productName || "Peak60",
      usage: id.usage ?? 1, usagePage: id.usagePage ?? 65456, currentKeyboardSystem: original,
    },
    version: "v2",
    firmwareVersion: di.appVersion,
    protocolVersion: { mainVersion: pv[2], subVersion: pv[3], hardwareVersion: pv[4], softwareVersion: pv[5] },
    sn: di.sn,
  };
}

export const identityOf = (d: KeyboardDevice): DeviceIdentity => {
  const col = d.hid.collections.find(c => c.usagePage === 65456);
  return { vendorId: d.vendorId, productId: d.productId, productName: d.name, usagePage: col?.usagePage, usage: col?.usage };
};
