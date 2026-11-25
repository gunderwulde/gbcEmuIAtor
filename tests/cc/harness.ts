// Banco de pruebas del compilador (K1): compila C, ensambla con build() (lo mismo que la
// UI) y ejecuta en core-probe.wasm hasta el LD B,B del crt0 (fin de main).
import { compile, type CcOptions } from "../../web/src/cc";
import { build } from "../../web/src/ui/run";
import { loadRom, now, regs, runUntilLdBB, type Probe } from "../util/runners";

export interface Built { asm: string; rom: Uint8Array; symbols: Map<string, { bank: number; addr: number }> }

/** Compila y ensambla; lanza con los diagnósticos si hay errores (de compilador o ensamblador). */
export function buildC(src: string | Map<string, string>, opts: Partial<CcOptions> = {}): Built {
  const files = typeof src === "string" ? new Map([["main.c", src]]) : src;
  const r = compile(files, { main: "main.c", ...opts });
  const errs = r.errors.filter((e) => e.severity === "error");
  if (errs.length) throw new Error(`compile:\n${errs.map((e) => `${e.file}:${e.line}:${e.col}: ${e.msg}`).join("\n")}`);
  const b = build(r.asm, { file: "main.asm" });
  if (!b.ok || !b.rom) {
    const lines = r.asm.split("\n");
    const es = b.result.errors.map((e) => `${e.file}:${e.line}: ${e.msg}  | ${lines[e.line - 1] ?? ""}`).concat(b.headerErrors);
    throw new Error(`no ensambla:\n${es.slice(0, 20).join("\n")}`);
  }
  return { asm: r.asm, rom: b.rom, symbols: b.result.symbols };
}

export interface Run {
  x: Probe;
  b: Built;
  /** Byte / palabra de una variable global por nombre de C. */
  u8(name: string, i?: number): number;
  u16(name: string, i?: number): number;
  s16(name: string, i?: number): number;
  hl(): number;
}

/** Compila, ejecuta main hasta el final y devuelve accesores a la memoria. */
export async function runC(src: string | Map<string, string>, opts: Partial<CcOptions> = {}, seconds = 5): Promise<Run> {
  const b = buildC(src, opts);
  const x = await loadRom(b.rom);
  if (!runUntilLdBB(x, seconds)) throw new Error("main no ha vuelto");
  const addr = (n: string) => {
    const s = b.symbols.get("_" + n);
    if (!s) throw new Error(`falta el símbolo _${n}`);
    return s.addr;
  };
  const pk = (a: number) => x.gb_peek(a) & 0xff;
  return {
    x, b,
    u8: (n, i = 0) => pk(addr(n) + i),
    u16: (n, i = 0) => pk(addr(n) + 2 * i) | (pk(addr(n) + 2 * i + 1) << 8),
    s16: (n, i = 0) => { const v = pk(addr(n) + 2 * i) | (pk(addr(n) + 2 * i + 1) << 8); return v >= 0x8000 ? v - 0x10000 : v; },
    hl: () => { const r = regs(x); return (r.h << 8) | r.l; },
  };
}

/**
 * Ciclos M de `main` (de su primera instrucción a la vuelta al crt0), a paso de
 * instrucción con gb_step. Las interrupciones están desactivadas (el crt0 hace DI).
 */
export async function cyclesOfMain(src: string, opts: Partial<CcOptions> = {}, maxSteps = 50_000_000): Promise<{ m: number; run: Run }> {
  const b = buildC(src, opts);
  const x = await loadRom(b.rom);
  const main = b.symbols.get("_main")!.addr;
  const exit = b.symbols.get("__exit")!.addr;
  const pc = () => regs(x).pc;
  let n = 0;
  while (pc() !== main) { x.gb_step(); if (++n > 1_000_000) throw new Error("no llega a main"); }
  const t0 = now(x);
  n = 0;
  while (pc() !== exit) { x.gb_step(); if (++n > maxSteps) throw new Error("main no vuelve"); }
  const m = (now(x) - t0) / 4;
  const pk = (a: number) => x.gb_peek(a) & 0xff;
  const addr = (s: string) => b.symbols.get("_" + s)!.addr;
  return {
    m,
    run: {
      x, b,
      u8: (s, i = 0) => pk(addr(s) + i),
      u16: (s, i = 0) => pk(addr(s) + 2 * i) | (pk(addr(s) + 2 * i + 1) << 8),
      s16: (s, i = 0) => { const v = pk(addr(s) + 2 * i) | (pk(addr(s) + 2 * i + 1) << 8); return v >= 0x8000 ? v - 0x10000 : v; },
      hl: () => { const r = regs(x); return (r.h << 8) | r.l; },
    },
  };
}
