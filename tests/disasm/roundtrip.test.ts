// D1 · Aceptación del desensamblador: ensamblar(desensamblar(bytes)) == bytes para los 244
// opcodes base válidos y los 256 CB, con todos los valores de los operandos de 8 bits
// (n8, e8, s8, a8, SP+e8) y una muestra de los de 16 bits. El oráculo son los propios
// bytes de entrada: no depende de lo que diga el desensamblador.
import { describe, expect, it } from "vitest";
import { assemble } from "../../web/src/asm";
import { disasmOne, disasmRange, findStart, romReader, symbolTable, type DisasmLine } from "../../web/src/disasm";
import { BASE_OPS, CB_OPS, ILLEGAL_OPCODES, type Op } from "../../web/src/sm83isa";

const ORG = 0x1000; // los destinos de JR (±128) caen dentro de ROM0

/** Valores de 16 bits: bordes de cada región y una secuencia pseudoaleatoria fija. */
const V16: number[] = [0x0000, 0x0001, 0x007f, 0x0080, 0x00ff, 0x0100, 0x1234, 0x3fff, 0x4000, 0x7fff,
  0x8000, 0x9fff, 0xa000, 0xc000, 0xdfff, 0xe000, 0xfe00, 0xfeff, 0xff00, 0xff80, 0xfffe, 0xffff];
for (let s = 12345, i = 0; i < 64; i++) { s = (s * 1103515245 + 12345) >>> 0; V16.push(s >>> 16); }

function variants(op: Op): number[][] {
  const head = op.prefix ? [0xcb, op.opcode] : [op.opcode];
  if (op.opcode === 0x10 && !op.prefix) return [[0x10, 0x00]];
  const extra = op.length - head.length;
  if (extra === 0) return [head];
  if (extra === 1) return Array.from({ length: 256 }, (_, v) => [...head, v]);
  return V16.map((v) => [...head, v & 0xff, v >> 8]);
}

function roundTrip(code: number[], symbols?: ReturnType<typeof symbolTable>, extraSrc = ""): { lines: DisasmLine[]; out: Uint8Array; errors: string[] } {
  const img = new Uint8Array(0x8000).fill(0xff);
  img.set(code, ORG);
  const read = romReader(img, 1);
  const lines: DisasmLine[] = [];
  for (let a = ORG; a < ORG + code.length;) { const l = disasmOne(read, a, { symbols }); lines.push(l); a += l.len; }
  const src = `SECTION "t", ROM0[${ORG}]\n${lines.map((l) => (symbols?.name(l.bank, l.addr) ?? "") + (symbols?.name(l.bank, l.addr) ? ": " : "  ") + l.text).join("\n")}\n${extraSrc}`;
  const r = assemble(src);
  return { lines, out: r.rom.slice(ORG, ORG + code.length), errors: r.errors.map((e) => `${e.line}: ${e.msg}`) };
}

describe("D1 desensamblador: round-trip ensamblar(desensamblar(bytes)) == bytes", () => {
  it("cubre 244 opcodes base y 256 CB", () => {
    expect(BASE_OPS.filter((o) => o).length + 1 + ILLEGAL_OPCODES.length).toBe(256);
    expect(CB_OPS.length).toBe(256);
  });

  for (const op of BASE_OPS) {
    if (!op) continue;
    it(`${op.opcode.toString(16).padStart(2, "0")} ${op.syntax}`, () => {
      const code = variants(op).flat();
      const { lines, out, errors } = roundTrip(code);
      expect(errors).toEqual([]);
      expect(lines.length).toBe(variants(op).length);
      expect(lines.every((l) => l.op === op)).toBe(true);
      expect(Array.from(out)).toEqual(code);
    });
  }

  it("los 256 opcodes CB", () => {
    const code = CB_OPS.flatMap((o) => variants(o).flat());
    const { lines, out, errors } = roundTrip(code);
    expect(errors).toEqual([]);
    expect(lines.length).toBe(256);
    expect(Array.from(out)).toEqual(code);
  });

  it("opcodes ilegales y STOP sin 00 se emiten como DB y se reproducen", () => {
    const code = [...ILLEGAL_OPCODES, 0x10, 0x3c];
    const { lines, out, errors } = roundTrip(code);
    expect(errors).toEqual([]);
    expect(lines.map((l) => l.text).slice(0, 2)).toEqual(["DB $D3", "DB $DB"]);
    expect(lines.at(-2)!.text).toBe("DB $10");
    expect(lines.at(-1)!.text).toBe("INC A");
    expect(Array.from(out)).toEqual(code);
  });

  it("JR cerca de $FFFF que da la vuelta se escribe con @ y se reproduce", () => {
    const img = new Uint8Array(0x10000);
    img[0xfffe] = 0x18; img[0xffff] = 0x10; // JR +16 desde FFFE → 0x10010
    const l = disasmOne((a) => img[a]!, 0xfffe);
    expect(l.text).toBe("JR @+$12");
    expect(l.target).toBeUndefined();
  });
});

describe("D1 desensamblador: formato y símbolos", () => {
  it("textos de referencia (escritos a mano según Pan Docs)", () => {
    const cases: Array<[number[], string, number?]> = [
      [[0xf0, 0x44], "LDH A,[$FF44]"],
      [[0xe2], "LDH [C],A"],
      [[0xf8, 0xfe], "LD HL,SP-$02"],
      [[0xe8, 0x7f], "ADD SP,$7F"],
      [[0xe8, 0x80], "ADD SP,-$80"],
      [[0x18, 0xfe], "JR $1000", 0x1000],
      [[0xcd, 0x34, 0x12], "CALL $1234", 0x1234],
      [[0xc2, 0x00, 0x40], "JP NZ,$4000", 0x4000],
      [[0xff], "RST $38", 0x38],
      [[0xcb, 0x7e], "BIT 7,[HL]"],
      [[0x22], "LD [HL+],A"],
      [[0xea, 0x00, 0xc0], "LD [$C000],A"],
      [[0x10, 0x00], "STOP"],
    ];
    for (const [code, text, target] of cases) {
      const img = new Uint8Array(0x8000);
      img.set(code, ORG);
      const l = disasmOne(romReader(img, 1), ORG);
      expect(l.text).toBe(text);
      expect(l.len).toBe(code.length);
      expect(l.target).toBe(target);
    }
  });

  it("usa las etiquetas del ensamblador (por banco en ROMX) y sigue siendo ensamblable", () => {
    const src = [
      `SECTION "a", ROM0[$1000]`,
      `Start: call Func`, `  jr Start`, `  ld hl, Data`, `  ldh a, [hVar]`, `  jp Far`,
      `Func: ret`,
      `Data: db 1, 2`,
      `SECTION "h", HRAM[$FF90]`, `hVar: ds 1`,
      `SECTION "x", ROMX[$4000], BANK[2]`, `Far: jr Far`,
      `SECTION "y", ROMX[$4000], BANK[3]`, `Other: jr Other`,
    ].join("\n");
    const r = assemble(src);
    expect(r.errors).toEqual([]);
    const syms = symbolTable(r.symbols);
    const text = disasmRange(romReader(r.rom, 1), 0x1000, 5, { symbols: syms }).map((l) => l.text);
    expect(text).toEqual(["CALL Func", "JR Start", "LD HL,Data", "LDH A,[hVar]", "JP $4000"]);
    expect(disasmOne(romReader(r.rom, 2), 0x4000, { bank: 2, symbols: syms }).text).toBe("JR Far");
    expect(disasmOne(romReader(r.rom, 3), 0x4000, { bank: 3, symbols: syms }).text).toBe("JR Other");
    expect(syms.find("Far")).toEqual({ bank: 2, addr: 0x4000 });

    // Las etiquetas se resuelven igual al volver a ensamblar.
    const code = Array.from(r.rom.slice(0x1000, 0x100d));
    const back = roundTrip(code, syms, `Func: ret\nData: db 1,2\nSECTION "h", HRAM[$FF90]\nhVar: ds 1`);
    expect(back.errors).toEqual([]);
    expect(Array.from(back.out)).toEqual(code);
  });

  it("findStart vuelve atrás hasta sincronizar con pc sin pasarse", () => {
    // 1000: LD HL,$1234 (3) · 1003: NOP · 1004: LD A,$05 (2) · 1006: CALL $2000 (3) · 1009: INC A
    const img = new Uint8Array(0x8000);
    img.set([0x21, 0x34, 0x12, 0x00, 0x3e, 0x05, 0xcd, 0x00, 0x20, 0x3c], 0x1000);
    const read = romReader(img, 1);
    const s = findStart(read, 0x1009, 3);
    expect(disasmRange(read, s, 4).map((l) => l.addr)).toEqual([0x1003, 0x1004, 0x1006, 0x1009]);
    expect(findStart(read, 0x4000, 4)).toBe(0x4000); // no cruza a ROM0 desde ROMX
  });
});
