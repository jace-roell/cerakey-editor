import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codeOf } from "../src/config";
import * as P from "../src/hid/protocol";
import { readConfig } from "../src/hid/reader";
import { buildWritePlan } from "../src/hid/writer";
import { PRESETS } from "../src/presets";
import type { KeyboardConfig } from "../src/types";
import { SimKeyboard } from "./sim";

// Your own decrypted export (not committed). Override with CERAKEY_FIXTURE=/path/to/file.json.
const FIXTURE = process.env.CERAKEY_FIXTURE ?? resolve(__dirname, "../keyboard_config (5).decrypted.json");
const load = (): KeyboardConfig => JSON.parse(readFileSync(FIXTURE, "utf8")) as KeyboardConfig;
const ID = { vendorId: 7334, productId: 20481, productName: "Peak60", usagePage: 65456, usage: 1 };

describe("read parsers invert the write builders", () => {
  it("performance", () => {
    const pf = { mode: 1, normalPress: 1.25, normalRelease: 0, rtFirstTouch: 0.15, rtPress: 0.1, rtRelease: 0.35, pressDeadStroke: 0.05, releaseDeadStroke: 0.3, axis: 2, calibrate: 0, axisV2Id: 3, axisRangeMax: 4000, axisCoefficient: 12 };
    expect(P.parsePerformance(P.setPerformance(1, 2, pf))).toEqual(pf);
  });
  it("macro actions", () => {
    const a = [{ status: 1, delay: 32767, keyCode: 65535 }, { status: 0, delay: 0, keyCode: 4 }];
    expect(P.parseMacroData(P.setMacroData(0, 0, a)).slice(0, 2)).toEqual(a);
  });
  it("every advanced-key type", () => {
    const cases = [
      { advancedType: 1, dks: { dks: [4, 5, 6, 7], trps: [1, 2, 3, 0], db: 1.5, db2: 3.2 } },
      { advancedType: 2, mpt: { dks: [20, 26, 8], dbs: [0.5, 1.5, 3] } },
      { advancedType: 3, mt: { mt: { delay: 200, dksAll: [225, 41] } } },
      { advancedType: 4, tgl: { tgl: { kc: 57, delay: 300 } } },
      { advancedType: 5, end: { end: { dks: [4, 22], delay: 50 } } },
      { advancedType: 6, socd: { socd: { row2: 3, col2: 3, kcs: [4, 7], delay: 5 }, socdMode: 1 } },
      { advancedType: 7, rs: { rs: { row2: 3, col2: 2, kcs: [22, 26], delay: 10 } } },
    ];
    for (const c of cases) {
      const back = P.parseAdvancedKey(P.setAdvancedKey(3, 1, c)[0]);
      expect(back).toMatchObject(c);
    }
    expect(P.parseAdvancedKey(P.setAdvancedKey(3, 1, { advancedType: "" })[0]).advancedType).toBe("");
  });
});

describe.skipIf(!existsSync(FIXTURE))("readConfig against a simulated keyboard", () => {
  it("reads back your config exactly: the writer finds nothing to change", async () => {
    const cfg = load();
    const sim = SimKeyboard.from(cfg);
    const read = await readConfig(sim, ID);
    expect(buildWritePlan(read, { baseline: cfg })).toEqual([]);
    expect(buildWritePlan(cfg, { baseline: read })).toEqual([]);
    // factory defaults, identity and OS mode come back too
    for (const k of cfg.keyboards.flat()) {
      const r = read.keyboards[k.row][k.col];
      for (const os of ["win", "mac"] as const) for (const l of ["fn0", "fn1", "fn2", "fn3"] as const) {
        expect(r.customKeys[os][l].defaultKeycode).toBe(k.customKeys[os][l].defaultKeycode);
        expect(codeOf(r.customKeys[os][l].bindKeyValue)).toBe(codeOf(k.customKeys[os][l].bindKeyValue));
      }
      expect(r.keyValue).toBe(k.keyValue);
    }
    expect(read.system).toMatchObject({ vid: 7334, pid: 20481, currentKeyboardSystem: "WIN", keyboardName: "Peak60" });
    expect(read.v2light.Keyboard.light).toEqual(cfg.v2light.Keyboard.light);
    expect(read.firmwareVersion).toBe("0.1.5.0");
    expect(read.macro.v2list).toHaveLength(16);
  });

  it("round-trips presets, advanced keys and macros, and restores Mac mode", async () => {
    const cfg = load();
    for (const id of ["esports", "synthwave", "vim", "caps-ctrl"]) PRESETS.find(p => p.id === id)!.apply(cfg);
    cfg.keyboards[3][1].advancedKeys = { advancedType: 6, socd: { socd: { row2: 3, col2: 3, kcs: [4, 7], delay: 0 }, socdMode: 1 } };
    cfg.keyboards[3][3].advancedKeys = { advancedType: 6, socd: { socd: { row2: 3, col2: 1, kcs: [7, 4], delay: 0 }, socdMode: 2 } };
    cfg.keyboards[2][3].advancedKeys = { advancedType: 1, dks: { dks: [8, 0, 0, 8], trps: [1, 2, 0, 3], db: 1.2, db2: 3.5 } };
    const m = cfg.macro.v2list[2];
    m.data = Array.from({ length: 33 }, (_, i) => ({ status: i % 2 ? 0 : 1, delay: 10 + i, keyCode: 4 + (i >> 1) }));
    m.actNum = 33; m.valid = true; m.repNum = 3; m.mode = 4;
    cfg.system.currentKeyboardSystem = "MAC";

    const sim = SimKeyboard.from(cfg);
    expect(sim.system).toBe(1);
    const read = await readConfig(sim, ID);
    expect(sim.system).toBe(1); // put back in Mac mode after reading
    expect(read.system.currentKeyboardSystem).toBe("MAC");
    expect(buildWritePlan(read, { baseline: cfg })).toEqual([]);
    expect(read.macro.v2list[2].data).toEqual(m.data);
    expect(read.keyboards[3][1].advancedKeys).toMatchObject({ advancedType: 6, socd: { socdMode: 1 } });
  });

  it("only sends read-only commands apart from the OS switch and restore", async () => {
    const sim = SimKeyboard.from(load());
    await readConfig(sim, ID);
    const writes = sim.log.filter(p => [2, 4].includes(p[1]) && !(p[0] === 2 && p[2] === 1) && p[0] !== 1);
    expect(writes.map(p => `${p[0]}/${p[1]}/${p[2]}/${p[3]}`)).toEqual(["2/4/2/1", "2/4/2/0"]);
    sim.log.forEach(p => P.assertSafe(p));
    expect(sim.log.length).toBeLessThan(260);
  });

  it("restores the OS mode even when reading fails part-way", async () => {
    const sim = SimKeyboard.from(load());
    let n = 0;
    const flaky = { send: (p: Uint8Array) => (++n === 40 ? Promise.reject(new Error("unplugged")) : sim.send(p)) };
    await expect(readConfig(flaky, ID)).rejects.toThrow(/unplugged/);
    expect(sim.system).toBe(0);
  });

  it("rejects replies that don't echo the request", async () => {
    const liar = { send: async (p: Uint8Array) => { const r = new Uint8Array(64); r[0] = p[0]; r[1] = 99; return r; } };
    await expect(readConfig(liar, ID)).rejects.toThrow(/Unexpected reply/);
  });
});
