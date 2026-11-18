# Cerakey / Peak60 `keyboard_config.json` format

Reverse-engineered from lab.cerakey.com and checked against a real Peak60 export
(firmware 0.1.5.0, format `v2`, protocol 1.3). "Unverified" marks guesses.

## Encryption

```json
{ "data": "U2FsdGVkX1..." }
```

`data` is `CryptoJS.AES.encrypt(JSON.stringify(config), PASSPHRASE).toString()`:

- Passphrase: a fixed string set by the official editor. It is not reproduced here; the app reads it
  from `VITE_CERAKEY_PASSPHRASE` (see the README).
- Base64 of `"Salted__"` + 8-byte random salt + AES-256-CBC ciphertext (PKCS#7).
- Key (32 B) and IV (16 B) = OpenSSL `EVP_BytesToKey(MD5, passphrase, salt, 1 iteration)`.
  The salt is new on every export, so each file has its own key and IV.
- Plaintext is compact `JSON.stringify` output. Re-encrypting a parsed file reproduces
  the original plaintext byte for byte.

Decrypt with OpenSSL:
`jq -r .data keyboard_config.json | openssl enc -d -aes-256-cbc -md md5 -a -A -pass env:VITE_CERAKEY_PASSPHRASE`

## Top level

| Field | Meaning |
|---|---|
| `keyboards` | 6 × 21 matrix (`[row][col]`) of key objects. Only 61 slots are real keys (see below). |
| `macro.v2list` | 16 macros. |
| `v2light` | Lighting, keyed by area (`Keyboard`). |
| `system` | `keyboardName`, `vid` 7334, `pid` 20481, `usagePage`, `usage`, `currentKeyboardSystem` (`WIN`/`MAC`), `isAxisStatus`, `rateOfReturn`, `topDeadBandSwitch`. Keep vid/pid or the official editor rejects the import. |
| `version` | `"v2"` |
| `firmwareVersion`, `protocolVersion`, `sn` | Device info. |

## Matrix → physical keys (61-key ANSI)

Row 0 and cols 14–20 are empty. Used slots:

- r1: c0–c13 (Esc … Bksp)
- r2: c0–c13 (Tab … `\`)
- r3: c0–c11, c13 (Caps … `'`, Enter)
- r4: c0, c2–c11, c13 (LShift, Z … `/`, RShift)
- r5: c0 c1 c2 c6 c10 c11 c12 c13 (LCtrl LWin LAlt Space RAlt Menu RCtrl Fn1)

## Key object

```text
row, col, keyValue            keyValue mirrors the active OS's fn0 bindKeyValue
customKeys.{win,mac}.fn{0-3}  { keyValue: -1, bindKeyValue, defaultKeycode }
performance                   see below
advancedKeys                  { advancedType: "" | 1..7, value, dks, mpt, mt, tgl, end, socd, macro }
customLight                   { R, G, B, isCustom }  (also stored in v2light.Keyboard.customLight[row][col])
```

`bindKeyValue` is the current binding and `defaultKeycode` is the factory one.

### Keycodes

- `< 256`: HID keyboard usage (4 = A …), plus 0 = none and 1 = transparent.
- `4096 | mods<<8 | key`: shortcut. Mod bits: 1 Ctrl, 2 Shift, 4 Alt, 8 Win/Cmd (left only). For example 6187 = Win+Tab.
- `0x2000 | usage`: consumer control (8418 Mute, 8737 = 0x2221 Search).
- `0x4000+`: mouse. `0x5xxx` / `0xCxxx`: gamepad.
- `0xF100–0xF103` (61696–61699): Fn0–Fn3 layer.
- `0xF2xx`: device/lighting functions. `0xF4xx`: wireless.
- `0xF500 + n` (62720+): macro n.
- Unknown but present on the factory Fn1 layer: 61963 (0xF20B), 65280 (0xFF00), 65281 (0xFF01).

### performance

Travel values are in mm (0–4). Relevant fields:
`normalPress` (actuation), `rtFirstTouch`, `rtPress`, `rtRelease`, `pressDeadStroke`,
`releaseDeadStroke`, and `mode` (0 = single actuation point, 1 = Rapid Trigger; confirmed
from the official UI code).

Only `mode`, the seven travel values and the `axis*` fields are sent to the keyboard (see the
performance packet below). `isRt`, `isGlobalTriggering` and `globalTriggeringValue` exist only
for the official editor's UI, so they don't change what the keyboard does. This editor keeps
`isRt` in step with `mode` and leaves `isGlobalTriggering` alone.
Some keys also carry `singleTriggeringValue`, `rtPressValue`, `rtReleaseValue`,
`deadBandPressValue` and `deadBandReleaseValue` (all 0). These are left untouched.

## Macros (`macro.v2list[i]`)

`{ name, macroId, mode (0–5 playback), valid, actNum, repNum, data: [{ status 1=down/0=up, keyCode, delay ms }] }`.
`actNum` must equal `data.length`, and `valid` is true when it has actions.

## Lighting (`v2light.Keyboard`)

`light: { area, open "Open"/"Close", mode, luminance 0–100, speed 0–100, direction, selectStaticColor }`,
`lamp: "SingleLighting"`, `customLight: 6×21 grid of {R,G,B,isCustom}`.

Spacebar LEDs (unconfirmed): the spacebar's switch is at r5 c6, but the slots r5 c3–c5 and c7–c9
have no switch and probably carry the LEDs under the 6.25u bar. A slot without `isCustom` shows
the running effect, so colouring only c6 leaves the spacebar cycling colours. The editor copies
the spacebar's colour into those six slots whenever colours change (`mirrorSpaceLeds`).

## HID protocol (writing to the keyboard)

From the lab.cerakey.com bundle; implemented in `src/hid/`. WebHID, vendor interface
usagePage `0xFFB0` / usage `1`. Every command is a 64-byte output report with report ID 0,
zero-padded. The keyboard replies to each one with an input report (the client waits up to
1 s and retries 3 times). u16 values are little-endian, and travel distances are µm (mm × 1000).

| Command | Bytes |
|---|---|
| Protocol version (read) | `01 01` → reply `[2]`.`[3]` |
| Device info (read) | `01 02` → firmware `[8..11]`, SN `[17..28]` |
| Set OS mode | `02 04 02 os` (0 WIN, 1 MAC) |
| Set keycode | `03 04 layer row col kc:u16`. Layer 0–3 = Fn0–Fn3 of the *currently active* OS mode |
| Set performance | `04 02 row col mode normalPress normalRelease rtFirstTouch rtPress rtRelease pressDead releaseDead` (all u16 µm) `axis calibrate(0) axisV2Id:u16 axisRangeMax:u16 axisCoefficient:u16` |
| Lighting effect | `05 02 area(0) config(0=base) open mode luminance speed direction staticColor` |
| Per-key colours | `05 04 area(0) page` + 15 × `B G R flag(255 = custom)`, pages 0–8 over the flattened 6×21 grid |
| Advanced key | `06 02 row col type …`: DKS `kc×4 trp×4 db:u16µm db2:u16µm` · MPT `kc×3 db×3(µm)` · MT `kc×2 time` · TGL `kc time` · END `kc×2 delay` · SOCD/RS: two packets, one per key, with the partner's row/col and keycodes swapped (SOCD adds a priority byte) |
| Macro settings | `07 02 id valid actNum:u16 repNum:u16 mode` |
| Macro actions | `07 04 id chunk` + up to 15 × u32 LE (`down<<31 \| delay<<16 \| keycode`) |

The official "import" writes, per key: performance, then OS mode WIN and Fn0–3, then MAC and
Fn0–3, then restores the file's OS, then the advanced key. After that it writes the lighting
effect and colour pages, then every macro. It never sends a separate "save" command, so the
keyboard stores writes itself.

Commands this editor never sends (and refuses in `assertSafe`): category 8 (firmware upgrade),
`02 01` (factory reset), `02 06` (calibration), and everything else not listed above.

### Reading

Reads use the same headers with the "read" sub-command. Replies echo the request header, and
their payload uses the same layout as the matching write packet.

| Read | Request | Reply |
|---|---|---|
| OS mode | `02 04 01` | `[3]` 0 WIN / 1 MAC |
| Lamp type | `02 0A 00` | `[3]` 1 = double lighting |
| Keymap row | `03 01 layer row` | 21 × u16 from `[4]`, for the *active* OS mode |
| Factory keymap row | `03 06 (os<<4 \| layer) row` | 21 × u16 from `[4]` |
| Performance | `04 01 row col` | same layout as the write |
| Advanced key | `06 01 row col 00` | `[4]` type, then the same layout as the write |
| Lighting effect | `05 01 00 00` | `[4]` open … `[9]` palette |
| Per-key colours | `05 03 00 page` | 15 × `B G R flag` from `[4]` |
| Macro settings / actions | `07 01 id` / `07 03 id chunk` | same layout as the writes |

A full read is about 250 packets. To read the other OS's keymap the client switches OS mode,
reads, and switches back, as the official site does.
