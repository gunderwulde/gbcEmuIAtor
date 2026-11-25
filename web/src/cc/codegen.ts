// Generación de código SM83 (K1) directamente sobre el AST tipado. ABI: docs/c-abi.md.
//
// Modelo: acumulador HL para valores de 16 bits y A para los de 8; DE (y a veces BC) como
// segundo operando; pila para temporales cuando no queda registro libre.
//
// - expr(e): HL = valor de e. Si e es de tipo char, HL lleva el valor ya extendido (cero
//   o signo), así que las promociones a int no cuestan nada.
// - exprA(e): A = byte bajo del valor de e. Las operaciones cuyo byte bajo sólo depende de
//   los bytes bajos de los operandos (+ - & | ^ ~ y << constante) se hacen en 8 bits.
// - branch(e, L, when): salta a L si el valor de verdad de e es `when`, sin materializar 0/1.
//
// Registros que pisa cada expresión: clob(e) (máscara DE/BC). A, F, H y L se pisan
// siempre. Toda ruta de código de este fichero debe respetar clob(): con eso se decide si
// un operando puede quedarse en DE o BC mientras se evalúa el otro (sin push/pop).
//
// Marcos (docs/c-abi.md §4): convención estática (dirección fija `__fr_<f>+n`) o de pila
// (`ld hl,sp+n`, con `depth` = bytes apilados por temporales en este punto).

import { constAddr, type Program } from "./parser";
import type { Diag } from "./preproc";
import { helperClob } from "./runtime";
import { isChar, sizeOf, type CmpOp, type Expr, type FuncInfo, type Init, type Pos, type Stmt, type Type, type VarSym } from "./types";

/** Dirección de memoria directa: absoluta (`h` = en $FF00-$FFFF, se usa LDH) o relativa a SP. */
type Loc = { k: "abs"; a: string; h: boolean } | { k: "sp"; o: number };
type CC = "z" | "nz" | "c" | "nc" | "T" | "F";

const DE = 1, BC = 2, ALL = 3;

const hx = (v: number) => (v < 10 ? String(v) : "$" + v.toString(16).toUpperCase());
const hex = (v: number) => hx(v & 0xffff);
const hex8 = (v: number) => hx(v & 0xff);
const plus = (a: string, n: number) => (n === 0 ? a : n > 0 ? `${a}+${n}` : `${a}-${-n}`);
const isPow2 = (v: number) => v > 0 && (v & (v - 1)) === 0;
const INVCC: Record<string, CC> = { z: "nz", nz: "z", c: "nc", nc: "c", T: "F", F: "T" };
const NARROW = new Set(["+", "-", "&", "|", "^"]);
const ALU: Record<string, string> = { "+": "add a,", "-": "sub ", "&": "and ", "|": "or ", "^": "xor " };

/** Marcador de línea C en la salida (lo consume index.ts para el cLineMap). */
export const MARK = ";#";
/** Delimitan un bloque __asm del usuario (barrera del peephole; se quitan al final). */
export const ASM_BEGIN = ";{asm";
export const ASM_END = ";}asm";

export interface FrameInfo {
  /** Bytes de parámetros (convención estática) o L (pila: locales + copia del 1.er argumento). */
  size: number;
}

export class CodeGen {
  out: string[] = [];
  helpers = new Set<string>();
  /** Cadenas por banco (clave banco:bytes). */
  strings = new Map<string, string>();
  stringOrder: { label: string; bytes: number[]; bank: number }[] = [];
  blobs: { label: string; init: Init; size: number; bank: number }[] = [];
  /** Funciones a las que se llama por __bcall (para el runtime). */
  private fn!: FuncInfo;
  private stack = false;
  private depth = 0;
  private labelN = 0;
  private brk: string[] = [];
  private cont: string[] = [];
  private retUsed = false;
  private lastMark = "";
  private fullLabels = false;
  private bank = 0;

  constructor(private prog: Program, private diags: Diag[], private srcLine: (file: string, line: number) => string) {}

  private e(s: string) { this.out.push("        " + s); }
  private ln(l: string): string { return this.fullLabels && l.startsWith(".") ? this.fn.label + l : l; }
  private lab(l: string) { this.out.push(this.ln(l) + ":"); }
  private newLabel(): string { return `.c${++this.labelN}`; }
  private err(pos: Pos, msg: string) { this.diags.push({ ...pos, msg, severity: "error" }); }
  private push(r: string) { this.e(`push ${r}`); this.depth += 2; }
  private pop(r: string) { this.e(`pop ${r}`); this.depth -= 2; }
  private jp(cc: CC, l: string) {
    if (cc === "F") return;
    this.e(cc === "T" ? `jp ${this.ln(l)}` : `jp ${cc},${this.ln(l)}`);
  }

  mark(pos: Pos) {
    const key = `${pos.file}:${pos.line}`;
    if (key === this.lastMark) return;
    this.lastMark = key;
    this.out.push(`${MARK}${pos.file}:${pos.line}: ${this.srcLine(pos.file, pos.line).trim()}`);
  }

  strLabel(bytes: number[], bank: number): string {
    const key = bank + ":" + bytes.join(",");
    let l = this.strings.get(key);
    if (!l) {
      l = `__str${this.strings.size}`;
      this.strings.set(key, l);
      this.stringOrder.push({ label: l, bytes, bank });
    }
    return l;
  }

  // ---- funciones ----------------------------------------------------------------------
  /** Tamaño del bloque de la pila (L) de una función con convención de pila. */
  static stackL(f: FuncInfo): number { return (f.frameSize ?? 0) + ((f.params?.length ?? 0) > 0 ? 2 : 0); }
  /** Bytes de parámetros de una función (convención estática). */
  static paramBytes(f: FuncInfo): number { let n = 0; for (const p of f.params ?? []) n += Math.max(1, sizeOf(p.type)); return n; }
  /** ¿Se le llama por el trampolín __bcall? (docs/c-abi.md §8) */
  static viaTramp(f: FuncInfo): boolean { return f.banked && f.bank !== 0; }

  genFunc(f: FuncInfo) {
    this.fn = f;
    this.labelN = 0;
    this.retUsed = false;
    this.lastMark = "";
    this.depth = 0;
    this.stack = f.conv !== "static";
    this.bank = f.bank;
    this.fullLabels = hasAsm(f.body!);
    this.out.push("");
    this.out.push(`; ${f.name}: ${f.file ?? ""}:${f.pos.line} (convención ${this.stack ? "de pila" : "estática"})`);
    this.out.push(f.label + ":");
    this.mark(f.pos);
    if (f.naked) { this.stmt(f.body!); return; }
    if (f.interrupt) for (const r of ["af", "bc", "de", "hl"]) this.e(`push ${r}`);
    const p0 = f.params?.[0];
    if (this.stack) {
      if (p0) this.e(sizeOf(p0.type) === 1 ? "push af" : "push hl");
      this.addSp(-(f.frameSize ?? 0));
    } else if (p0) {
      const l: Loc = { k: "abs", a: `__fr_${f.label}`, h: false };
      if (sizeOf(p0.type) === 1) this.storeA(l); else this.store16(l, false);
    }
    this.stmt(f.body!);
    this.lastMark = "";
    if (this.retUsed) this.lab(".lret");
    if (this.stack) this.addSp(CodeGen.stackL(f));
    if (f.interrupt) { for (const r of ["hl", "de", "bc", "af"]) this.e(`pop ${r}`); this.e("reti"); }
    else this.e("ret");
  }

  /** SP += n sin tocar A ni HL (el valor de retorno). */
  private addSp(n: number) {
    while (n !== 0) {
      const k = Math.max(-128, Math.min(127, n));
      this.e(`add sp,${k}`);
      n -= k;
    }
  }

  // ---- sentencias ---------------------------------------------------------------------
  private stmt(s: Stmt) {
    switch (s.k) {
      case "block": for (const b of s.body) this.stmt(b); return;
      case "empty": return;
      case "expr": this.mark(s.pos); this.expr(s.e, true); return;
      case "init": this.mark(s.pos); this.localInit(s.v, s.init); return;
      case "if": {
        this.mark(s.pos);
        const lelse = this.newLabel();
        this.branch(s.c, lelse, false);
        this.stmt(s.a);
        if (s.b) {
          const lend = this.newLabel();
          this.jp("T", lend);
          this.lab(lelse);
          this.stmt(s.b);
          this.lab(lend);
        } else this.lab(lelse);
        this.lastMark = "";
        return;
      }
      case "while": {
        // Bucle rotado: la condición va al final y se entra saltando a ella.
        this.mark(s.pos);
        const lb = this.newLabel(), lc = this.newLabel(), le = this.newLabel();
        const always = s.c.k === "num" && s.c.v !== 0;
        if (!always) this.jp("T", lc);
        this.lab(lb);
        this.loop(le, lc, s.body);
        this.lab(lc);
        this.lastMark = "";
        this.mark(s.pos);
        if (always) this.jp("T", lb);
        else this.branch(s.c, lb, true);
        this.lab(le);
        this.lastMark = "";
        return;
      }
      case "do": {
        const lb = this.newLabel(), lc = this.newLabel(), le = this.newLabel();
        this.lab(lb);
        this.loop(le, lc, s.body);
        this.lab(lc);
        this.lastMark = "";
        this.mark(s.cpos);
        this.branch(s.c, lb, true);
        this.lab(le);
        this.lastMark = "";
        return;
      }
      case "for": {
        this.mark(s.pos);
        if (s.init) this.stmt(s.init);
        const lb = this.newLabel(), lc = this.newLabel(), ls = this.newLabel(), le = this.newLabel();
        const always = !s.c || (s.c.k === "num" && s.c.v !== 0);
        if (!always) this.jp("T", lc);
        this.lab(lb);
        this.loop(le, ls, s.body);
        this.lab(ls);
        this.lastMark = "";
        if (s.step) { this.mark(s.spos ?? s.pos); this.expr(s.step, true); }
        this.lab(lc);
        this.lastMark = "";
        if (always) this.jp("T", lb);
        else { this.mark(s.cpos ?? s.pos); this.branch(s.c!, lb, true); }
        this.lab(le);
        this.lastMark = "";
        return;
      }
      case "switch": {
        this.mark(s.pos);
        const le = this.newLabel();
        this.switchDispatch(s.e, s.cases, s.def ?? le);
        this.brk.push(le);
        try { this.stmt(s.body); } finally { this.brk.pop(); }
        this.lab(le);
        this.lastMark = "";
        return;
      }
      case "case": this.lab(s.label); this.lastMark = ""; return;
      case "label": this.lab(s.label); this.lastMark = ""; return;
      case "break": this.mark(s.pos); this.jp("T", this.brk[this.brk.length - 1]!); return;
      case "continue": this.mark(s.pos); this.jp("T", this.cont[this.cont.length - 1]!); return;
      case "goto": this.mark(s.pos); this.jp("T", s.label); return;
      case "return": {
        this.mark(s.pos);
        if (s.e) {
          if (isChar(this.fn.type.ret)) this.exprA(s.e);
          else this.expr(s.e, false);
        }
        if (this.fn.naked) { this.e("ret"); return; }
        this.retUsed = true;
        this.jp("T", ".lret");
        return;
      }
      case "asm": this.asmText(s.text, s.pos.file, s.line); return;
    }
  }

  /** Copia un bloque __asm con una marca de línea C por cada línea no vacía. */
  asmText(text: string, file: string, line: number) {
    this.out.push(ASM_BEGIN);
    text.split("\n").forEach((l, i) => {
      this.lastMark = "";
      if (l.trim() !== "") this.mark({ file, line: line + i, col: 1 });
      this.out.push(l);
    });
    this.out.push(ASM_END);
    this.lastMark = "";
  }

  private loop(brk: string, cont: string, body: Stmt) {
    this.brk.push(brk); this.cont.push(cont);
    try { this.stmt(body); } finally { this.brk.pop(); this.cont.pop(); }
  }

  private switchDispatch(e: Expr, cases: { v: number; label: string }[], def: string) {
    const inner = stripNoop(e);
    const signed = inner.t.k === "int" && inner.t.signed;
    // Despacho de 8 bits sólo si la conversión al tipo del switch conserva el valor del
    // char: un signed char convertido a unsigned vale 65408..65535, no −128..−1.
    const byte = isChar(inner.t) && (!signed || (e.t.k === "int" && e.t.signed));
    let cs = cases.slice();
    if (byte) cs = cs.filter((c) => (signed ? c.v >= -128 && c.v <= 127 : c.v >= 0 && c.v <= 255));
    cs.sort((a, b) => a.v - b.v);
    if (byte) this.exprA(inner); else this.expr(e, false);
    if (cs.length === 0) { this.jp("T", def); return; }
    const min = cs[0]!.v, max = cs[cs.length - 1]!.v;
    const range = max - min + 1;
    const D = this.ln(def);
    if (cs.length >= 4 && range <= 256 && range <= 3 * cs.length) {
      // Tabla de saltos densa: índice = valor - min, comprobado sin signo contra el rango.
      const tbl = this.newLabel();
      if (byte) {
        if (min !== 0) this.e(`sub ${hex8(min)}`);
        if (range < 256) { this.e(`cp ${range}`); this.e(`jp nc,${D}`); }
        this.e("ld l,a");
        this.e("ld h,0");
      } else {
        if (min !== 0) { this.e(`ld de,${hex(-min)}`); this.e("add hl,de"); }
        this.e("ld a,h");
        this.e("or a");
        this.e(`jp nz,${D}`);
        if (range < 256) { this.e("ld a,l"); this.e(`cp ${range}`); this.e(`jp nc,${D}`); }
      }
      this.e("add hl,hl");
      this.e(`ld de,${this.ln(tbl)}`);
      this.e("add hl,de");
      this.e("ld a,[hl+]");
      this.e("ld h,[hl]");
      this.e("ld l,a");
      this.e("jp hl");
      this.lab(tbl);
      const m = new Map(cs.map((c) => [c.v, c.label]));
      for (let v = min; v <= max; v++) this.e(`dw ${this.ln(m.get(v) ?? def)}`);
      return;
    }
    if (byte) {
      for (const c of cs) { this.e(`cp ${hex8(c.v)}`); this.jp("z", c.label); }
      this.jp("T", def);
      return;
    }
    for (const c of cs) {
      const n = this.newLabel();
      this.e("ld a,l");
      this.e(`cp ${hex8(c.v)}`);
      this.e(`jr nz,${this.ln(n)}`);
      this.e("ld a,h");
      this.e(`cp ${hex8((c.v & 0xffff) >> 8)}`);
      this.jp("z", c.label);
      this.lab(n);
    }
    this.jp("T", def);
  }

  private localInit(v: VarSym, init: Init) {
    const t = v.type;
    const loc = this.varLoc(v, 0);
    if (t.k !== "array" && t.k !== "struct") {
      const it = init.items[0]!;
      if (sizeOf(t) === 1) { this.exprA(it.e); this.storeA(loc); }
      else { this.expr(it.e, false); this.store16(loc, false); }
      return;
    }
    const size = sizeOf(t);
    if (init.items.length === 1 && init.items[0]!.type.k === "struct") {
      this.addr(init.items[0]!.e);
      this.dstDE(loc);
      this.copyBytes(size);
      return;
    }
    if (init.items.every((it) => constAddr(it.e))) {
      // Imagen constante en ROM y copia: es lo más corto para arrays y structs.
      const label = `__init${this.blobs.length}`;
      this.blobs.push({ label, init, size, bank: this.bank });
      this.dstDE(loc);
      this.e(`ld hl,${label}`);
      this.copyBytes(size);
      return;
    }
    // Valores no constantes: a cero y luego elemento a elemento.
    this.hlAt(loc);
    this.fillZero(size);
    for (const it of init.items) {
      if (it.e.k === "num" && it.e.v === 0) continue;
      const l = this.varLoc(v, it.off);
      if (sizeOf(it.type) === 1) { this.exprA(it.e); this.storeA(l); }
      else { this.expr(it.e, false); this.store16(l, false); }
    }
  }

  /** DE = dirección de loc (HL se conserva si loc es absoluta). */
  private dstDE(loc: Loc) {
    if (loc.k === "abs") { this.e(`ld de,${loc.a}`); return; }
    this.push("hl");
    this.spAddr(loc.o);
    this.e("ld d,h");
    this.e("ld e,l");
    this.pop("hl");
  }

  /** Copia `size` bytes de [HL] a [DE]. Pisa A, BC (o C), DE y HL. */
  private copyBytes(size: number) {
    if (size <= 6) {
      for (let i = 0; i < size; i++) { this.e("ld a,[hl+]"); this.e("ld [de],a"); if (i < size - 1) this.e("inc de"); }
      return;
    }
    const l = this.newLabel();
    if (size <= 256) {
      this.e(`ld c,${size & 0xff}`);
      this.lab(l);
      this.e("ld a,[hl+]"); this.e("ld [de],a"); this.e("inc de"); this.e("dec c"); this.e(`jr nz,${this.ln(l)}`);
      return;
    }
    this.e(`ld bc,${size}`);
    this.lab(l);
    this.e("ld a,[hl+]"); this.e("ld [de],a"); this.e("inc de"); this.e("dec bc"); this.e("ld a,b"); this.e("or c"); this.e(`jr nz,${this.ln(l)}`);
  }

  /** Pone a cero `size` bytes desde HL. */
  private fillZero(size: number) {
    this.e("xor a");
    if (size <= 8) { for (let i = 0; i < size; i++) this.e("ld [hl+],a"); return; }
    const l = this.newLabel();
    if (size <= 256) {
      this.e(`ld c,${size & 0xff}`);
      this.lab(l);
      this.e("ld [hl+],a"); this.e("dec c"); this.e(`jr nz,${this.ln(l)}`);
      return;
    }
    this.e(`ld bc,${size}`);
    this.lab(l);
    this.e("xor a"); this.e("ld [hl+],a"); this.e("dec bc"); this.e("ld a,b"); this.e("or c"); this.e(`jr nz,${this.ln(l)}`);
  }

  // ---- direcciones ------------------------------------------------------------------------
  /** Dirección de una variable (+ extra bytes). */
  private varLoc(v: VarSym, extra: number): Loc {
    if (v.storage === "global") {
      if (v.at !== undefined) return { k: "abs", a: plus(v.label, extra), h: ((v.at + extra) & 0xffff) >= 0xff00 };
      return { k: "abs", a: plus(v.label, extra), h: false };
    }
    const f = this.fn;
    if (!this.stack) {
      let o: number;
      if (v.storage === "param") { o = 0; for (let i = 0; i < v.off; i++) o += Math.max(1, sizeOf(f.params![i]!.type)); }
      else o = CodeGen.paramBytes(f) + (f.frameSize ?? 0) + v.off;
      return { k: "abs", a: plus(`__fr_${f.label}`, o + extra), h: false };
    }
    const fs = f.frameSize ?? 0;
    if (v.storage === "local") return { k: "sp", o: fs + v.off + extra };
    if (v.off === 0) return { k: "sp", o: fs + (sizeOf(v.type) === 1 ? 1 : 0) + extra };
    return { k: "sp", o: fs + 4 + (CodeGen.viaTramp(f) ? 4 : 0) + 2 * (v.off - 1) + extra };
  }

  /** Dirección directa de un lvalue sin efectos laterales, si existe. */
  private loc(e: Expr): Loc | null {
    if (e.k === "var") return this.varLoc(e.sym, 0);
    if (e.k === "deref") {
      const p = stripNoop(e.e);
      if (p.k === "num") { const a = p.v & 0xffff; return { k: "abs", a: hex(a), h: a >= 0xff00 }; }
      if (p.k === "addr" && p.e.k === "var") return this.varLoc(p.e.sym, 0);
      if (p.k === "bin" && (p.op === "+" || p.op === "-") && p.r.k === "num" && p.l.k === "addr" && p.l.e.k === "var") return this.varLoc(p.l.e.sym, p.op === "+" ? p.r.v : -p.r.v);
    }
    return null;
  }

  /** HL = SP + o (o relativo al marco; se suma lo apilado por temporales). */
  private spAddr(o: number) {
    const n = o + this.depth;
    if (n <= 127) this.e(`ld hl,sp+${n}`);
    else { this.e(`ld hl,${n}`); this.e("add hl,sp"); }
  }

  private hlAt(l: Loc) { if (l.k === "abs") this.e(`ld hl,${l.a}`); else this.spAddr(l.o); }

  /** HL = dirección del lvalue (o de la cadena/función). */
  private addr(e: Expr) {
    switch (e.k) {
      case "var": this.hlAt(this.varLoc(e.sym, 0)); return;
      case "deref": this.expr(e.e, false); return;
      case "str": this.e(`ld hl,${this.strLabel(e.bytes, this.bank)}`); return;
      case "faddr": this.e(`ld hl,${e.f.label}`); return;
      default: this.err(e.pos, "se esperaba un lvalue"); return;
    }
  }

  // ---- cargas y almacenamientos -------------------------------------------------------------
  private loadA(l: Loc) {
    if (l.k === "sp") { this.spAddr(l.o); this.e("ld a,[hl]"); }
    else this.e(l.h ? `ldh a,[${l.a}]` : `ld a,[${l.a}]`);
  }

  /** [l] = A. Si l es relativa a SP pisa HL. */
  private storeA(l: Loc) {
    if (l.k === "sp") { this.spAddr(l.o); this.e("ld [hl],a"); }
    else this.e(l.h ? `ldh [${l.a}],a` : `ld [${l.a}],a`);
  }

  private load16(l: Loc) {
    if (l.k === "abs" && l.h) { this.e(`ldh a,[${l.a}]`); this.e("ld l,a"); this.e(`ldh a,[${plus(l.a, 1)}]`); this.e("ld h,a"); return; }
    this.hlAt(l);
    this.e("ld a,[hl+]"); this.e("ld h,[hl]"); this.e("ld l,a");
  }

  /** [l] = HL. Absoluta: conserva HL. Relativa a SP: usa DE; con keep, HL vuelve a tener el valor. */
  private store16(l: Loc, keep: boolean) {
    if (l.k === "abs") {
      const ld = l.h ? "ldh" : "ld";
      this.e("ld a,l"); this.e(`${ld} [${l.a}],a`); this.e("ld a,h"); this.e(`${ld} [${plus(l.a, 1)}],a`);
      return;
    }
    this.e("ld d,h"); this.e("ld e,l");
    this.spAddr(l.o);
    this.e("ld a,e"); this.e("ld [hl+],a"); this.e("ld [hl],d");
    if (keep) { this.e("ld h,d"); this.e("ld l,e"); }
  }

  /** HL = valor de tipo t en l, extendido. */
  private load(l: Loc, t: Type) {
    if (sizeOf(t) === 2) { this.load16(l); return; }
    const signed = t.k === "int" && t.signed;
    if (l.k === "sp" && !signed) { this.spAddr(l.o); this.e("ld l,[hl]"); this.e("ld h,0"); return; }
    this.loadA(l);
    this.extA(signed);
  }

  /** HL = A extendido. */
  private extA(signed: boolean) {
    this.e("ld l,a");
    if (signed) { this.e("rla"); this.e("sbc a,a"); this.e("ld h,a"); }
    else this.e("ld h,0");
  }

  private loadViaHL(t: Type) {
    if (sizeOf(t) === 2) { this.e("ld a,[hl+]"); this.e("ld h,[hl]"); this.e("ld l,a"); }
    else if (t.k === "int" && t.signed) { this.e("ld a,[hl]"); this.extA(true); }
    else { this.e("ld l,[hl]"); this.e("ld h,0"); }
  }

  /** [DE] = HL (2 bytes) o L (1 byte); HL se conserva. */
  private storeViaDE(t: Type) {
    this.e("ld a,l"); this.e("ld [de],a");
    if (sizeOf(t) === 2) { this.e("inc de"); this.e("ld a,h"); this.e("ld [de],a"); }
  }

  // ---- clasificación de operandos -------------------------------------------------------------
  /** ¿Se carga en DE sin tocar HL ni BC? */
  private deLoadable(e0: Expr): boolean {
    const e = stripNoop(e0);
    if (e.k === "num") return true;
    if (e.k === "addr" && ((e.e.k === "var" && e.e.sym.storage === "global") || e.e.k === "str" || e.e.k === "faddr")) return true;
    if ((e.k === "var" || e.k === "deref") && e.t.k !== "struct" && e.t.k !== "array") return this.loc(e)?.k === "abs";
    return false;
  }

  private loadDE(e0: Expr) {
    const e = stripNoop(e0);
    if (e.k === "num") { this.e(`ld de,${hex(e.v)}`); return; }
    if (e.k === "addr") {
      const x = e.e;
      this.e(`ld de,${x.k === "var" ? x.sym.label : x.k === "faddr" ? x.f.label : this.strLabel((x as Extract<Expr, { k: "str" }>).bytes, this.bank)}`);
      return;
    }
    const l = this.loc(e)! as Extract<Loc, { k: "abs" }>;
    const ld = l.h ? "ldh" : "ld";
    this.e(`${ld} a,[${l.a}]`);
    this.e("ld e,a");
    if (sizeOf(e.t) === 2) { this.e(`${ld} a,[${plus(l.a, 1)}]`); this.e("ld d,a"); }
    else if (e.t.k === "int" && e.t.signed) { this.e("rla"); this.e("sbc a,a"); this.e("ld d,a"); }
    else this.e("ld d,0");
  }

  /** Byte de memoria directa sin efectos laterales (operando de `op [hl]`). */
  private mem8(e0: Expr): Loc | null {
    const e = stripNoop(e0);
    if ((e.k === "var" || e.k === "deref") && e.t.k !== "struct" && e.t.k !== "array") return this.loc(e);
    return null;
  }

  /** HL = l, DE = r (en el orden que menos cueste). */
  private pair(l: Expr, r: Expr) {
    if (this.deLoadable(r)) { this.expr(l, false); this.loadDE(r); }
    else if (!(clob(l) & DE)) { this.expr(r, false); this.e("ld d,h"); this.e("ld e,l"); this.expr(l, false); }
    else if (!(clob(r) & BC)) { this.expr(l, false); this.e("ld b,h"); this.e("ld c,l"); this.expr(r, false); this.e("ld d,h"); this.e("ld e,l"); this.e("ld h,b"); this.e("ld l,c"); }
    else { this.expr(l, false); this.push("hl"); this.expr(r, false); this.e("ld d,h"); this.e("ld e,l"); this.pop("hl"); }
  }

  // ---- expresiones (HL) --------------------------------------------------------------------------
  /** Evalúa e en HL. discard: el valor no se usa. */
  expr(e: Expr, discard: boolean): void {
    switch (e.k) {
      case "num": if (!discard) this.e(`ld hl,${hex(e.v)}`); return;
      case "str": case "faddr": if (!discard) this.addr(e); return;
      case "addr": if (!discard || hasSide(e.e)) this.addr(e.e); return;
      case "var": case "deref": {
        if (discard && !hasSide(e)) return;
        if (e.t.k === "struct" || e.t.k === "array" || e.t.k === "func") { this.addr(e); return; }
        const l = this.loc(e);
        if (l) { this.load(l, e.t); return; }
        this.addr(e);
        this.loadViaHL(e.t);
        return;
      }
      case "un":
        if (e.op === "!") { this.boolValue(e, discard); return; }
        this.expr(e.e, discard);
        if (discard) return;
        if (e.op === "-") { this.e("xor a"); this.e("sub l"); this.e("ld l,a"); this.e("sbc a,a"); this.e("sub h"); this.e("ld h,a"); }
        else { this.e("ld a,l"); this.e("cpl"); this.e("ld l,a"); this.e("ld a,h"); this.e("cpl"); this.e("ld h,a"); }
        return;
      case "bin": this.bin(e, discard); return;
      case "cmp": case "land": case "lor": this.boolValue(e, discard); return;
      case "cond": {
        const lf = this.newLabel(), le = this.newLabel();
        const d = this.depth;
        this.branch(e.c, lf, false);
        this.expr(e.a, discard);
        this.jp("T", le);
        this.lab(lf);
        this.depth = d;
        this.expr(e.b, discard);
        this.lab(le);
        return;
      }
      case "assign": this.assign(e, discard, false); return;
      case "incdec": this.incdec(e, discard, false); return;
      case "call": {
        this.call(e);
        if (!discard && isChar(e.t)) this.extA(e.t.k === "int" && e.t.signed);
        return;
      }
      case "cast": {
        if (e.t.k === "void") { this.expr(e.e, true); return; }
        if (discard) { this.expr(e.e, true); return; }
        if (isChar(e.t) && !(isChar(e.e.t) && (e.e.t as { signed: boolean }).signed === (e.t as { signed: boolean }).signed)) {
          this.exprA(e.e);
          this.extA(e.t.k === "int" && e.t.signed);
          return;
        }
        this.expr(e.e, false);
        return;
      }
      case "comma": this.expr(e.l, true); this.expr(e.r, discard); return;
    }
  }

  /** HL = 0/1 según el valor de verdad de e. */
  private boolValue(e: Expr, discard: boolean) {
    if (discard) {
      const l = this.newLabel();
      this.branch(e, l, false);
      this.lab(l);
      return;
    }
    if (e.k === "cmp" || e.k === "un") {
      const cc = e.k === "cmp" ? this.cmpFlags(e) : INVCC[this.truthFlags(e.e)]!;
      if (cc === "T" || cc === "F") { this.e(`ld hl,${cc === "T" ? 1 : 0}`); return; }
      this.e("ld hl,0");
      if (cc === "c" || cc === "nc") {
        if (cc === "nc") this.e("ccf");
        this.e("rl l");
        return;
      }
      const l = this.newLabel();
      this.e(`jr ${INVCC[cc]},${this.ln(l)}`);
      this.e("inc l");
      this.lab(l);
      return;
    }
    const lf = this.newLabel(), le = this.newLabel();
    this.branch(e, lf, false);
    this.e("ld hl,1");
    this.jp("T", le);
    this.lab(lf);
    this.e("ld hl,0");
    this.lab(le);
  }

  private bin(e: Extract<Expr, { k: "bin" }>, discard: boolean) {
    if (discard && !hasSide(e)) return;
    let l = e.l, r = e.r;
    if (l.k === "num" && r.k !== "num" && (e.op === "+" || e.op === "*" || e.op === "&" || e.op === "|" || e.op === "^")) [l, r] = [r, l];
    if (r.k === "num") {
      this.expr(l, false);
      this.binConst(e.op, e.t, r.v);
      return;
    }
    this.pair(l, r);
    this.binDE(e.op, e.t);
  }

  /** HL = HL op DE. */
  private binDE(op: string, t: Type) {
    const signed = t.k === "int" && t.signed;
    switch (op) {
      case "+": this.e("add hl,de"); return;
      case "-": this.e("ld a,l"); this.e("sub e"); this.e("ld l,a"); this.e("ld a,h"); this.e("sbc a,d"); this.e("ld h,a"); return;
      case "*": this.helper("__mul16"); return;
      case "/": this.helper(signed ? "__divs16" : "__divu16"); return;
      case "%":
        if (signed) this.helper("__mods16");
        else { this.helper("__divu16"); this.e("ld h,d"); this.e("ld l,e"); }
        return;
      case "<<": this.e("ld a,e"); this.helper("__shl16"); return;
      case ">>": this.e("ld a,e"); this.helper(signed ? "__shrs16" : "__shru16"); return;
      case "&": case "|": case "^": {
        const m = op === "&" ? "and" : op === "|" ? "or" : "xor";
        this.e("ld a,l"); this.e(`${m} e`); this.e("ld l,a"); this.e("ld a,h"); this.e(`${m} d`); this.e("ld h,a");
        return;
      }
    }
  }

  private helper(name: string) { this.helpers.add(name); this.e(`call ${name}`); }

  /** HL = HL op v. */
  private binConst(op: string, t: Type, v0: number) {
    const v = v0 & 0xffff;
    const signed = t.k === "int" && t.signed;
    switch (op) {
      case "+": case "-": this.addConst(op === "+" ? v : -v); return;
      case "*": this.mulConst(v); return;
      case "/":
        if (v === 0) break;
        if (v === 1) return;
        if (!signed && isPow2(v)) { this.shr(Math.log2(v), false); return; }
        if (signed && isPow2(v) && v < 0x8000) {
          // Truncar hacia cero: a los negativos se les suma v-1 antes de desplazar.
          const l = this.newLabel();
          this.e("bit 7,h");
          this.e(`jr z,${this.ln(l)}`);
          this.addConst(v - 1);
          this.lab(l);
          this.shr(Math.log2(v), true);
          return;
        }
        break;
      case "%":
        if (!signed && isPow2(v)) { this.andConst(v - 1); return; }
        break;
      case "<<":
        if (v >= 16) { this.e("ld hl,0"); return; }
        this.shl(v);
        return;
      case ">>":
        if (v >= 16) { if (signed) { this.e("ld a,h"); this.e("rla"); this.e("sbc a,a"); this.e("ld h,a"); this.e("ld l,a"); } else this.e("ld hl,0"); return; }
        this.shr(v, signed);
        return;
      case "&": this.andConst(v); return;
      case "|": case "^": {
        const m = op === "|" ? "or" : "xor";
        for (const [r, b] of [["l", v & 0xff], ["h", v >> 8]] as const) {
          if (b === 0) continue;
          if (op === "|" && b === 0xff) { this.e(`ld ${r},$FF`); continue; }
          this.e(`ld a,${r}`);
          if (op === "^" && b === 0xff) this.e("cpl");
          else this.e(`${m} ${hex8(b)}`);
          this.e(`ld ${r},a`);
        }
        return;
      }
    }
    this.e(`ld de,${hex(v)}`);
    this.binDE(op, t);
  }

  private addConst(d: number) {
    d &= 0xffff;
    if (d === 0) return;
    if (d <= 2) { for (let i = 0; i < d; i++) this.e("inc hl"); return; }
    if (d >= 0xfffe) { for (let i = 0; i < 0x10000 - d; i++) this.e("dec hl"); return; }
    if ((d & 0xff) === 0) { this.e("ld a,h"); this.e(`add a,${hex8(d >> 8)}`); this.e("ld h,a"); return; }
    this.e(`ld de,${hex(d)}`);
    this.e("add hl,de");
  }

  private andConst(v: number) {
    for (const [r, b] of [["l", v & 0xff], ["h", v >> 8]] as const) {
      if (b === 0xff) continue;
      if (b === 0) { this.e(`ld ${r},0`); continue; }
      this.e(`ld a,${r}`); this.e(`and ${hex8(b)}`); this.e(`ld ${r},a`);
    }
  }

  private shl(k: number) {
    if (k >= 8) { this.e("ld h,l"); this.e("ld l,0"); k -= 8; }
    for (let i = 0; i < k; i++) this.e("add hl,hl");
  }

  private shr(k: number, signed: boolean) {
    if (k >= 8) {
      this.e("ld l,h");
      if (signed) { this.e("ld a,h"); this.e("rla"); this.e("sbc a,a"); this.e("ld h,a"); }
      else this.e("ld h,0");
      for (let i = 8; i < k; i++) this.e(signed ? "sra l" : "srl l");
      return;
    }
    for (let i = 0; i < k; i++) { this.e(signed ? "sra h" : "srl h"); this.e("rr l"); }
  }

  /** HL *= v con sumas y desplazamientos si sale corto; si no, __mul16. */
  private mulConst(v: number) {
    if (v === 0) { this.e("ld hl,0"); return; }
    if (v === 1) return;
    if (isPow2(v)) { this.shl(Math.log2(v)); return; }
    const bits = v.toString(2);
    const ops = bits.length - 1 + [...bits].filter((b) => b === "1").length - 1;
    if (ops <= 12) {
      this.e("ld d,h");
      this.e("ld e,l");
      for (let i = 1; i < bits.length; i++) {
        this.e("add hl,hl");
        if (bits[i] === "1") this.e("add hl,de");
      }
      return;
    }
    this.e(`ld de,${hex(v)}`);
    this.helper("__mul16");
  }

  // ---- expresiones (A) -----------------------------------------------------------------------------
  /** A = byte bajo del valor de e. */
  exprA(e: Expr): void {
    switch (e.k) {
      case "num": this.e((e.v & 0xff) === 0 ? "xor a" : `ld a,${hex8(e.v)}`); return;
      case "var": case "deref": {
        if (e.t.k === "struct" || e.t.k === "array" || e.t.k === "func") break;
        const l = this.loc(e);
        if (l) { this.loadA(l); return; }
        this.addr(e);
        this.e("ld a,[hl]");
        return;
      }
      case "cast": if (e.t.k !== "void") { this.exprA(e.e); return; } break;
      case "un":
        if (e.op === "!") break;
        this.exprA(e.e);
        if (e.op === "-") { this.e("cpl"); this.e("inc a"); } else this.e("cpl");
        return;
      case "bin": {
        if (NARROW.has(e.op)) { this.bin8(e.op, e.l, e.r); return; }
        if (e.op === "<<" && e.r.k === "num") {
          const k = e.r.v & 0xffff;
          if (k >= 8) { this.expr(e.l, true); this.e("xor a"); return; }
          this.exprA(e.l);
          for (let i = 0; i < k; i++) this.e("add a,a");
          return;
        }
        const li = stripNoop(e.l);
        if (e.op === ">>" && e.r.k === "num" && isChar(li.t)) {
          // El valor entero es el char extendido: basta desplazar el byte.
          const k = Math.min(8, e.r.v & 0xffff);
          const sg = li.t.k === "int" && li.t.signed;
          this.exprA(li);
          if (k === 8) { if (sg) { this.e("add a,a"); this.e("sbc a,a"); } else this.e("xor a"); return; }
          for (let i = 0; i < k; i++) this.e(sg ? "sra a" : "srl a");
          return;
        }
        break;
      }
      case "assign": this.assign(e, false, true); return;
      case "incdec": this.incdec(e, false, true); return;
      case "call": this.call(e); if (!isChar(e.t)) this.e("ld a,l"); return;
      case "comma": this.expr(e.l, true); this.exprA(e.r); return;
    }
    this.expr(e, false);
    this.e("ld a,l");
  }

  /** A = l op r (8 bits). */
  private bin8(op: string, l: Expr, r: Expr) {
    if (l.k === "num" && r.k !== "num" && op !== "-") [l, r] = [r, l];
    const alu = ALU[op]!;
    if (r.k === "num") {
      const v = r.v & 0xff;
      if (op === "&" && v === 0) { this.expr(l, true); this.e("xor a"); return; }
      this.exprA(l);
      if ((v === 0 && op !== "&") || (op === "&" && v === 0xff)) return;
      if (op === "|" && v === 0xff) { this.e("ld a,$FF"); return; }
      if (op === "^" && v === 0xff) { this.e("cpl"); return; }
      if (op === "+" && v === 1) { this.e("inc a"); return; }
      if (op === "-" && v === 1) { this.e("dec a"); return; }
      this.e(alu + hex8(v));
      return;
    }
    const m = this.mem8(r);
    if (m) { this.exprA(l); this.hlAt(m); this.e(alu + "[hl]"); return; }
    if (!(clob(l) & BC)) { this.exprA(r); this.e("ld c,a"); this.exprA(l); this.e(alu + "c"); return; }
    this.exprA(l);
    this.push("af");
    this.exprA(r);
    this.e("ld c,a");
    this.pop("af");
    this.e(alu + "c");
  }

  // ---- condiciones -------------------------------------------------------------------------------------
  /** Salta a `label` si el valor de verdad de e es `when`. */
  branch(e: Expr, label: string, when: boolean): void {
    switch (e.k) {
      case "num": if ((e.v !== 0) === when) this.jp("T", label); return;
      case "land": case "lor": {
        const isAnd = e.k === "land";
        if (isAnd !== when) {
          // && saltando si falso / || saltando si cierto: cualquiera de los dos decide.
          this.branch(e.l, label, when);
          this.branch(e.r, label, when);
        } else {
          const skip = this.newLabel();
          this.branch(e.l, skip, !when);
          this.branch(e.r, label, when);
          this.lab(skip);
        }
        return;
      }
      case "un": if (e.op === "!") { this.branch(e.e, label, !when); return; } break;
      case "cmp": { const cc = this.cmpFlags(e); this.jp(when ? cc : INVCC[cc]!, label); return; }
      case "comma": this.expr(e.l, true); this.branch(e.r, label, when); return;
    }
    const cc = this.truthFlags(e);
    this.jp(when ? cc : INVCC[cc]!, label);
  }

  /** Pone los flags según el valor de verdad de e; devuelve la condición de «cierto». */
  private truthFlags(e0: Expr): CC {
    const e = stripNoop(e0);
    if (e.k === "num") return e.v !== 0 ? "T" : "F";
    if (e.k === "cmp") return this.cmpFlags(e);
    // El valor es un char, o un & con máscara de 8 bits: basta el byte bajo.
    if (isChar(e.t) || (e.k === "bin" && e.op === "&" && ((e.r.k === "num" && (e.r.v & 0xff00) === 0) || (e.l.k === "num" && (e.l.v & 0xff00) === 0)))) {
      this.exprA(e);
      this.e("or a");
      return "nz";
    }
    this.expr(e, false);
    this.e("ld a,h");
    this.e("or l");
    return "nz";
  }

  /** Compara y deja los flags; devuelve la condición que significa «cierto». */
  private cmpFlags(e: Extract<Expr, { k: "cmp" }>): CC {
    let op: CmpOp = e.op;
    let l = e.l, r = e.r;
    if (l.k === "num" && r.k !== "num") {
      const SW: Record<CmpOp, CmpOp> = { "==": "==", "!=": "!=", "<": ">", ">": "<", "<=": ">=", ">=": "<=" };
      [l, r] = [r, l];
      op = SW[op];
    }
    const signed = e.signed;
    const li = stripNoop(l), ri = stripNoop(r);
    // 8 bits: char contra constante de su rango, o char contra char del mismo signo.
    if (isChar(li.t)) {
      const ls = li.t.k === "int" && li.t.signed;
      if (r.k === "num") {
        const v = r.v;
        if (v >= (ls ? -128 : 0) && v <= (ls ? 127 : 255) && (signed || !ls)) return this.cmp8c(op, li, v, ls);
      } else if (isChar(ri.t) && (ri.t.k === "int" && ri.t.signed) === ls && (signed || !ls)) return this.cmp8(op, li, ri, ls);
    }
    if (r.k === "num") {
      let v = r.v & 0xffff;
      if (v === 0 && (op === "==" || op === "!=")) {
        this.expr(l, false);
        this.e("ld a,h"); this.e("or l");
        return op === "==" ? "z" : "nz";
      }
      if (v === 0 && signed && (op === "<" || op === ">=")) {
        this.expr(l, false);
        this.e("bit 7,h");
        return op === "<" ? "nz" : "z";
      }
      if (v === 0 && !signed) {
        if (op === "<") { this.expr(l, true); return "F"; }
        if (op === ">=") { this.expr(l, true); return "T"; }
        this.expr(l, false);
        this.e("ld a,h"); this.e("or l");
        return op === ">" ? "nz" : "z";
      }
      if (op === "==" || op === "!=") {
        this.expr(l, false);
        const n = this.newLabel();
        this.e("ld a,l"); this.e(v & 0xff ? `cp ${hex8(v)}` : "or a");
        this.e(`jr nz,${this.ln(n)}`);
        this.e("ld a,h"); this.e(v >> 8 ? `cp ${hex8(v >> 8)}` : "or a");
        this.lab(n);
        return op === "==" ? "z" : "nz";
      }
      // a > v  ==  a >= v+1 ;  a <= v  ==  a < v+1
      const sv = signed ? (v ^ 0x8000) : v;
      if (op === ">" || op === "<=") {
        if (sv === 0xffff) { this.expr(l, true); return op === ">" ? "F" : "T"; }
        op = op === ">" ? ">=" : "<";
        v = (v + 1) & 0xffff;
      }
      this.expr(l, false);
      const fv = signed ? v ^ 0x8000 : v;
      if (signed) { this.e("ld a,h"); this.e("xor $80"); this.e("ld h,a"); }
      this.e("ld a,l"); this.e(fv & 0xff ? `sub ${hex8(fv)}` : "or a");
      this.e("ld a,h"); this.e(fv & 0xff ? `sbc a,${hex8(fv >> 8)}` : `sub ${hex8(fv >> 8)}`);
      return op === "<" ? "c" : "nc";
    }
    this.pair(l, r);
    if (op === "==" || op === "!=") {
      const n = this.newLabel();
      this.e("ld a,l"); this.e("cp e"); this.e(`jr nz,${this.ln(n)}`); this.e("ld a,h"); this.e("cp d");
      this.lab(n);
      return op === "==" ? "z" : "nz";
    }
    if (signed) { this.e("ld a,h"); this.e("xor $80"); this.e("ld h,a"); this.e("ld a,d"); this.e("xor $80"); this.e("ld d,a"); }
    if (op === "<" || op === ">=") { this.e("ld a,l"); this.e("sub e"); this.e("ld a,h"); this.e("sbc a,d"); return op === "<" ? "c" : "nc"; }
    this.e("ld a,e"); this.e("sub l"); this.e("ld a,d"); this.e("sbc a,h");
    return op === ">" ? "c" : "nc";
  }

  /** A ? v (8 bits). */
  private cmp8c(op: CmpOp, l: Expr, v: number, signed: boolean): CC {
    let x = v & 0xff;
    if (op === "==" || op === "!=") {
      this.exprA(l);
      this.e(x === 0 ? "or a" : `cp ${hex8(x)}`);
      return op === "==" ? "z" : "nz";
    }
    const sx = signed ? x ^ 0x80 : x;
    if ((op === "<" && sx === 0) || (op === ">" && sx === 255)) { this.expr(l, true); return "F"; }
    if ((op === ">=" && sx === 0) || (op === "<=" && sx === 255)) { this.expr(l, true); return "T"; }
    this.exprA(l);
    if (signed) { this.e("xor $80"); x = sx; }
    switch (op) {
      case "<": this.e(`cp ${hex8(x)}`); return "c";
      case ">=": this.e(`cp ${hex8(x)}`); return "nc";
      case ">": this.e(`cp ${hex8(x + 1)}`); return "nc";
      default: this.e(`cp ${hex8(x + 1)}`); return "c";
    }
  }

  /** l ? r, los dos char del mismo signo. */
  private cmp8(op: CmpOp, l: Expr, r: Expr, signed: boolean): CC {
    // a > b == b < a ; a <= b == b >= a
    const [a, b] = op === ">" || op === "<=" ? [r, l] : [l, r];
    const cc: CC = op === "==" ? "z" : op === "!=" ? "nz" : op === "<" || op === ">" ? "c" : "nc";
    const flip = signed && op !== "==" && op !== "!=";
    const m = flip ? null : this.mem8(b);
    if (m) { this.exprA(a); this.hlAt(m); this.e("cp [hl]"); return cc; }
    if (!(clob(a) & BC)) {
      this.exprA(b);
      if (flip) this.e("xor $80");
      this.e("ld c,a");
      this.exprA(a);
    } else {
      this.exprA(a);
      this.push("af");
      this.exprA(b);
      if (flip) this.e("xor $80");
      this.e("ld c,a");
      this.pop("af");
    }
    if (flip) this.e("xor $80");
    this.e("cp c");
    return cc;
  }

  // ---- asignaciones ------------------------------------------------------------------------------------
  /** wantA: deja el valor en A (si no, en HL). */
  private assign(e: Extract<Expr, { k: "assign" }>, discard: boolean, wantA: boolean) {
    const l = e.l, t = l.t;
    if (t.k === "struct") {
      this.addr(e.r);
      if (this.deLoadable({ ...l, k: "addr", e: l, t: { k: "ptr", to: t } } as Expr) || this.loc(l)?.k === "abs") this.dstDE(this.loc(l)!);
      else if (!(clob(l) & BC)) { this.e("ld b,h"); this.e("ld c,l"); this.addr(l); this.e("ld d,h"); this.e("ld e,l"); this.e("ld h,b"); this.e("ld l,c"); }
      else { this.push("hl"); this.addr(l); this.e("ld d,h"); this.e("ld e,l"); this.pop("hl"); }
      if (!discard) { this.push("de"); this.copyBytes(sizeOf(t)); this.pop("hl"); }
      else this.copyBytes(sizeOf(t));
      return;
    }
    const size = sizeOf(t);
    const signed = t.k === "int" && t.signed;
    const loc = this.loc(l);
    const result8 = () => { if (!discard && !wantA) this.extA(signed); };
    const result16 = () => { if (wantA) this.e("ld a,l"); };
    if (!e.op) {
      const r = e.r;
      if (size === 1) {
        if (loc) {
          this.exprA(r);
          this.storeA(loc);
          result8();
          return;
        }
        if (r.k === "num" && discard) { this.addr(l); this.e(`ld [hl],${hex8(r.v)}`); return; }
        if (r.k === "num" || this.mem8(r)?.k === "abs") { this.addr(l); this.exprA(r); this.e("ld [hl],a"); }
        else if (!(clob(r) & DE)) { this.addr(l); this.e("ld d,h"); this.e("ld e,l"); this.exprA(r); this.e("ld [de],a"); }
        else if (!(clob(r) & BC)) { this.addr(l); this.e("ld b,h"); this.e("ld c,l"); this.exprA(r); this.e("ld [bc],a"); }
        else { this.addr(l); this.push("hl"); this.exprA(r); this.pop("hl"); this.e("ld [hl],a"); }
        result8();
        return;
      }
      if (loc) {
        this.expr(r, false);
        this.store16(loc, !discard);
        result16();
        return;
      }
      if (r.k === "num" && discard) {
        this.addr(l);
        this.e(`ld a,${hex8(r.v)}`); this.e("ld [hl+],a"); this.e(`ld [hl],${hex8((r.v & 0xffff) >> 8)}`);
        return;
      }
      if (l.k === "deref" && this.deLoadable(l.e)) { this.expr(r, false); this.loadDE(l.e); }
      else if (!(clob(r) & DE)) { this.addr(l); this.e("ld d,h"); this.e("ld e,l"); this.expr(r, false); }
      else if (!(clob(r) & BC)) { this.addr(l); this.e("ld b,h"); this.e("ld c,l"); this.expr(r, false); this.e("ld d,b"); this.e("ld e,c"); }
      else { this.addr(l); this.push("hl"); this.expr(r, false); this.pop("de"); }
      this.storeViaDE(t);
      result16();
      return;
    }
    // Compuesta.
    const opT = e.opT!;
    if (size === 1 && loc && (NARROW.has(e.op) || (e.op === "<<" && e.r.k === "num"))) {
      // El byte bajo del resultado sólo depende de los bytes bajos: se opera en A.
      this.exprA({ k: "bin", op: e.op, l, r: e.r, t: opT, pos: e.pos });
      this.storeA(loc);
      result8();
      return;
    }
    if (loc) {
      this.load(loc, t);
      this.opWith(e.op, opT, e.r);
      if (size === 1) { this.e("ld a,l"); this.storeA(loc); result8(); }
      else { this.store16(loc, !discard); result16(); }
      return;
    }
    this.addr(l);
    this.push("hl");
    this.loadViaHL(t);
    this.opWith(e.op, opT, e.r);
    this.pop("de");
    if (size === 1) { this.e("ld a,l"); this.e("ld [de],a"); result8(); }
    else { this.storeViaDE(t); result16(); }
  }

  /** HL = HL op r, con HL ya cargado. */
  private opWith(op: string, opT: Type, r: Expr) {
    if (r.k === "num") { this.binConst(op, opT, r.v); return; }
    if (this.deLoadable(r)) this.loadDE(r);
    else { this.push("hl"); this.expr(r, false); this.e("ld d,h"); this.e("ld e,l"); this.pop("hl"); }
    this.binDE(op, opT);
  }

  private incdec(e: Extract<Expr, { k: "incdec" }>, discard: boolean, wantA: boolean) {
    const t = e.t, d = e.delta;
    const loc = this.loc(e.l);
    const signed = t.k === "int" && t.signed;
    if (sizeOf(t) === 1) {
      const op = d > 0 ? "inc" : "dec";
      if (loc) this.hlAt(loc); else this.addr(e.l);
      if (discard) { this.e(`${op} [hl]`); return; }
      if (e.post) { this.e("ld a,[hl]"); this.e(`${op} [hl]`); }
      else { this.e(`${op} [hl]`); this.e("ld a,[hl]"); }
      if (!wantA) this.extA(signed);
      return;
    }
    if (loc?.k === "abs" && !loc.h && discard && (d === 1 || d === -1)) {
      const n = this.newLabel();
      this.e(`ld hl,${loc.a}`);
      if (d === 1) { this.e("inc [hl]"); this.e(`jr nz,${this.ln(n)}`); this.e("inc hl"); this.e("inc [hl]"); }
      else { this.e("ld a,[hl]"); this.e("dec [hl]"); this.e("or a"); this.e(`jr nz,${this.ln(n)}`); this.e("inc hl"); this.e("dec [hl]"); }
      this.lab(n);
      return;
    }
    if (loc) {
      this.load16(loc);
      this.addConst(d);
      this.store16(loc, !discard);
      if (e.post && !discard) this.addConst(-d);
      if (wantA) this.e("ld a,l");
      return;
    }
    this.addr(e.l);
    this.e("ld e,[hl]");
    this.e("inc hl");
    this.e("ld d,[hl]");
    if (d === 1) this.e("inc de");
    else if (d === -1) this.e("dec de");
    else { this.e("ld a,e"); this.e(`add a,${hex8(d)}`); this.e("ld e,a"); this.e("ld a,d"); this.e(`adc a,${hex8(d >> 8)}`); this.e("ld d,a"); }
    this.e("ld [hl],d");
    this.e("dec hl");
    this.e("ld [hl],e");
    if (discard) return;
    this.e("ld h,d");
    this.e("ld l,e");
    if (e.post) this.addConst(-d);
    if (wantA) this.e("ld a,l");
  }

  // ---- llamadas ------------------------------------------------------------------------------------------
  /** Llama a f; deja el resultado en A (char) o HL (16 bits). */
  private call(e: Extract<Expr, { k: "call" }>) {
    const f = e.f, args = e.args;
    if (f.bank !== 0 && f.bank !== this.bank && !f.banked) {
      this.err(e.pos, `'${f.name}' está en el banco ${f.bank} y no es __banked: sólo se puede llamar desde su banco`);
    }
    const a0 = args[0];
    const arg0 = () => { if (a0) { if (sizeOf(a0.t) === 1) this.exprA(a0); else this.expr(a0, false); } };
    const target = () => {
      if (CodeGen.viaTramp(f)) {
        this.helpers.add("__bcall");
        this.e(`ld de,${f.label}`);
        this.e(`ld b,BANK(${f.label})`);
        this.e("call __bcall");
      } else this.e(`call ${f.label}`);
    };
    if (f.conv === "static") {
      // Argumentos 2.º y siguientes en el marco fijo del llamado (docs/c-abi.md §4.1).
      const slot = (i: number) => {
        let o = 0;
        for (let k = 0; k < i; k++) o += Math.max(1, sizeOf(f.params![k]!.type));
        return { k: "abs", a: plus(`__fr_${f.label}`, o), h: false } as Loc;
      };
      const nested = args.some(hasCall);
      if (!nested) {
        for (let i = 1; i < args.length; i++) {
          const a = args[i]!;
          if (sizeOf(a.t) === 1) { this.exprA(a); this.storeA(slot(i)); }
          else { this.expr(a, false); this.store16(slot(i), false); }
        }
        arg0();
      } else {
        // Una llamada anidada podría pisar huecos ya escritos: todo a la pila primero.
        for (let i = 0; i < args.length; i++) { this.expr(args[i]!, false); this.push("hl"); }
        for (let i = args.length - 1; i >= 1; i--) {
          this.pop("hl");
          if (sizeOf(args[i]!.t) === 1) { this.e("ld a,l"); this.storeA(slot(i)); }
          else this.store16(slot(i), false);
        }
        if (a0) { this.pop("hl"); if (sizeOf(a0.t) === 1) this.e("ld a,l"); }
      }
      target();
      return;
    }
    for (let i = args.length - 1; i >= 1; i--) { this.expr(args[i]!, false); this.push("hl"); }
    arg0();
    target();
    const n = 2 * Math.max(0, args.length - 1);
    if (n) { this.addSp(n); this.depth -= n; }
  }
}

/** Quita conversiones que no cambian la representación en HL (ampliaciones y punteros). */
export function stripNoop(e: Expr): Expr {
  while (e.k === "cast" && e.t.k !== "void" && !(e.t.k === "int" && e.t.size === 1) && (e.e.t.k === "int" || e.e.t.k === "ptr")) e = e.e;
  return e;
}

export function hasSide(e: Expr): boolean {
  switch (e.k) {
    case "num": case "str": case "var": case "faddr": return false;
    case "assign": case "incdec": case "call": return true;
    case "deref": case "addr": case "un": case "cast": return hasSide(e.e);
    case "bin": case "cmp": case "land": case "lor": case "comma": return hasSide(e.l) || hasSide(e.r);
    case "cond": return hasSide(e.c) || hasSide(e.a) || hasSide(e.b);
  }
}

function hasCall(e: Expr): boolean {
  switch (e.k) {
    case "num": case "str": case "var": case "faddr": return false;
    case "call": return true;
    case "deref": case "addr": case "un": case "cast": return hasCall(e.e);
    case "incdec": return hasCall(e.l);
    case "bin": case "cmp": case "land": case "lor": case "comma": case "assign": return hasCall(e.l) || hasCall(e.r);
    case "cond": return hasCall(e.c) || hasCall(e.a) || hasCall(e.b);
  }
}

/**
 * Registros (además de AF y HL) que puede pisar el código de e: DE (1) y BC (2). Cota
 * superior de lo que emite CodeGen para e en cualquiera de sus modos (HL, A, saltos).
 */
export function clob(e: Expr): number {
  switch (e.k) {
    case "num": case "str": case "var": case "faddr": return 0;
    case "deref": case "addr": case "cast": return clob(e.e);
    case "un": return clob(e.e);
    case "bin":
      if (e.op === "*" || e.op === "/" || e.op === "%") return ALL;
      if (e.r.k === "num" || e.l.k === "num") {
        // Con número de bits variable se llama al helper: lo que pisa sale de su tabla.
        const sh = (e.op === "<<" || e.op === ">>") && e.r.k !== "num"
          ? helperClob(e.op === "<<" ? "__shl16" : "__shru16") | helperClob("__shrs16") : 0;
        return DE | sh | clob(e.l) | clob(e.r);
      }
      return ALL;
    case "cmp":
      if (e.r.k === "num" || e.l.k === "num") return clob(e.l) | clob(e.r);
      return ALL;
    case "land": case "lor": case "comma": return clob(e.l) | clob(e.r);
    case "cond": return clob(e.c) | clob(e.a) | clob(e.b);
    case "assign": case "incdec": case "call": return ALL;
  }
}

function hasAsm(s: Stmt): boolean {
  switch (s.k) {
    case "asm": return true;
    case "block": return s.body.some(hasAsm);
    case "if": return hasAsm(s.a) || (!!s.b && hasAsm(s.b));
    case "while": case "do": case "switch": return hasAsm(s.body);
    case "for": return (!!s.init && hasAsm(s.init)) || hasAsm(s.body);
    default: return false;
  }
}
