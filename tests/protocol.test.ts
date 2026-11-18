import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { MissingPassphraseError, decryptText, encryptConfig, isEncryptedFile } from "../src/crypto";
import * as P from "../src/hid/protocol";
import { buildWritePlan, summarize } from "../src/hid/writer";
import type { AdvancedKeys, KeyboardConfig, MacroAction } from "../src/types";

// Oracle: packet builders copied from lab.cerakey.com. That's Cerakey's code, so it's kept out
// of the repository (.gitignore). With a local copy the comparison tests run; without one they're
// skipped. Loaded by path so a fresh clone still typechecks.
type Oracle = Record<string, (...args: any[]) => any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORACLE = resolve(__dirname, "official-reference.ts");
const O: Oracle = existsSync(ORACLE) ? ((await import(/* @vite-ignore */ pathToFileURL(ORACLE).href)) as Oracle) : {};
const hasOracle = existsSync(ORACLE);

// Your own decrypted export (not committed). Override with CERAKEY_FIXTURE=/path/to/file.json.
const FIXTURE = process.env.CERAKEY_FIXTURE ?? resolve(__dirname, "../keyboard_config (5).decrypted.json");
const hasFixture = existsSync(FIXTURE);
const load = (): KeyboardConfig => JSON.parse(readFileSync(FIXTURE, "utf8")) as KeyboardConfig;
const arr = (u: Uint8Array) => Array.from(u);

describe("packet safety", () => {
  it("refuses commands that are not on the allowlist", () => {
    expect(() => P.assertSafe(P.packet([8, 1]))).toThrow(/allowlist/); // firmware: AppToBoot
    expect(() => P.assertSafe(P.packet([2, 1, 0]))).toThrow(/allowlist/); // factory reset
    expect(() => P.assertSafe(P.packet([2, 6, 0]))).toThrow(/allowlist/); // calibration
    expect(() => P.assertSafe(new Uint8Array(10))).toThrow(/64 bytes/);
    expect(() => P.assertSafe(P.setKeyCode(0, 1, 1, 4))).not.toThrow();
  });
  it("every packet in a full plan passes the allowlist", () => {
    if (!hasFixture) return;
    for (const s of buildWritePlan(load())) expect(() => P.assertSafe(s.packet)).not.toThrow();
  });
});

describe.skipIf(!hasOracle)("matches the official lab.cerakey.com builders (needs local tests/official-reference.ts)", () => {
  it("system type", () => {
    expect(arr(P.setSystemType("WIN"))).toEqual(arr(O.setSystemType("WIN")));
    expect(arr(P.setSystemType("MAC"))).toEqual(arr(O.setSystemType("MAC")));
  });

  it.skipIf(!hasFixture)("keycodes and performance for every key in the real config", () => {
    const cfg = load();
    let n = 0;
    for (const k of cfg.keyboards.flat()) {
      expect(arr(P.setPerformance(k.row, k.col, k.performance))).toEqual(arr(O.importPerformance(k.performance, k.row, k.col)));
      for (const os of ["win", "mac"] as const) {
        for (let layer = 0; layer < 4; layer++) {
          const code = k.customKeys[os][`fn${layer}` as "fn0"].bindKeyValue as number;
          expect(arr(P.setKeyCode(layer, k.row, k.col, code))).toEqual(arr(O.setKeyCodePack({ layer, row: k.row, col: k.col, keycode: code })));
          n++;
        }
      }
    }
    expect(n).toBe(126 * 8);
  });

  it("performance with edited RT values", () => {
    const pf = { mode: 1, normalPress: 1.25, rtFirstTouch: 0.15, rtPress: 0.1, rtRelease: 0.35, pressDeadStroke: 0.05, releaseDeadStroke: 0.3, axisV2Id: 3, axisRangeMax: 4000, axisCoefficient: 12 };
    expect(arr(P.setPerformance(2, 3, pf))).toEqual(arr(O.importPerformance(pf, 2, 3)));
  });

  it.skipIf(!hasFixture)("lighting base and per-key colour pages", () => {
    const L = load().v2light.Keyboard;
    for (const open of ["Open", "Close"]) {
      const light = { ...L.light, open, direction: "Backward", mode: 7, luminance: 80, speed: 20, selectStaticColor: 3 };
      expect(arr(P.setLightingBase(light, L.lamp))).toEqual(arr(O.setLightingBaseProtocol({ area: "Keyboard", config: "Base", data: light, lamp: L.lamp })));
    }
    const grid = L.customLight.map((row, r) => row.map((c, i) => ({ ...c, R: (r * 40 + i) & 255, G: i * 7, B: 200 - r, isCustom: (r + i) % 3 === 0 })));
    expect(P.lightingPageCount(grid)).toBe(9);
    for (let page = 0; page < 9; page++) {
      expect(arr(P.setLightingCustomPage(grid, page))).toEqual(arr(O.getLightingCustomProtocol({ area: "Keyboard", protocol: "Custom", data: grid }, page)));
    }
  });

  it("macro header and action chunks", () => {
    const actions: MacroAction[] = Array.from({ length: 20 }, (_, i) => ({ status: i % 2 ? 0 : 1, delay: i * 1000 + 30, keyCode: 4 + i }));
    const m = { macroId: 5, mode: 4, valid: true, actNum: 20, repNum: 300, name: "x", data: actions };
    expect(arr(P.setMacroMode(m))).toEqual(arr(O.setMacroMode({ ...m, valid: Number(m.valid) })));
    expect(arr(P.setMacroData(5, 0, actions.slice(0, 15)))).toEqual(arr(O.setMacroData({ macroId: 5, offset: 0, actions: actions.slice(0, 15) })));
    expect(arr(P.setMacroData(5, 1, actions.slice(15)))).toEqual(arr(O.setMacroData({ macroId: 5, offset: 1, actions: actions.slice(15) })));
    expect(() => P.encodeMacroAction({ status: 1, delay: 40000, keyCode: 4 })).toThrow();
  });

  const adv: Record<string, AdvancedKeys> = {
    none: { advancedType: "" },
    dks: { advancedType: 1, dks: { dks: [4, 5, 6, 7], trps: [1, 2, 3, 0], db: 1.5, db2: 3.2 } },
    mpt: { advancedType: 2, mpt: { dks: [20, 26, 8], dbs: [0.5, 1.5, 3] } },
    mt: { advancedType: 3, mt: { mt: { delay: 200, dksAll: [225, 41] } } },
    end: { advancedType: 5, end: { end: { dks: [4, 22], delay: 50 } } },
    socd: { advancedType: 6, socd: { socd: { row2: 3, col2: 3, kcs: [4, 7], delay: 0 }, socdMode: 1 } },
    socdNeutral: { advancedType: 6, socd: { socd: { row2: 3, col2: 3, kcs: [4, 7], delay: 5 }, socdMode: 3 } },
    rs: { advancedType: 7, rs: { rs: { row2: 3, col2: 2, kcs: [22, 26], delay: 10 } } },
  };
  for (const [name, a] of Object.entries(adv)) {
    it(`advanced key: ${name}`, () => {
      const ours = P.setAdvancedKey(3, 1, a).map(arr);
      const theirs = [O.importAdvanced(3, 1, a)].flat().map(arr);
      expect(ours).toEqual(theirs);
    });
  }
  it("advanced key TGL sends the stored delay (the official import drops it to 0)", () => {
    const a: AdvancedKeys = { advancedType: 4, tgl: { tgl: { kc: 57, delay: 300 } } };
    const ours = arr(P.setAdvancedKey(2, 0, a)[0]);
    const theirs = arr([O.importAdvanced(2, 0, a)].flat()[0]);
    expect(ours.slice(0, 7)).toEqual(theirs.slice(0, 7));
    expect(theirs.slice(7, 9)).toEqual([0, 0]);
    expect(ours.slice(7, 9)).toEqual([300 & 255, 300 >> 8]);
  });
});

describe.skipIf(!hasFixture)("write plan", () => {
  it("full plan covers every key, both OSes and restores the OS", () => {
    const cfg = load();
    const steps = buildWritePlan(cfg);
    const s = summarize(steps);
    expect(s.performance).toBe(126);
    expect(s.keymap).toBe(126 * 8);
    expect(s.advanced).toBe(126);
    expect(s.lighting).toBe(10);
    expect(s.macros).toBe(16);
    const sys = steps.filter(x => x.section === "system").map(x => x.label);
    expect(sys).toEqual(["Switch to WIN mode", "Switch to MAC mode", "Restore WIN mode"]);
    // keymap packets for MAC come after the MAC switch
    const macSwitch = steps.findIndex(x => x.label === "Switch to MAC mode");
    expect(steps.slice(macSwitch + 1).find(x => x.section === "keymap")!.label).toMatch(/^MAC/);
  });

  it("diff plan is empty when nothing changed", () => {
    const cfg = load();
    expect(buildWritePlan(cfg, { baseline: structuredClone(cfg) })).toEqual([]);
  });

  it("diff plan contains only the edited items", () => {
    const base = load();
    const cfg = structuredClone(base);
    const k = cfg.keyboards[2][1]; // Q
    k.customKeys.win.fn0.bindKeyValue = 29; // Z
    k.performance = { ...k.performance, mode: 1, rtPress: 0.15 };
    cfg.v2light.Keyboard.customLight[2][1] = { R: 255, G: 0, B: 0, isCustom: true };
    cfg.macro.v2list[0].data = [{ status: 1, delay: 30, keyCode: 4 }, { status: 0, delay: 30, keyCode: 4 }];
    cfg.macro.v2list[0].actNum = 2;
    cfg.macro.v2list[0].valid = true;
    const steps = buildWritePlan(cfg, { baseline: base });
    expect(steps.map(s => s.label)).toEqual([
      "Actuation r2 c1",
      "Switch to WIN mode", "WIN Fn0 r2 c1", "Restore WIN mode",
      "Key colours 3/9",
      "Macro M0 settings", "Macro M0 actions 1",
    ]);
    expect(arr(steps[2].packet).slice(0, 7)).toEqual([3, 4, 0, 2, 1, 29, 0]);
  });

  it("renaming a macro alone sends nothing (names are file-only)", () => {
    const base = load();
    const cfg = structuredClone(base);
    cfg.macro.v2list[3].name = "Renamed";
    expect(buildWritePlan(cfg, { baseline: base })).toEqual([]);
  });

  // Any passphrase works for a round trip; the real one is never needed in tests.
  const TEST_PASS = "test-only-passphrase";

  it("encrypt/decrypt round-trips", () => {
    const cfg = load();
    const enc = JSON.stringify(encryptConfig(cfg, TEST_PASS));
    expect(JSON.parse(enc).data.startsWith("U2FsdGVkX1")).toBe(true); // OpenSSL "Salted__" format
    expect(isEncryptedFile(enc)).toBe(true);
    expect(decryptText(enc, TEST_PASS)).toEqual(cfg);
  });

  it("without a passphrase: encrypted files fail clearly, plain JSON still opens", () => {
    const cfg = load();
    const enc = JSON.stringify(encryptConfig(cfg, TEST_PASS));
    expect(() => decryptText(enc, "")).toThrow(MissingPassphraseError);
    expect(() => encryptConfig(cfg, "")).toThrow(MissingPassphraseError);
    expect(decryptText(JSON.stringify(cfg), "")).toEqual(cfg);
    expect(isEncryptedFile(JSON.stringify(cfg))).toBe(false);
  });

  it("a wrong passphrase is reported, not silently accepted", () => {
    const enc = JSON.stringify(encryptConfig(load(), TEST_PASS));
    expect(() => decryptText(enc, "wrong")).toThrow(/Could not decrypt|JSON|Malformed/);
  });
});
