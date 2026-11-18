/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Passphrase lab.cerakey.com uses to encrypt exported config files. Not committed; see .env.example. */
  readonly VITE_CERAKEY_PASSPHRASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
