// Tabla única de instrucciones SM83 (CPU de la Game Boy / Game Boy Color).
// La usan el ensamblador (web/src/asm) y el desensamblador (web/src/disasm).
//
// Fuente: tabla de opcodes de Pan Docs / gbdev (gbdev.io/gb-opcodes) y gbz80(7) de RGBDS.
// Ciclos en ciclos M (1 ciclo M = 4 puntos en velocidad normal). Las instrucciones con
// salto condicional tienen dos cifras: `cycles` si se salta y `cyclesNotTaken` si no.
//
// Los 11 opcodes ilegales (D3 DB DD E3 E4 EB EC ED F4 FC FD) bloquean la CPU: no están en la
// tabla. CB es el prefijo de la segunda tabla. 256 − 11 − 1 = 244 opcodes base válidos.

/**
 * Tipos de operando:
 * - `r8`   registro de 8 bits (`name`: A B C D E H L)
 * - `r16`  par de registros (`name`: BC DE HL SP AF)
 * - `ind`  memoria apuntada por registro (`name`: BC DE HL HLI=[HL+] HLD=[HL-] C=[$FF00+C])
 * - `cc`   condición (`name`: NZ Z NC C)
 * - `n8`   inmediato de 8 bits
 * - `n16`  inmediato de 16 bits (little endian)
 * - `e8`   desplazamiento relativo de JR (con signo, respecto al PC tras la instrucción)
 * - `s8`   inmediato con signo de 8 bits (ADD SP,e8)
 * - `a16`  memoria en dirección inmediata de 16 bits `[n16]`
 * - `a8`   memoria en $FF00 + inmediato de 8 bits (LDH)
 * - `spe8` SP + inmediato con signo de 8 bits (LD HL,SP+e8)
 * - `u3`   número de bit codificado en el opcode (`value` 0–7)
 * - `vec`  vector de RST codificado en el opcode (`value` $00–$38)
 */
export type OperandKind =
  | "r8" | "r16" | "ind" | "cc" | "n8" | "n16" | "e8" | "s8" | "a16" | "a8" | "spe8" | "u3" | "vec";

export interface Operand {
  readonly kind: OperandKind;
  /** Registro o condición, en mayúsculas (r8, r16, ind, cc). */
  readonly name?: string;
  /** Valor fijo codificado en el opcode (u3, vec). */
  readonly value?: number;
  /** Texto en la sintaxis canónica: "A", "[HL+]", "NZ", "n8", "[n16]", "[a8]", "SP+e8", "3", "$38". */
  readonly text: string;
}

export interface Op {
  /** 0 para la tabla base, 0xCB para la tabla con prefijo. */
  readonly prefix: 0 | 0xcb;
  readonly opcode: number;
  /** Mnemónico en mayúsculas. */
  readonly mnemonic: string;
  readonly operands: readonly Operand[];
  /** Bytes totales, incluido el prefijo CB y los inmediatos. */
  readonly length: number;
  /** Ciclos M (con salto, si es condicional). */
  readonly cycles: number;
  /** Ciclos M si la condición no se cumple (= cycles si no es condicional). */
  readonly cyclesNotTaken: number;
  /** Sintaxis canónica, p. ej. "LD A,[n16]" o "BIT 3,[HL]". */
  readonly syntax: string;
}

// [opcode, sintaxis, bytes, ciclos M (con salto), ciclos M sin salto]
// Bloques 40–7F (LD r,r') y 80–BF (ALU A,r) se generan más abajo: son regulares.
type Row = readonly [number, string, number, number, number?];
const BASE_ROWS: readonly Row[] = [
  [0x00, "NOP", 1, 1],
  [0x01, "LD BC,n16", 3, 3],
  [0x02, "LD [BC],A", 1, 2],
  [0x03, "INC BC", 1, 2],
  [0x04, "INC B", 1, 1],
  [0x05, "DEC B", 1, 1],
  [0x06, "LD B,n8", 2, 2],
  [0x07, "RLCA", 1, 1],
  [0x08, "LD [n16],SP", 3, 5],
  [0x09, "ADD HL,BC", 1, 2],
  [0x0a, "LD A,[BC]", 1, 2],
  [0x0b, "DEC BC", 1, 2],
  [0x0c, "INC C", 1, 1],
  [0x0d, "DEC C", 1, 1],
  [0x0e, "LD C,n8", 2, 2],
  [0x0f, "RRCA", 1, 1],
  // STOP ocupa 2 bytes (10 00): la CPU se salta el byte siguiente; RGBDS emite el 00.
  [0x10, "STOP", 2, 1],
  [0x11, "LD DE,n16", 3, 3],
  [0x12, "LD [DE],A", 1, 2],
  [0x13, "INC DE", 1, 2],
  [0x14, "INC D", 1, 1],
  [0x15, "DEC D", 1, 1],
  [0x16, "LD D,n8", 2, 2],
  [0x17, "RLA", 1, 1],
  [0x18, "JR e8", 2, 3],
  [0x19, "ADD HL,DE", 1, 2],
  [0x1a, "LD A,[DE]", 1, 2],
  [0x1b, "DEC DE", 1, 2],
  [0x1c, "INC E", 1, 1],
  [0x1d, "DEC E", 1, 1],
  [0x1e, "LD E,n8", 2, 2],
  [0x1f, "RRA", 1, 1],
  [0x20, "JR NZ,e8", 2, 3, 2],
  [0x21, "LD HL,n16", 3, 3],
  [0x22, "LD [HL+],A", 1, 2],
  [0x23, "INC HL", 1, 2],
  [0x24, "INC H", 1, 1],
  [0x25, "DEC H", 1, 1],
  [0x26, "LD H,n8", 2, 2],
  [0x27, "DAA", 1, 1],
  [0x28, "JR Z,e8", 2, 3, 2],
  [0x29, "ADD HL,HL", 1, 2],
  [0x2a, "LD A,[HL+]", 1, 2],
  [0x2b, "DEC HL", 1, 2],
  [0x2c, "INC L", 1, 1],
  [0x2d, "DEC L", 1, 1],
  [0x2e, "LD L,n8", 2, 2],
  [0x2f, "CPL", 1, 1],
  [0x30, "JR NC,e8", 2, 3, 2],
  [0x31, "LD SP,n16", 3, 3],
  [0x32, "LD [HL-],A", 1, 2],
  [0x33, "INC SP", 1, 2],
  [0x34, "INC [HL]", 1, 3],
  [0x35, "DEC [HL]", 1, 3],
  [0x36, "LD [HL],n8", 2, 3],
  [0x37, "SCF", 1, 1],
  [0x38, "JR C,e8", 2, 3, 2],
  [0x39, "ADD HL,SP", 1, 2],
  [0x3a, "LD A,[HL-]", 1, 2],
  [0x3b, "DEC SP", 1, 2],
  [0x3c, "INC A", 1, 1],
  [0x3d, "DEC A", 1, 1],
  [0x3e, "LD A,n8", 2, 2],
  [0x3f, "CCF", 1, 1],
  [0xc0, "RET NZ", 1, 5, 2],
  [0xc1, "POP BC", 1, 3],
  [0xc2, "JP NZ,n16", 3, 4, 3],
  [0xc3, "JP n16", 3, 4],
  [0xc4, "CALL NZ,n16", 3, 6, 3],
  [0xc5, "PUSH BC", 1, 4],
  [0xc6, "ADD A,n8", 2, 2],
  [0xc7, "RST $00", 1, 4],
  [0xc8, "RET Z", 1, 5, 2],
  [0xc9, "RET", 1, 4],
  [0xca, "JP Z,n16", 3, 4, 3],
  [0xcc, "CALL Z,n16", 3, 6, 3],
  [0xcd, "CALL n16", 3, 6],
  [0xce, "ADC A,n8", 2, 2],
  [0xcf, "RST $08", 1, 4],
  [0xd0, "RET NC", 1, 5, 2],
  [0xd1, "POP DE", 1, 3],
  [0xd2, "JP NC,n16", 3, 4, 3],
  [0xd4, "CALL NC,n16", 3, 6, 3],
  [0xd5, "PUSH DE", 1, 4],
  [0xd6, "SUB A,n8", 2, 2],
  [0xd7, "RST $10", 1, 4],
  [0xd8, "RET C", 1, 5, 2],
  [0xd9, "RETI", 1, 4],
  [0xda, "JP C,n16", 3, 4, 3],
  [0xdc, "CALL C,n16", 3, 6, 3],
  [0xde, "SBC A,n8", 2, 2],
  [0xdf, "RST $18", 1, 4],
  [0xe0, "LDH [a8],A", 2, 3],
  [0xe1, "POP HL", 1, 3],
  [0xe2, "LDH [C],A", 1, 2],
  [0xe5, "PUSH HL", 1, 4],
  [0xe6, "AND A,n8", 2, 2],
  [0xe7, "RST $20", 1, 4],
  [0xe8, "ADD SP,e8", 2, 4],
  [0xe9, "JP HL", 1, 1],
  [0xea, "LD [n16],A", 3, 4],
  [0xee, "XOR A,n8", 2, 2],
  [0xef, "RST $28", 1, 4],
  [0xf0, "LDH A,[a8]", 2, 3],
  [0xf1, "POP AF", 1, 3],
  [0xf2, "LDH A,[C]", 1, 2],
  [0xf3, "DI", 1, 1],
  [0xf5, "PUSH AF", 1, 4],
  [0xf6, "OR A,n8", 2, 2],
  [0xf7, "RST $30", 1, 4],
  [0xf8, "LD HL,SP+e8", 2, 3],
  [0xf9, "LD SP,HL", 1, 2],
  [0xfa, "LD A,[n16]", 3, 4],
  [0xfb, "EI", 1, 1],
  [0xfe, "CP A,n8", 2, 2],
  [0xff, "RST $38", 1, 4],
];

/** Opcodes base que bloquean la CPU. */
export const ILLEGAL_OPCODES: readonly number[] = [0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd];

// Orden de registros en los 3 bits de los opcodes regulares.
const R8 = ["B", "C", "D", "E", "H", "L", "[HL]", "A"] as const;
const ALU = ["ADD", "ADC", "SUB", "SBC", "AND", "XOR", "OR", "CP"] as const;
const CB_ROT = ["RLC", "RRC", "RL", "RR", "SLA", "SRA", "SWAP", "SRL"] as const;
const CB_BIT = ["BIT", "RES", "SET"] as const;
const BRANCH = new Set(["JR", "JP", "CALL", "RET"]);

function parseOperand(mnemonic: string, text: string, index: number): Operand {
  switch (text) {
    case "A": case "B": case "D": case "E": case "H": case "L":
      return { kind: "r8", name: text, text };
    case "C":
      return BRANCH.has(mnemonic) && index === 0 ? { kind: "cc", name: "C", text } : { kind: "r8", name: "C", text };
    case "AF": case "BC": case "DE": case "HL": case "SP":
      return { kind: "r16", name: text, text };
    case "[BC]": return { kind: "ind", name: "BC", text };
    case "[DE]": return { kind: "ind", name: "DE", text };
    case "[HL]": return { kind: "ind", name: "HL", text };
    case "[HL+]": return { kind: "ind", name: "HLI", text };
    case "[HL-]": return { kind: "ind", name: "HLD", text };
    case "[C]": return { kind: "ind", name: "C", text };
    case "NZ": case "Z": case "NC": return { kind: "cc", name: text, text };
    case "n8": return { kind: "n8", text };
    case "n16": return { kind: "n16", text };
    case "e8": return mnemonic === "JR" ? { kind: "e8", text } : { kind: "s8", text };
    case "[n16]": return { kind: "a16", text };
    case "[a8]": return { kind: "a8", text };
    case "SP+e8": return { kind: "spe8", text };
  }
  if (/^[0-7]$/.test(text)) return { kind: "u3", value: Number(text), text };
  if (/^\$[0-3][08]$/.test(text)) return { kind: "vec", value: parseInt(text.slice(1), 16), text };
  throw new Error(`sm83isa: operando desconocido '${text}'`);
}

function makeOp(prefix: 0 | 0xcb, opcode: number, syntax: string, length: number, cycles: number, notTaken?: number): Op {
  const sp = syntax.indexOf(" ");
  const mnemonic = sp < 0 ? syntax : syntax.slice(0, sp);
  const operands = sp < 0 ? [] : syntax.slice(sp + 1).split(",").map((t, i) => parseOperand(mnemonic, t, i));
  return { prefix, opcode, mnemonic, operands, length, cycles, cyclesNotTaken: notTaken ?? cycles, syntax };
}

function buildBase(): (Op | undefined)[] {
  const t: (Op | undefined)[] = new Array(256).fill(undefined);
  for (const [opc, syn, len, cyc, nt] of BASE_ROWS) t[opc] = makeOp(0, opc, syn, len, cyc, nt);
  for (let opc = 0x40; opc < 0xc0; opc++) {
    const src = R8[opc & 7]!;
    if (opc < 0x80) {
      if (opc === 0x76) { t[opc] = makeOp(0, opc, "HALT", 1, 1); continue; } // sería LD [HL],[HL]
      const dst = R8[(opc >> 3) & 7]!;
      // Un acceso a [HL] añade un ciclo M de bus.
      t[opc] = makeOp(0, opc, `LD ${dst},${src}`, 1, dst === "[HL]" || src === "[HL]" ? 2 : 1);
    } else {
      t[opc] = makeOp(0, opc, `${ALU[(opc >> 3) & 7]!} A,${src}`, 1, src === "[HL]" ? 2 : 1);
    }
  }
  return t;
}

function buildCb(): Op[] {
  const t: Op[] = [];
  for (let opc = 0; opc < 256; opc++) {
    const reg = R8[opc & 7]!;
    const hl = reg === "[HL]";
    if (opc < 0x40) {
      t.push(makeOp(0xcb, opc, `${CB_ROT[opc >> 3]!} ${reg}`, 2, hl ? 4 : 2));
    } else {
      const kind = CB_BIT[(opc >> 6) - 1]!;
      // BIT b,[HL] sólo lee (3 ciclos M); RES/SET leen y escriben (4).
      const cyc = hl ? (kind === "BIT" ? 3 : 4) : 2;
      t.push(makeOp(0xcb, opc, `${kind} ${(opc >> 3) & 7},${reg}`, 2, cyc));
    }
  }
  return t;
}

/** Tabla base indexada por opcode (undefined en los ilegales y en 0xCB). */
export const BASE_OPS: readonly (Op | undefined)[] = buildBase();
/** Tabla con prefijo CB indexada por el segundo byte. */
export const CB_OPS: readonly Op[] = buildCb();
/** Las 500 instrucciones: 244 base (en orden de opcode) y 256 CB. */
export const OPS: readonly Op[] = [...BASE_OPS.filter((o): o is Op => o !== undefined), ...CB_OPS];

/** Instrucción de la tabla base por su primer byte (undefined si es ilegal o el prefijo CB). */
export function opByByte(byte: number): Op | undefined {
  return BASE_OPS[byte & 0xff];
}

/** Instrucción de la tabla CB por el byte que sigue al prefijo. */
export function cbOpByByte(byte: number): Op {
  return CB_OPS[byte & 0xff]!;
}

/**
 * Decodifica la instrucción en `bytes[at]` (sin leer inmediatos).
 * Devuelve undefined si el opcode es ilegal o falta el byte tras el prefijo.
 */
export function decode(bytes: ArrayLike<number>, at: number): Op | undefined {
  const b = bytes[at];
  if (b === undefined) return undefined;
  if (b === 0xcb) {
    const b2 = bytes[at + 1];
    return b2 === undefined ? undefined : CB_OPS[b2];
  }
  return BASE_OPS[b];
}
