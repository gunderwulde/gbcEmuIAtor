// Banco de pruebas en C: compila con el compilador de K1 (web/src/cc) resolviendo la
// librería con includeResolver (lo mismo que hará la UI), ensambla con build() y ejecuta
// en core-probe.wasm. Exige cero errores y cero avisos.
import { compile } from "../../web/src/cc";
import { includeResolver } from "../../web/src/clib";
import { build } from "../../web/src/ui/run";
import { loadRom, now, runUntilLdBB, type Probe } from "../util/runners";

export const LINE = 456;
export const FRAME = 154 * LINE;
export const DOTS_PER_SECOND = 4194304;

export interface CBuild {
  asm: string;
  rom: Uint8Array;
  symbols: Map<string, { bank: number; addr: number }>;
}

/** Compila y ensambla; lanza con la lista de diagnósticos si hay errores o avisos. */
export function buildC(files: Map<string, string> | string, main = "main.c"): CBuild {
  const fs = typeof files === "string" ? new Map([[main, files]]) : files;
  const r = compile(fs, { main, includeResolver });
  if (r.errors.length) {
    throw new Error(`compile:\n${r.errors.slice(0, 20).map((e) => `${e.file}:${e.line}:${e.col}: ${e.severity}: ${e.msg}`).join("\n")}`);
  }
  const b = build(r.asm, { file: main.replace(/\.c$/, ".asm") });
  if (!b.ok || !b.rom) {
    const errs = b.result.errors.map((e) => `${e.file}:${e.line}: ${e.msg}`).concat(b.headerErrors);
    throw new Error(`no ensambla:\n${errs.slice(0, 20).join("\n")}`);
  }
  if (b.result.warnings?.length) {
    throw new Error(`avisos del ensamblador:\n${b.result.warnings.slice(0, 20).map((w) => `${w.file}:${w.line}: ${w.msg}`).join("\n")}`);
  }
  return { asm: r.asm, rom: b.rom, symbols: b.result.symbols };
}

export interface CMachine {
  x: Probe;
  build: CBuild;
  now(): number;
  /** Ejecuta `seconds` segundos más con la entrada dada (función del tiempo en puntos). */
  run(seconds: number, input?: (t: number) => number): void;
  /** Ejecuta hasta el LD B,B del crt0 (fin de main). */
  runToExit(maxSeconds?: number, input?: (t: number) => number): void;
  peek(addr: number): number;
  peek16(addr: number): number;
  sym(name: string): number;
  vram(bank: number, addr: number, len: number): number[];
  io(addr: number): number;
  pal(obj: boolean, n: number, idx: number): number;
  oam(): Uint8Array;
  /** Píxel del último frame: [r, g, b]. */
  pixel(x: number, y: number): [number, number, number];
  /** Texto de una fila del mapa (fuente cargada en el tile `first`: carácter = tile − first + 32). */
  text(map: number, col: number, row: number, len: number, first?: number): string;
  sram(): Uint8Array;
}

/** RGB555 → RGB888 sin corrección de color (docs/gbc-hardware.md §7.6: c·8 + c/4). */
export const rgb = (c: number): [number, number, number] => {
  const ch = (v: number) => (v << 3) | (v >> 2);
  return [ch(c & 31), ch((c >> 5) & 31), ch((c >> 10) & 31)];
};
export const RGB = (r: number, g: number, b: number): number => r | (g << 5) | (b << 10);

export async function startC(files: Map<string, string> | string, main = "main.c"): Promise<CMachine> {
  const b = buildC(files, main);
  return start(b);
}

export async function start(b: CBuild, sav?: Uint8Array): Promise<CMachine> {
  const x = await loadRom(b.rom);
  if (sav) {
    new Uint8Array(x.memory.buffer, x.gb_io_buffer(), sav.length).set(sav);
    x.gb_load_sav(sav.length);
  }
  const mem = () => new Uint8Array(x.memory.buffer);
  const m: CMachine = {
    x,
    build: b,
    now: () => now(x),
    run: (seconds, input) => runDots(x, Math.round(seconds * DOTS_PER_SECOND), input),
    runToExit: (maxSeconds = 10, input) => {
      if (!runUntilLdBB(x, maxSeconds, input)) throw new Error("main no ha vuelto (sin LD B,B)");
    },
    peek: (a) => x.gb_peek(a) & 0xff,
    peek16: (a) => (x.gb_peek(a) & 0xff) | ((x.gb_peek(a + 1) & 0xff) << 8),
    sym: (name) => {
      const s = b.symbols.get(name);
      if (!s) throw new Error(`falta el símbolo ${name}`);
      return s.addr;
    },
    vram: (bank, addr, len) => {
      const p = x.gb_vram() + bank * 0x2000 + (addr - 0x8000);
      return Array.from(mem().subarray(p, p + len));
    },
    io: (a) => mem()[x.gb_io() + (a === 0xffff ? 0x80 : a - 0xff00)]!,
    pal: (obj, n, idx) => {
      const p = x.gb_palettes() + (obj ? 64 : 0) + n * 8 + idx * 2;
      return mem()[p]! | (mem()[p + 1]! << 8);
    },
    oam: () => mem().slice(x.gb_oam(), x.gb_oam() + 160),
    pixel: (px, py) => {
      const p = x.gb_framebuffer() + (py * 160 + px) * 4;
      const f = mem();
      return [f[p]!, f[p + 1]!, f[p + 2]!];
    },
    text: (map, col, row, len, first = 0) =>
      String.fromCharCode(...m.vram(0, map + row * 32 + col, len).map((t) => t - first + 32)),
    sram: () => mem().slice(x.gb_sram(), x.gb_sram() + x.gb_sram_size()),
  };
  return m;
}

/** Como runFor de tests/util/runners.ts pero con el final en un número entero de puntos:
 *  runFor con segundos fraccionarios puede quedarse en un bucle sin fin si la máquina para
 *  justo en el entero truncado (end = 9227468,8 → run_until(9227468) ya no avanza). */
function runDots(x: Probe, dots: number, input: (t: number) => number = () => 0): void {
  // Sin `input`, ninguna tecla: si no, la última máscara de una llamada anterior seguiría
  // pulsada.
  const end = now(x) + dots;
  let pad = -1;
  while (now(x) < end) {
    const m = input(now(x));
    if (m !== pad) { x.gb_joypad(m); pad = m; }
    x.gb_t_run_until(Math.min(end, now(x) + 4 * LINE) >>> 0);
  }
  x.gb_t_ppu_state();
}

/** Entrada que pulsa `mask` entre los instantes `from` y `to` (en puntos absolutos). */
export const hold = (mask: number, from: number, to: number) => (t: number) => (t >= from && t < to ? mask : 0);
