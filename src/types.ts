// Shapes of the decrypted keyboard_config.json (see FORMAT.md).
// Only the fields this editor reads or writes are typed precisely; everything
// else is preserved untouched via the index signatures.

export type OsKey = "win" | "mac";
export type LayerKey = "fn0" | "fn1" | "fn2" | "fn3";

/** Older exports store some keycodes as { keycode } objects. */
export type KeycodeValue = number | { keycode?: number };

export interface KeySlot {
  keyValue: number;
  bindKeyValue: KeycodeValue;
  defaultKeycode: KeycodeValue;
}

export interface Rgb {
  R: number;
  G: number;
  B: number;
  isCustom: boolean;
}

export interface Performance {
  mode: number; // 0 = single actuation point, 1 = Rapid Trigger
  normalPress: number; // mm
  normalRelease?: number;
  rtFirstTouch: number;
  rtPress: number;
  rtRelease: number;
  pressDeadStroke: number;
  releaseDeadStroke: number;
  isRt?: boolean;
  isGlobalTriggering?: boolean;
  axis?: number;
  calibrate?: number;
  axisV2Id?: number;
  axisRangeMax?: number;
  axisCoefficient?: number;
  [k: string]: unknown;
}

export interface AdvancedKeys {
  advancedType: number | "" | string;
  value?: number;
  dks?: { dks: number[]; trps: number[]; db: number; db2: number } | null;
  mpt?: { dks: number[]; dbs: number[] } | null;
  mt?: { mt: { delay: number; dksAll: number[] } } | null;
  tgl?: { tgl: { kc: number; delay: number } } | null;
  end?: { end: { dks: number[]; delay: number } } | null;
  socd?: { socd: { row2: number; col2: number; kcs: number[]; delay: number }; socdMode: number } | null;
  rs?: { rs: { row2: number; col2: number; kcs: number[]; delay: number } } | null;
  macro?: unknown;
  [k: string]: unknown;
}

export interface KeyConfig {
  row: number;
  col: number;
  keyValue: number;
  customLight: Rgb;
  performance: Performance;
  advancedKeys: AdvancedKeys;
  customKeys: Record<OsKey, Record<LayerKey, KeySlot>>;
  [k: string]: unknown;
}

export interface MacroAction {
  status: number; // 1 = key down, 0 = key up
  delay: number; // ms after this action, max 32767
  keyCode: number;
}

export interface Macro {
  name: string;
  macroId: number;
  mode: number;
  valid: boolean;
  actNum: number;
  repNum: number;
  data: MacroAction[];
}

export interface LightBase {
  area: string;
  open: "Open" | "Close" | string;
  mode: number;
  luminance: number;
  speed: number;
  direction: "Forward" | "Backward" | string;
  selectStaticColor: number;
}

export interface LightArea {
  light: LightBase;
  area?: string;
  lamp?: string;
  customLight: Rgb[][];
  [k: string]: unknown;
}

export interface SystemInfo {
  keyboardName: string;
  vid: number;
  pid: number;
  usagePage?: number;
  usage?: number;
  currentKeyboardSystem: "WIN" | "MAC" | string;
  [k: string]: unknown;
}

export interface KeyboardConfig {
  keyboards: KeyConfig[][];
  macro: { v2list: Macro[]; [k: string]: unknown };
  v2light: Record<string, LightArea>;
  system: SystemInfo;
  version?: string;
  firmwareVersion?: string;
  protocolVersion?: unknown;
  sn?: string;
  [k: string]: unknown;
}
