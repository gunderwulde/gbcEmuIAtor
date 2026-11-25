// CPU-01 · SingleStepTests/sm83 (v1) sobre core-test.wasm · oráculo EXT.
// Compara registros, IME, retardo de EI, memoria tocada y CADA ciclo M (tipo de acceso,
// dirección y valor en lecturas/escrituras; en los ciclos internos sólo el tipo, porque la
// suite deja ahí "la última dirección generada", que no es observable).
//
// Casos por opcode: 25 por defecto (fast); GB_SST_CASES=1000 (o "all") para el soak.
// Si faltan los fixtures (npm run fetch) el test se salta con un aviso.
//
// Única desviación de la suite, por hardware: STOP (10). La suite (traducida del núcleo
// de Ares) lo trata como 1 byte con dos ciclos internos. En el SM83 real, sin IRQ
// pendiente, STOP ocupa 2 bytes (Pan Docs "Using the STOP instruction"; SameBoy lee el
// segundo byte), y bus_stop() de testbus devuelve 0 → la CPU queda parada. Para 10 el
// valor esperado de PC y del 2º ciclo sale de esa fuente (DOC), no de la suite.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, instantiate } from "../../util/wasm";

const DIR = join(FIXTURES, "sm83", "v1");
const have = existsSync(join(DIR, ".fetched"));
if (!have) console.warn(`[CPU-01] Sin fixtures en ${DIR}: ejecuta "npm run fetch". Se salta.`);

const envCases = process.env.GB_SST_CASES;
const CASES = envCases === "all" ? Infinity : Number(envCases ?? 25);

interface State {
  pc: number; sp: number; a: number; b: number; c: number; d: number; e: number;
  f: number; h: number; l: number; ime: number; ei?: number; ram: [number, number][];
}
interface Case {
  name: string; initial: State; final: State;
  cycles: ([number | null, number | null, string] | null)[];
}

const KIND: Record<string, number> = { "r-m": 0, "-wm": 1, "---": 2 };
const KIND_NAME = ["R", "W", "-"];

const files = have ? readdirSync(DIR).filter((f) => f.endsWith(".json")).sort() : [];

const x = have ? ((await instantiate("core-test")).exports as Record<string, any>) : {};

describe.skipIf(!have)("CPU-01 SingleStepTests/sm83", () => {
  const memory = x.memory as WebAssembly.Memory;
  x.gbt_reset();
  const memPtr = x.gbt_mem() as number;
  const regsPtr = x.gbt_regs() as number;
  const logPtr = x.gbt_log() as number;

  function runCase(t: Case, opcodeFile: string): string | null {
    const mem = new Uint8Array(memory.buffer, memPtr, 65536);
    const rv = new DataView(memory.buffer, regsPtr, 20);
    const i = t.initial;
    for (const [a, v] of i.ram) mem[a] = v;
    rv.setUint8(0, i.f); rv.setUint8(1, i.a); rv.setUint8(2, i.c); rv.setUint8(3, i.b);
    rv.setUint8(4, i.e); rv.setUint8(5, i.d); rv.setUint8(6, i.l); rv.setUint8(7, i.h);
    rv.setUint16(8, i.sp, true); rv.setUint16(10, i.pc, true);
    rv.setUint8(12, i.ime); rv.setUint8(13, i.ei ?? 0);
    for (let k = 14; k < 20; k++) rv.setUint8(k, 0);
    x.gbt_log_clear();

    // Una instrucción. HALT y STOP dejan la CPU detenida: la suite muestrea esos ciclos
    // ociosos, así que se sigue dando pasos (cada uno = 1 ciclo interno) hasta igualarla.
    x.gbt_step();
    while ((rv.getUint8(14) || rv.getUint8(16)) && x.gbt_log_len() < t.cycles.length) x.gbt_step();

    const isStop = opcodeFile === "10.json";
    const fin = t.final;
    const expCycles = t.cycles.map((c) => c!);
    let expPc = fin.pc;
    if (isStop) {
      // DOC: STOP de 2 bytes sin IRQ pendiente (ver cabecera).
      expPc = (i.pc + 2) & 0xffff;
      const second = (i.pc + 1) & 0xffff;
      expCycles[1] = [second, mem[second]!, "r-m"];
    }

    const errs: string[] = [];
    const got = {
      a: rv.getUint8(1), f: rv.getUint8(0), b: rv.getUint8(3), c: rv.getUint8(2),
      d: rv.getUint8(5), e: rv.getUint8(4), h: rv.getUint8(7), l: rv.getUint8(6),
      sp: rv.getUint16(8, true), pc: rv.getUint16(10, true), ime: rv.getUint8(12), ei: rv.getUint8(13),
    };
    const exp = { ...fin, pc: expPc, ei: fin.ei ?? 0 };
    for (const k of ["a", "f", "b", "c", "d", "e", "h", "l", "sp", "pc", "ime", "ei"] as const) {
      if (got[k] !== exp[k]) errs.push(`${k}=${got[k].toString(16)} esperado ${exp[k]!.toString(16)}`);
    }
    for (const [a, v] of fin.ram) {
      if (mem[a] !== v) errs.push(`mem[${a.toString(16)}]=${mem[a]!.toString(16)} esperado ${v.toString(16)}`);
    }

    const n = x.gbt_log_len() as number;
    const log = new DataView(memory.buffer, logPtr, n * 8);
    const fmt = (k: number, a: number, v: number) => k === 2 ? "-" : `${KIND_NAME[k]} ${a.toString(16)}=${v.toString(16)}`;
    if (n !== expCycles.length) errs.push(`${n} ciclos M, esperados ${expCycles.length}`);
    for (let c = 0; c < Math.min(n, expCycles.length); c++) {
      const [ea, ev, ek] = expCycles[c]!;
      const kind = KIND[ek];
      const ga = log.getUint16(c * 8 + 4, true), gk = log.getUint8(c * 8 + 6), gv = log.getUint8(c * 8 + 7);
      const ok = gk === kind && (kind === 2 || (ga === ea && gv === ev));
      if (!ok) errs.push(`ciclo ${c}: ${fmt(gk, ga, gv)} esperado ${fmt(kind!, ea ?? 0, ev ?? 0)}`);
    }

    // Limpia lo tocado para el siguiente caso (evita borrar 64 KB por caso).
    for (const [a] of i.ram) mem[a] = 0;
    for (const [a] of fin.ram) mem[a] = 0;
    for (let c = 0; c < n; c++) if (log.getUint8(c * 8 + 6) === 1) mem[log.getUint16(c * 8 + 4, true)] = 0;
    return errs.length ? `${t.name}: ${errs.join("; ")}` : null;
  }

  for (const f of files) {
    it(f.replace(".json", ""), () => {
      const cases = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Case[];
      const fails: string[] = [];
      let total = 0;
      for (const t of cases.slice(0, Math.min(cases.length, CASES))) {
        total++;
        const e = runCase(t, f);
        if (e) fails.push(e);
      }
      expect(fails.length, `${fails.length}/${total} fallos; primero: ${fails[0]}`).toBe(0);
    });
  }
});
