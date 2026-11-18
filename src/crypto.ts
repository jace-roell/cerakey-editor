// File encryption used by lab.cerakey.com:
//   { "data": CryptoJS.AES.encrypt(JSON.stringify(config), PASSPHRASE).toString() }
// i.e. OpenSSL "Salted__" format, AES-256-CBC, key/IV from EVP_BytesToKey(MD5).
//
// The passphrase is not part of this repository. It comes from VITE_CERAKEY_PASSPHRASE
// (see .env.example and the README) or from the passphrase field in the app. Without it,
// encrypted files can't be opened or exported, but everything else (including reading
// and writing the keyboard directly) still works.
import CryptoJS from "crypto-js";
import type { KeyboardConfig } from "./types";

/** Passphrase from the build environment (.env), or "" when not configured. */
export const ENV_PASSPHRASE: string = (import.meta.env.VITE_CERAKEY_PASSPHRASE ?? "").trim();

export class MissingPassphraseError extends Error {
  constructor(action: string) {
    super(`${action} needs the Cerakey file passphrase, which isn't configured. Add it to .env (see .env.example) or enter it when asked.`);
    this.name = "MissingPassphraseError";
  }
}

export function isConfig(v: unknown): v is KeyboardConfig {
  const o = v as KeyboardConfig | null;
  return !!o && typeof o === "object" && Array.isArray(o.keyboards) && !!o.system;
}

/** True for an encrypted export ({ data: "U2FsdGVk…" }), false for a plain config. */
export function isEncryptedFile(text: string): boolean {
  try {
    const o: unknown = JSON.parse(text);
    return !!o && typeof o === "object" && typeof (o as { data?: unknown }).data === "string";
  } catch {
    return false;
  }
}

/** Accepts either an encrypted export or an already-decrypted config. */
export function decryptText(text: string, passphrase: string): KeyboardConfig {
  const obj: unknown = JSON.parse(text);
  if (obj && typeof obj === "object" && typeof (obj as { data?: unknown }).data === "string") {
    if (!passphrase) throw new MissingPassphraseError("Opening an encrypted file");
    let plain = "";
    try {
      plain = CryptoJS.AES.decrypt((obj as { data: string }).data, passphrase).toString(CryptoJS.enc.Utf8);
    } catch {
      plain = "";
    }
    if (!plain) throw new Error("Could not decrypt the file. The passphrase is wrong, or Cerakey has changed it.");
    const cfg: unknown = JSON.parse(plain);
    if (!isConfig(cfg)) throw new Error("Decrypted data is not a Cerakey config.");
    return cfg;
  }
  if (isConfig(obj)) return obj;
  throw new Error("Not a Cerakey config file.");
}

export function encryptConfig(cfg: KeyboardConfig, passphrase: string): { data: string } {
  if (!passphrase) throw new MissingPassphraseError("Exporting an encrypted file");
  return { data: CryptoJS.AES.encrypt(JSON.stringify(cfg), passphrase).toString() };
}
