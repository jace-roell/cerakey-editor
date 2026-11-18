// WebHID transport. Mirrors the official client: output report ID 0, one packet at
// a time, wait for the next input report as the reply, 1 s timeout, 3 attempts.
import { assertSafe, getDeviceInfo, getDeviceProtocol, parseDeviceInfo, REPORT_SIZE } from "./protocol";

/** Cerakey vendor interface (usagePage 0xFFB0, usage 1). PIDs 20481-20484 are the Peak60 family. */
export const HID_FILTERS: HIDDeviceFilter[] = [20481, 20482, 20483, 20484].map(productId => ({
  vendorId: 7334, productId, usagePage: 65456, usage: 1,
}));

const TIMEOUT_MS = 1000;
const ATTEMPTS = 3;

export const hidSupported = (): boolean => typeof navigator !== "undefined" && "hid" in navigator;

export class KeyboardDevice {
  private queue: Uint8Array[] = [];
  private waiter: ((d: Uint8Array | null) => void) | null = null;
  /** Optional wire log for debugging: called for every packet sent and received. */
  onTraffic: ((dir: "out" | "in", bytes: Uint8Array) => void) | null = null;

  private constructor(readonly hid: HIDDevice) {
    hid.addEventListener("inputreport", this.onInput);
  }

  get name(): string { return this.hid.productName || "Keyboard"; }
  get vendorId(): number { return this.hid.vendorId; }
  get productId(): number { return this.hid.productId; }

  /** Opens a device the page already has permission for, or asks the user to pick one. */
  static async connect(prompt: boolean): Promise<KeyboardDevice | null> {
    if (!hidSupported()) throw new Error("WebHID isn't available. Use Chrome or Edge, served from localhost (npm run dev).");
    const isVendorIface = (d: HIDDevice) => d.collections.some(c => c.usagePage === 65456 && c.usage === 1);
    let dev = (await navigator.hid.getDevices()).find(d => HID_FILTERS.some(f => f.productId === d.productId) && isVendorIface(d));
    if (!dev && prompt) {
      const picked = await navigator.hid.requestDevice({ filters: HID_FILTERS });
      dev = picked.find(isVendorIface) ?? picked[0];
    }
    if (!dev) return null;
    if (!dev.opened) await dev.open();
    return new KeyboardDevice(dev);
  }

  async close(): Promise<void> {
    this.hid.removeEventListener("inputreport", this.onInput);
    if (this.hid.opened) await this.hid.close();
  }

  private onInput = (e: HIDInputReportEvent): void => {
    const data = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength).slice();
    this.onTraffic?.("in", data);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(data);
    } else this.queue.push(data);
  };

  private nextReport(ms: number): Promise<Uint8Array | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiter = null; resolve(null); }, ms);
      this.waiter = d => { clearTimeout(timer); resolve(d); };
    });
  }

  private lock: Promise<unknown> = Promise.resolve();

  /** Sends one packet and resolves with the keyboard's reply. Calls are serialized, so
   *  auto-write and a manual write can never interleave packets and replies. */
  send(p: Uint8Array): Promise<Uint8Array> {
    assertSafe(p);
    const run = this.lock.then(() => this.sendNow(p));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async sendNow(p: Uint8Array): Promise<Uint8Array> {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      this.queue = [];
      try {
        this.onTraffic?.("out", p);
        await this.hid.sendReport(0, p);
        const reply = await this.nextReport(TIMEOUT_MS);
        if (reply) return reply;
        lastErr = new Error("no reply within 1 s");
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Command ${p[0]}/${p[1]} failed after ${ATTEMPTS} attempts: ${(lastErr as Error)?.message ?? lastErr}`);
  }

  async info(): Promise<{ protocol: string; appVersion: string; sn: string }> {
    const pv = await this.send(getDeviceProtocol());
    const di = parseDeviceInfo(await this.send(getDeviceInfo()));
    return { protocol: `${pv[2]}.${pv[3]}`, appVersion: di.appVersion, sn: di.sn };
  }
}

export const hex = (b: Uint8Array, n = REPORT_SIZE): string =>
  Array.from(b.slice(0, n), x => x.toString(16).padStart(2, "0")).join(" ");
