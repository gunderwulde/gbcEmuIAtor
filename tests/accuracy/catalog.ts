// Catálogo de ROMs de exactitud: se descubre a partir de tests/fixtures (npm run fetch) y
// de reglas de aplicabilidad al modelo emulado (CGB, CPU CGB-E; docs/accuracy.md).
// Cada caso tiene un id estable "<suite>/<ruta>" que es la clave de known-failures.ts.
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { FIXTURES } from "../util/wasm";

export type Kind = "mooneye" | "blargg" | "screen";

export interface Case {
  id: string;               // clave estable: suite/ruta-sin-extensión
  suite: string;
  rom: string;              // relativo a tests/fixtures
  kind: Kind;
  ref?: string;             // PNG de referencia (kind = "screen")
  maxSeconds?: number;
  /** Botones por instante (rtc3test). */
  input?: Array<{ at: number; mask: number; dur: number }>;
  /** Capturar a tiempo fijo en vez de en LD B,B. */
  fixedTime?: boolean;
}

/** Casos que no aplican al CGB-E (o fuera de alcance): se listan en docs, no se ejecutan. */
export interface NotApplicable { id: string; reason: string }

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out.sort();
}

const rel = (p: string) => relative(FIXTURES, p).replace(/\\/g, "/");
const stem = (p: string) => p.replace(/\.(gbc?|png)$/, "");

/** Sufijos de modelo de mooneye (README "Test naming"): dmg0, dmgABC, mgb, sgb, sgb2,
 *  cgb0, cgbABCDE, agb0, ags; grupos G (DMG+MGB), S (SGB), C (todos los CGB), A (AGB).
 *  Sin sufijo = todos los modelos. */
function mooneyeAppliesToCgbE(name: string): boolean {
  const m = /-([A-Za-z0-9]+)$/.exec(name);
  if (!m) return true;
  const s = m[1]!;
  if (/^[GSCA]+$/.test(s)) return s.includes("C");
  if (s === "cgb") return true;
  return /^cgb[A-Z0-9]*E$/.test(s) || /^cgbABCDE$/.test(s);
}

/** AGE/SameSuite: tokens "cgbBCE", "ncmE" (CGB en modo no-CGB = compatibilidad), "dmgC"…
 *  Aplica si algún token cubre la revisión E del CGB (o no hay token de modelo). */
function revTokens(name: string): string[] {
  return name.split("-").slice(1).filter((t) => /^(dmg|cgb|ncm|mgb|sgb|agb|A$|S$|G$|C$)/.test(t));
}
function ageApplies(name: string): boolean {
  const t = revTokens(name);
  if (!t.length) return true;
  return t.some((x) => /^(cgb|ncm)[A-Z0-9]*E[A-Z0-9]*$/.test(x));
}

export function mooneyeCases(): { cases: Case[]; na: NotApplicable[] } {
  const base = join(FIXTURES, "gbtr", "mooneye-test-suite");
  const cases: Case[] = [];
  const na: NotApplicable[] = [];
  for (const f of walk(base).filter((p) => p.endsWith(".gb"))) {
    const r = rel(f);
    const id = stem(r.replace(/^gbtr\/mooneye-test-suite\//, "mooneye/"));
    const name = stem(f.split(/[\\/]/).pop()!);
    if (/\/(manual-only|madness|utils)\//.test(r)) { na.push({ id, reason: "no automática (manual-only/madness/utils)" }); continue; }
    if (/multicart/.test(name)) { na.push({ id, reason: "MBC1M (multicartucho) fuera de alcance (AGENTS.md §1)" }); continue; }
    if (!mooneyeAppliesToCgbE(name)) { na.push({ id, reason: "otro modelo (sufijo de mooneye)" }); continue; }
    cases.push({ id, suite: "mooneye", rom: r, kind: "mooneye" });
  }
  return { cases, na };
}

export function sameSuiteCases(): { cases: Case[]; na: NotApplicable[] } {
  const base = join(FIXTURES, "gbtr", "same-suite");
  const cases: Case[] = [];
  const na: NotApplicable[] = [];
  for (const f of walk(base).filter((p) => p.endsWith(".gb"))) {
    const r = rel(f);
    const id = stem(r.replace(/^gbtr\/same-suite\//, "samesuite/"));
    const name = stem(f.split(/[\\/]/).pop()!);
    if (r.includes("/sgb/")) { na.push({ id, reason: "SGB fuera de alcance" }); continue; }
    // Sufijos de revisión de SameSuite: -cgb0B, -cgbB, -A, -cgb0BC, -cgbDE…
    const m = /-([A-Za-z0-9]+)$/.exec(name);
    if (m && !/E/.test(m[1]!)) { na.push({ id, reason: `sólo revisión ${m[1]} (no CGB-E)` }); continue; }
    cases.push({ id, suite: "samesuite", rom: r, kind: "mooneye" });
  }
  return { cases, na };
}

export function ageCases(): { cases: Case[]; na: NotApplicable[] } {
  const base = join(FIXTURES, "gbtr", "age-test-roms");
  const files = walk(base);
  const pngs = files.filter((p) => p.endsWith(".png")).map(rel);
  const cases: Case[] = [];
  const na: NotApplicable[] = [];
  for (const f of files.filter((p) => p.endsWith(".gb"))) {
    const r = rel(f);
    const id = stem(r.replace(/^gbtr\/age-test-roms\//, "age/"));
    const name = stem(f.split(/[\\/]/).pop()!);
    // Captura: <stem>-<tokens>.png, con algún token aplicable al CGB-E.
    const shotsOf = (applicable: boolean) => pngs.filter((p) => {
      if (!p.startsWith(`${stem(r)}-`)) return false;
      const rest = stem(p).slice(stem(r).length + 1).split("-");
      if (!rest.every((t) => revTokens(`x-${t}`).length === 1)) return false; // otra ROM (p. ej. -ds)
      return !applicable || ageApplies(`x-${rest.join("-")}`);
    });
    const shots = shotsOf(true);
    if (r.includes("/caution/")) { na.push({ id, reason: "la propia suite advierte que puede dañar el hardware (speed-switch/caution)" }); continue; }
    if (shots.length) {
      cases.push({ id, suite: "age", rom: r, kind: "screen", ref: shots[0]! });
      continue;
    }
    if (shotsOf(false).length) { na.push({ id, reason: "sin captura de referencia para CGB-E" }); continue; }
    if (!ageApplies(name)) { na.push({ id, reason: "otro modelo/revisión (sufijo AGE)" }); continue; }
    cases.push({ id, suite: "age", rom: r, kind: "mooneye" });
  }
  return { cases, na };
}

/** Mealybug: capturas de CPU CGB D (la última revisión con referencias publicadas; para
 *  CGB-E se asume igual, como hacen SameBoy y la propia suite); si sólo hay de CGB C se
 *  usa ésa y se avisa en docs. Sin captura CGB = no aplica. */
export function mealybugCases(): { cases: Case[]; na: NotApplicable[] } {
  const base = join(FIXTURES, "gbtr", "mealybug-tearoom-tests");
  const files = walk(base);
  const have = new Set(files.map(rel));
  const cases: Case[] = [];
  const na: NotApplicable[] = [];
  for (const f of files.filter((p) => p.endsWith(".gb"))) {
    const r = rel(f);
    const id = stem(r.replace(/^gbtr\/mealybug-tearoom-tests\//, "mealybug/"));
    if (!r.includes("/ppu/")) {
      // dma/*-C y mbc/mbc3_rtc: resultado por registros (Fibonacci) en LD B,B.
      cases.push({ id, suite: "mealybug", rom: r, kind: "mooneye" });
      continue;
    }
    const d = `${stem(r)}_cgb_d.png`, c = `${stem(r)}_cgb_c.png`;
    const ref = have.has(d) ? d : have.has(c) ? c : null;
    if (!ref) { na.push({ id, reason: "sin captura de referencia de CGB" }); continue; }
    cases.push({ id, suite: "mealybug", rom: r, kind: "screen", ref });
  }
  return { cases, na };
}

const BLARGG_SINGLE = [
  "blargg/cpu_instrs/cpu_instrs.gb",
  "blargg/instr_timing/instr_timing.gb",
  "blargg/mem_timing/mem_timing.gb",
  "blargg/mem_timing-2/mem_timing.gb",
];

// halt_bug e interrupt_time no escriben por el puerto serie ni en A000h: el resultado sólo
// está en pantalla. Captura a tiempo fijo (howto de c-sp: 2 s emulados; se dan 3).
const BLARGG_SCREEN: Array<[string, string]> = [
  ["blargg/halt_bug.gb", "gbtr/blargg/halt_bug-dmg-cgb.png"],
  ["blargg/interrupt_time/interrupt_time.gb", "gbtr/blargg/interrupt_time/interrupt_time-cgb.png"],
];

export function blarggCases(): { cases: Case[]; na: NotApplicable[] } {
  const cases: Case[] = BLARGG_SINGLE.map((r) => ({
    id: stem(r), suite: "blargg", rom: r, kind: "blargg" as const, maxSeconds: 60,
  }));
  for (const [r, ref] of BLARGG_SCREEN) {
    if (existsSync(join(FIXTURES, ref))) {
      cases.push({ id: stem(r), suite: "blargg", rom: r, kind: "screen", ref, maxSeconds: 3, fixedTime: true });
    }
  }
  // cgb_sound: la ROM completa repite las pruebas sin fin; se usan las 12 sueltas.
  const singles = walk(join(FIXTURES, "gbtr", "blargg", "cgb_sound", "rom_singles")).filter((p) => p.endsWith(".gb"));
  for (const f of singles) {
    const r = rel(f);
    cases.push({ id: stem(r.replace(/^gbtr\/blargg\//, "blargg/")), suite: "blargg", rom: r, kind: "blargg", maxSeconds: 30 });
  }
  return { cases, na: [] };
}

// rtc3test (docs de c-sp): A → básicas (13 s), abajo+A → rangos (8 s), abajo,abajo,A →
// escrituras de sub-segundo (26 s). Pulsaciones de 0,1 s espaciadas, tras 1 s de menú.
const S = 4194304;
const press = (at: number, mask: number) => ({ at: at * S, mask, dur: 0.1 * S });
const DOWN = 8, A = 16;

export function rtc3Cases(): { cases: Case[]; na: NotApplicable[] } {
  const r = "gbtr/rtc3test/rtc3test.gb";
  const mk = (sub: string, keys: Array<{ at: number; mask: number; dur: number }>, secs: number): Case => ({
    id: `rtc3test/${sub}`, suite: "rtc3test", rom: r, kind: "screen",
    ref: `gbtr/rtc3test/rtc3test-${sub}-cgb.png`, input: keys, maxSeconds: secs, fixedTime: true,
  });
  return {
    cases: [
      mk("basic-tests", [press(1, A)], 1.5 + 13 + 2),
      mk("range-tests", [press(1, DOWN), press(1.5, A)], 2 + 8 + 2),
      mk("sub-second-writes", [press(1, DOWN), press(1.5, DOWN), press(2, A)], 2.5 + 26 + 2),
    ],
    na: [],
  };
}
