// Tokenizador de líneas de ensamblador SM83 con sintaxis RGBDS, para el resaltado del
// editor. TS puro, sin DOM ni CodeMirror: trabaja sobre {string, pos} (la parte pública
// del StringStream de CodeMirror), así que se prueba en Node con un objeto plano.
//
// Estructura de una línea (rgbasm(5)): [etiqueta[:|::]] [instrucción|directiva|macro
// operandos] [; comentario]. El nombre de cada token es un nombre de etiqueta de
// @lezer/highlight con modificadores separados por puntos (lo resuelve StreamLanguage).
import { OPS } from "../../sm83isa";

/** Nombres de token (etiquetas de @lezer/highlight). */
export const TOK = {
  comment: "comment",
  string: "string",
  number: "number",
  gfx: "number.special",
  mnemonic: "keyword",
  directive: "processingInstruction",
  sectionType: "typeName",
  register: "atom",
  condition: "modifier",
  labelDef: "labelName.definition",
  localLabelDef: "labelName.local.definition",
  label: "labelName",
  constDef: "variableName.definition",
  macroDef: "macroName.definition",
  macroCall: "macroName",
  macroArg: "variableName.special",
  fn: "variableName.function",
  here: "variableName.standard",
  operator: "operator",
  bracket: "squareBracket",
  paren: "paren",
  brace: "brace",
  separator: "separator",
  invalid: "invalid",
} as const;

export type TokenName = (typeof TOK)[keyof typeof TOK];

export const MNEMONICS: ReadonlySet<string> = new Set([...OPS.map((o) => o.mnemonic), "LDI", "LDD", "LDHL"]);

export const DIRECTIVES: ReadonlySet<string> = new Set([
  "SECTION", "ENDSECTION", "PUSHS", "POPS", "DB", "DW", "DL", "DS", "INCBIN", "INCLUDE", "DEF", "REDEF",
  "EQU", "EQUS", "SET", "MACRO", "ENDM", "SHIFT", "IF", "ELIF", "ELSE", "ENDC", "REPT", "FOR", "ENDR",
  "BREAK", "CHARMAP", "ASSERT", "STATIC_ASSERT", "PRINT", "PRINTLN", "FAIL", "WARN", "EXPORT", "GLOBAL",
  "PURGE", "RSRESET", "RSSET", "RB", "RW", "RL", "FATAL",
]);

const SECTION_WORDS = new Set(["ROM0", "ROMX", "VRAM", "SRAM", "WRAM0", "WRAMX", "HRAM", "OAM", "BANK", "ALIGN", "FRAGMENT"]);
const REGISTERS = new Set(["A", "B", "C", "D", "E", "H", "L", "AF", "BC", "DE", "HL", "SP", "HLI", "HLD"]);
const CONDITIONS = new Set(["NZ", "Z", "NC", "C"]);
const BRANCHES = new Set(["JR", "JP", "CALL", "RET"]);
const FUNCTIONS = new Set(["HIGH", "LOW", "BANK", "SIZEOF", "STARTOF", "DEF", "ISCONST", "STRLEN"]);
/** Directivas tras las que el primer identificador es una definición. */
const DEFINES_NEXT: Record<string, string> = { DEF: TOK.constDef, REDEF: TOK.constDef, MACRO: TOK.macroDef, PURGE: TOK.constDef };

export interface LineState {
  /** Aún no ha aparecido la instrucción/directiva de la línea. */
  head: boolean;
  /** Instrucción o directiva actual (mayúsculas), o "" si es una llamada a macro. */
  op: string;
  /** Índice del operando actual (comas vistas). */
  arg: number;
  /** El último token fue un valor (para distinguir `%` y `&` binarios de los operadores). */
  value: boolean;
  /** El siguiente identificador es una definición (tras DEF, MACRO…). */
  defineAs: string;
}

export function startState(): LineState {
  return { head: true, op: "", arg: 0, value: false, defineAs: "" };
}

export function copyState(s: LineState): LineState {
  return { ...s };
}

/** Lo que el tokenizador usa del StringStream de CodeMirror. */
export interface Stream {
  string: string;
  pos: number;
}

const ID = /^[A-Za-z_][\w#@]*(?:\.[\w#@]+)?/;
const LOCAL = /^\.[A-Za-z_][\w#@]*/;
const NUMBER = /^(?:\$[0-9A-Fa-f_]+|0x[0-9A-Fa-f_]+|0b[01_]+|0o[0-7_]+|[0-9][0-9_]*)/;

/**
 * Consume un token desde `s.pos` y devuelve su nombre (o null para espacios y texto sin
 * estilo). Siempre avanza al menos un carácter, como exige StreamParser.
 */
export function token(s: Stream, st: LineState): string | null {
  const line = s.string;
  const start = s.pos;
  if (start === 0) Object.assign(st, startState());
  const rest = line.slice(start);
  const c = rest[0]!;

  if (c === " " || c === "\t") {
    s.pos += /^[ \t]+/.exec(rest)![0].length;
    return null;
  }
  if (c === ";") { s.pos = line.length; return TOK.comment; }
  if (rest.startsWith("/*")) {
    const end = line.indexOf("*/", start + 2);
    s.pos = end < 0 ? line.length : end + 2;
    return TOK.comment;
  }
  if (c === '"') {
    let i = start + 1;
    while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
    s.pos = Math.min(i + 1, line.length);
    st.value = true;
    return TOK.string;
  }

  // Argumentos de macro: \1…\9, \@, \#, \<n>; `\` solo al final = continuación de línea.
  if (c === "\\") {
    const m = /^\\(?:[1-9@#]|<[^>]*>)/.exec(rest);
    s.pos += m ? m[0].length : 1;
    if (m) { st.value = true; return TOK.macroArg; }
    return TOK.operator;
  }

  // Gráficos 2bpp: `01233210
  if (c === "`") {
    s.pos += /^`[0-3_]*/.exec(rest)![0].length;
    st.value = true;
    return TOK.gfx;
  }

  // Etiqueta local al principio de una línea o como referencia.
  if (c === ".") {
    const m = LOCAL.exec(rest);
    if (m) {
      s.pos += m[0].length;
      const def = st.head && (start === 0 || line[s.pos] === ":") ;
      if (def) { skipColons(s); return TOK.localLabelDef; }
      st.value = true;
      return TOK.label;
    }
  }

  // Etiqueta anónima: `:` al principio de la línea; referencias `:+`, `:--`…
  if (c === ":") {
    if (st.head && line.slice(0, start).trim() === "") {
      s.pos += /^::?/.exec(rest)![0].length;
      return TOK.labelDef;
    }
    const m = /^:(?:\++|-+)/.exec(rest);
    if (m) { s.pos += m[0].length; st.value = true; return TOK.label; }
    s.pos++;
    return TOK.operator;
  }

  const num = NUMBER.exec(rest);
  if (num) { s.pos += num[0].length; st.value = true; return TOK.number; }
  // `%1010` y `&17` son números salvo que sigan a un valor (entonces módulo / AND).
  if (!st.value) {
    const m = /^(?:%[01_]+|&[0-7_]+)/.exec(rest);
    if (m) { s.pos += m[0].length; st.value = true; return TOK.number; }
  }

  const id = ID.exec(rest);
  if (id) return word(s, st, id[0], start);

  if (c === "@") { s.pos++; st.value = true; return TOK.here; }

  s.pos++;
  switch (c) {
    case ",":
      st.arg++;
      st.value = false;
      return TOK.separator;
    case "[": st.value = false; return TOK.bracket;
    case "]": st.value = true; return TOK.bracket;
    case "(": st.value = false; return TOK.paren;
    case ")": st.value = true; return TOK.paren;
    case "{": st.value = false; return TOK.brace;
    case "}": st.value = true; return TOK.brace;
  }
  if ("+-*/%&|^~!<>=".includes(c)) {
    // Operadores de varios caracteres: <<, >>, >>>, **, ==, !=, <=, >=, &&, ||, +=…
    const m = /^(?:>>>=?|<<=?|>>=?|\*\*|==|!=|<=|>=|&&|\|\||[+\-*/%&|^]=)/.exec(rest);
    if (m) s.pos = start + m[0].length;
    st.value = false;
    return TOK.operator;
  }
  return null;
}

function skipColons(s: Stream): void {
  while (s.string[s.pos] === ":") s.pos++;
}

function word(s: Stream, st: LineState, w: string, start: number): string | null {
  s.pos = start + w.length;
  const U = w.toUpperCase();
  const line = s.string;
  const next = line[s.pos];

  if (st.defineAs) {
    const t = st.defineAs;
    st.defineAs = "";
    st.value = true;
    return t;
  }

  if (st.head) {
    // `Main:` / `Main::` (en cualquier columna) o identificador en la columna 0.
    if (next === ":" && !DIRECTIVES.has(U)) {
      skipColons(s);
      return w.includes(".") ? TOK.localLabelDef : TOK.labelDef;
    }
    if (start === 0 && !MNEMONICS.has(U) && !DIRECTIVES.has(U)) {
      // `x EQU 1`, `x = 1`, `x SET 1`, `x += 1`… → constante; si no, etiqueta sin `:`.
      const after = line.slice(s.pos);
      if (!/^\s*(?:EQUS?\b|SET\b|RB\b|RW\b|RL\b|[+\-*/%&|^]?=|<<=|>>=)/i.test(after)) return TOK.labelDef;
      st.head = false;
      st.op = "";
      return TOK.constDef;
    }
    st.head = false;
    st.arg = 0;
    st.value = false;
    if (MNEMONICS.has(U)) { st.op = U; return TOK.mnemonic; }
    if (DIRECTIVES.has(U)) {
      st.op = U;
      const d = DEFINES_NEXT[U];
      if (d) st.defineAs = d;
      return TOK.directive;
    }
    st.op = "";
    return TOK.macroCall;
  }

  // Operandos.
  if (DIRECTIVES.has(U) && (U === "EQU" || U === "EQUS" || U === "SET" || U === "RB" || U === "RW" || U === "RL")) {
    st.value = false;
    return TOK.directive;
  }
  if (FUNCTIONS.has(U) && /^\s*\(/.test(line.slice(s.pos))) {
    st.value = false;
    return TOK.fn;
  }
  if (st.op === "SECTION" && SECTION_WORDS.has(U)) { st.value = false; return TOK.sectionType; }
  if (st.op === "ASSERT" && (U === "WARN" || U === "FAIL" || U === "FATAL")) return TOK.directive;
  if (MNEMONICS.has(st.op)) {
    st.value = true;
    if (BRANCHES.has(st.op) && st.arg === 0 && CONDITIONS.has(U)) return TOK.condition;
    if (REGISTERS.has(U)) return TOK.register;
  }
  if (U === "_NARG" || U === "_RS") { st.value = true; return TOK.macroArg; }
  st.value = true;
  return TOK.label;
}

/** Tokeniza una línea completa (para tests y depuración): pares [texto, token]. */
export function tokenizeLine(line: string, st: LineState = startState()): Array<[string, string]> {
  const s: Stream = { string: line, pos: 0 };
  const out: Array<[string, string]> = [];
  while (s.pos < line.length) {
    const from = s.pos;
    const t = token(s, st);
    if (s.pos <= from) throw new Error(`el tokenizador no avanza en la columna ${from}`);
    if (t) out.push([line.slice(from, s.pos), t]);
  }
  return out;
}
