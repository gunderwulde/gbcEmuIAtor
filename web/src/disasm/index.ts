// Desensamblador SM83 (D1). TS puro, sin DOM, determinista. Comparte la tabla de
// instrucciones con el ensamblador (web/src/sm83isa), así que lo que escribe se puede
// volver a ensamblar byte a byte (tests/disasm/roundtrip.test.ts).
//
// Consciente de bancos: lee bytes con una función `ByteReader` sobre el mapa de 16 bits.
// - `coreReader` (en la UI) usa gb_peek: ve exactamente lo que ve la CPU, con el banco
//   ROMX que tenga mapeado el MBC en ese momento.
// - `romReader(rom, bank)` lee una imagen de ROM como si `bank` estuviera en 4000-7FFF,
//   para mirar bancos no mapeados.
// El banco sólo importa en 4000-7FFF (ROMX): es el único sitio donde el mismo PC puede
// ser código distinto según el MBC. Ahí la línea lleva el banco; fuera, -1 ("cualquiera").
import { cbOpByByte, opByByte, type Op, type Operand } from "../sm83isa";

/** Lee un byte del mapa de memoria de 16 bits (la dirección ya viene enmascarada). */
export type ByteReader = (addr: number) => number;

export interface SymbolLookup {
  /** Nombre de la etiqueta en `bank:addr` (bank ya normalizado con `normBank`). */
  name(bank: number, addr: number): string | undefined;
}

export interface DisasmOptions {
  /** Banco mapeado en 4000-7FFF (para la línea y los símbolos). Por defecto 1. */
  bank?: number;
  symbols?: SymbolLookup;
}

export interface DisasmLine {
  addr: number;
  /** Banco normalizado: el de ROMX en 4000-7FFF; -1 en el resto. */
  bank: number;
  len: number;
  bytes: number[];
  /** undefined si es un byte suelto (opcode ilegal, o STOP sin su 00). */
  op: Op | undefined;
  /** Texto ensamblable (sintaxis RGBDS del ensamblador propio). */
  text: string;
  /** Destino fijo de JP/JR/CALL n16/RST, si lo hay. */
  target?: number;
}

const h2 = (n: number): string => "$" + (n & 0xff).toString(16).toUpperCase().padStart(2, "0");
const h4 = (n: number): string => "$" + (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");
const signed = (b: number): number => (b & 0x80 ? b - 0x100 : b);
const sh2 = (v: number): string => (v < 0 ? "-" + h2(-v) : h2(v));

/** Banco con el que se identifica una dirección: sólo ROMX (4000-7FFF) distingue bancos. */
export function normBank(bank: number, addr: number): number {
  return addr >= 0x4000 && addr < 0x8000 ? bank : -1;
}

/** Lector sobre una imagen de ROM con `bank` mapeado en 4000-7FFF (fuera de la ROM: $FF). */
export function romReader(rom: ArrayLike<number>, bank: number): ByteReader {
  return (a) => {
    a &= 0xffff;
    const off = a < 0x4000 ? a : a < 0x8000 ? bank * 0x4000 + (a - 0x4000) : -1;
    return off >= 0 && off < rom.length ? rom[off]! : 0xff;
  };
}

/** ¿CALL (con o sin condición) o RST? Son las que "paso por encima" no sigue. */
export function isCall(op: Op | undefined): boolean {
  return !!op && op.prefix === 0 && (op.mnemonic === "CALL" || op.mnemonic === "RST");
}

/** ¿RET, RET cc o RETI? */
export function isReturn(op: Op | undefined): boolean {
  return !!op && op.prefix === 0 && (op.mnemonic === "RET" || op.mnemonic === "RETI");
}

/** Instrucción en `addr` (sin leer inmediatos), o undefined si es ilegal. */
export function opAt(read: ByteReader, addr: number): Op | undefined {
  const b = read(addr & 0xffff);
  return b === 0xcb ? cbOpByByte(read((addr + 1) & 0xffff)) : opByByte(b);
}

/** Desensambla una instrucción en `addr`. */
export function disasmOne(read: ByteReader, addr: number, opts: DisasmOptions = {}): DisasmLine {
  addr &= 0xffff;
  const romBank = opts.bank ?? 1;
  const bank = normBank(romBank, addr);
  const b0 = read(addr);
  const op = b0 === 0xcb ? cbOpByByte(read((addr + 1) & 0xffff)) : opByByte(b0);
  // STOP es 10 00; con otro byte detrás el ensamblador no lo reproduciría: byte suelto.
  if (!op || (b0 === 0x10 && read((addr + 1) & 0xffff) !== 0)) {
    return { addr, bank, len: 1, bytes: [b0], op: undefined, text: `DB ${h2(b0)}` };
  }
  const bytes: number[] = [];
  for (let i = 0; i < op.length; i++) bytes.push(read((addr + i) & 0xffff));
  const imm8 = bytes[op.length - 1]!;
  const imm16 = op.length === 3 ? bytes[1]! | (bytes[2]! << 8) : 0;
  const sym = (a: number): string | undefined => opts.symbols?.name(normBank(romBank, a), a & 0xffff);
  let target: number | undefined;

  const fmt = (o: Operand): string => {
    switch (o.kind) {
      case "n8": return h2(imm8);
      case "n16": return sym(imm16) ?? h4(imm16);
      case "a16": return `[${sym(imm16) ?? h4(imm16)}]`;
      case "a8": return `[${sym(0xff00 | imm8) ?? h4(0xff00 | imm8)}]`;
      case "s8": return sh2(signed(imm8));
      case "spe8": { const e = signed(imm8); return `SP${e < 0 ? "-" : "+"}${h2(Math.abs(e))}`; }
      case "e8": {
        const t = addr + 2 + signed(imm8);
        // Un destino que da la vuelta al mapa no se puede escribir como dirección: el
        // ensamblador mide la distancia sin envolver. `@` es el inicio de la instrucción.
        if (t < 0 || t > 0xffff) { const d = 2 + signed(imm8); return d < 0 ? `@-${h2(-d)}` : `@+${h2(d)}`; }
        target = t;
        return sym(t) ?? h4(t);
      }
      default: return o.text; // registros, condiciones, [HL+], bit, vector de RST
    }
  };

  const ops = op.operands.map(fmt);
  if (op.prefix === 0) {
    if ((op.mnemonic === "JP" || op.mnemonic === "CALL") && op.operands.some((o) => o.kind === "n16")) target = imm16;
    else if (op.mnemonic === "RST") target = op.operands[0]!.value!;
  }
  const text = ops.length ? `${op.mnemonic} ${ops.join(",")}` : op.mnemonic;
  const r: DisasmLine = { addr, bank, len: op.length, bytes, op, text };
  if (target !== undefined) r.target = target;
  return r;
}

/** `count` instrucciones seguidas desde `addr`. */
export function disasmRange(read: ByteReader, addr: number, count: number, opts: DisasmOptions = {}): DisasmLine[] {
  const out: DisasmLine[] = [];
  let a = addr & 0xffff;
  for (let i = 0; i < count; i++) {
    const l = disasmOne(read, a, opts);
    out.push(l);
    a = (a + l.len) & 0xffff;
  }
  return out;
}

/**
 * Dirección desde la que desensamblar para mostrar ~`before` instrucciones antes de `pc`.
 * El código de longitud variable no se puede leer hacia atrás: se prueban inicios cada
 * vez más cercanos y se elige el más lejano cuya decodificación cae justo en `pc`
 * (heurística clásica; con datos mezclados puede elegir mal, nunca pasa de largo de pc).
 * No cruza el inicio de la región (0000, 4000, 8000…) para no mezclar bancos.
 */
export function findStart(read: ByteReader, pc: number, before: number): number {
  pc &= 0xffff;
  const region = pc & 0xc000 ? (pc < 0x8000 ? 0x4000 : pc & 0xf000) : 0;
  for (let back = Math.min(before * 3, pc - region); back > 0; back--) {
    let a = pc - back, n = 0;
    while (a < pc) { a += disasmOne(read, a).len; n++; }
    if (a === pc) {
      // Sobran instrucciones: avanzar hasta dejar sólo `before`.
      let s = pc - back;
      for (; n > before; n--) s += disasmOne(read, s).len;
      return s;
    }
  }
  return pc;
}

/**
 * Tabla de símbolos a partir de `AsmResult.symbols`. Si varias etiquetas comparten
 * dirección, gana la global (sin '.') definida primero.
 */
export function symbolTable(symbols: ReadonlyMap<string, { bank: number; addr: number }>): SymbolLookup & {
  /** Etiqueta → dirección (para "ir a" por nombre). */
  find(name: string): { bank: number; addr: number } | undefined;
} {
  const byAddr = new Map<number, string>();
  const key = (bank: number, addr: number): number => (bank + 1) * 0x10000 + addr;
  for (const [name, s] of symbols) {
    const k = key(normBank(s.bank, s.addr), s.addr);
    const cur = byAddr.get(k);
    if (cur === undefined || (cur.includes(".") && !name.includes("."))) byAddr.set(k, name);
  }
  return {
    name: (bank, addr) => byAddr.get(key(bank, addr)),
    find: (name) => symbols.get(name),
  };
}
