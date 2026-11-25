// Lexer de una línea de ensamblador con la sintaxis de RGBDS.
// Puro y sin estado: una línea → lista de tokens. Las sustituciones de macro (\1, \@),
// la interpolación {sym} y la expansión de EQUS ocurren antes/después, en el ensamblador.

export const TK_ID = 0;
export const TK_NUM = 1;
export const TK_STR = 2;
export const TK_OP = 3;
/** Referencia a etiqueta anónima: `v` = -1 para `:-`, -2 para `:--`, +1 para `:+`… */
export const TK_ANON = 4;

export interface Tok {
  t: number;
  /** Texto del identificador u operador; contenido decodificado de la cadena. */
  s: string;
  /** Valor numérico (números y anónimas). */
  v: number;
  /** Columna (1-based) en la línea. */
  col: number;
}

/** Error de ensamblado con columna; el ensamblador le añade fichero y línea. */
export class AsmErr extends Error {
  constructor(public col: number, msg: string) {
    super(msg);
  }
}

function isIdStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 /* _ */ || c === 46 /* . */;
}

function isIdChar(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
    c === 95 || c === 46 || c === 35 /* # */ || c === 64 /* @ */ || c === 36 /* $ */
  );
}

function digitVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return 99;
}

// Operadores de varios caracteres, del más largo al más corto.
const OPS3 = ["<<=", ">>=", ">>>"];
const OPS2 = ["**", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "::", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^="];
const OPS1 = "+-*/%&|^~!<>=()[],:@";

/**
 * Tokeniza una línea. `keywords` (en mayúsculas) decide si `%`/`&` tras un identificador
 * son operadores o prefijos de número: tras una palabra clave (`db %1010`) son número.
 */
export function lex(src: string, keywords: ReadonlySet<string>): Tok[] {
  const out: Tok[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 13 || c === 10) { i++; continue; }
    if (c === 59 /* ; */) break;
    const col = i + 1;
    if (c === 47 /* / */ && src.charCodeAt(i + 1) === 42 /* * */) {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) throw new AsmErr(col, "unterminated block comment");
      i = e + 2;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdChar(src.charCodeAt(j))) j++;
      out.push({ t: TK_ID, s: src.slice(i, j), v: 0, col });
      i = j;
      continue;
    }
    // Números
    let radix = 0;
    let start = i;
    if (c >= 48 && c <= 57) {
      const c1 = src.charCodeAt(i + 1) | 0x20;
      if (c === 48 && c1 === 120 /* x */) { radix = 16; start = i + 2; }
      else if (c === 48 && c1 === 98 /* b */ && (src.charCodeAt(i + 2) === 48 || src.charCodeAt(i + 2) === 49)) { radix = 2; start = i + 2; }
      else if (c === 48 && c1 === 111 /* o */) { radix = 8; start = i + 2; }
      else { radix = 10; start = i; }
    } else if (c === 36 /* $ */) {
      radix = 16; start = i + 1;
    } else if ((c === 37 /* % */ || c === 38 /* & */) && !afterOperand(out, keywords)) {
      const d = src.charCodeAt(i + 1);
      if (c === 37 && (d === 48 || d === 49)) { radix = 2; start = i + 1; }
      else if (c === 38 && d >= 48 && d <= 55) { radix = 8; start = i + 1; }
    }
    if (radix) {
      let v = 0;
      let j = start;
      let digits = 0;
      for (; j < n; j++) {
        const d = src.charCodeAt(j);
        if (d === 95 /* _ */) continue;
        const dv = digitVal(d);
        if (dv >= radix) break;
        v = (v * radix + dv) % 4294967296;
        digits++;
      }
      if (!digits) throw new AsmErr(col, "invalid number");
      if (j < n && isIdChar(src.charCodeAt(j)) && src.charCodeAt(j) !== 46) {
        throw new AsmErr(col, `invalid digit in number '${src.slice(i, j + 1)}'`);
      }
      out.push({ t: TK_NUM, s: src.slice(i, j), v: v | 0, col });
      i = j;
      continue;
    }
    if (c === 96 /* ` */) {
      // Fila de 8 píxeles 2bpp: el bit bajo de cada dígito va al primer byte (plano bajo)
      // y el alto al segundo; el píxel de la izquierda es el bit 7.
      let lo = 0, hi = 0, j = i + 1, digits = 0;
      for (; j < n; j++) {
        const d = src.charCodeAt(j) - 48;
        if (d < 0 || d > 3) break;
        lo = ((lo << 1) | (d & 1)) & 0xff;
        hi = ((hi << 1) | (d >> 1)) & 0xff;
        digits++;
      }
      if (!digits || (j < n && isIdChar(src.charCodeAt(j)))) throw new AsmErr(col, "invalid graphics constant");
      out.push({ t: TK_NUM, s: src.slice(i, j), v: lo | (hi << 8), col });
      i = j;
      continue;
    }
    if (c === 34 /* " */) {
      let s = "";
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new AsmErr(col, "unterminated string");
        const d = src.charCodeAt(j);
        if (d === 34) { j++; break; }
        if (d === 92 /* \ */) {
          const e = src[j + 1];
          switch (e) {
            case "n": s += "\n"; break;
            case "r": s += "\r"; break;
            case "t": s += "\t"; break;
            case "0": s += "\0"; break;
            case "\\": case "\"": case "'": case ",": case "{": case "}": s += e; break;
            default: throw new AsmErr(j + 1, `invalid escape '\\${e ?? ""}'`);
          }
          j += 2;
          continue;
        }
        s += src[j];
        j++;
      }
      out.push({ t: TK_STR, s, v: 0, col });
      i = j;
      continue;
    }
    if (c === 58 /* : */) {
      const d = src.charCodeAt(i + 1);
      if (d === 43 || d === 45) {
        let j = i + 1;
        while (src.charCodeAt(j) === d) j++;
        const cnt = j - i - 1;
        out.push({ t: TK_ANON, s: src.slice(i, j), v: d === 43 ? cnt : -cnt, col });
        i = j;
        continue;
      }
    }
    const s3 = src.substr(i, 3);
    if (OPS3.includes(s3)) { out.push({ t: TK_OP, s: s3, v: 0, col }); i += 3; continue; }
    const s2 = src.substr(i, 2);
    if (OPS2.includes(s2)) { out.push({ t: TK_OP, s: s2, v: 0, col }); i += 2; continue; }
    const s1 = src[i]!;
    if (OPS1.includes(s1)) { out.push({ t: TK_OP, s: s1, v: 0, col }); i++; continue; }
    throw new AsmErr(col, `unexpected character '${s1}'`);
  }
  return out;
}

/** ¿El token anterior termina un operando? (entonces `%`/`&` son operadores binarios) */
function afterOperand(out: Tok[], keywords: ReadonlySet<string>): boolean {
  const p = out[out.length - 1];
  if (!p) return false;
  if (p.t === TK_NUM || p.t === TK_STR || p.t === TK_ANON) return true;
  if (p.t === TK_OP) return p.s === ")" || p.s === "]" || p.s === "@";
  // Identificador: es un operando salvo que sea cabeza de sentencia o palabra clave.
  return out.length > 1 && !keywords.has(p.s.toUpperCase());
}
