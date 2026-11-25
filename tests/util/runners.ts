// Runners genéricos de ROMs de test sobre core-probe.wasm (T1, docs/TEST-PLAN.md §1).
//
// - Blargg: texto por el puerto serie y/o en la RAM del cartucho (A000h: estado, firma
//   DE B0 61 en A001-A003, texto ASCIIZ desde A004).
// - mooneye / SameSuite / AGE: la ROM ejecuta LD B,B (40h) al terminar; B,C,D,E,H,L =
//   3,5,8,13,21,34 es éxito, 42h en todos es fallo.
// - Capturas: framebuffer frente a la imagen de referencia de la suite, exacto; si difiere
//   se escriben <nombre>-emu.png, -ref.png y -diff.png en build/test-out/.
//
// El tiempo se avanza con gb_t_run_until en tramos de una línea (456 puntos), así que
// "al ejecutar LD B,B" significa "como mucho una línea después". Cada ROM usa una
// instancia nueva de wasm (los contadores de los hooks no se reinician con gb_init).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPng as decodePng } from "./png-read";
import { encodePng } from "./png-write";
import { instantiate, ROOT } from "./wasm";

export type Probe = Record<string, any> & { memory: WebAssembly.Memory };

export const DOTS_PER_SECOND = 4194304;
const CHUNK = 456;

export async function loadRom(rom: Uint8Array): Promise<Probe> {
  const x = (await instantiate("core-probe")).exports as Probe;
  x.gb_init();
  new Uint8Array(x.memory.buffer, x.gb_rom(), rom.length).set(rom);
  const err = x.gb_insert(rom.length);
  if (err !== 0) throw new Error(`gb_insert: ${err}`);
  return x;
}

export const now = (x: Probe): number => (x.gb_cycles_lo() >>> 0) + (x.gb_cycles_hi() >>> 0) * 2 ** 32;

/** Avanza hasta el instante `t` (puntos desde el reset). */
export function runTo(x: Probe, t: number): void {
  while (now(x) < t) {
    const step = Math.min(t, now(x) + CHUNK);
    x.gb_t_run_until(step >>> 0);
  }
  x.gb_t_ppu_state(); // pone la PPU al día (framebuffer)
}

/** Ejecuta hasta el primer LD B,B nuevo o hasta `maxSeconds` emulados. `input(t)` da la
 *  máscara del joypad en cada tramo (opcional). */
export function runUntilLdBB(x: Probe, maxSeconds: number, input?: (dots: number) => number): boolean {
  const start = x.gb_t_ld_b_b() >>> 0;
  const end = now(x) + maxSeconds * DOTS_PER_SECOND;
  let pad = -1;
  while (now(x) < end) {
    if (input) {
      const m = input(now(x));
      if (m !== pad) { x.gb_joypad(m); pad = m; }
    }
    x.gb_t_run_until((now(x) + CHUNK) >>> 0);
    if ((x.gb_t_ld_b_b() >>> 0) !== start) {
      x.gb_t_ppu_state();
      return true;
    }
  }
  x.gb_t_ppu_state();
  return false;
}

export interface Regs { a: number; f: number; b: number; c: number; d: number; e: number; h: number; l: number; sp: number; pc: number }

export function regs(x: Probe): Regs {
  const r = new Uint8Array(x.memory.buffer, x.gb_regs(), 20);
  const dv = new DataView(x.memory.buffer, x.gb_regs(), 20);
  return {
    f: r[0]!, a: r[1]!, c: r[2]!, b: r[3]!, e: r[4]!, d: r[5]!, l: r[6]!, h: r[7]!,
    sp: dv.getUint16(8, true), pc: dv.getUint16(10, true),
  };
}

const hex = (n: number, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");
export const fmtRegs = (r: Regs): string =>
  `A=${hex(r.a)} F=${hex(r.f)} B=${hex(r.b)} C=${hex(r.c)} D=${hex(r.d)} E=${hex(r.e)} H=${hex(r.h)} L=${hex(r.l)} SP=${hex(r.sp, 4)} PC=${hex(r.pc, 4)}`;

export interface Result { pass: boolean; msg: string }

/** Resultado mooneye a partir de los registros en el LD B,B. */
export function mooneyeResult(x: Probe): Result {
  const r = regs(x);
  const fib = r.b === 3 && r.c === 5 && r.d === 8 && r.e === 13 && r.h === 21 && r.l === 34;
  if (fib) return { pass: true, msg: "ok" };
  const all42 = [r.b, r.c, r.d, r.e, r.h, r.l].every((v) => v === 0x42);
  return { pass: false, msg: `${all42 ? "fallo (42h)" : "registros inesperados"}: ${fmtRegs(r)}` };
}

/** mooneye/SameSuite/AGE: hasta LD B,B (límite: 120 s emulados como mooneye-gb, por
 *  defecto 30 s porque ninguna ROM aplicable tarda más de unos pocos). */
export async function runMooneye(rom: Uint8Array, maxSeconds = 30): Promise<Result> {
  const x = await loadRom(rom);
  if (!runUntilLdBB(x, maxSeconds)) {
    return { pass: false, msg: `sin LD B,B tras ${maxSeconds} s emulados: ${fmtRegs(regs(x))}` };
  }
  return mooneyeResult(x);
}

/** Texto de Blargg: serie + RAM del cartucho (si lleva la firma). */
export function blarggText(x: Probe): { serial: string; sram: string | null; status: number } {
  const sl = x.gb_t_serial_len() >>> 0;
  const serial = Buffer.from(new Uint8Array(x.memory.buffer, x.gb_t_serial_log(), sl)).toString("latin1");
  const size = x.gb_sram_size() >>> 0;
  if (size < 8) return { serial, sram: null, status: -1 };
  const s = new Uint8Array(x.memory.buffer, x.gb_sram(), size);
  if (s[1] !== 0xde || s[2] !== 0xb0 || s[3] !== 0x61) return { serial, sram: null, status: -1 };
  let end = 4;
  while (end < size && s[end] !== 0) end++;
  return { serial, sram: Buffer.from(s.subarray(4, end)).toString("latin1"), status: s[0]! };
}

/** Blargg: termina cuando el estado en A000h deja de ser 80h (si hay firma) o cuando el
 *  texto serie contiene "Passed"/"Failed". */
export async function runBlargg(rom: Uint8Array, maxSeconds = 60): Promise<Result> {
  const x = await loadRom(rom);
  const end = maxSeconds * DOTS_PER_SECOND;
  let t = 0;
  while (t < end) {
    t += DOTS_PER_SECOND / 4;
    runTo(x, t);
    const { serial, sram, status } = blarggText(x);
    if (sram !== null && status !== 0x80 && status !== -1) {
      // La firma se escribe antes que el estado definitivo: esperar a que el texto acabe.
      return { pass: status === 0 && !/Failed/.test(sram), msg: `A000=${hex(status)}: ${sram.trim()}` };
    }
    if (/Passed|Failed/.test(serial)) {
      // Dejar terminar la línea de texto.
      runTo(x, t + DOTS_PER_SECOND / 4);
      const s = blarggText(x).serial;
      return { pass: /Passed/.test(s) && !/Failed/.test(s), msg: s.trim() };
    }
  }
  const { serial, sram } = blarggText(x);
  return { pass: false, msg: `sin resultado tras ${maxSeconds} s: serie="${serial.trim()}" sram="${sram ?? ""}"` };
}

export interface ScreenDiff { diff: number; first: string; out: string | null }

/** Compara el framebuffer con un PNG de referencia (exacto). Si difiere, escribe las
 *  imágenes en build/test-out/<name>-{emu,ref,diff}.png. */
export function compareScreen(x: Probe, refPng: Uint8Array, name: string): ScreenDiff {
  const ref = decodePng(refPng);
  if (ref.width !== 160 || ref.height !== 144) throw new Error(`referencia ${ref.width}×${ref.height}`);
  const fb = new Uint8Array(x.memory.buffer, x.gb_framebuffer(), 160 * 144 * 4).slice();
  const diffImg = new Uint8Array(160 * 144 * 4);
  let diff = 0;
  let first = "";
  for (let i = 0; i < 160 * 144; i++) {
    const o = i * 4;
    const same = fb[o] === ref.rgba[o] && fb[o + 1] === ref.rgba[o + 1] && fb[o + 2] === ref.rgba[o + 2];
    if (!same) {
      if (!diff) {
        first = `(${i % 160},${Math.floor(i / 160)}) emu ${fb.subarray(o, o + 3).join(",")} ref ${ref.rgba.subarray(o, o + 3).join(",")}`;
      }
      diff++;
      diffImg.set([255, 0, 0, 255], o);
    } else {
      // Referencia atenuada para situar las diferencias.
      diffImg.set([ref.rgba[o]! >> 2, ref.rgba[o + 1]! >> 2, ref.rgba[o + 2]! >> 2, 255], o);
    }
  }
  let out: string | null = null;
  if (diff) {
    const dir = join(ROOT, "build", "test-out");
    mkdirSync(dir, { recursive: true });
    const safe = name.replace(/[^A-Za-z0-9_.-]+/g, "_");
    writeFileSync(join(dir, `${safe}-emu.png`), encodePng(fb, 160, 144));
    writeFileSync(join(dir, `${safe}-ref.png`), encodePng(ref.rgba, 160, 144));
    writeFileSync(join(dir, `${safe}-diff.png`), encodePng(diffImg, 160, 144));
    out = join(dir, `${safe}-diff.png`);
  }
  return { diff, first, out };
}

/** Ejecuta `seconds` emulados con el joypad dado por `input(t)`. */
export function runFor(x: Probe, seconds: number, input?: (dots: number) => number): void {
  const end = now(x) + seconds * DOTS_PER_SECOND;
  let pad = -1;
  while (now(x) < end) {
    if (input) {
      const m = input(now(x));
      if (m !== pad) { x.gb_joypad(m); pad = m; }
    }
    x.gb_t_run_until(Math.min(end, now(x) + CHUNK) >>> 0);
  }
  x.gb_t_ppu_state();
}

/** Pulsaciones {at, mask, dur} (puntos) → función de entrada para runFor/runUntilLdBB. */
export function presses(list: Array<{ at: number; mask: number; dur: number }>): (t: number) => number {
  return (t) => list.reduce((m, p) => (t >= p.at && t < p.at + p.dur ? m | p.mask : m), 0);
}

/** ROM de captura: hasta LD B,B (o a tiempo fijo con `fixedTime`) y comparación con la
 *  referencia. */
export async function runScreenshot(
  rom: Uint8Array, refPng: Uint8Array, name: string,
  opts: { maxSeconds?: number; input?: (dots: number) => number; fixedTime?: boolean } = {},
): Promise<Result> {
  const x = await loadRom(rom);
  const max = opts.maxSeconds ?? 10;
  if (opts.fixedTime) runFor(x, max, opts.input);
  else if (!runUntilLdBB(x, max, opts.input)) return { pass: false, msg: `sin LD B,B tras ${max} s` };
  const d = compareScreen(x, refPng, name);
  return { pass: d.diff === 0, msg: d.diff ? `${d.diff} píxeles distintos; primero ${d.first}; ${d.out}` : "ok" };
}
