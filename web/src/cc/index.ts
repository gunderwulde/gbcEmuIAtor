// Compilador de C a SM83 (K1). Puro (sin DOM), determinista. Genera fuente para el
// ensamblador de A1 (web/src/asm). ABI: docs/c-abi.md. Uso y cLineMap: README.md.

import { ASM_BEGIN, ASM_END, CodeGen, MARK } from "./codegen";
import type { Token } from "./lexer";
import { asmRefs, constAddr, parseFile, Program } from "./parser";
import { insnSize, peephole } from "./peephole";
import { Preprocessor, type Diag } from "./preproc";
import { crt0, helperCode, OAM_DMA_CODE, OAM_DMA_SIZE, vectors } from "./runtime";
import { IRQ_VECTORS, sizeOf, type FuncInfo, type Init, type IrqSource, type Pos, type Stmt, type Type, type VarSym } from "./types";

export interface CcError { file: string; line: number; col: number; msg: string; severity: "error" | "warning" }
export interface CLine { file: string; line: number; asmLine: number }

export interface CcOptions {
  /** Nombre (clave de `files`) del fichero con main. */
  main: string;
  /** Resuelve #include y #pragma link que no están en `files` (la librería). */
  includeResolver?: (name: string, from: string) => string | undefined;
  /** Optimizador de mirilla (por defecto sí; false para medirlo). */
  peephole?: boolean;
  /** Arranque estándar: vectores, cabecera, crt0 y rutina de OAM DMA (por defecto sí). */
  crt0?: boolean;
  /** Bytes reservados para la pila en WRAM0 (por defecto 512). */
  stackSize?: number;
  /** Sólo compila `main` y lo enlazado, no el resto de .c de `files`. */
  onlyMain?: boolean;
}

export interface CcResult {
  asm: string;
  errors: CcError[];
  cLineMap: CLine[];
  /** Funciones emitidas (las alcanzables) y eliminadas por no usarse. */
  emitted: string[];
  removed: string[];
  /** Convención y marco de cada función emitida (para tests y el depurador). */
  frames: Map<string, { conv: "static" | "stack"; base?: number; size: number }>;
  /** Ocupación estimada (bytes): código+datos de ROM0 y de cada banco, y WRAM0. */
  usage: { rom0: number; banks: Map<number, number>; wram0: { oam: number; frames: number; data: number; bss: number; stack: number } };
}

const FRAMES_BASE = 0xc0a0;
const WRAM0_END = 0xd000;
const ROM0_FREE = 0x4000 - 0x150;
const BANK_SIZE = 0x4000;

export function compile(files: Map<string, string>, opts: CcOptions): CcResult {
  const diags: Diag[] = [];
  const empty = (errors: CcError[]): CcResult => ({
    asm: "", errors, cLineMap: [], emitted: [], removed: [], frames: new Map(),
    usage: { rom0: 0, banks: new Map(), wram0: { oam: 0, frames: 0, data: 0, bss: 0, stack: 0 } },
  });
  const res = opts.includeResolver;
  const fromFiles = (n: string) => (files.has(n) ? { name: n, text: files.get(n)! } : undefined);
  const fromRes = (n: string, from: string) => {
    const t = res?.(n, from);
    return t === undefined ? undefined : { name: n, text: t };
  };
  const resolve = (n: string, from: string, angle: boolean) =>
    angle ? (fromRes(n, from) ?? fromFiles(n)) : (fromFiles(n) ?? fromRes(n, from));

  const sources = new Map<string, string[]>();
  const prog = new Program();
  const queue: { name: string; text: string }[] = [];
  const seen = new Set<string>();
  const mainText = files.get(opts.main);
  if (mainText === undefined) return empty([{ file: opts.main, line: 1, col: 1, msg: `no existe el fichero '${opts.main}'`, severity: "error" }]);
  queue.push({ name: opts.main, text: mainText });
  seen.add(opts.main);
  if (!opts.onlyMain) for (const [n, t] of files) if (/\.c$/i.test(n) && !seen.has(n)) { queue.push({ name: n, text: t }); seen.add(n); }
  const linkedAsm: { name: string; text: string }[] = [];

  const resolveTracked = (n: string, from: string, angle: boolean) => {
    const r = resolve(n, from, angle);
    if (r && !sources.has(r.name)) sources.set(r.name, r.text.split("\n"));
    return r;
  };

  for (let fi = 0; fi < queue.length; fi++) {
    const u = queue[fi]!;
    sources.set(u.name, u.text.split("\n"));
    const pp = new Preprocessor(resolveTracked, diags);
    const toks: Token[] = pp.run(u.name, u.text);
    const last = toks[toks.length - 1];
    toks.push({ k: "eof", v: "", file: u.name, line: (last?.line ?? 1) + 1, col: 1, bol: true });
    parseFile(toks, fi, prog, diags);
    for (const l of pp.links) {
      if (seen.has(l.name)) continue;
      seen.add(l.name);
      const r = resolveTracked(l.name, l.from.file, true);
      if (!r) { diags.push({ file: l.from.file, line: l.from.line, col: l.from.col, msg: `#pragma link: no se encuentra '${l.name}'`, severity: "error" }); continue; }
      if (/\.c$/i.test(l.name)) queue.push(r);
      else linkedAsm.push(r);
    }
  }

  // ---- enlace -------------------------------------------------------------------
  assignLabels(prog);
  const allAsm = [...prog.asmBlocks.map((b) => b.text), ...linkedAsm.map((a) => a.text)].join("\n");
  /** Funciones nombradas desde ensamblador: raíces con convención de pila. */
  const fromAsm = new Set<FuncInfo>();
  const noteAsm = (r: VarSym | FuncInfo) => { if (!("kind" in r)) fromAsm.add(r); };
  for (const b of prog.asmBlocks) for (const r of asmRefs(b.text, prog)) { b.refs.add(r); noteAsm(r); }
  for (const f of prog.funcs) if (f.body) walkAsm(f.body, (t) => { for (const r of asmRefs(t, prog)) { f.refs.add(r); noteAsm(r); } });
  const linkedRefs = linkedAsm.flatMap((a) => asmRefs(a.text, prog));
  for (const r of linkedRefs) noteAsm(r);

  const mainF = prog.funcs.find((f) => f.name === "main" && !f.isStatic);
  if (!mainF?.defined) diags.push({ file: opts.main, line: 1, col: 1, msg: "falta la función main", severity: "error" });

  // Rutinas de interrupción: una por fuente; siempre vivas.
  const isrs = new Map<IrqSource, FuncInfo>();
  for (const f of prog.funcs) {
    if (!f.interrupt) continue;
    const o = isrs.get(f.interrupt);
    if (o && o !== f) diags.push({ ...f.pos, msg: `ya hay una rutina para la interrupción ${f.interrupt}: '${o.name}'`, severity: "error" });
    else isrs.set(f.interrupt, f);
  }

  // Alcanzables desde main, las interrupciones y el ensamblador.
  const live = new Set<VarSym | FuncInfo>();
  const work: (VarSym | FuncInfo)[] = [];
  const mark = (s: VarSym | FuncInfo) => { if (!live.has(s)) { live.add(s); work.push(s); } };
  if (mainF) mark(mainF);
  for (const f of isrs.values()) mark(f);
  for (const b of prog.asmBlocks) for (const r of b.refs) mark(r);
  for (const r of linkedRefs) mark(r);
  while (work.length) {
    const s = work.pop()!;
    for (const r of s.refs ?? []) mark(r);
  }

  // Externas sin definición en C: deben estar en el ensamblador (o ser del crt0).
  const crtLabels = new Set(opts.crt0 === false ? [] : ["_shadow_oam"]);
  const definedInAsm = (label: string) => crtLabels.has(label) || new RegExp(`(^|\\n)[ \\t]*${label.replace(/[.$?@]/g, "\\$&")}:`).test(allAsm);
  for (const s of live) {
    if (!("kind" in s)) {
      if (!s.defined && !definedInAsm(s.label)) diags.push({ ...s.pos, msg: `función '${s.name}' declarada y usada pero no definida (ni en C ni en ensamblador)`, severity: "error" });
    } else if (s.extern && !definedInAsm(s.label)) {
      diags.push({ ...s.pos, msg: `variable '${s.name}' declarada extern y usada pero no definida`, severity: "error" });
    }
  }

  let errors = finishDiags(diags);
  if (errors.some((e) => e.severity === "error")) return empty(errors);

  // ---- convenciones y marcos (docs/c-abi.md §3.1, §4) -------------------------------------
  const liveFuncs = prog.funcs.filter((f) => live.has(f));
  const frameInfo = layoutFrames(liveFuncs, mainF!, [...isrs.values()], fromAsm);
  const stackSize = opts.stackSize ?? 512;

  // ---- código --------------------------------------------------------------------
  const srcLine = (file: string, line: number) => sources.get(file)?.[line - 1] ?? "";
  const gen = new CodeGen(prog, diags, srcLine);
  const emitted: string[] = [], removed: string[] = [];
  const volatile = new Set(prog.globals.filter((g) => g.at !== undefined).map((g) => g.label));
  /** Código por banco (0 = ROM0) y bytes estimados, con la posición de cada función. */
  const code = new Map<number, string[]>();
  const sizes: { bank: number; bytes: number; pos: Pos; what: string }[] = [];
  const funcs = prog.funcs.filter((f) => f.defined);
  const order = [...funcs.filter((f) => f === mainF), ...funcs.filter((f) => f !== mainF)];
  for (const f of order) {
    if (!live.has(f)) { removed.push(f.name); continue; }
    const start = gen.out.length;
    gen.genFunc(f);
    emitted.push(f.name);
    const part = gen.out.splice(start);
    if (opts.peephole !== false) peephole(part, { volatile });
    const dst = code.get(f.bank) ?? [];
    dst.push(...part);
    code.set(f.bank, dst);
    sizes.push({ bank: f.bank, bytes: estimate(part), pos: f.pos, what: `la función '${f.name}'` });
  }

  // Datos: rodata (const, en su banco), data (imagen en ROM0, variable en WRAM0), bss.
  const rodata = new Map<number, string[]>();
  const dataImg: string[] = [], dataVars: string[] = [], bss: string[] = [], defs: string[] = [];
  let dataSize = 0, bssSize = 0;
  const wramItems: { bytes: number; pos: Pos; what: string }[] = [];
  for (const v of prog.globals) {
    if (!live.has(v) || v.extern) continue;
    if (v.at !== undefined) { defs.push(`DEF ${v.label} EQU $${hex4(v.at)}`); continue; }
    const sz = Math.max(1, sizeOf(v.type));
    if (v.init && constObject(v.type)) {
      const b = v.bank ?? 0;
      const lines = [`${v.label}:`, ...emitInit(v.init, sz, gen, b)];
      const dst = rodata.get(b) ?? [];
      dst.push(...lines);
      rodata.set(b, dst);
      sizes.push({ bank: b, bytes: sz, pos: v.pos, what: `la constante '${v.name}'` });
    } else if (v.init) {
      dataImg.push(...emitInit(v.init, sz, gen, 0));
      dataVars.push(`${v.label}:`, `        ds ${sz}`);
      dataSize += sz;
      sizes.push({ bank: 0, bytes: sz, pos: v.pos, what: `el valor inicial de '${v.name}'` });
      wramItems.push({ bytes: sz, pos: v.pos, what: `'${v.name}'` });
    } else {
      bss.push(`${v.label}:`, `        ds ${sz}`);
      bssSize += sz;
      wramItems.push({ bytes: sz, pos: v.pos, what: `'${v.name}'` });
    }
  }
  for (const b of gen.blobs) {
    const dst = rodata.get(b.bank) ?? [];
    dst.push(`${b.label}:`, ...emitInit(b.init, b.size, gen, b.bank));
    rodata.set(b.bank, dst);
    sizes.push({ bank: b.bank, bytes: b.size, pos: { file: opts.main, line: 1, col: 1 }, what: "un inicializador local" });
  }
  // Las cadenas al final: emitInit puede haber añadido nuevas.
  for (const s of gen.stringOrder) {
    const dst = rodata.get(s.bank) ?? [];
    dst.push(`${s.label}:`, ...dbLines([...s.bytes, 0]));
    rodata.set(s.bank, dst);
    sizes.push({ bank: s.bank, bytes: s.bytes.length + 1, pos: { file: opts.main, line: 1, col: 1 }, what: "una cadena" });
  }

  // Errores de la generación (llamadas entre bancos…).
  errors = finishDiags(diags);
  if (errors.some((e) => e.severity === "error")) return empty(errors);

  // ---- comprobación de tamaños (docs/c-abi.md §5.1) ------------------------------------------
  const withCrt = opts.crt0 !== false;
  const hc = helperCode(gen.helpers);
  const fixed0 = (withCrt ? estimate(crt0(dataSize).split("\n").map((l) => l.replace(/^\s+/, "        "))) + OAM_DMA_SIZE : 0)
    + estimate(hc.split("\n").map((l) => l.replace(/^\s+/, "        ")));
  const used = new Map<number, number>([[0, fixed0]]);
  const overflow = new Set<number>();
  for (const s of sizes) {
    const n = (used.get(s.bank) ?? 0) + s.bytes;
    used.set(s.bank, n);
    const cap = s.bank === 0 ? ROM0_FREE : BANK_SIZE;
    if (n > cap && !overflow.has(s.bank)) {
      overflow.add(s.bank);
      diags.push({ ...s.pos, msg: `${s.bank === 0 ? "ROM0" : `el banco ${s.bank}`} no cabe: con ${s.what} van ~${n} bytes y caben ${cap}${s.bank === 0 ? " (pasa funciones o datos const a otro banco con #pragma bank)" : ""}`, severity: "error" });
    }
  }
  const oamBytes = withCrt ? 160 : 0;
  const framesBytes = frameInfo.total;
  const wram0 = { oam: oamBytes, frames: framesBytes, data: dataSize, bss: bssSize, stack: stackSize };
  const wramCap = WRAM0_END - 0xc000;
  if (oamBytes + framesBytes + stackSize > wramCap) {
    diags.push({ ...mainF!.pos, msg: `WRAM0 no cabe: OAM sombra ${oamBytes} + marcos ${framesBytes} + pila ${stackSize} = ${oamBytes + framesBytes + stackSize} bytes de ${wramCap}`, severity: "error" });
  } else {
    let n = oamBytes + framesBytes + stackSize;
    for (const it of wramItems) {
      n += it.bytes;
      if (n > wramCap) {
        diags.push({ ...it.pos, msg: `WRAM0 no cabe con ${it.what}: OAM sombra ${oamBytes} + marcos ${framesBytes} + .data ${dataSize} + BSS ${bssSize} + pila ${stackSize} = ${oamBytes + framesBytes + dataSize + bssSize + stackSize} bytes de ${wramCap} (usa __at en WRAMX $D000-$DFFF para arrays grandes)`, severity: "error" });
        break;
      }
    }
  }
  errors = finishDiags(diags);
  if (errors.some((e) => e.severity === "error")) return empty(errors);

  // ---- salida --------------------------------------------------------------------------------
  const out: string[] = [`; Generado por el compilador de C de gbcEmuIAtor (K1). ABI: docs/c-abi.md`];
  out.push(...defs);
  for (const f of liveFuncs) {
    const fi = frameInfo.funcs.get(f);
    if (fi?.conv === "static") out.push(`DEF __fr_${f.label} EQU $${hex4(FRAMES_BASE + fi.base!)}`);
  }
  if (withCrt) {
    const vec: (string | undefined)[] = (Object.keys(IRQ_VECTORS) as IrqSource[]).map((s) => isrs.get(s)?.label);
    out.push("", vectors(vec));
  }
  out.push("", `SECTION "C code", ROM0`);
  if (withCrt) out.push(crt0(dataSize), OAM_DMA_CODE);
  out.push(...(code.get(0) ?? []));
  if (hc) out.push("", "; runtime", hc);
  if (rodata.get(0)?.length) out.push("", "; rodata", ...rodata.get(0)!);
  if (dataSize) out.push("", "; imagen de .data (el crt0 la copia a WRAM0)", "__data_img:", ...dataImg);
  const banks = new Set([...code.keys(), ...rodata.keys()]);
  for (const b of [...banks].filter((b) => b !== 0).sort((x, y) => x - y)) {
    out.push("", `SECTION "C bank ${b}", ROMX, BANK[${b}]`, ...(code.get(b) ?? []), ...(rodata.get(b) ?? []));
  }
  if (withCrt) out.push("", `SECTION "C shadow_oam", WRAM0[$C000]`, "_shadow_oam:", "        ds 160");
  if (framesBytes) out.push(`SECTION "C frames", WRAM0[$${hex4(FRAMES_BASE)}]`, "__frames:", `        ds ${framesBytes}`);
  if (dataSize) out.push(`SECTION "C data", WRAM0`, "__data_start:", ...dataVars);
  if (bssSize) out.push(`SECTION "C bss", WRAM0`, ...bss);
  if (stackSize) out.push(`SECTION "C stack", WRAM0[$${hex4(WRAM0_END - stackSize)}]`, "__stack:", `        ds ${stackSize}`);
  out.push(`SECTION "C hram", HRAM`, "__cur_bank:", "        ds 1", "__oam_dma_hram:", `        ds ${OAM_DMA_SIZE}`);
  let asmN = 0;
  for (const b of prog.asmBlocks) { out.push("", `SECTION "C asm ${asmN++}", ROM0`, `; __asm de ${b.file}:${b.line}`); gen.out = []; gen.asmText(b.text, b.file, b.line); out.push(...gen.out); }
  for (const a of linkedAsm) out.push("", `SECTION "C asm ${asmN++}", ROM0`, `; #pragma link "${a.name}"`, ASM_BEGIN, a.text, ASM_END);

  // Texto final y cLineMap.
  const lines = out.join("\n").split("\n").filter((l) => l !== ASM_BEGIN && l !== ASM_END);
  const cLineMap: CLine[] = [];
  const final: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith(MARK)) {
      // Una marca sin código detrás (otra marca a continuación) no se mapea.
      let j = i + 1;
      while (j < lines.length && (lines[j]!.trim() === "" || (/^\s*;/.test(lines[j]!) && !lines[j]!.startsWith(MARK)))) j++;
      if (j < lines.length && lines[j]!.startsWith(MARK)) continue;
      const m = /^;#(.*):(\d+): /.exec(l)!;
      final.push("; " + l.slice(2));
      cLineMap.push({ file: m[1]!, line: Number(m[2]), asmLine: final.length });
      continue;
    }
    final.push(l);
  }
  const frames = new Map<string, { conv: "static" | "stack"; base?: number; size: number }>();
  for (const [f, fi] of frameInfo.funcs) if (f.defined) frames.set(f.name, { conv: fi.conv, base: fi.base === undefined ? undefined : FRAMES_BASE + fi.base, size: fi.size });
  const bankUse = new Map([...used].filter(([b]) => b !== 0));
  return {
    asm: final.join("\n") + "\n", errors: finishDiags(diags), cLineMap, emitted, removed, frames,
    usage: { rom0: (used.get(0) ?? 0) + 0x150, banks: bankUse, wram0 },
  };
}

/** El objeto entero es const (un array lo es si lo son sus elementos): va a ROM. */
function constObject(t: Type): boolean {
  return !!t.c || (t.k === "array" && constObject(t.of));
}

const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, "0");

/** Bytes estimados (por exceso) de un tramo de código generado. */
function estimate(lines: string[]): number {
  let n = 0;
  let inAsm = false;
  for (const l of lines) {
    if (l === ASM_BEGIN) { inAsm = true; continue; }
    if (l === ASM_END) { inAsm = false; continue; }
    const t = l.trim();
    if (!t || t.startsWith(";") || /:$/.test(t)) continue;
    // Ensamblador del usuario: 3 bytes por línea es una cota razonable (no exacta).
    n += inAsm ? 3 : insnSize(t);
  }
  return n;
}

// ---- marcos ----------------------------------------------------------------------------------
interface FrameAlloc { funcs: Map<FuncInfo, { conv: "static" | "stack"; base?: number; size: number }>; total: number }

/**
 * Decide la convención de cada función y coloca los marcos estáticos (docs/c-abi.md §4.1):
 * cada función por encima de todas sus llamadoras (camino más largo en el DAG de
 * componentes fuertemente conexas); `main` y sus descendientes abajo y cada otra raíz en
 * una región propia encima.
 */
function layoutFrames(funcs: FuncInfo[], mainF: FuncInfo, isrList: FuncInfo[], fromAsm: Set<FuncInfo>): FrameAlloc {
  const set = new Set(funcs);
  const callees = new Map<FuncInfo, FuncInfo[]>();
  for (const f of funcs) callees.set(f, [...f.refs].filter((r): r is FuncInfo => !("kind" in r) && set.has(r) && r.defined));
  const roots: FuncInfo[] = [mainF];
  for (const f of [...isrList, ...funcs]) {
    if (roots.includes(f)) continue;
    if (isrList.includes(f) || fromAsm.has(f) || f.addrTaken) roots.push(f);
  }
  // Raíces que alcanzan a cada función.
  const reach = new Map<FuncInfo, Set<FuncInfo>>();
  for (const r of roots) {
    const st = [r];
    const seen = new Set<FuncInfo>([r]);
    while (st.length) {
      const f = st.pop()!;
      const s = reach.get(f) ?? new Set();
      s.add(r);
      reach.set(f, s);
      for (const g of callees.get(f) ?? []) if (!seen.has(g)) { seen.add(g); st.push(g); }
    }
  }
  // Componentes fuertemente conexas (Tarjan, iterativo para no agotar la pila de JS).
  const comp = new Map<FuncInfo, number>();
  const comps: FuncInfo[][] = [];
  {
    const idx = new Map<FuncInfo, number>(), low = new Map<FuncInfo, number>(), on = new Set<FuncInfo>();
    const S: FuncInfo[] = [];
    let n = 0;
    for (const s0 of funcs) {
      if (idx.has(s0)) continue;
      const it: { f: FuncInfo; i: number }[] = [{ f: s0, i: 0 }];
      idx.set(s0, n); low.set(s0, n); n++; S.push(s0); on.add(s0);
      while (it.length) {
        const top = it[it.length - 1]!;
        const cs = callees.get(top.f)!;
        if (top.i < cs.length) {
          const g = cs[top.i++]!;
          if (!idx.has(g)) { idx.set(g, n); low.set(g, n); n++; S.push(g); on.add(g); it.push({ f: g, i: 0 }); }
          else if (on.has(g)) low.set(top.f, Math.min(low.get(top.f)!, idx.get(g)!));
          continue;
        }
        it.pop();
        if (it.length) { const p = it[it.length - 1]!.f; low.set(p, Math.min(low.get(p)!, low.get(top.f)!)); }
        if (low.get(top.f) === idx.get(top.f)) {
          const c: FuncInfo[] = [];
          let g: FuncInfo;
          do { g = S.pop()!; on.delete(g); comp.set(g, comps.length); c.push(g); } while (g !== top.f);
          comps.push(c);
        }
      }
    }
  }
  const out: FrameAlloc = { funcs: new Map(), total: 0 };
  for (const f of funcs) {
    const recursive = comps[comp.get(f)!]!.length > 1 || callees.get(f)!.includes(f);
    const stack = !f.defined || f.naked || f.type.variadic || recursive || fromAsm.has(f) || !!f.addrTaken || (reach.get(f)?.size ?? 0) > 1;
    f.conv = stack ? "stack" : "static";
    const size = stack ? 0 : CodeGen.paramBytes(f) + (f.frameSize ?? 0);
    out.funcs.set(f, { conv: f.conv, size: stack ? CodeGen.stackL(f) : size });
  }
  // Tarjan da las componentes en orden topológico inverso: se recorren al revés.
  const off = new Map<FuncInfo, number>();
  const regionOf = (f: FuncInfo) => { const r = reach.get(f); return r && r.size === 1 ? [...r][0]! : undefined; };
  const regionSize = new Map<FuncInfo, number>();
  for (let ci = comps.length - 1; ci >= 0; ci--) {
    const c = comps[ci]!;
    let o = 0;
    for (const f of c) o = Math.max(o, off.get(f) ?? 0);
    for (const f of c) off.set(f, o);
    for (const f of c) {
      const sz = f.conv === "static" ? out.funcs.get(f)!.size : 0;
      const r = regionOf(f);
      if (r) regionSize.set(r, Math.max(regionSize.get(r) ?? 0, o + sz));
      for (const g of callees.get(f)!) if (comp.get(g) !== ci) off.set(g, Math.max(off.get(g) ?? 0, o + sz));
    }
  }
  let base = 0;
  for (const r of roots) {
    const rb = base;
    for (const f of funcs) if (f.conv === "static" && regionOf(f) === r) out.funcs.get(f)!.base = rb + off.get(f)!;
    base += regionSize.get(r) ?? 0;
  }
  out.total = base;
  return out;
}

function walkAsm(s: Stmt, f: (text: string) => void) {
  switch (s.k) {
    case "asm": f(s.text); return;
    case "block": for (const b of s.body) walkAsm(b, f); return;
    case "if": walkAsm(s.a, f); if (s.b) walkAsm(s.b, f); return;
    case "while": case "do": case "switch": walkAsm(s.body, f); return;
    case "for": if (s.init) walkAsm(s.init, f); walkAsm(s.body, f); return;
  }
}

/** Labels de los static de fichero: `_x` salvo choque con otro fichero (docs/c-abi.md §2). */
function assignLabels(prog: Program) {
  const byName = new Map<string, (VarSym | FuncInfo)[]>();
  const fileScope: (VarSym | FuncInfo)[] = [...prog.funcs, ...prog.globals.filter((g) => !g.inFunc)];
  for (const s of fileScope) {
    const l = byName.get(s.name) ?? [];
    l.push(s);
    byName.set(s.name, l);
  }
  for (const [name, l] of byName) {
    if (l.length < 2) continue;
    for (const s of l) if (s.isStatic) s.label = `__s${s.fileIdx}_${name}`;
  }
}

function finishDiags(d: Diag[]): CcError[] {
  const seen = new Set<string>();
  const out: CcError[] = [];
  for (const e of d) {
    const k = `${e.file}:${e.line}:${e.col}:${e.msg}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ file: e.file, line: e.line, col: e.col, msg: e.msg, severity: e.severity });
  }
  return out;
}

function dbLines(bytes: number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    // Tramos imprimibles entre comillas para que el ensamblador generado se lea.
    const parts: string[] = [];
    let str = "";
    for (const b of chunk) {
      if (b >= 32 && b < 127 && b !== 34 && b !== 92) { str += String.fromCharCode(b); continue; }
      if (str) { parts.push(`"${str}"`); str = ""; }
      parts.push(String(b));
    }
    if (str) parts.push(`"${str}"`);
    out.push("        db " + parts.join(","));
  }
  return out;
}

/** Imagen de un inicializador constante: db/dw con reubicaciones. */
function emitInit(init: Init, size: number, gen: CodeGen, bank: number): string[] {
  const bytes = new Array<number>(size).fill(0);
  const reloc = new Map<number, string>();
  for (const it of init.items) {
    const c = constAddr(it.e)!;
    const sz = sizeOf(it.type);
    if (c.sym || c.str) {
      const label = c.sym ? c.sym.label : gen.strLabel(c.str!, bank);
      reloc.set(it.off, c.off === 0 ? label : `${label}${c.off > 0 ? "+" : "-"}${Math.abs(c.off)}`);
      continue;
    }
    bytes[it.off] = c.off & 0xff;
    if (sz === 2) bytes[it.off + 1] = (c.off >> 8) & 0xff;
  }
  const out: string[] = [];
  let run: number[] = [];
  const flush = () => { if (run.length) { out.push(...dbLines(run)); run = []; } };
  for (let o = 0; o < size; o++) {
    const r = reloc.get(o);
    if (r !== undefined) { flush(); out.push(`        dw ${r}`); o++; continue; }
    run.push(bytes[o]!);
  }
  flush();
  return out;
}

export { MARK };
