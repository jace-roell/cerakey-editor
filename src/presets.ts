// One-click presets. Each one edits the config in place; the UI wraps apply() in
// mutate(), so every preset can be undone and is picked up by auto-write.
//
// Keys are found by their factory base-layer keycode (not by matrix position), so a
// preset touches the same physical keys even if you've remapped them.
import { LAYOUT, activeOs, layerKey, lightArea } from "./config";
import type { KeyConfig, KeyboardConfig, OsKey, Performance, Rgb } from "./types";

export type PresetGroup = "Actuation" | "Lighting" | "Keymap";

export interface Preset {
  id: string;
  group: PresetGroup;
  name: string;
  desc: string;
  apply: (cfg: KeyboardConfig) => void;
}

// HID usage codes used below
const K = {
  A: 4, D: 7, F: 9, H: 11, I: 12, J: 13, K: 14, L: 15, O: 18, S: 22, U: 24, W: 26, Y: 28,
  Enter: 40, Esc: 41, Bksp: 42, Tab: 43, Space: 44, Caps: 57,
  Home: 74, PgUp: 75, Del: 76, End: 77, PgDn: 78, Right: 79, Left: 80, Down: 81, Up: 82,
  LCtrl: 224, LShift: 225, LAlt: 226, LWin: 227, RCtrl: 228, RShift: 229, RAlt: 230,
};
const MODS = new Set([K.Esc, K.Tab, K.Caps, K.LShift, K.LCtrl, K.LAlt, K.LWin, K.RShift, K.RCtrl, K.RAlt, K.Enter, K.Bksp, 101, 61697]);

// ---------- helpers ----------
const realKeys = (cfg: KeyboardConfig): { key: KeyConfig; x: number; y: number; w: number }[] => {
  const idx = new Map(cfg.keyboards.flat().map(k => [`${k.row}-${k.col}`, k]));
  return LAYOUT.flatMap(p => {
    const key = idx.get(`${p.r}-${p.c}`);
    return key ? [{ key, x: p.x + p.w / 2, y: p.y, w: p.w }] : [];
  });
};
const factoryCode = (k: KeyConfig): number => {
  const d = k.customKeys?.win?.fn0?.defaultKeycode;
  return typeof d === "object" ? (d?.keycode ?? 0) : (d ?? 0);
};
const findKeys = (cfg: KeyboardConfig, codes: number[]): KeyConfig[] =>
  realKeys(cfg).map(r => r.key).filter(k => codes.includes(factoryCode(k)));

function setPerf(k: KeyConfig, p: Partial<Performance>): void {
  Object.assign(k.performance, p);
  k.performance.isRt = k.performance.mode === 1;
}
const normal = (mm: number, dz = 0.2): Partial<Performance> => ({ mode: 0, normalPress: mm, pressDeadStroke: dz, releaseDeadStroke: dz });
const rt = (first: number, press: number, release: number, dz = 0.1): Partial<Performance> =>
  ({ mode: 1, rtFirstTouch: first, rtPress: press, rtRelease: release, pressDeadStroke: dz, releaseDeadStroke: dz });

function bind(cfg: KeyboardConfig, fromCode: number, layer: number, toCode: number, oses: OsKey[] = ["win", "mac"]): void {
  const cur = activeOs(cfg);
  for (const k of findKeys(cfg, [fromCode])) {
    for (const os of oses) {
      const s = k.customKeys?.[os]?.[layerKey(layer)];
      if (!s) continue;
      s.bindKeyValue = toCode;
      if (layer === 0 && os === cur) k.keyValue = toCode;
    }
  }
}

type RGB = [number, number, number];
const hexRgb = (h: string): RGB => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as RGB;
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as RGB;
/** Multi-stop gradient, t in 0..1. */
function ramp(stops: string[], t: number): RGB {
  const c = stops.map(hexRgb);
  const s = Math.min(Math.max(t, 0), 1) * (c.length - 1);
  const i = Math.min(Math.floor(s), c.length - 2);
  return mix(c[i], c[i + 1], s - i);
}
function hsv(h: number, s: number, v: number): RGB {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}
/** Deterministic pseudo-random 0..1 per key, so presets look the same every time. */
const hash = (r: number, c: number): number => {
  const x = Math.sin(r * 127.1 + c * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const KB_W = 15, KB_H = 4;
/** Paints every real key; returning null leaves the key without a custom colour. */
function paint(cfg: KeyboardConfig, colour: (k: KeyConfig, x: number, y: number) => RGB | null): void {
  const area = lightArea(cfg);
  const L = area ? cfg.v2light[area] : undefined;
  for (const { key, x, y } of realKeys(cfg)) {
    const rgb = colour(key, x / KB_W, y / KB_H);
    const v: Rgb = rgb ? { R: rgb[0], G: rgb[1], B: rgb[2], isCustom: true } : { R: 0, G: 0, B: 0, isCustom: false };
    if (L?.customLight?.[key.row]) L.customLight[key.row][key.col] = { ...v };
    key.customLight = { ...v };
  }
  if (L?.light) L.light.open = "Open";
}

// ---------- presets ----------
export const PRESETS: Preset[] = [
  // Actuation
  {
    id: "esports", group: "Actuation", name: "Esports",
    desc: "Rapid Trigger 0.1 mm on W A S D, Space, Shift and Ctrl, for instant counter-strafing. Every other key actuates at 1.2 mm.",
    apply: cfg => {
      const hot = new Set(findKeys(cfg, [K.W, K.A, K.S, K.D, K.Space, K.LShift, K.LCtrl]));
      for (const { key } of realKeys(cfg)) setPerf(key, hot.has(key) ? rt(0.15, 0.1, 0.1) : normal(1.2));
    },
  },
  {
    id: "rhythm", group: "Actuation", name: "Rhythm game",
    desc: "D F J K and Space get Rapid Trigger 0.1 mm for fast streams and trills. Everything else stays at 1.5 mm.",
    apply: cfg => {
      const hot = new Set(findKeys(cfg, [K.D, K.F, K.J, K.K, K.Space]));
      for (const { key } of realKeys(cfg)) setPerf(key, hot.has(key) ? rt(0.2, 0.1, 0.1) : normal(1.5));
    },
  },
  {
    id: "allrt", group: "Actuation", name: "Rapid Trigger everywhere",
    desc: "Every key resets the moment it starts rising: first trigger 0.3 mm, 0.15 mm press and release.",
    apply: cfg => realKeys(cfg).forEach(({ key }) => setPerf(key, rt(0.3, 0.15, 0.15))),
  },
  {
    id: "typist", group: "Actuation", name: "Typist",
    desc: "A deliberate 2.0 mm on letters, 2.4 mm on Space and the modifiers so resting fingers don't misfire. No Rapid Trigger.",
    apply: cfg => realKeys(cfg).forEach(({ key }) =>
      setPerf(key, normal(key && (MODS.has(factoryCode(key)) || factoryCode(key) === K.Space) ? 2.4 : 2.0, 0.25))),
  },
  {
    id: "feather", group: "Actuation", name: "Featherlight",
    desc: "A light 0.8 mm actuation everywhere for fast, low-effort typing. Takes some getting used to.",
    apply: cfg => realKeys(cfg).forEach(({ key }) => setPerf(key, normal(0.8, 0.15))),
  },
  {
    id: "factory-perf", group: "Actuation", name: "Factory actuation",
    desc: "Back to the stock settings: 2.0 mm, Rapid Trigger off (with its values reset to 0.5 / 0.3 / 0.3), 0.2 mm dead zones.",
    apply: cfg => realKeys(cfg).forEach(({ key }) =>
      setPerf(key, { mode: 0, normalPress: 2, rtFirstTouch: 0.5, rtPress: 0.3, rtRelease: 0.3, pressDeadStroke: 0.2, releaseDeadStroke: 0.2 })),
  },

  // Lighting
  {
    id: "synthwave", group: "Lighting", name: "Synthwave",
    desc: "Hot pink to violet to electric cyan, left to right.",
    apply: cfg => paint(cfg, (_k, x) => ramp(["#ff2bd6", "#8a2cff", "#00e5ff"], x)),
  },
  {
    id: "sunset", group: "Lighting", name: "Sunset",
    desc: "Golden hour across the board: amber top-left fading to coral and deep purple.",
    apply: cfg => paint(cfg, (_k, x, y) => ramp(["#ffc24b", "#ff5e62", "#c3177a", "#4b1d8f"], x * 0.6 + y * 0.4)),
  },
  {
    id: "ocean", group: "Lighting", name: "Ocean depths",
    desc: "Bright aqua on the number row sinking to midnight blue at the space bar.",
    apply: cfg => paint(cfg, (_k, _x, y) => ramp(["#7ff6ff", "#00a6d6", "#0a3d8f", "#06144a"], y)),
  },
  {
    id: "aurora", group: "Lighting", name: "Aurora",
    desc: "Northern-lights green and teal waves with violet edges.",
    apply: cfg => paint(cfg, (_k, x, y) => ramp(["#3dff9a", "#00c2b8", "#2d7bff", "#a34dff"], (Math.sin(x * 7 + y * 2) + 1) / 2 * 0.7 + y * 0.3)),
  },
  {
    id: "rainbow", group: "Lighting", name: "Static rainbow",
    desc: "A full saturated spectrum sweeping across the keyboard.",
    apply: cfg => paint(cfg, (_k, x, y) => hsv(((x * 330 + y * 25) % 360), 1, 1)),
  },
  {
    id: "matrix", group: "Lighting", name: "Matrix",
    desc: "Phosphor greens at random brightness, like falling code.",
    apply: cfg => paint(cfg, k => { const h = hash(k.row, k.col); return mix([0, 40, 8], [120, 255, 140], h * h); }),
  },
  {
    id: "wasd", group: "Lighting", name: "Gamer focus",
    desc: "Dim navy board with W A S D in red, Space/Shift/Ctrl in orange and 1 to 5 in gold.",
    apply: cfg => {
      const red = new Set(findKeys(cfg, [K.W, K.A, K.S, K.D]));
      const orange = new Set(findKeys(cfg, [K.Space, K.LShift, K.LCtrl, K.Esc]));
      const gold = new Set(findKeys(cfg, [30, 31, 32, 33, 34]));
      paint(cfg, k => red.has(k) ? hexRgb("#ff1f3d") : orange.has(k) ? hexRgb("#ff8a00") : gold.has(k) ? hexRgb("#ffd21f") : hexRgb("#0b1a40"));
    },
  },
  {
    id: "retro", group: "Lighting", name: "Retro",
    desc: "Classic beige-and-grey: warm white letters, cool grey modifiers, red Esc and Enter.",
    apply: cfg => paint(cfg, k => {
      const c = factoryCode(k);
      if (c === K.Esc || c === K.Enter) return hexRgb("#ff3b2f");
      return MODS.has(c) || c === K.Space ? hexRgb("#6f86a8") : hexRgb("#ffd9a8");
    }),
  },
  {
    id: "heatmap", group: "Lighting", name: "Actuation heat map",
    desc: "Colours each key by its current actuation: light keys blue, heavy keys red, Rapid Trigger keys magenta. Re-apply after changing actuation.",
    apply: cfg => paint(cfg, k => {
      const p = k.performance;
      if (p.mode === 1) return hexRgb("#ff2bd6");
      return ramp(["#2d7bff", "#3dff9a", "#ffd21f", "#ff3b2f"], (p.normalPress - 0.5) / 3);
    }),
  },
  {
    id: "lights-off", group: "Lighting", name: "Clear custom colours",
    desc: "Removes every per-key colour so the effect shows on its own.",
    apply: cfg => paint(cfg, () => null),
  },

  // Keymap
  {
    id: "vim", group: "Keymap", name: "Vim arrows on Fn1",
    desc: "Hold Fn and use H J K L for ← ↓ ↑ →. Windows and Mac.",
    apply: cfg => {
      bind(cfg, K.H, 1, K.Left); bind(cfg, K.J, 1, K.Down); bind(cfg, K.K, 1, K.Up); bind(cfg, K.L, 1, K.Right);
    },
  },
  {
    id: "nav", group: "Keymap", name: "Navigation cluster on Fn1",
    desc: "Hold Fn: I J K L are arrows, U/O are Home/End, Y/H are Page Up/Down. Windows and Mac.",
    apply: cfg => {
      bind(cfg, K.I, 1, K.Up); bind(cfg, K.J, 1, K.Left); bind(cfg, K.K, 1, K.Down); bind(cfg, K.L, 1, K.Right);
      bind(cfg, K.U, 1, K.Home); bind(cfg, K.O, 1, K.End); bind(cfg, K.Y, 1, K.PgUp); bind(cfg, K.H, 1, K.PgDn);
    },
  },
  {
    id: "caps-ctrl", group: "Keymap", name: "Caps Lock → Ctrl",
    desc: "Caps Lock becomes a second Ctrl, which is easier on the pinky. Fn + Caps Lock still toggles caps.",
    apply: cfg => { bind(cfg, K.Caps, 0, K.LCtrl); bind(cfg, K.Caps, 1, K.Caps); },
  },
  {
    id: "caps-esc", group: "Keymap", name: "Caps Lock → Esc",
    desc: "A favourite of Vim users. Fn + Caps Lock still toggles caps.",
    apply: cfg => { bind(cfg, K.Caps, 0, K.Esc); bind(cfg, K.Caps, 1, K.Caps); },
  },
  {
    id: "factory-keys", group: "Keymap", name: "Factory keymap",
    desc: "Resets every key on every layer, for both Windows and Mac, to its factory binding.",
    apply: cfg => {
      const cur = activeOs(cfg);
      for (const { key } of realKeys(cfg)) {
        for (const os of ["win", "mac"] as const) {
          for (let l = 0; l < 4; l++) {
            const s = key.customKeys?.[os]?.[layerKey(l)];
            if (s) s.bindKeyValue = s.defaultKeycode;
          }
        }
        const base = key.customKeys?.[cur]?.fn0;
        if (base) key.keyValue = typeof base.bindKeyValue === "object" ? (base.bindKeyValue.keycode ?? 0) : base.bindKeyValue;
      }
    },
  },
];

/** Colour of every real key after applying a lighting preset to a copy of cfg (for previews). */
export function previewColours(cfg: KeyboardConfig, p: Preset): { x: number; y: number; w: number; rgb: Rgb | null }[] {
  const copy = structuredClone(cfg);
  p.apply(copy);
  const area = lightArea(copy);
  return realKeys(copy).map(({ key, x, y, w }) => {
    const v = (area ? copy.v2light[area]?.customLight?.[key.row]?.[key.col] : undefined) ?? key.customLight;
    return { x: x - w / 2, y, w, rgb: v?.isCustom ? v : null };
  });
}
