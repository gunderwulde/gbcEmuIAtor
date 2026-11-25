// U1: resaltado de C para CodeMirror 6 con un StreamLanguage propio (sin dependencias).
//
// Por qué no @codemirror/lang-cpp: añade @lezer/cpp (la gramática de C++ entera) y su
// árbol no sabe nada de la librería ni de __asm. El subconjunto que acepta el compilador
// (web/src/cc) cabe en un tokenizador de línea: palabras clave, tipos, preprocesador,
// números, cadenas y caracteres, comentarios // y /* */ (que cruzan líneas: van en el
// estado), extensiones de la GB (__at, __banked, __interrupt…) y las funciones y
// constantes de las cabeceras de la librería (sacadas de los propios .h).
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser, type StringStream } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { clibFiles } from "./deps";

export const C_KEYWORDS: ReadonlySet<string> = new Set([
  "auto", "break", "case", "const", "continue", "default", "do", "else", "enum", "extern",
  "for", "goto", "if", "inline", "register", "restrict", "return", "sizeof", "static",
  "struct", "switch", "typedef", "union", "volatile", "while",
  "__asm", "__endasm", "__at", "__banked", "__naked", "__interrupt",
]);

export const C_TYPES: ReadonlySet<string> = new Set([
  "char", "short", "int", "long", "signed", "unsigned", "void", "float", "double", "_Bool",
]);

/** Funciones y macros declaradas en las cabeceras de la librería. */
export function libNames(files: ReadonlyMap<string, string>): { funcs: Set<string>; consts: Set<string> } {
  const funcs = new Set<string>(), consts = new Set<string>();
  for (const [name, text] of files) {
    if (!name.endsWith(".h")) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
    for (const line of code.split("\n")) {
      const d = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(line);
      if (d) { if (!/_H$/.test(d[1]!)) consts.add(d[1]!); continue; }
      if (/^\s*#/.test(line)) continue;
      const f = /([A-Za-z_]\w*)\s*\(/.exec(line); // primera llamada = nombre del prototipo
      if (f && !C_KEYWORDS.has(f[1]!) && !C_TYPES.has(f[1]!)) funcs.add(f[1]!);
    }
  }
  return { funcs, consts };
}
const LIB = libNames(clibFiles);
export const C_BUILTINS: ReadonlySet<string> = LIB.funcs;
export const C_LIB_CONSTS: ReadonlySet<string> = LIB.consts;

export interface CState {
  /** Dentro de un comentario /* … *\/ que viene de una línea anterior. */
  comment: boolean;
  /** Línea de preprocesador (sigue si acaba en \). */
  pp: boolean;
  /** La línea anterior acabó en "\" (la de preprocesador continúa). */
  cont: boolean;
  /** Tras #include: lo que va entre <> es una cadena. */
  include: boolean;
  /** Dentro de __asm … __endasm: el texto es ensamblador (no C). */
  asm: boolean;
}

const IDENT = /^[A-Za-z_]\w*/;

export const cParser: StreamParser<CState> = {
  name: "c",
  startState: () => ({ comment: false, pp: false, cont: false, include: false, asm: false }),
  copyState: (s) => ({ ...s }),
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },

  token(stream: StringStream, st: CState): string | null {
    // Una línea de preprocesador acaba en el salto de línea salvo que termine en "\".
    if (stream.sol() && st.pp && !st.cont) { st.pp = false; st.include = false; }
    const style = token(stream, st);
    if (stream.eol()) st.cont = /\\\s*$/.test(stream.string);
    return style;
  },
  blankLine(st: CState) { st.pp = false; st.include = false; st.cont = false; },
};

function token(stream: StringStream, st: CState): string | null {
  if (st.comment) {
    if (stream.match(/^.*?\*\//)) st.comment = false;
    else stream.skipToEnd();
    return "comment";
  }
  if (stream.eatSpace()) return null;
  if (st.asm) {
    if (stream.match(/^__endasm\b/)) { st.asm = false; return "keyword"; }
    if (stream.match(/^;.*/)) return "comment";
    stream.next();
    while (!stream.eol() && !stream.match(/^__endasm\b/, false) && stream.peek() !== ";") stream.next();
    return "string.special";
  }
  if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
  if (stream.match("/*")) {
    if (!stream.match(/^.*?\*\//)) { st.comment = true; stream.skipToEnd(); }
    return "comment";
  }
  // Preprocesador: "#" al principio (salvo espacios) y la directiva.
  if (stream.peek() === "#" && /^\s*$/.test(stream.string.slice(0, stream.pos))) {
    stream.next();
    stream.eatSpace();
    const d = stream.match(IDENT) as RegExpMatchArray | null;
    st.pp = true;
    st.include = d?.[0] === "include";
    return "meta";
  }
  if (st.include && stream.peek() === "<") {
    stream.match(/^<[^>\n]*>?/);
    return "string";
  }
  const ch = stream.peek()!;
  if (ch === '"' || ch === "'") {
    stream.next();
    for (;;) {
      const c = stream.next();
      if (c === undefined) return "invalid"; // sin cerrar en la línea
      if (c === "\\") { stream.next(); continue; }
      if (c === ch) return ch === '"' ? "string" : "character";
    }
  }
  // Números: decimal, 0x hex, 0 octal, 0b binario, con sufijos u/l.
  if (/[0-9]/.test(ch)) {
    const n = stream.match(/^(0[xX][0-9A-Fa-f]+|0[bB][01]+|[0-9]+)[uUlL]*/) as RegExpMatchArray | null;
    if (!n) { stream.next(); return "invalid"; }
    if (stream.match(/^[A-Za-z0-9_.]+/)) return "invalid"; // 0x1G, 12abc, 1.5 (sin float)
    return "number";
  }
  const m = stream.match(IDENT) as RegExpMatchArray | null;
  if (m) {
    const w = m[0];
    if (w === "__asm") { st.asm = true; return "keyword"; }
    if (C_KEYWORDS.has(w)) return "keyword";
    if (C_TYPES.has(w)) return "typeName";
    if (st.pp) return C_LIB_CONSTS.has(w) ? "variableName.constant" : "macroName";
    if (C_BUILTINS.has(w)) return "variableName.standard";
    if (C_LIB_CONSTS.has(w)) return "variableName.constant";
    if (/^\s*\(/.test(stream.string.slice(stream.pos))) return "variableName.function";
    return "variableName";
  }
  stream.next();
  if ("()[]{}".includes(ch)) return "bracket";
  if (ch === ";" || ch === ",") return "punctuation";
  if (ch === "\\" && st.pp) return "meta";
  return "operator";
}

export const cLanguage = StreamLanguage.define(cParser);

/** Colores a juego con el resaltado del ensamblador (web/src/ui/editor/language.ts). */
export const cHighlight = HighlightStyle.define([
  { tag: t.comment, color: "#6b7089", fontStyle: "italic" },
  { tag: [t.string, t.character], color: "#9ece6a" },
  { tag: t.special(t.string), color: "#c0caf5", fontStyle: "italic" },
  { tag: t.number, color: "#ff9e64" },
  { tag: t.keyword, color: "#7aa2f7", fontWeight: "600" },
  { tag: t.typeName, color: "#2ac3de" },
  { tag: t.meta, color: "#bb9af7" },
  { tag: t.macroName, color: "#73daca" },
  { tag: t.function(t.variableName), color: "#7dcfff" },
  { tag: t.standard(t.variableName), color: "#e0af68" },
  { tag: t.constant(t.variableName), color: "#f7768e" },
  { tag: t.operator, color: "#89ddff" },
  { tag: [t.bracket, t.punctuation], color: "#a9b1d6" },
  { tag: t.invalid, color: "#f7768e", textDecoration: "underline" },
]);

export function cLang(): Extension {
  return [cLanguage, syntaxHighlighting(cHighlight)];
}
