// Ensamblador SM83 con sintaxis de un subconjunto de RGBDS (ver README.md).
// Puro (sin DOM), determinista y sin excepciones hacia fuera: los errores se acumulan.
//
// Funcionamiento:
//  1. Pasada 1: se recorren las líneas (con macros, REPT/FOR, IF, INCLUDE) y se generan los
//     bytes de cada sección. Lo que depende de algo aún desconocido (etiquetas de secciones
//     flotantes, referencias hacia delante) se deja como "parche" con su expresión.
//  2. Colocación: secciones fijas primero, luego flotantes de mayor a menor tamaño.
//  3. Pasada 2: se evalúan los parches y los ASSERT pendientes y se compone la ROM.

import { OPS, type Op } from "../sm83isa";
import { AsmErr, lex, TK_ANON, TK_ID, TK_NUM, TK_OP, TK_STR, type Tok } from "./lexer";

export type SectionKind = "ROM0" | "ROMX" | "WRAM0" | "WRAMX" | "HRAM" | "SRAM" | "VRAM";

export interface AsmError {
  line: number;
  col: number;
  file: string;
  msg: string;
}

export interface AsmSection {
  name: string;
  kind: SectionKind;
  bank: number;
  addr: number;
  size: number;
}

export interface AsmLineMapEntry {
  bank: number;
  addr: number;
  line: number;
  file: string;
  len: number;
}

export interface AsmResult {
  /** Imagen completa (bancos de 16 KB, potencia de 2 ≥ 32 KB, relleno 0xFF). Vacía si hay errores. */
  rom: Uint8Array;
  sections: AsmSection[];
  /** Dirección de entrada: la etiqueta `opts.entry` si se da, si no 0x0100. */
  entry: number;
  /** Etiquetas (globales, locales `Global.local`) → banco y dirección. */
  symbols: Map<string, { bank: number; addr: number }>;
  lineMap: AsmLineMapEntry[];
  errors: AsmError[];
  /** Avisos (WARN, ASSERT WARN, PRINT/PRINTLN). No impiden generar la ROM. */
  warnings: AsmError[];
}

export interface AsmOptions {
  /** Nombre del fichero principal (para errores y lineMap). Por defecto "main.asm". */
  file?: string;
  /** Ficheros para INCLUDE (texto) e INCBIN (binario). */
  files?: ReadonlyMap<string, string | Uint8Array>;
  /** Alternativa/complemento a `files`: resolver por nombre y fichero que incluye. */
  include?: (name: string, from: string) => string | Uint8Array | undefined;
  /** Símbolos predefinidos: número → EQU, texto → EQUS. */
  defines?: Readonly<Record<string, number | string>>;
  /** Número de bancos de 16 KB fijo; si no se da, la potencia de 2 mínima (≥ 2). */
  romBanks?: number;
  /** Etiqueta cuya dirección se devuelve en `entry`. */
  entry?: string;
}

// ---------------------------------------------------------------------------
// Regiones de memoria de cada tipo de sección.

interface Region {
  start: number;
  end: number;
  minBank: number;
  maxBank: number;
  rom: boolean;
}

const REGIONS: Record<SectionKind, Region> = {
  ROM0: { start: 0x0000, end: 0x4000, minBank: 0, maxBank: 0, rom: true },
  ROMX: { start: 0x4000, end: 0x8000, minBank: 1, maxBank: 511, rom: true },
  VRAM: { start: 0x8000, end: 0xa000, minBank: 0, maxBank: 1, rom: false },
  SRAM: { start: 0xa000, end: 0xc000, minBank: 0, maxBank: 15, rom: false },
  WRAM0: { start: 0xc000, end: 0xd000, minBank: 0, maxBank: 0, rom: false },
  WRAMX: { start: 0xd000, end: 0xe000, minBank: 1, maxBank: 7, rom: false },
  HRAM: { start: 0xff80, end: 0xffff, minBank: 0, maxBank: 0, rom: false },
};

interface Sec {
  name: string;
  kind: SectionKind;
  region: Region;
  fixedAddr: number; // -1 = flotante
  fixedBank: number; // -1 = flotante
  align: number; // bits
  alignOfs: number;
  addr: number; // -1 hasta colocarla
  bank: number; // -1 hasta colocarla
  data: number[] | null; // null en secciones de RAM
  size: number;
  fragment: boolean;
  file: string;
  line: number;
  order: number;
}

// ---------------------------------------------------------------------------
// Símbolos, expresiones y parches.

const S_EQU = 0;
const S_VAR = 1;
const S_LABEL = 2;
const S_EQUS = 3;

interface Sym {
  k: number;
  v: number;
  str: string;
  sec: Sec | null;
  off: number;
  file: string;
  line: number;
}

type Expr =
  | { k: "n"; v: number }
  | { k: "s"; name: string; col: number }
  | { k: "pc"; sec: Sec; off: number }
  | { k: "u"; op: string; a: Expr; col: number }
  | { k: "b"; op: string; a: Expr; b: Expr; col: number }
  | { k: "bank"; name: string | null; sec: Sec | null; secName: string | null; col: number }
  | { k: "sizeof" | "startof"; secName: string; col: number };

type PatchKind = "n8" | "n16" | "n32" | "e8" | "s8" | "a8" | "bit" | "vec";

interface Patch {
  sec: Sec;
  off: number;
  kind: PatchKind;
  e: Expr;
  /** e8: offset del final de la instrucción (el PC tras leerla). bit/vec: opcode base. */
  aux: number;
  file: string;
  line: number;
  col: number;
}

interface PendingAssert {
  e: Expr;
  level: string;
  msg: string;
  file: string;
  line: number;
  col: number;
}

// Operando ya analizado de una instrucción.
type POp =
  | { c: "reg"; n: string }
  | { c: "cond"; n: string }
  | { c: "ind"; n: string }
  | { c: "mem"; e: Expr; paren: boolean }
  | { c: "imm"; e: Expr }
  | { c: "spe"; e: Expr };

// ---------------------------------------------------------------------------
// Fuentes de líneas: fichero, expansión de macro o repetición.

const F_FILE = 0;
const F_MACRO = 1;
const F_REPT = 2;

interface Frame {
  kind: number;
  file: string;
  lines: string[];
  lineNos: number[];
  i: number;
  args: string[] | null;
  uniq: string;
  name: string;
  left: number;
  forVar: string | null;
  forVal: number;
  forStep: number;
  /** Macro cuyos argumentos (\1…) se ven aquí: la propia, o la que contiene el REPT. */
  mac: Frame | null;
  /** Profundidad de IF al entrar: BREAK cierra los IF abiertos dentro del bloque. */
  ifBase: number;
}

interface Capture {
  macro: boolean;
  name: string;
  depth: number;
  frameDepth: number;
  lines: string[];
  lineNos: number[];
  file: string;
  line: number;
  count: number;
  forVar: string | null;
  forVal: number;
  forStep: number;
}

interface MacroDef {
  lines: string[];
  lineNos: number[];
  file: string;
  line: number;
}

interface IfState {
  active: boolean;
  done: boolean;
  sawElse: boolean;
  file: string;
  line: number;
}

// ---------------------------------------------------------------------------
// Índice de instrucciones para el ensamblador.

const INDEX = new Map<string, Op[]>();
for (const op of OPS) {
  // BIT/RES/SET y RST se ensamblan con la entrada de valor 0 como plantilla y el valor
  // se suma al opcode (bit << 3, vector): así admiten expresiones y referencias diferidas.
  if (op.operands.some((o) => (o.kind === "u3" || o.kind === "vec") && o.value !== 0)) continue;
  let l = INDEX.get(op.mnemonic);
  if (!l) INDEX.set(op.mnemonic, (l = []));
  l.push(op);
}
// RGBDS también acepta `ld [c], a` y `ld a, [c]` (= LDH).
for (const op of OPS) {
  if (op.mnemonic === "LDH" && op.operands.some((o) => o.kind === "ind")) INDEX.get("LD")!.push(op);
}

const ALU_A = new Set(["ADD", "ADC", "SUB", "SBC", "AND", "XOR", "OR", "CP"]);
const REG_NAMES = new Set(["A", "B", "C", "D", "E", "H", "L", "AF", "BC", "DE", "HL", "SP"]);
const COND_NAMES = new Set(["NZ", "Z", "NC"]);
const MNEMONICS = new Set([...INDEX.keys(), "LDI", "LDD", "LDHL"]);
const DIRECTIVES = new Set([
  "SECTION", "ENDSECTION", "PUSHS", "POPS", "DB", "DW", "DL", "DS", "INCBIN", "INCLUDE", "DEF", "REDEF",
  "EQU", "EQUS", "SET", "MACRO", "ENDM", "SHIFT", "IF", "ELIF", "ELSE", "ENDC", "REPT", "FOR", "ENDR",
  "BREAK", "CHARMAP", "ASSERT", "STATIC_ASSERT", "PRINT", "PRINTLN", "FAIL", "WARN", "EXPORT", "GLOBAL",
  "PURGE", "RSRESET", "RSSET", "RB", "RW", "RL",
]);
const KEYWORDS: ReadonlySet<string> = new Set([...MNEMONICS, ...DIRECTIVES]);
const DEF_OPS = new Set(["EQU", "EQUS", "SET", "RB", "RW", "RL"]);
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

// Precedencia de operadores binarios de RGBDS (rgbasm(5)): ojo, & | ^ van por encima de + -.
const BIN_PREC: Record<string, number> = {
  "||": 1, "&&": 1,
  "==": 2, "!=": 2, "<": 2, ">": 2, "<=": 2, ">=": 2,
  "+": 3, "-": 3,
  "&": 4, "|": 4, "^": 4,
  "<<": 5, ">>": 5, ">>>": 5,
  "*": 6, "/": 6, "%": 6,
  "**": 7,
};

const MAX_ERRORS = 200;
const MAX_DEPTH = 64;
const MAX_LINES = 5_000_000;

const utf8 = new TextEncoder();
const utf8dec = new TextDecoder();

function hex(v: number, w = 4): string {
  return "$" + (v >>> 0).toString(16).toUpperCase().padStart(w, "0");
}

/** Primera palabra de la línea en mayúsculas (para IF/ENDC/ENDM/ENDR sin tokenizar). */
function firstWord(s: string): string {
  let i = 0;
  const n = s.length;
  while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  const st = i;
  while (i < n) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || (c >= 48 && c <= 57)) i++;
    else break;
  }
  return s.slice(st, i).toUpperCase();
}

function binop(op: string, a: number, b: number, col: number): number {
  switch (op) {
    case "+": return (a + b) | 0;
    case "-": return (a - b) | 0;
    case "*": return Math.imul(a, b);
    case "/":
      if (b === 0) throw new AsmErr(col, "division by zero");
      return Math.floor(a / b) | 0;
    case "%":
      if (b === 0) throw new AsmErr(col, "modulo by zero");
      return (a - b * Math.floor(a / b)) | 0;
    case "**": {
      if (b < 0) throw new AsmErr(col, "negative exponent");
      let r = 1;
      for (let i = 0; i < b && i < 64; i++) r = Math.imul(r, a);
      return r;
    }
    case "<<": return b >= 32 ? 0 : b < 0 ? binop(">>", a, -b, col) : a << b;
    case ">>": return b >= 32 ? (a < 0 ? -1 : 0) : b < 0 ? binop("<<", a, -b, col) : a >> b;
    case ">>>": return b >= 32 ? 0 : b < 0 ? binop("<<", a, -b, col) : (a >>> b) | 0;
    case "&": return a & b;
    case "|": return a | b;
    case "^": return a ^ b;
    case "==": return a === b ? 1 : 0;
    case "!=": return a !== b ? 1 : 0;
    case "<": return a < b ? 1 : 0;
    case ">": return a > b ? 1 : 0;
    case "<=": return a <= b ? 1 : 0;
    case ">=": return a >= b ? 1 : 0;
    case "&&": return a && b ? 1 : 0;
    case "||": return a || b ? 1 : 0;
  }
  throw new AsmErr(col, `unknown operator '${op}'`);
}

function unop(op: string, a: number): number {
  switch (op) {
    case "-": return -a | 0;
    case "+": return a;
    case "~": return ~a;
    case "!": return a ? 0 : 1;
    case "HIGH": return (a >> 8) & 0xff;
    case "LOW": return a & 0xff;
  }
  return a;
}

// ---------------------------------------------------------------------------

class Assembler {
  private readonly opts: AsmOptions;
  private readonly errors: AsmError[] = [];
  private readonly warnings: AsmError[] = [];
  private readonly syms = new Map<string, Sym>();
  private equsCount = 0;
  private readonly macros = new Map<string, MacroDef>();
  private readonly sections: Sec[] = [];
  private readonly secByName = new Map<string, Sec>();
  private readonly patches: Patch[] = [];
  private readonly asserts: PendingAssert[] = [];
  private readonly lineMap: { sec: Sec; off: number; len: number; file: string; line: number }[] = [];
  private readonly labels: string[] = [];
  private readonly charmap = new Map<string, number[]>();
  private charmapMax = 0;
  private readonly frames: Frame[] = [];
  private readonly ifs: IfState[] = [];
  private readonly secStack: { sec: Sec | null; scope: string }[] = [];
  private capture: Capture | null = null;
  private sec: Sec | null = null;
  private scope = "";
  private anonCount = 0;
  private uniqCount = 0;
  private abort = false;

  // Línea en curso.
  private curFile = "";
  private curLine = 0;
  private text = "";
  private toks: Tok[] = [];
  private p = 0;
  private end = 0;

  constructor(opts: AsmOptions) {
    this.opts = opts;
  }

  run(source: string): AsmResult {
    const file = this.opts.file ?? "main.asm";
    this.setVar("_RS", 0);
    for (const [k, v] of Object.entries(this.opts.defines ?? {})) {
      if (typeof v === "number") this.syms.set(k, { k: S_EQU, v: v | 0, str: "", sec: null, off: 0, file: "", line: 0 });
      else { this.syms.set(k, { k: S_EQUS, v: 0, str: v, sec: null, off: 0, file: "", line: 0 }); this.equsCount++; }
    }
    this.pushFile(file, source);
    this.pass1();
    const placed = this.place();
    let rom: Uint8Array = new Uint8Array(0);
    if (placed) {
      this.resolve();
      if (!this.errors.length) rom = this.buildRom();
    }
    return this.result(rom, placed);
  }

  // -------------------------------------------------------------------------
  // Errores

  private err(file: string, line: number, col: number, msg: string): void {
    if (this.errors.length >= MAX_ERRORS) { this.abort = true; return; }
    this.errors.push({ file, line, col, msg });
  }

  private warn(col: number, msg: string): void {
    this.warnings.push({ file: this.curFile, line: this.curLine, col, msg });
  }

  private macroContext(): string {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.kind === F_MACRO) return ` (in macro '${f.name}')`;
    }
    return "";
  }

  // -------------------------------------------------------------------------
  // Pasada 1

  private splitLines(src: string): { lines: string[]; lineNos: number[] } {
    const raw = src.split("\n");
    const lines: string[] = [];
    const lineNos: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      let l = raw[i]!;
      const no = i + 1;
      // Continuación de línea con '\' al final (fuera de comentarios).
      while (i + 1 < raw.length && /\\\s*$/.test(l) && !/\\\\\s*$/.test(l) && !l.includes(";")) {
        l = l.replace(/\\\s*$/, " ") + raw[++i]!;
      }
      lines.push(l);
      lineNos.push(no);
    }
    return { lines, lineNos };
  }

  private pushFile(file: string, src: string): void {
    const { lines, lineNos } = this.splitLines(src);
    this.frames.push({
      kind: F_FILE, file, lines, lineNos, i: 0, args: null, uniq: "", name: file,
      left: 0, forVar: null, forVal: 0, forStep: 0, mac: null, ifBase: this.ifs.length,
    });
  }

  private pass1(): void {
    let budget = MAX_LINES;
    while (this.frames.length && !this.abort) {
      const f = this.frames[this.frames.length - 1]!;
      if (f.i >= f.lines.length) { this.endFrame(f); continue; }
      if (--budget < 0) {
        this.err(this.curFile, this.curLine, 1, "too many lines processed (infinite REPT or macro recursion?)");
        break;
      }
      const idx = f.i++;
      this.curFile = f.file;
      this.curLine = f.lineNos[idx]!;
      let text = f.lines[idx]!;
      try {
        // Dentro de MACRO/REPT capturado el texto se guarda sin sustituir: los argumentos se
        // expanden al ejecutar cada línea (así SHIFT dentro de REPT _NARG funciona).
        if (this.capture) { this.captureLine(text); continue; }
        if ((f.mac || f.kind === F_REPT) && text.includes("\\")) text = this.substArgs(text, f);
        if (this.ifs.length && !this.ifs[this.ifs.length - 1]!.active) { this.skipLine(text); continue; }
        if (text.includes("{")) text = this.interpolate(text);
        this.text = text;
        let toks = lex(text, KEYWORDS);
        if (!toks.length) continue;
        if (this.equsCount) toks = this.expandEqus(toks);
        this.toks = toks;
        this.p = 0;
        this.end = toks.length;
        this.statement();
      } catch (e) {
        if (e instanceof AsmErr) this.err(this.curFile, this.curLine, e.col, e.message + this.macroContext());
        else throw e;
      }
    }
    if (this.capture) {
      const c = this.capture;
      this.err(c.file, c.line, 1, c.macro ? `unterminated MACRO '${c.name}' (missing ENDM)` : "unterminated REPT/FOR (missing ENDR)");
      this.capture = null;
    }
    for (const s of this.ifs) this.err(s.file, s.line, 1, "unterminated IF (missing ENDC)");
  }

  private endFrame(f: Frame): void {
    if (this.capture && this.capture.frameDepth === this.frames.length) {
      const c = this.capture;
      this.err(c.file, c.line, 1, c.macro ? `unterminated MACRO '${c.name}' (missing ENDM)` : "unterminated REPT/FOR (missing ENDR)");
      this.capture = null;
    }
    if (f.kind === F_REPT && --f.left > 0) {
      f.i = 0;
      f.uniq = `_u${++this.uniqCount}`;
      if (f.forVar !== null) {
        f.forVal = (f.forVal + f.forStep) | 0;
        this.setVar(f.forVar, f.forVal);
      }
      return;
    }
    this.frames.pop();
  }

  /** Sustituye \1…\9, \<n>, \@, \# en una línea de macro (o \@ en REPT). */
  private substArgs(text: string, f: Frame): string {
    let out = "";
    let i = 0;
    const n = text.length;
    const args = f.mac?.args ?? null;
    while (i < n) {
      const ch = text[i]!;
      if (ch !== "\\" || i + 1 >= n) { out += ch; i++; continue; }
      const nx = text[i + 1]!;
      if (nx === "@") { out += f.uniq; i += 2; continue; }
      if (args) {
        if (nx >= "1" && nx <= "9") {
          const a = args[nx.charCodeAt(0) - 49];
          if (a === undefined) throw new AsmErr(i + 1, `macro argument '\\${nx}' not defined`);
          out += a;
          i += 2;
          continue;
        }
        if (nx === "#") { out += args.join(", "); i += 2; continue; }
        if (nx === "<") {
          const close = text.indexOf(">", i + 2);
          if (close > 0) {
            const inner = text.slice(i + 2, close).trim();
            let k = Number(inner);
            if (!/^\d+$/.test(inner)) {
              const s = this.syms.get(inner);
              if (!s || (s.k !== S_EQU && s.k !== S_VAR)) throw new AsmErr(i + 1, `invalid macro argument '\\<${inner}>'`);
              k = s.v;
            }
            const a = args[k - 1];
            if (a === undefined) throw new AsmErr(i + 1, `macro argument '\\<${inner}>' not defined`);
            out += a;
            i = close + 1;
            continue;
          }
        }
      }
      // Escapes de cadena (\n, \", \\…): se dejan para el lexer.
      out += ch + nx;
      i += 2;
    }
    return out;
  }

  /** Interpolación {sym} / {fmt:sym} de RGBDS. */
  private interpolate(text: string): string {
    let out = "";
    let i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i]!;
      if (ch === "\\" && i + 1 < n) { out += ch + text[i + 1]; i += 2; continue; }
      if (ch === ";") { out += text.slice(i); break; }
      if (ch !== "{") { out += ch; i++; continue; }
      const close = text.indexOf("}", i + 1);
      if (close < 0) throw new AsmErr(i + 1, "missing '}' in symbol interpolation");
      let inner = text.slice(i + 1, close).trim();
      let fmt = "";
      const colon = inner.indexOf(":");
      if (colon >= 0) { fmt = inner.slice(0, colon); inner = inner.slice(colon + 1).trim(); }
      const name = inner.startsWith(".") ? this.scope + inner : inner;
      const s = this.syms.get(name);
      if (!s) throw new AsmErr(i + 1, `interpolated symbol '${inner}' does not exist`);
      if (s.k === S_EQUS) out += s.str;
      else {
        let v = s.v;
        if (s.k === S_LABEL) {
          if (s.sec!.addr < 0) throw new AsmErr(i + 1, `cannot interpolate non-constant label '${inner}'`);
          v = s.sec!.addr + s.off;
        }
        const pre = fmt.includes("#");
        const type = fmt.replace(/[#\d+\-.]/g, "") || "X";
        switch (type) {
          case "d": out += String(v); break;
          case "u": out += String(v >>> 0); break;
          case "x": out += (pre ? "$" : "") + (v >>> 0).toString(16); break;
          case "b": out += (pre ? "%" : "") + (v >>> 0).toString(2); break;
          case "o": out += (pre ? "&" : "") + (v >>> 0).toString(8); break;
          default: out += "$" + (v >>> 0).toString(16).toUpperCase(); break;
        }
      }
      i = close + 1;
    }
    return out;
  }

  private expandEqus(toks: Tok[]): Tok[] {
    let guard = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.t !== TK_ID) continue;
      const s = this.syms.get(t.s);
      if (!s || s.k !== S_EQUS) continue;
      const prev = toks[i - 1];
      const pu = prev && prev.t === TK_ID ? prev.s.toUpperCase() : "";
      if (pu === "DEF" || pu === "REDEF" || pu === "PURGE" || pu === "EXPORT" || pu === "GLOBAL") continue;
      if (prev && prev.t === TK_OP && prev.s === "(") {
        const pp = toks[i - 2];
        if (pp && pp.t === TK_ID && pp.s.toUpperCase() === "DEF") continue;
      }
      if (i === 0) {
        const nx = toks[1];
        if (nx && ((nx.t === TK_ID && DEF_OPS.has(nx.s.toUpperCase())) || (nx.t === TK_OP && ASSIGN_OPS.has(nx.s)))) continue;
      }
      if (++guard > 1000) throw new AsmErr(t.col, "EQUS expansion too deep");
      const sub = lex(s.str, KEYWORDS);
      for (const st of sub) st.col = t.col;
      toks.splice(i, 1, ...sub);
      i--;
    }
    return toks;
  }

  private captureLine(text: string): void {
    const c = this.capture!;
    const w = firstWord(text);
    if (c.macro) {
      if (w === "ENDM") { this.finishCapture(); return; }
    } else if (w === "REPT" || w === "FOR") {
      c.depth++;
    } else if (w === "ENDR") {
      if (--c.depth === 0) { this.finishCapture(); return; }
    }
    c.lines.push(text);
    c.lineNos.push(this.curLine);
  }

  private finishCapture(): void {
    const c = this.capture!;
    this.capture = null;
    if (c.macro) {
      this.macros.set(c.name, { lines: c.lines, lineNos: c.lineNos, file: c.file, line: c.line });
      return;
    }
    if (c.count <= 0) return;
    if (this.frames.length >= MAX_DEPTH * 4) throw new AsmErr(1, "nesting too deep");
    if (c.forVar !== null) this.setVar(c.forVar, c.forVal);
    this.frames.push({
      kind: F_REPT, file: c.file, lines: c.lines, lineNos: c.lineNos, i: 0, args: null,
      uniq: `_u${++this.uniqCount}`, name: "REPT", left: c.count, forVar: c.forVar, forVal: c.forVal, forStep: c.forStep,
      mac: this.frames[this.frames.length - 1]?.mac ?? null, ifBase: this.ifs.length,
    });
  }

  private skipLine(text: string): void {
    const w = firstWord(text);
    const top = this.ifs[this.ifs.length - 1]!;
    switch (w) {
      case "IF":
        this.ifs.push({ active: false, done: true, sawElse: false, file: this.curFile, line: this.curLine });
        break;
      case "ELIF":
        if (top.sawElse) throw new AsmErr(1, "ELIF after ELSE");
        if (!top.done) {
          if (text.includes("{")) text = this.interpolate(text);
          this.toks = lex(text, KEYWORDS);
          if (this.equsCount) this.toks = this.expandEqus(this.toks);
          this.p = 1;
          this.end = this.toks.length;
          if (this.constExpr() !== 0) { top.active = true; top.done = true; }
          this.endOfLine();
        }
        break;
      case "ELSE":
        if (top.sawElse) throw new AsmErr(1, "duplicate ELSE");
        top.sawElse = true;
        if (!top.done) { top.active = true; top.done = true; }
        break;
      case "ENDC":
        this.ifs.pop();
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Tokens de la línea en curso

  private peek(): Tok | undefined {
    return this.p < this.end ? this.toks[this.p] : undefined;
  }

  private isOp(s: string, at = this.p): boolean {
    if (at >= this.end) return false;
    const t = this.toks[at]!;
    return t.t === TK_OP && t.s === s;
  }

  private isId(s: string, at = this.p): boolean {
    if (at >= this.end) return false;
    const t = this.toks[at]!;
    return t.t === TK_ID && t.s.toUpperCase() === s;
  }

  private colHere(): number {
    const t = this.toks[this.p];
    if (t) return t.col;
    const last = this.toks[this.end - 1];
    return last ? last.col + Math.max(1, last.s.length) : 1;
  }

  private expectOp(s: string): void {
    if (!this.isOp(s)) throw new AsmErr(this.colHere(), `expected '${s}'`);
    this.p++;
  }

  private endOfLine(): void {
    if (this.p < this.end) throw new AsmErr(this.colHere(), `unexpected '${this.toks[this.p]!.s}'`);
  }

  private str(): string {
    const t = this.peek();
    if (!t || t.t !== TK_STR) throw new AsmErr(this.colHere(), "expected a string");
    this.p++;
    return t.s;
  }

  private ident(): Tok {
    const t = this.peek();
    if (!t || t.t !== TK_ID) throw new AsmErr(this.colHere(), "expected an identifier");
    this.p++;
    return t;
  }

  // -------------------------------------------------------------------------
  // Expresiones

  private expr(): Expr {
    if (this.p >= this.end) throw new AsmErr(this.colHere(), "expected an expression");
    return this.binary(1);
  }

  private binary(minPrec: number): Expr {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== TK_OP) break;
      const prec = BIN_PREC[t.s];
      if (prec === undefined || prec < minPrec) break;
      this.p++;
      const right = this.binary(t.s === "**" ? prec : prec + 1);
      left = this.mkBin(t.s, left, right, t.col);
    }
    return left;
  }

  private mkBin(op: string, a: Expr, b: Expr, col: number): Expr {
    if (a.k === "n" && b.k === "n") return { k: "n", v: binop(op, a.v, b.v, col) };
    return { k: "b", op, a, b, col };
  }

  private mkUn(op: string, a: Expr, col: number): Expr {
    if (a.k === "n") return { k: "n", v: unop(op, a.v) };
    return { k: "u", op, a, col };
  }

  private unary(): Expr {
    const t = this.peek();
    if (t && t.t === TK_OP && (t.s === "-" || t.s === "+" || t.s === "~" || t.s === "!")) {
      this.p++;
      return this.mkUn(t.s, this.unary(), t.col);
    }
    return this.primary();
  }

  private primary(): Expr {
    const t = this.peek();
    if (!t) throw new AsmErr(this.colHere(), "expected an expression");
    this.p++;
    switch (t.t) {
      case TK_NUM:
        return { k: "n", v: t.v };
      case TK_STR: {
        const b = this.mapStr(t.s);
        if (b.length !== 1) throw new AsmErr(t.col, "string in numeric expression must map to exactly one byte");
        return { k: "n", v: b[0]! };
      }
      case TK_ANON:
        return this.symRef(this.anonName(t), t.col);
      case TK_OP:
        if (t.s === "(") {
          const e = this.expr();
          this.expectOp(")");
          return e;
        }
        if (t.s === "@") return this.pcRef(t.col);
        break;
      case TK_ID: {
        if (this.isOp("(")) {
          const fn = t.s.toUpperCase();
          const r = this.func(fn, t.col);
          if (r) return r;
        }
        if (t.s === "_NARG") return { k: "n", v: this.narg(t.col) };
        return this.symRef(t.s, t.col);
      }
    }
    throw new AsmErr(t.col, `unexpected '${t.s}' in expression`);
  }

  private func(fn: string, col: number): Expr | null {
    switch (fn) {
      case "HIGH": case "LOW": {
        this.p++;
        const e = this.expr();
        this.expectOp(")");
        return this.mkUn(fn, e, col);
      }
      case "BANK": {
        this.p++;
        const a = this.peek();
        let r: Expr;
        if (a && a.t === TK_STR) { this.p++; r = { k: "bank", name: null, sec: null, secName: a.s, col }; }
        else if (a && a.t === TK_OP && a.s === "@") { this.p++; r = { k: "bank", name: null, sec: this.needSec(col), secName: null, col }; }
        else if (a && (a.t === TK_ID || a.t === TK_ANON)) {
          this.p++;
          r = { k: "bank", name: a.t === TK_ANON ? this.anonName(a) : this.fullName(a.s, a.col), sec: null, secName: null, col };
        } else throw new AsmErr(this.colHere(), "BANK() expects a symbol, '@' or a section name");
        this.expectOp(")");
        const v = this.ev(r, false);
        return v === undefined ? r : { k: "n", v };
      }
      case "SIZEOF": case "STARTOF": {
        this.p++;
        const name = this.str();
        this.expectOp(")");
        const r: Expr = { k: fn === "SIZEOF" ? "sizeof" : "startof", secName: name, col };
        if (fn === "STARTOF") {
          const v = this.ev(r, false);
          if (v !== undefined) return { k: "n", v };
        }
        return r;
      }
      case "DEF": {
        this.p++;
        const a = this.peek();
        if (!a || (a.t !== TK_ID && a.t !== TK_ANON)) throw new AsmErr(this.colHere(), "DEF() expects a symbol name");
        this.p++;
        this.expectOp(")");
        const name = a.t === TK_ANON ? this.anonName(a) : a.s.startsWith(".") ? this.scope + a.s : a.s;
        return { k: "n", v: this.syms.has(name) || this.macros.has(name) ? 1 : 0 };
      }
      case "ISCONST": {
        this.p++;
        const e = this.expr();
        this.expectOp(")");
        return { k: "n", v: this.ev(e, false) === undefined ? 0 : 1 };
      }
      case "STRLEN": {
        this.p++;
        const s = this.str();
        this.expectOp(")");
        return { k: "n", v: [...s].length };
      }
    }
    return null;
  }

  private narg(col: number): number {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.kind === F_MACRO) return f.args!.length;
    }
    throw new AsmErr(col, "_NARG used outside of a macro");
  }

  private anonName(t: Tok): string {
    const n = t.v < 0 ? this.anonCount + t.v : this.anonCount + t.v - 1;
    if (n < 0) throw new AsmErr(t.col, "reference to anonymous label before the first one");
    return `!anon${n}`;
  }

  private fullName(name: string, col: number): string {
    if (name.charCodeAt(0) === 46 /* . */) {
      if (!this.scope) throw new AsmErr(col, `local label '${name}' without a global label before it`);
      return this.scope + name;
    }
    return name;
  }

  private symRef(name: string, col: number): Expr {
    const full = this.fullName(name, col);
    const s = this.syms.get(full);
    if (s) {
      if (s.k === S_EQU || s.k === S_VAR) return { k: "n", v: s.v };
      if (s.k === S_EQUS) throw new AsmErr(col, `'${full}' is a string symbol (EQUS)`);
      if (s.sec!.addr >= 0) return { k: "n", v: s.sec!.addr + s.off };
    }
    return { k: "s", name: full, col };
  }

  private pcRef(col: number): Expr {
    const sec = this.needSec(col);
    return sec.addr >= 0 ? { k: "n", v: sec.addr + sec.size } : { k: "pc", sec, off: sec.size };
  }

  private needSec(col: number): Sec {
    if (!this.sec) throw new AsmErr(col, "not inside a section");
    return this.sec;
  }

  /** Etiqueta o '@' → (sección, offset), para restar dos direcciones de la misma sección. */
  private labelRef(e: Expr): { sec: Sec; off: number } | null {
    if (e.k === "pc") return e;
    if (e.k === "s") {
      const s = this.syms.get(e.name);
      if (s && s.k === S_LABEL) return { sec: s.sec!, off: s.off };
    }
    return null;
  }

  /** Sección por nombre; puede definirse más adelante, así que sólo es error en la pasada final. */
  private findSec(name: string, col: number, fin: boolean): Sec | undefined {
    const s = this.secByName.get(name);
    if (!s && fin) throw new AsmErr(col, `section '${name}' does not exist`);
    return s;
  }

  /** Evalúa; undefined si aún no se conoce. Con `fin`, un símbolo indefinido es error. */
  private ev(e: Expr, fin: boolean): number | undefined {
    switch (e.k) {
      case "n":
        return e.v;
      case "s": {
        const s = this.syms.get(e.name);
        if (!s) {
          if (fin) throw new AsmErr(e.col, `undefined symbol '${e.name.startsWith("!anon") ? "anonymous label" : e.name}'`);
          return undefined;
        }
        if (s.k === S_LABEL) return s.sec!.addr >= 0 ? s.sec!.addr + s.off : undefined;
        if (s.k === S_EQUS) throw new AsmErr(e.col, `'${e.name}' is a string symbol (EQUS)`);
        return s.v;
      }
      case "pc":
        return e.sec.addr >= 0 ? e.sec.addr + e.off : undefined;
      case "u": {
        const a = this.ev(e.a, fin);
        return a === undefined ? undefined : unop(e.op, a);
      }
      case "b": {
        if (e.op === "-") {
          const la = this.labelRef(e.a);
          const lb = la && this.labelRef(e.b);
          if (la && lb && la.sec === lb.sec) return (la.off - lb.off) | 0;
        }
        const a = this.ev(e.a, fin);
        const b = this.ev(e.b, fin);
        return a === undefined || b === undefined ? undefined : binop(e.op, a, b, e.col);
      }
      case "bank": {
        let sec: Sec;
        if (e.sec) sec = e.sec;
        else if (e.secName !== null) {
          const s = this.findSec(e.secName, e.col, fin);
          if (!s) return undefined;
          sec = s;
        } else {
          const s = this.syms.get(e.name!);
          if (!s) {
            if (fin) throw new AsmErr(e.col, `undefined symbol '${e.name}'`);
            return undefined;
          }
          if (s.k !== S_LABEL) throw new AsmErr(e.col, `BANK() of '${e.name}', which is not a label`);
          sec = s.sec!;
        }
        return sec.bank >= 0 ? sec.bank : undefined;
      }
      case "sizeof": {
        const sec = this.findSec(e.secName, e.col, fin);
        return sec && fin ? sec.size : undefined;
      }
      case "startof": {
        const sec = this.findSec(e.secName, e.col, fin);
        return sec && sec.addr >= 0 ? sec.addr : undefined;
      }
    }
  }

  private constExpr(): number {
    const col = this.colHere();
    const e = this.expr();
    const v = this.ev(e, false);
    if (v === undefined) {
      const why = e.k === "s" && !this.syms.has(e.name) ? `undefined symbol '${e.name}'` : "expression is not constant";
      throw new AsmErr(col, why);
    }
    return v;
  }

  // -------------------------------------------------------------------------
  // Sentencias

  private statement(): void {
    const toks = this.toks;
    const t0 = toks[0]!;
    // Etiquetas
    if (t0.t === TK_OP && t0.s === ":") {
      this.defineLabel(`!anon${this.anonCount++}`, t0.col, false);
      this.p = 1;
    } else if (t0.t === TK_ID && (this.isOp(":", 1) || this.isOp("::", 1))) {
      if (this.isId("MACRO", 2)) {
        this.p = 3;
        this.startMacro(t0.s, t0.col);
        return;
      }
      this.defineLabel(t0.s, t0.col, true);
      this.p = 2;
    } else if (t0.t === TK_ID && t0.s.charCodeAt(0) === 46 && !(toks[1] && toks[1].t === TK_ID && DEF_OPS.has(toks[1].s.toUpperCase()))) {
      this.defineLabel(t0.s, t0.col, true);
      this.p = 1;
    }
    if (this.p >= this.end) return;
    const head = toks[this.p]!;
    if (head.t !== TK_ID) throw new AsmErr(head.col, `syntax error at '${head.s}'`);
    const U = head.s.toUpperCase();
    this.p++;
    if (MNEMONICS.has(U)) { this.instruction(U, head); return; }
    if (DIRECTIVES.has(U) && !(U === "EQU" || U === "EQUS" || U === "SET" || U === "RB" || U === "RW" || U === "RL")) {
      this.directive(U, head);
      return;
    }
    // Definiciones al estilo antiguo: `nombre EQU v`, `nombre = v`…
    const nx = this.peek();
    if (nx && ((nx.t === TK_ID && DEF_OPS.has(nx.s.toUpperCase())) || (nx.t === TK_OP && ASSIGN_OPS.has(nx.s)))) {
      this.define(head, false);
      return;
    }
    const m = this.macros.get(head.s);
    if (m) { this.invoke(head, m); return; }
    throw new AsmErr(head.col, `unknown instruction, directive or macro '${head.s}'`);
  }

  private defineLabel(name: string, col: number, named: boolean): void {
    const sec = this.needSec(col);
    let full = name;
    if (named) {
      if (name.charCodeAt(0) === 46) full = this.fullName(name, col);
      else if (!name.includes(".")) this.scope = name;
    }
    const old = this.syms.get(full);
    if (old) throw new AsmErr(col, `'${full}' already defined at ${old.file}:${old.line}`);
    this.syms.set(full, { k: S_LABEL, v: 0, str: "", sec, off: sec.size, file: this.curFile, line: this.curLine });
    if (named) this.labels.push(full);
  }

  private setVar(name: string, v: number): void {
    const s = this.syms.get(name);
    if (s && s.k === S_VAR) { s.v = v | 0; return; }
    this.syms.set(name, { k: S_VAR, v: v | 0, str: "", sec: null, off: 0, file: this.curFile, line: this.curLine });
  }

  /** `nombre EQU/EQUS/=/SET/RB… valor` con el cursor tras el nombre. */
  private define(nameTok: Tok, redef: boolean): void {
    const name = this.fullName(nameTok.s, nameTok.col);
    const opTok = this.toks[this.p]!;
    this.p++;
    const op = opTok.t === TK_ID ? opTok.s.toUpperCase() : opTok.s;
    const old = this.syms.get(name);
    const where = old ? `${old.file}:${old.line}` : "";
    if (KEYWORDS.has(name.toUpperCase())) throw new AsmErr(nameTok.col, `'${name}' is a reserved word`);
    switch (op) {
      case "EQU": {
        const v = this.constExpr();
        if (old && !(redef && old.k === S_EQU)) throw new AsmErr(nameTok.col, `'${name}' already defined at ${where}`);
        this.syms.set(name, { k: S_EQU, v, str: "", sec: null, off: 0, file: this.curFile, line: this.curLine });
        break;
      }
      case "EQUS": {
        const s = this.str();
        if (old && !(redef && old.k === S_EQUS)) throw new AsmErr(nameTok.col, `'${name}' already defined at ${where}`);
        if (!old) this.equsCount++;
        this.syms.set(name, { k: S_EQUS, v: 0, str: s, sec: null, off: 0, file: this.curFile, line: this.curLine });
        break;
      }
      case "=": case "SET": {
        const v = this.constExpr();
        if (old && old.k !== S_VAR) throw new AsmErr(nameTok.col, `'${name}' already defined as a constant at ${where}`);
        this.setVar(name, v);
        break;
      }
      case "RB": case "RW": case "RL": {
        const n = this.p < this.end ? this.constExpr() : 1;
        if (old) throw new AsmErr(nameTok.col, `'${name}' already defined at ${where}`);
        const rs = this.syms.get("_RS")!;
        this.syms.set(name, { k: S_EQU, v: rs.v, str: "", sec: null, off: 0, file: this.curFile, line: this.curLine });
        rs.v = (rs.v + n * (op === "RB" ? 1 : op === "RW" ? 2 : 4)) | 0;
        break;
      }
      default: {
        if (!ASSIGN_OPS.has(op)) throw new AsmErr(opTok.col, `expected EQU, EQUS, = or RB after '${name}'`);
        if (!old || old.k !== S_VAR) throw new AsmErr(nameTok.col, `'${name}' is not a variable defined with '='`);
        const v = this.constExpr();
        this.setVar(name, binop(op.slice(0, -1), old.v, v, opTok.col));
      }
    }
    this.endOfLine();
  }

  private startMacro(name: string, col: number): void {
    if (KEYWORDS.has(name.toUpperCase())) throw new AsmErr(col, `'${name}' is a reserved word`);
    const old = this.macros.get(name);
    if (old) throw new AsmErr(col, `macro '${name}' already defined at ${old.file}:${old.line}`);
    this.capture = {
      macro: true, name, depth: 1, frameDepth: this.frames.length, lines: [], lineNos: [],
      file: this.curFile, line: this.curLine, count: 0, forVar: null, forVal: 0, forStep: 0,
    };
  }

  private invoke(head: Tok, m: MacroDef): void {
    let depth = 0;
    for (const f of this.frames) if (f.kind === F_MACRO) depth++;
    if (depth >= MAX_DEPTH) throw new AsmErr(head.col, `macro recursion too deep ('${head.s}')`);
    const args = splitMacroArgs(this.text.slice(head.col - 1 + head.s.length));
    const f: Frame = {
      kind: F_MACRO, file: m.file, lines: m.lines, lineNos: m.lineNos, i: 0, args,
      uniq: `_u${++this.uniqCount}`, name: head.s, left: 0, forVar: null, forVal: 0, forStep: 0,
      mac: null, ifBase: this.ifs.length,
    };
    f.mac = f;
    this.frames.push(f);
  }

  private directive(U: string, head: Tok): void {
    switch (U) {
      case "SECTION": this.section(); break;
      case "ENDSECTION": this.sec = null; break;
      case "PUSHS": this.secStack.push({ sec: this.sec, scope: this.scope }); this.sec = null; break;
      case "POPS": {
        const s = this.secStack.pop();
        if (!s) throw new AsmErr(head.col, "POPS without PUSHS");
        this.sec = s.sec;
        this.scope = s.scope;
        break;
      }
      case "DB": this.data(1, head); break;
      case "DW": this.data(2, head); break;
      case "DL": this.data(4, head); break;
      case "DS": this.ds(head); break;
      case "INCBIN": this.incbin(head); break;
      case "INCLUDE": {
        const name = this.str();
        this.endOfLine();
        const v = this.readFile(name, head.col);
        if (this.frames.length >= MAX_DEPTH * 4) throw new AsmErr(head.col, "INCLUDE nesting too deep");
        this.pushFile(name, typeof v === "string" ? v : utf8dec.decode(v));
        break;
      }
      case "DEF": case "REDEF": {
        const name = this.ident();
        const nx = this.peek();
        if (!nx || !((nx.t === TK_ID && DEF_OPS.has(nx.s.toUpperCase())) || (nx.t === TK_OP && ASSIGN_OPS.has(nx.s)))) {
          throw new AsmErr(this.colHere(), "expected EQU, EQUS, = or RB");
        }
        this.define(name, U === "REDEF");
        return;
      }
      case "MACRO": {
        const name = this.ident();
        this.startMacro(name.s, name.col);
        return;
      }
      case "ENDM": throw new AsmErr(head.col, "ENDM without MACRO");
      case "ENDR": throw new AsmErr(head.col, "ENDR without REPT/FOR");
      case "SHIFT": {
        const n = this.p < this.end ? this.constExpr() : 1;
        let f: Frame | undefined;
        for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.kind === F_MACRO) { f = this.frames[i]; break; }
        if (!f) throw new AsmErr(head.col, "SHIFT outside of a macro");
        if (n < 0 || n > f.args!.length) throw new AsmErr(head.col, `cannot shift ${n} macro arguments`);
        f.args = f.args!.slice(n);
        break;
      }
      case "IF": {
        const v = this.constExpr();
        this.ifs.push({ active: v !== 0, done: v !== 0, sawElse: false, file: this.curFile, line: this.curLine });
        break;
      }
      case "ELIF": case "ELSE": {
        const top = this.ifs[this.ifs.length - 1];
        if (!top) throw new AsmErr(head.col, `${U} without IF`);
        if (top.sawElse) throw new AsmErr(head.col, `${U} after ELSE`);
        if (U === "ELSE") top.sawElse = true;
        // Si llegamos aquí la rama anterior estaba activa: el resto se salta sin evaluar.
        top.active = false;
        top.done = true;
        return;
      }
      case "ENDC":
        if (!this.ifs.pop()) throw new AsmErr(head.col, "ENDC without IF");
        break;
      case "REPT": case "FOR": this.rept(U === "FOR"); return;
      case "BREAK": this.breakRept(head); break;
      case "CHARMAP": {
        const s = this.str();
        if (!s) throw new AsmErr(head.col, "empty CHARMAP string");
        const vals: number[] = [];
        while (this.isOp(",")) {
          this.p++;
          const col = this.colHere();
          const v = this.constExpr();
          if (v < -128 || v > 255) throw new AsmErr(col, `CHARMAP value ${v} does not fit in a byte`);
          vals.push(v & 0xff);
        }
        if (!vals.length) throw new AsmErr(this.colHere(), "CHARMAP needs at least one value");
        this.charmap.set(s, vals);
        this.charmapMax = Math.max(this.charmapMax, s.length);
        break;
      }
      case "ASSERT": case "STATIC_ASSERT": this.assert(U === "STATIC_ASSERT"); break;
      case "PRINT": case "PRINTLN": {
        let out = "";
        while (this.p < this.end) {
          const t = this.peek()!;
          if (t.t === TK_STR) { this.p++; out += t.s; }
          else out += hex(this.constExpr(), 1);
          if (!this.isOp(",")) break;
          this.p++;
        }
        this.warn(head.col, out);
        break;
      }
      case "FAIL": throw new AsmErr(head.col, this.str());
      case "WARN": this.warn(head.col, this.str()); break;
      case "EXPORT": case "GLOBAL":
        // Todos los símbolos son visibles: no hay enlazado de objetos separados.
        this.p = this.end;
        return;
      case "PURGE":
        do {
          const t = this.ident();
          const name = this.fullName(t.s, t.col);
          const s = this.syms.get(name);
          if (!s) throw new AsmErr(t.col, `cannot PURGE undefined symbol '${name}'`);
          if (s.k === S_EQUS) this.equsCount--;
          this.syms.delete(name);
        } while (this.isOp(",") && ++this.p);
        break;
      case "RSRESET": this.setVar("_RS", 0); break;
      case "RSSET": this.setVar("_RS", this.constExpr()); break;
      default: throw new AsmErr(head.col, `'${U}' is not supported`);
    }
    this.endOfLine();
  }

  private rept(isFor: boolean): void {
    let count: number;
    let forVar: string | null = null;
    let start = 0;
    let step = 0;
    if (isFor) {
      const v = this.ident();
      forVar = this.fullName(v.s, v.col);
      const old = this.syms.get(forVar);
      if (old && old.k !== S_VAR) throw new AsmErr(v.col, `FOR variable '${forVar}' is already a constant`);
      this.expectOp(",");
      const a = this.constExpr();
      let stop = a;
      step = 1;
      if (this.isOp(",")) {
        this.p++;
        start = a;
        stop = this.constExpr();
        if (this.isOp(",")) { this.p++; step = this.constExpr(); }
      }
      if (step === 0) throw new AsmErr(v.col, "FOR step cannot be 0");
      count = step > 0 ? Math.ceil((stop - start) / step) : Math.ceil((start - stop) / -step);
    } else {
      count = this.constExpr();
      if (count < 0) throw new AsmErr(1, "negative REPT count");
    }
    this.endOfLine();
    this.capture = {
      macro: false, name: "", depth: 1, frameDepth: this.frames.length, lines: [], lineNos: [],
      file: this.curFile, line: this.curLine, count: Math.max(0, count), forVar, forVal: start, forStep: step,
    };
  }

  private breakRept(head: Tok): void {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.kind === F_REPT) {
        this.frames.length = i + 1;
        this.ifs.length = f.ifBase;
        f.i = f.lines.length;
        f.left = 1;
        return;
      }
    }
    throw new AsmErr(head.col, "BREAK outside of REPT/FOR");
  }

  private assert(isStatic: boolean): void {
    let level = "FAIL";
    if (this.peek()?.t === TK_ID && this.isOp(",", this.p + 1)) {
      const u = this.toks[this.p]!.s.toUpperCase();
      if (u === "WARN" || u === "FAIL" || u === "FATAL") { level = u; this.p += 2; }
    }
    const col = this.colHere();
    const e = this.expr();
    let msg = "";
    if (this.isOp(",")) { this.p++; msg = this.str(); }
    this.endOfLine();
    const v = this.ev(e, false);
    if (v === undefined) {
      if (isStatic) throw new AsmErr(col, "STATIC_ASSERT expression is not constant");
      this.asserts.push({ e, level, msg, file: this.curFile, line: this.curLine, col });
      return;
    }
    if (!v) this.assertFailed(level, msg, this.curFile, this.curLine, col);
  }

  private assertFailed(level: string, msg: string, file: string, line: number, col: number): void {
    const text = msg ? `assertion failed: ${msg}` : "assertion failed";
    if (level === "WARN") this.warnings.push({ file, line, col, msg: text });
    else this.err(file, line, col, text);
  }

  private readFile(name: string, col: number): string | Uint8Array {
    const from = this.curFile;
    let v = this.opts.files?.get(name);
    if (v === undefined && this.opts.include) v = this.opts.include(name, from);
    if (v === undefined) {
      const slash = from.lastIndexOf("/");
      if (slash >= 0) v = this.opts.files?.get(from.slice(0, slash + 1) + name);
    }
    if (v === undefined) throw new AsmErr(col, `file '${name}' not found`);
    return v;
  }

  // -------------------------------------------------------------------------
  // Secciones y datos

  private section(): void {
    let fragment = false;
    if (this.isId("FRAGMENT")) { fragment = true; this.p++; }
    else if (this.isId("UNION")) throw new AsmErr(this.colHere(), "SECTION UNION is not supported");
    const nameCol = this.colHere();
    const name = this.str();
    this.expectOp(",");
    const kt = this.ident();
    const kind = kt.s.toUpperCase() as SectionKind;
    const region = REGIONS[kind];
    if (!region) throw new AsmErr(kt.col, `unknown section type '${kt.s}' (ROM0, ROMX, VRAM, SRAM, WRAM0, WRAMX, HRAM)`);
    let fixedAddr = -1;
    let fixedBank = -1;
    let align = 0;
    let alignOfs = 0;
    if (this.isOp("[")) {
      this.p++;
      const col = this.colHere();
      fixedAddr = this.constExpr();
      this.expectOp("]");
      if (fixedAddr < region.start || fixedAddr >= region.end) {
        throw new AsmErr(col, `address ${hex(fixedAddr)} is outside ${kind} (${hex(region.start)}-${hex(region.end - 1)})`);
      }
    }
    while (this.isOp(",")) {
      this.p++;
      const opt = this.ident();
      const u = opt.s.toUpperCase();
      this.expectOp("[");
      const col = this.colHere();
      if (u === "BANK") {
        fixedBank = this.constExpr();
        if (region.minBank === region.maxBank) throw new AsmErr(opt.col, `BANK[] is not allowed in ${kind} sections`);
        const maxBank = kind === "ROMX" && this.opts.romBanks ? this.opts.romBanks - 1 : region.maxBank;
        if (fixedBank < region.minBank || fixedBank > maxBank) {
          throw new AsmErr(col, `bank ${fixedBank} is out of range for ${kind} (${region.minBank}-${maxBank})`);
        }
      } else if (u === "ALIGN") {
        align = this.constExpr();
        if (align < 0 || align > 16) throw new AsmErr(col, "ALIGN must be between 0 and 16");
        if (this.isOp(",")) { this.p++; alignOfs = this.constExpr(); }
        if (alignOfs < 0 || alignOfs >= 1 << align) throw new AsmErr(col, "ALIGN offset out of range");
      } else {
        throw new AsmErr(opt.col, `unknown section option '${opt.s}' (BANK, ALIGN)`);
      }
      this.expectOp("]");
    }
    this.endOfLine();
    if (fixedAddr >= 0 && align && (fixedAddr & ((1 << align) - 1)) !== alignOfs) {
      throw new AsmErr(nameCol, `section address ${hex(fixedAddr)} does not satisfy ALIGN[${align}]`);
    }
    const old = this.secByName.get(name);
    if (old) {
      if (fragment && old.fragment && old.kind === kind) { this.sec = old; return; }
      throw new AsmErr(nameCol, `section '${name}' already defined at ${old.file}:${old.line}`);
    }
    const sec: Sec = {
      name, kind, region, fixedAddr, fixedBank, align, alignOfs,
      addr: fixedAddr,
      bank: fixedBank >= 0 ? fixedBank : region.minBank === region.maxBank ? region.minBank : -1,
      data: region.rom ? [] : null, size: 0, fragment, file: this.curFile, line: this.curLine,
      order: this.sections.length,
    };
    this.sections.push(sec);
    this.secByName.set(name, sec);
    this.sec = sec;
  }

  /** Sección en curso, que debe ser de ROM para emitir bytes. */
  private romSec(col: number, what: string): Sec {
    const sec = this.needSec(col);
    if (!sec.data) throw new AsmErr(col, `${what} is not allowed in ${sec.kind} section '${sec.name}' (use DS to reserve RAM)`);
    return sec;
  }

  private addLine(sec: Sec, start: number): void {
    const len = sec.size - start;
    if (len > 0) this.lineMap.push({ sec, off: start, len, file: this.curFile, line: this.curLine });
  }

  /** Emite `bytes` bytes para la expresión (inmediatamente si es constante, si no como parche). */
  private emitExpr(kind: PatchKind, e: Expr, col: number, aux = 0): void {
    const sec = this.sec!;
    const data = sec.data!;
    const off = kind === "bit" || kind === "vec" ? sec.size - 1 : sec.size;
    const n = kind === "n16" ? 2 : kind === "n32" ? 4 : kind === "bit" || kind === "vec" ? 0 : 1;
    for (let i = 0; i < n; i++) data.push(0);
    sec.size += n;
    const p: Patch = { sec, off, kind, e, aux, file: this.curFile, line: this.curLine, col };
    const v = this.ev(e, false);
    if (v !== undefined && (kind !== "e8" || sec.addr >= 0)) this.applyPatch(p, v);
    else this.patches.push(p);
  }

  private applyPatch(p: Patch, v: number): void {
    const d = p.sec.data!;
    switch (p.kind) {
      case "n8":
        if (v < -128 || v > 255) throw new AsmErr(p.col, `value ${v} does not fit in 8 bits`);
        d[p.off] = v & 0xff;
        return;
      case "n16":
        if (v < -32768 || v > 65535) throw new AsmErr(p.col, `value ${v} does not fit in 16 bits`);
        d[p.off] = v & 0xff;
        d[p.off + 1] = (v >> 8) & 0xff;
        return;
      case "n32":
        d[p.off] = v & 0xff;
        d[p.off + 1] = (v >> 8) & 0xff;
        d[p.off + 2] = (v >> 16) & 0xff;
        d[p.off + 3] = (v >>> 24) & 0xff;
        return;
      case "e8": {
        // El desplazamiento de JR es relativo al PC tras la instrucción.
        const rel = v - (p.sec.addr + p.aux);
        if (rel < -128 || rel > 127) throw new AsmErr(p.col, `JR target out of range (distance ${rel}, must be -128..127)`);
        d[p.off] = rel & 0xff;
        return;
      }
      case "s8":
        if (v < -128 || v > 127) throw new AsmErr(p.col, `signed offset ${v} out of range (-128..127)`);
        d[p.off] = v & 0xff;
        return;
      case "a8":
        // LDH accede a $FF00 + n8: se admite la dirección completa o sólo el byte bajo.
        if (v >= 0xff00 && v <= 0xffff) d[p.off] = v & 0xff;
        else if (v >= 0 && v <= 0xff) d[p.off] = v;
        else throw new AsmErr(p.col, `LDH address ${hex(v)} is not in $FF00-$FFFF`);
        return;
      case "bit":
        if (v < 0 || v > 7) throw new AsmErr(p.col, `bit number ${v} out of range (0-7)`);
        d[p.off] = p.aux | (v << 3);
        return;
      case "vec":
        if (v < 0 || (v & ~0x38) !== 0) throw new AsmErr(p.col, `invalid RST vector ${hex(v, 2)} ($00, $08, … $38)`);
        d[p.off] = p.aux | v;
        return;
    }
  }

  private data(width: 1 | 2 | 4, head: Tok): void {
    const sec = this.romSec(head.col, head.s.toUpperCase());
    const start = sec.size;
    if (this.p >= this.end) throw new AsmErr(head.col, `${head.s.toUpperCase()} needs at least one value`);
    const kind: PatchKind = width === 1 ? "n8" : width === 2 ? "n16" : "n32";
    while (this.p < this.end) {
      const t = this.peek()!;
      const nx = this.toks[this.p + 1];
      if (t.t === TK_STR && (this.p + 1 >= this.end || (nx!.t === TK_OP && nx!.s === ","))) {
        this.p++;
        for (const b of this.mapStr(t.s)) this.emitExpr(kind, { k: "n", v: b }, t.col);
      } else {
        const col = this.colHere();
        this.emitExpr(kind, this.expr(), col);
      }
      if (!this.isOp(",")) break;
      this.p++;
    }
    this.endOfLine();
    this.addLine(sec, start);
  }

  private ds(head: Tok): void {
    const sec = this.needSec(head.col);
    const col = this.colHere();
    const n = this.constExpr();
    if (n < 0) throw new AsmErr(col, "DS size cannot be negative");
    const fill: { e: Expr; col: number }[] = [];
    while (this.isOp(",")) {
      this.p++;
      const c = this.colHere();
      fill.push({ e: this.expr(), col: c });
    }
    this.endOfLine();
    if (!sec.data) {
      if (fill.length) throw new AsmErr(col, `DS fill values are not allowed in ${sec.kind}`);
      sec.size += n;
      return;
    }
    if (sec.size + n > 0x8000) throw new AsmErr(col, `DS size ${n} is too big`);
    const start = sec.size;
    if (!fill.length) {
      // Sin valor: relleno con 0 (valor de relleno por defecto de rgbasm).
      for (let i = 0; i < n; i++) sec.data.push(0);
      sec.size += n;
    } else {
      for (let i = 0; i < n; i++) {
        const f = fill[i % fill.length]!;
        this.emitExpr("n8", f.e, f.col);
      }
    }
    this.addLine(sec, start);
  }

  private incbin(head: Tok): void {
    const sec = this.romSec(head.col, "INCBIN");
    const name = this.str();
    let from = 0;
    let len = -1;
    if (this.isOp(",")) { this.p++; from = this.constExpr(); }
    if (this.isOp(",")) { this.p++; len = this.constExpr(); }
    this.endOfLine();
    const v = this.readFile(name, head.col);
    const bytes = typeof v === "string" ? utf8.encode(v) : v;
    if (len < 0) len = bytes.length - from;
    if (from < 0 || from > bytes.length || from + len > bytes.length) {
      throw new AsmErr(head.col, `INCBIN range ${from}+${len} is outside '${name}' (${bytes.length} bytes)`);
    }
    if (sec.size + len > 0x8000) throw new AsmErr(head.col, `INCBIN '${name}' is too big for a section`);
    const start = sec.size;
    for (let i = 0; i < len; i++) sec.data!.push(bytes[from + i]!);
    sec.size += len;
    this.addLine(sec, start);
  }

  /** Cadena → bytes con el CHARMAP (coincidencia más larga); sin mapa, UTF-8. */
  private mapStr(s: string): number[] {
    if (!this.charmap.size) return Array.from(utf8.encode(s));
    const out: number[] = [];
    let i = 0;
    while (i < s.length) {
      let hit = false;
      for (let l = Math.min(this.charmapMax, s.length - i); l > 0; l--) {
        const m = this.charmap.get(s.substr(i, l));
        if (m) { out.push(...m); i += l; hit = true; break; }
      }
      if (!hit) {
        const cp = s.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        out.push(...utf8.encode(ch));
        i += ch.length;
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Instrucciones

  private instruction(U: string, head: Tok): void {
    const sec = this.romSec(head.col, "code");
    const ops: POp[] = [];
    const cols: number[] = [];
    while (this.p < this.end) {
      const a = this.p;
      const b = this.findComma(a);
      if (a === b) throw new AsmErr(this.colHere(), "missing operand");
      cols.push(this.toks[a]!.col);
      ops.push(this.operand(a, b));
      this.p = b;
      if (b < this.end) {
        this.p++;
        if (this.p >= this.end) throw new AsmErr(this.colHere(), "missing operand");
      }
    }
    let mn = U;
    // Alias de RGBDS: LDI/LDD = LD con [HL+]/[HL-]; LDHL SP,e8; JP [HL]; ALU sin "A,".
    if (U === "LDI" || U === "LDD") {
      mn = "LD";
      for (const o of ops) if (o.c === "ind" && o.n === "HL") o.n = U === "LDI" ? "HLI" : "HLD";
    } else if (U === "LDHL") {
      mn = "LD";
      if (ops.length === 2 && ops[0]!.c === "reg" && ops[0]!.n === "SP" && ops[1]!.c === "imm") {
        ops.splice(0, 2, { c: "reg", n: "HL" }, { c: "spe", e: ops[1]!.e });
      }
    } else if (U === "JP" && ops.length === 1 && ops[0]!.c === "ind" && ops[0]!.n === "HL") {
      ops[0] = { c: "reg", n: "HL" };
    } else if (ALU_A.has(U) && ops.length === 1) {
      ops.unshift({ c: "reg", n: "A" });
      cols.unshift(head.col);
    }
    const list = INDEX.get(mn)!;
    let op: Op | undefined;
    for (let strict = 1; strict >= 0 && !op; strict--) {
      for (const cand of list) {
        if (cand.operands.length === ops.length && this.matches(cand, ops, strict === 1)) { op = cand; break; }
      }
    }
    if (!op) {
      const n = list.reduce((m, o) => (o.operands.length === ops.length ? m + 1 : m), 0);
      throw new AsmErr(head.col, n ? `invalid operands for '${head.s}'` : `wrong number of operands for '${head.s}'`);
    }
    const start = sec.size;
    const data = sec.data!;
    if (op.prefix) { data.push(0xcb); sec.size++; }
    data.push(op.opcode);
    sec.size++;
    if (op.opcode === 0x10 && !op.prefix) { data.push(0); sec.size++; } // STOP
    for (let i = 0; i < op.operands.length; i++) {
      const def = op.operands[i]!;
      const pa = ops[i]!;
      if (pa.c !== "mem" && pa.c !== "imm" && pa.c !== "spe") continue;
      const col = cols[i]!;
      switch (def.kind) {
        case "u3": this.emitExpr("bit", pa.e, col, op.opcode); break;
        case "vec": this.emitExpr("vec", pa.e, col, op.opcode); break;
        case "n8": this.emitExpr("n8", pa.e, col); break;
        case "n16": case "a16": this.emitExpr("n16", pa.e, col); break;
        case "e8": this.emitExpr("e8", pa.e, col, start + op.length); break;
        case "s8": case "spe8": this.emitExpr("s8", pa.e, col); break;
        case "a8": this.emitExpr("a8", pa.e, col); break;
        default: break;
      }
    }
    this.addLine(sec, start);
  }

  private matches(op: Op, ops: POp[], strict: boolean): boolean {
    for (let i = 0; i < ops.length; i++) {
      const d = op.operands[i]!;
      const o = ops[i]!;
      switch (d.kind) {
        case "r8": case "r16":
          if (o.c !== "reg" || o.n !== d.name) return false;
          break;
        case "cc":
          if ((o.c !== "cond" && o.c !== "reg") || o.n !== d.name) return false;
          break;
        case "ind":
          if (o.c !== "ind" || o.n !== d.name) return false;
          break;
        case "a16": case "a8":
          if (o.c !== "mem") return false;
          break;
        case "spe8":
          if (o.c !== "spe") return false;
          break;
        default: // n8 n16 e8 s8 u3 vec
          // `(expr)` es memoria si existe esa forma; si no, se acepta como expresión.
          if (o.c !== "imm" && !(o.c === "mem" && o.paren && !strict)) return false;
      }
    }
    return true;
  }

  private findComma(a: number): number {
    let depth = 0;
    for (let i = a; i < this.end; i++) {
      const t = this.toks[i]!;
      if (t.t !== TK_OP) continue;
      if (t.s === "(" || t.s === "[") depth++;
      else if (t.s === ")" || t.s === "]") depth--;
      else if (t.s === "," && depth === 0) return i;
    }
    return this.end;
  }

  private matching(a: number, b: number): number {
    let depth = 0;
    for (let i = a; i < b; i++) {
      const t = this.toks[i]!;
      if (t.t !== TK_OP) continue;
      if (t.s === "(" || t.s === "[") depth++;
      else if ((t.s === ")" || t.s === "]") && --depth === 0) return i;
    }
    return -1;
  }

  private subExpr(a: number, b: number): Expr {
    const saveEnd = this.end;
    this.p = a;
    this.end = b;
    const e = this.expr();
    this.endOfLine();
    this.end = saveEnd;
    return e;
  }

  private operand(a: number, b: number): POp {
    const t = this.toks[a]!;
    const n = b - a;
    if (n === 1 && t.t === TK_ID) {
      const u = t.s.toUpperCase();
      if (REG_NAMES.has(u)) return { c: "reg", n: u };
      if (COND_NAMES.has(u)) return { c: "cond", n: u };
    }
    if (t.t === TK_OP && (t.s === "[" || t.s === "(") && this.matching(a, b) === b - 1) {
      const t1 = this.toks[a + 1];
      const t2 = this.toks[a + 2];
      const t3 = this.toks[a + 3];
      const inner = n - 2;
      if (inner === 1 && t1!.t === TK_ID) {
        const u = t1!.s.toUpperCase();
        if (u === "BC" || u === "DE" || u === "HL" || u === "C" || u === "HLI" || u === "HLD") return { c: "ind", n: u };
      }
      if (inner === 2 && t1!.t === TK_ID && t1!.s.toUpperCase() === "HL" && t2!.t === TK_OP && (t2!.s === "+" || t2!.s === "-")) {
        return { c: "ind", n: t2!.s === "+" ? "HLI" : "HLD" };
      }
      if (inner === 3 && t1!.t === TK_NUM && t1!.v === 0xff00 && t2!.t === TK_OP && t2!.s === "+" && t3!.t === TK_ID && t3!.s.toUpperCase() === "C") {
        return { c: "ind", n: "C" };
      }
      if (inner === 0) throw new AsmErr(t.col, "empty memory operand");
      return { c: "mem", e: this.subExpr(a + 1, b - 1), paren: t.s === "(" };
    }
    if (t.t === TK_ID && t.s.toUpperCase() === "SP" && n >= 2) {
      const t1 = this.toks[a + 1]!;
      if (t1.t === TK_OP && (t1.s === "+" || t1.s === "-")) return { c: "spe", e: this.subExpr(a + 1, b) };
    }
    return { c: "imm", e: this.subExpr(a, b) };
  }

  // -------------------------------------------------------------------------
  // Colocación de secciones

  private place(): boolean {
    const nErr = this.errors.length;
    const free = new Map<string, [number, number][]>();
    const placedIn = new Map<string, Sec[]>();
    const romMax = this.opts.romBanks ? this.opts.romBanks - 1 : REGIONS.ROMX.maxBank;
    const getFree = (kind: SectionKind, bank: number): [number, number][] => {
      const key = kind + ":" + bank;
      let l = free.get(key);
      if (!l) {
        const r = REGIONS[kind];
        free.set(key, (l = [[r.start, r.end]]));
      }
      return l;
    };
    const take = (sec: Sec, bank: number, addr: number): void => {
      const l = getFree(sec.kind, bank);
      for (let i = 0; i < l.length; i++) {
        const iv = l[i]!;
        if (addr >= iv[0] && addr + sec.size <= iv[1]) {
          const parts: [number, number][] = [];
          if (addr > iv[0]) parts.push([iv[0], addr]);
          if (addr + sec.size < iv[1]) parts.push([addr + sec.size, iv[1]]);
          l.splice(i, 1, ...parts);
          break;
        }
      }
      sec.addr = addr;
      sec.bank = bank;
      const key = sec.kind + ":" + bank;
      let pl = placedIn.get(key);
      if (!pl) placedIn.set(key, (pl = []));
      pl.push(sec);
    };
    const fits = (sec: Sec, bank: number, addr: number): boolean => {
      for (const iv of getFree(sec.kind, bank)) if (addr >= iv[0] && addr + sec.size <= iv[1]) return true;
      return false;
    };
    const firstFit = (sec: Sec, bank: number): number => {
      const mask = (1 << sec.align) - 1;
      for (const iv of getFree(sec.kind, bank)) {
        let a = (iv[0] & ~mask) | sec.alignOfs;
        if (a < iv[0]) a += mask + 1;
        if (a + sec.size <= iv[1]) return a;
      }
      return -1;
    };
    const group = (s: Sec): number => (s.fixedAddr >= 0 ? 0 : 2) + (s.bank >= 0 ? 0 : 1);
    const order = [...this.sections].sort(
      (a, b) => group(a) - group(b) || b.size - a.size || b.align - a.align || a.order - b.order,
    );
    for (const sec of order) {
      const r = sec.region;
      const span = r.end - r.start;
      if (sec.size > span) {
        this.err(sec.file, sec.line, 1, `section '${sec.name}' is too big: ${sec.size} bytes (${sec.kind} holds ${span})`);
        continue;
      }
      const maxBank = sec.kind === "ROMX" ? romMax : r.maxBank;
      const b0 = sec.bank >= 0 ? sec.bank : r.minBank;
      const b1 = sec.bank >= 0 ? sec.bank : maxBank;
      let ok = false;
      for (let b = b0; b <= b1 && !ok; b++) {
        if (sec.fixedAddr >= 0) {
          if (sec.fixedAddr + sec.size > r.end) {
            this.err(sec.file, sec.line, 1, `section '${sec.name}' (${sec.size} bytes at ${hex(sec.fixedAddr)}) goes past the end of ${sec.kind} (${hex(r.end - 1)})`);
            ok = true; // ya informado
            break;
          }
          if (fits(sec, b, sec.fixedAddr)) { take(sec, b, sec.fixedAddr); ok = true; }
        } else {
          const a = firstFit(sec, b);
          if (a >= 0) { take(sec, b, a); ok = true; }
        }
      }
      if (ok) continue;
      if (sec.fixedAddr >= 0 && b0 === b1) {
        const other = (placedIn.get(sec.kind + ":" + b0) ?? []).find(
          (o) => sec.fixedAddr < o.addr + o.size && o.addr < sec.fixedAddr + sec.size,
        );
        this.err(sec.file, sec.line, 1,
          `section '${sec.name}' (${hex(sec.fixedAddr)}-${hex(sec.fixedAddr + sec.size - 1)}) overlaps section '${other?.name ?? "?"}'` +
          (other ? ` (${hex(other.addr)}-${hex(other.addr + other.size - 1)})` : ""));
      } else {
        const report: string[] = [];
        for (let b = b0; b <= b1 && report.length < 16; b++) {
          const l = free.get(sec.kind + ":" + b);
          if (!l) continue;
          const total = l.reduce((s, iv) => s + iv[1] - iv[0], 0);
          const largest = l.reduce((s, iv) => Math.max(s, iv[1] - iv[0]), 0);
          report.push(`bank ${b}: ${total} free, largest block ${largest}`);
        }
        this.err(sec.file, sec.line, 1,
          `cannot place section '${sec.name}' (${sec.size} bytes) in ${sec.kind}` +
          (sec.fixedBank >= 0 ? ` bank ${sec.fixedBank}` : "") + (report.length ? ` — ${report.join("; ")}` : ""));
      }
    }
    return this.errors.length === nErr;
  }

  // -------------------------------------------------------------------------
  // Pasada 2 y salida

  private resolve(): void {
    for (const p of this.patches) {
      try {
        const v = this.ev(p.e, true);
        if (v === undefined) throw new AsmErr(p.col, "expression could not be resolved");
        this.applyPatch(p, v);
      } catch (e) {
        if (e instanceof AsmErr) this.err(p.file, p.line, e.col, e.message);
        else throw e;
      }
    }
    for (const a of this.asserts) {
      try {
        const v = this.ev(a.e, true);
        if (v === undefined) throw new AsmErr(a.col, "assertion could not be resolved");
        if (!v) this.assertFailed(a.level, a.msg, a.file, a.line, a.col);
      } catch (e) {
        if (e instanceof AsmErr) this.err(a.file, a.line, e.col, e.message);
        else throw e;
      }
    }
    if (this.opts.entry !== undefined) {
      const s = this.syms.get(this.opts.entry);
      if (!s || s.k !== S_LABEL) this.err(this.opts.file ?? "main.asm", 1, 1, `entry label '${this.opts.entry}' not found`);
    }
  }

  private buildRom(): Uint8Array {
    let maxBank = 1;
    for (const s of this.sections) if (s.kind === "ROMX" && s.bank > maxBank) maxBank = s.bank;
    let banks = 2;
    while (banks <= maxBank) banks *= 2;
    if (this.opts.romBanks) banks = this.opts.romBanks;
    const rom = new Uint8Array(banks * 0x4000).fill(0xff);
    for (const s of this.sections) {
      if (!s.data) continue;
      const base = s.kind === "ROM0" ? s.addr : s.bank * 0x4000 + (s.addr - 0x4000);
      rom.set(s.data, base);
    }
    return rom;
  }

  private result(rom: Uint8Array, placed: boolean): AsmResult {
    const symbols = new Map<string, { bank: number; addr: number }>();
    const lineMap: AsmLineMapEntry[] = [];
    if (placed) {
      for (const name of this.labels) {
        const s = this.syms.get(name);
        if (s && s.k === S_LABEL) symbols.set(name, { bank: s.sec!.bank, addr: s.sec!.addr + s.off });
      }
      for (const l of this.lineMap) {
        lineMap.push({ bank: l.sec.bank, addr: l.sec.addr + l.off, line: l.line, file: l.file, len: l.len });
      }
    }
    let entry = 0x100;
    if (this.opts.entry !== undefined) entry = symbols.get(this.opts.entry)?.addr ?? 0x100;
    return {
      rom,
      sections: this.sections.map((s) => ({ name: s.name, kind: s.kind, bank: s.bank, addr: s.addr, size: s.size })),
      entry,
      symbols,
      lineMap,
      errors: this.errors,
      warnings: this.warnings,
    };
  }
}

/** Separa los argumentos de una llamada a macro (comas fuera de cadenas y paréntesis). */
function splitMacroArgs(s: string): string[] {
  const args: string[] = [];
  let cur = "";
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      cur += ch;
      if (ch === "\\" && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === ";") break;
    if (ch === "\"") { inStr = true; cur += ch; continue; }
    if (ch === "\\" && s[i + 1] === ",") { cur += ","; i++; continue; }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  const last = cur.trim();
  if (last || args.length) args.push(last);
  return args;
}

/** Ensambla `source` (y sus INCLUDE) en una imagen de ROM. Nunca lanza excepciones. */
export function assemble(source: string, opts: AsmOptions = {}): AsmResult {
  try {
    return new Assembler(opts).run(source);
  } catch (e) {
    // Red de seguridad: un fallo interno se informa como error, no se propaga a la UI.
    return {
      rom: new Uint8Array(0), sections: [], entry: 0x100, symbols: new Map(), lineMap: [],
      errors: [{ file: opts.file ?? "main.asm", line: 1, col: 1, msg: `internal assembler error: ${String(e)}` }],
      warnings: [],
    };
  }
}
