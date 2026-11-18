// A simulated Peak60 for tests: a register store that keeps what's written and answers
// reads with the same byte layout as the real protocol (replies echo the request header;
// read replies reuse the write packet's payload layout).
import { buildWritePlan } from "../src/hid/writer";
import type { KeyboardConfig } from "../src/types";

const le16 = (t: Uint8Array, i: number) => t[i] | (t[i + 1] << 8);
const grid = () => Array.from({ length: 2 }, () => Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => new Array(21).fill(0))));

export class SimKeyboard {
  system = 0; // 0 WIN, 1 MAC
  layouts = grid(); // [os][layer][row][col]
  defaults = grid();
  regs = new Map<string, Uint8Array>();
  log: Uint8Array[] = [];
  /** Set to make the keyboard stop answering. */
  dead = false;

  static from(cfg: KeyboardConfig): SimKeyboard {
    const sim = new SimKeyboard();
    for (const k of cfg.keyboards.flat()) {
      (["win", "mac"] as const).forEach((os, o) => [0, 1, 2, 3].forEach(l => {
        const s = k.customKeys[os][`fn${l}` as "fn0"];
        sim.defaults[o][l][k.row][k.col] = s.defaultKeycode as number;
      }));
    }
    for (const s of buildWritePlan(cfg)) sim.handle(s.packet);
    sim.log = [];
    return sim;
  }

  private store(key: string, p: Uint8Array, readSub: number): void {
    const copy = p.slice();
    copy[1] = readSub;
    this.regs.set(key, copy);
  }

  handle(p: Uint8Array): Uint8Array {
    this.log.push(p.slice());
    const reply = new Uint8Array(64);
    reply.set(p.slice(0, 4));
    const [cat, sub] = p;
    const k = `${cat}/${p[2]}/${p[3]}`;
    const recall = (key: string) => { const r = this.regs.get(key); if (r) reply.set(r); };
    switch (`${cat}/${sub}`) {
      case "1/1": reply.set([1, 1, 1, 3, 0, 0]); break;
      case "1/2": reply.set([0, 1, 5, 0], 8); reply.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2], 17); break;
      case "2/4": if (p[2] === 2) this.system = p[3]; reply[3] = this.system; break;
      case "2/10": reply[3] = 0; break;
      case "3/4": this.layouts[this.system][p[2]][p[3]][p[4]] = le16(p, 5); break;
      case "3/1": this.layouts[this.system][p[2]][p[3]].forEach((c, i) => { reply[4 + 2 * i] = c & 255; reply[5 + 2 * i] = c >> 8; }); break;
      case "3/6": this.defaults[p[2] >> 4][p[2] & 15][p[3]].forEach((c, i) => { reply[4 + 2 * i] = c & 255; reply[5 + 2 * i] = c >> 8; }); break;
      case "4/2": this.store(k, p, 1); break;
      case "4/1": recall(k); break;
      case "6/2": this.store(k, p, 1); break;
      case "6/1": recall(k); reply[4] = this.regs.get(k)?.[4] ?? 0; break;
      case "5/2": this.store("light", p, 1); break;
      case "5/1": recall("light"); break;
      case "5/4": this.store(`page${p[3]}`, p, 3); break;
      case "5/3": recall(`page${p[3]}`); break;
      case "7/2": this.store(`macro${p[2]}`, p, 1); break;
      case "7/1": recall(`macro${p[2]}`); reply[2] = p[2]; break;
      case "7/4": this.store(`mdata${p[2]}/${p[3]}`, p, 3); break;
      case "7/3": recall(`mdata${p[2]}/${p[3]}`); break;
      default: throw new Error(`SimKeyboard: unexpected command ${cat}/${sub}`);
    }
    return reply;
  }

  async send(p: Uint8Array): Promise<Uint8Array> {
    if (this.dead) throw new Error("no reply within 1 s");
    return this.handle(p);
  }
}
