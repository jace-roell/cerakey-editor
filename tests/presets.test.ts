import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LAYOUT, SPACE_LED_SLOTS, bindOf } from "../src/config";
import * as P from "../src/hid/protocol";
import { buildWritePlan, summarize } from "../src/hid/writer";
import { PRESETS } from "../src/presets";
import type { KeyboardConfig } from "../src/types";

// Your own decrypted export (not committed). Override with CERAKEY_FIXTURE=/path/to/file.json.
const FIXTURE = process.env.CERAKEY_FIXTURE ?? resolve(__dirname, "../keyboard_config (5).decrypted.json");
const load = (): KeyboardConfig => JSON.parse(readFileSync(FIXTURE, "utf8")) as KeyboardConfig;
const keyAt = (cfg: KeyboardConfig, r: number, c: number) => cfg.keyboards[r][c];

describe.skipIf(!existsSync(FIXTURE))("presets", () => {
  it("ids are unique", () => {
    expect(new Set(PRESETS.map(p => p.id)).size).toBe(PRESETS.length);
  });

  for (const p of PRESETS) {
    it(`${p.group} / ${p.name}: applies, stays in range, writes only its own section`, () => {
      const base = load();
      const cfg = structuredClone(base);
      p.apply(cfg);
      // Touches only real keys: row 0 / cols 14-20 are left alone.
      for (let c = 0; c < 21; c++) expect(cfg.keyboards[0][c]).toEqual(base.keyboards[0][c]);
      for (const { r, c } of LAYOUT) {
        const pf = keyAt(cfg, r, c).performance;
        for (const v of [pf.normalPress, pf.rtFirstTouch, pf.rtPress, pf.rtRelease, pf.pressDeadStroke, pf.releaseDeadStroke]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(4);
        }
        if (pf.mode === 1) expect(Math.min(pf.rtPress, pf.rtRelease)).toBeGreaterThanOrEqual(0.1);
        const col = cfg.v2light.Keyboard.customLight[r][c];
        for (const ch of [col.R, col.G, col.B]) expect(Number.isInteger(ch) && ch >= 0 && ch <= 255).toBe(true);
      }
      const steps = buildWritePlan(cfg, { baseline: base });
      steps.forEach(s => P.assertSafe(s.packet));
      const sum = summarize(steps);
      const own = { Actuation: "performance", Lighting: "lighting", Keymap: "keymap" }[p.group];
      for (const [sec, n] of Object.entries(sum)) {
        if (sec !== own && !(own === "keymap" && sec === "system")) expect(n, `${sec} untouched`).toBe(0);
      }
      // Applying twice changes nothing more (idempotent).
      const again = structuredClone(cfg);
      p.apply(again);
      expect(again).toEqual(cfg);
    });
  }

  it("Esports puts Rapid Trigger on W A S D only among letters", () => {
    const cfg = load();
    PRESETS.find(p => p.id === "esports")!.apply(cfg);
    expect(keyAt(cfg, 2, 2).performance.mode).toBe(1); // W
    expect(keyAt(cfg, 3, 1).performance.mode).toBe(1); // A
    expect(keyAt(cfg, 2, 1).performance.mode).toBe(0); // Q
    expect(keyAt(cfg, 2, 1).performance.normalPress).toBe(1.2);
    expect(keyAt(cfg, 2, 2).performance.isRt).toBe(true);
  });

  it("Vim arrows binds Fn1 H J K L on both OSes and leaves the base layer alone", () => {
    const cfg = load();
    PRESETS.find(p => p.id === "vim")!.apply(cfg);
    for (const os of ["win", "mac"] as const) {
      expect([6, 7, 8, 9].map(c => bindOf(keyAt(cfg, 3, c), os, 1))).toEqual([80, 81, 82, 79]);
      expect(bindOf(keyAt(cfg, 3, 6), os, 0)).toBe(11); // H still types H
    }
  });

  it("Caps → Ctrl keeps Caps Lock on Fn1", () => {
    const cfg = load();
    PRESETS.find(p => p.id === "caps-ctrl")!.apply(cfg);
    expect(bindOf(keyAt(cfg, 3, 0), "win", 0)).toBe(224);
    expect(bindOf(keyAt(cfg, 3, 0), "win", 1)).toBe(57);
    expect(keyAt(cfg, 3, 0).keyValue).toBe(224);
  });

  it("Factory keymap undoes a remap, including your F5–F12 changes", () => {
    const base = load();
    const cfg = structuredClone(base);
    PRESETS.find(p => p.id === "factory-keys")!.apply(cfg);
    expect(bindOf(keyAt(cfg, 1, 5), "win", 0)).toBe(34); // was remapped to F5, factory is 5
    expect(summarize(buildWritePlan(cfg, { baseline: base })).keymap).toBeGreaterThan(0);
  });

  it("spacebar LED slots (row 5, cols 3-5 and 7-9) always match the spacebar's colour", () => {
    for (const p of PRESETS.filter(x => x.group === "Lighting")) {
      const cfg = load();
      p.apply(cfg);
      const g = cfg.v2light.Keyboard.customLight;
      for (const [r, c] of SPACE_LED_SLOTS) expect(g[r][c], `${p.name} r${r} c${c}`).toEqual(g[5][6]);
    }
    const cfg = load();
    PRESETS.find(p => p.id === "synthwave")!.apply(cfg);
    expect(cfg.v2light.Keyboard.customLight[5][4].isCustom).toBe(true);
    PRESETS.find(p => p.id === "lights-off")!.apply(cfg);
    expect(cfg.v2light.Keyboard.customLight[5][4].isCustom).toBe(false); // cleared too
    // and the colour reaches the keyboard: the page holding r5 c3-c9 is in the write plan
    const base = load();
    const painted = structuredClone(base);
    PRESETS.find(p => p.id === "synthwave")!.apply(painted);
    const page = Math.floor((5 * 21 + 4) / 15);
    const step = buildWritePlan(painted, { baseline: base }).find(s => s.label === `Key colours ${page + 1}/9`)!;
    const slot = 4 + 4 * ((5 * 21 + 4) % 15); // B G R flag for r5 c4
    const sp = painted.v2light.Keyboard.customLight[5][6];
    expect(Array.from(step.packet.slice(slot, slot + 4))).toEqual([sp.B, sp.G, sp.R, 255]);
  });

  it("lighting presets switch lighting on and the heat map follows actuation", () => {
    const cfg = load();
    PRESETS.find(p => p.id === "esports")!.apply(cfg);
    PRESETS.find(p => p.id === "heatmap")!.apply(cfg);
    expect(cfg.v2light.Keyboard.light.open).toBe("Open");
    expect(cfg.v2light.Keyboard.customLight[2][2]).toMatchObject({ R: 255, G: 43, B: 214, isCustom: true }); // W is RT → magenta
    expect(cfg.v2light.Keyboard.customLight[2][1].isCustom).toBe(true);
  });
});
