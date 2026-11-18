# Peak60 Config Editor

An editor for Cerakey Peak60 (HE60) `keyboard_config.json` files, written in TypeScript. It
can export a file for lab.cerakey.com, or write the config straight to the keyboard over WebHID.

> [!WARNING]
> **This is not an official Cerakey product.** It isn't made, endorsed or supported by Cerakey.
> The file format and USB protocol were worked out from the public lab.cerakey.com web app and
> may change without notice. Use it at your own risk. Keep a backup of your settings (an export
> from lab.cerakey.com, or **Export (encrypted)** here). If something goes wrong, use
> lab.cerakey.com to restore your keyboard, and don't take problems with this editor to Cerakey
> support.

## Run

```sh
npm install
npm run dev        # http://localhost:5173 (open it in Chrome or Edge)
```

WebHID only works in Chromium browsers and on `localhost`/HTTPS, so open the page through the
dev server, not as a `file://` page. `npm run build` produces a static site in `dist/` that you
can host anywhere with HTTPS. Use `npm run preview` to serve it locally.

## File passphrase

lab.cerakey.com encrypts exported `keyboard_config.json` files with a fixed passphrase. That
passphrase is **not included in this project**. You'll need to find it yourself and supply it.

**What needs it:** opening an *encrypted* config file, and **Export (encrypted)**.

**What works without it:** reading from and writing to the keyboard, auto-write, presets, and
opening or exporting *decrypted* (plain JSON) files. You can use the editor fully without ever
touching an encrypted file.

### Setting it

Either of these works:

- **`.env` file (recommended).** Copy the example and fill in the value, then restart `npm run dev`:

  ```sh
  cp .env.example .env
  # edit .env:  VITE_CERAKEY_PASSPHRASE=<passphrase>
  ```

  `.env` is git-ignored, so the value stays out of the repository.

- **In the app.** If no passphrase is configured, the editor asks for it the first time you open
  or export an encrypted file. You can also set or clear it later in the **Raw JSON** tab. A value
  entered this way is stored in that browser's local storage and takes priority over `.env`.

### When it's missing or wrong

- **No passphrase:** the start screen shows a note. Opening an encrypted file asks for the
  passphrase, and cancelling leaves the editor as it was. Export (encrypted) asks too; if you
  cancel, nothing is exported, and you can still use **Export decrypted**.
- **Wrong passphrase, or Cerakey changes it:** decrypting fails with "Could not decrypt the
  file". You're asked once for a different passphrase before the error is shown.

> **Note:** Vite copies `VITE_*` values into the JavaScript it builds. If `.env` is set when you
> run `npm run build`, the passphrase ends up in `dist/`. Don't publish a build made with your
> `.env` in place; leave the variable empty for builds you share, and enter it in the app instead.

## Use

1. Plug in the keyboard and click **Read from keyboard**. This loads everything on it (both
   Windows and Mac keymaps, factory defaults, actuation / Rapid Trigger, advanced keys,
   lighting and macros) in about 3 seconds. You can also open a `keyboard_config.json`
   exported from lab.cerakey.com.
2. Edit it, or pick something from **✨ Presets** (actuation profiles, lighting themes, keymap tweaks).
3. Get it onto the keyboard:
   - **Auto-write** (header checkbox) sends each change as soon as you make it. It pauses with a
     warning if a change would leave no Fn1 key, and you can click the status pill to retry a
     failed write.
   - **Write to keyboard…** writes on demand: *only my changes*, or *the whole file*.
   - **Export (encrypted)** saves a file you can import in lab.cerakey.com, which is handy as a backup.

Close lab.cerakey.com (and any other tab using the keyboard) first; only one page can talk to
the device at a time. Every change can be undone with Ctrl+Z, and with auto-write on, undo is
written to the keyboard too.

## Develop

```sh
npm test           # packet builders vs. the official site's code, read/write round trips, presets, crypto
npm run typecheck
```

Most tests use your own decrypted export as a fixture. They look for
`keyboard_config (5).decrypted.json` in the project folder, or the path in `CERAKEY_FIXTURE`.
Without one, those tests are skipped. The tests never need the real passphrase.

```sh
CERAKEY_FIXTURE="/path/to/keyboard_config.decrypted.json" npm test
```

- `src/hid/protocol.ts`: 64-byte command builders and the command allowlist
- `src/hid/device.ts`: WebHID transport (send, wait for reply, retry)
- `src/hid/writer.ts`: builds the ordered write plan from a config (with an optional diff baseline)
- `src/hid/reader.ts`: reads the whole keyboard into a config
- `src/presets.ts`: one-click presets
- `tests/sim.ts`: a simulated keyboard used by the read/write round-trip tests
- `src/main.ts`: UI
- `src/crypto.ts`: file encryption; the passphrase comes from `VITE_CERAKEY_PASSPHRASE`
- `tests/official-reference.ts` (not in the repo): an optional local test oracle copied from the official site. When present, extra tests compare packets byte for byte against it.
- `FORMAT.md`: file format and protocol notes
- `legacy/`: the previous plain-JavaScript version