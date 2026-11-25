// Cada entrada de la tabla SM83 se ensambla y se compara con una referencia escrita a mano,
// independiente de la tabla: texto de ensamblador → bytes y ciclos M, copiados de la tabla de
// opcodes de Pan Docs (gbdev.io/gb-opcodes). Los bloques regulares 40–BF y CB se derivan con
// la fórmula documentada (ver más abajo), no con la tabla bajo prueba.
import { describe, expect, it } from "vitest";
import { assemble } from "../../web/src/asm";
import { BASE_OPS, CB_OPS, ILLEGAL_OPCODES, OPS, cbOpByByte, decode, opByByte } from "../../web/src/sm83isa";

// Se ensambla en ROM0[$1000]; los destinos de JR son absolutos ($1000 → desplazamiento -2).
// "texto | bytes hex | ciclos M (con salto/sin salto)"
const HAND = `
nop | 00 | 1
ld bc,$1234 | 01 34 12 | 3
ld [bc],a | 02 | 2
inc bc | 03 | 2
inc b | 04 | 1
dec b | 05 | 1
ld b,$12 | 06 12 | 2
rlca | 07 | 1
ld [$1234],sp | 08 34 12 | 5
add hl,bc | 09 | 2
ld a,[bc] | 0A | 2
dec bc | 0B | 2
inc c | 0C | 1
dec c | 0D | 1
ld c,$12 | 0E 12 | 2
rrca | 0F | 1
stop | 10 00 | 1
ld de,$1234 | 11 34 12 | 3
ld [de],a | 12 | 2
inc de | 13 | 2
inc d | 14 | 1
dec d | 15 | 1
ld d,$12 | 16 12 | 2
rla | 17 | 1
jr $1000 | 18 FE | 3
add hl,de | 19 | 2
ld a,[de] | 1A | 2
dec de | 1B | 2
inc e | 1C | 1
dec e | 1D | 1
ld e,$12 | 1E 12 | 2
rra | 1F | 1
jr nz,$1000 | 20 FE | 3/2
ld hl,$1234 | 21 34 12 | 3
ld [hl+],a | 22 | 2
inc hl | 23 | 2
inc h | 24 | 1
dec h | 25 | 1
ld h,$12 | 26 12 | 2
daa | 27 | 1
jr z,$1000 | 28 FE | 3/2
add hl,hl | 29 | 2
ld a,[hl+] | 2A | 2
dec hl | 2B | 2
inc l | 2C | 1
dec l | 2D | 1
ld l,$12 | 2E 12 | 2
cpl | 2F | 1
jr nc,$1000 | 30 FE | 3/2
ld sp,$1234 | 31 34 12 | 3
ld [hl-],a | 32 | 2
inc sp | 33 | 2
inc [hl] | 34 | 3
dec [hl] | 35 | 3
ld [hl],$12 | 36 12 | 3
scf | 37 | 1
jr c,$1000 | 38 FE | 3/2
add hl,sp | 39 | 2
ld a,[hl-] | 3A | 2
dec sp | 3B | 2
inc a | 3C | 1
dec a | 3D | 1
ld a,$12 | 3E 12 | 2
ccf | 3F | 1
ret nz | C0 | 5/2
pop bc | C1 | 3
jp nz,$1234 | C2 34 12 | 4/3
jp $1234 | C3 34 12 | 4
call nz,$1234 | C4 34 12 | 6/3
push bc | C5 | 4
add a,$12 | C6 12 | 2
rst $00 | C7 | 4
ret z | C8 | 5/2
ret | C9 | 4
jp z,$1234 | CA 34 12 | 4/3
call z,$1234 | CC 34 12 | 6/3
call $1234 | CD 34 12 | 6
adc a,$12 | CE 12 | 2
rst $08 | CF | 4
ret nc | D0 | 5/2
pop de | D1 | 3
jp nc,$1234 | D2 34 12 | 4/3
call nc,$1234 | D4 34 12 | 6/3
push de | D5 | 4
sub a,$12 | D6 12 | 2
rst $10 | D7 | 4
ret c | D8 | 5/2
reti | D9 | 4
jp c,$1234 | DA 34 12 | 4/3
call c,$1234 | DC 34 12 | 6/3
sbc a,$12 | DE 12 | 2
rst $18 | DF | 4
ldh [$FF12],a | E0 12 | 3
pop hl | E1 | 3
ldh [c],a | E2 | 2
push hl | E5 | 4
and a,$12 | E6 12 | 2
rst $20 | E7 | 4
add sp,-2 | E8 FE | 4
jp hl | E9 | 1
ld [$1234],a | EA 34 12 | 4
xor a,$12 | EE 12 | 2
rst $28 | EF | 4
ldh a,[$FF12] | F0 12 | 3
pop af | F1 | 3
ldh a,[c] | F2 | 2
di | F3 | 1
push af | F5 | 4
or a,$12 | F6 12 | 2
rst $30 | F7 | 4
ld hl,sp+5 | F8 05 | 3
ld sp,hl | F9 | 2
ld a,[$1234] | FA 34 12 | 4
ei | FB | 1
cp a,$12 | FE 12 | 2
rst $38 | FF | 4
`;

interface Ref {
  text: string;
  bytes: number[];
  cycles: number;
  notTaken: number;
}

const REG = ["b", "c", "d", "e", "h", "l", "[hl]", "a"];
const ALU = ["add a,", "adc a,", "sub a,", "sbc a,", "and a,", "xor a,", "or a,", "cp a,"];

function reference(): Map<number, Ref> {
  const m = new Map<number, Ref>();
  for (const line of HAND.trim().split("\n")) {
    const [text, hex, cyc] = line.split("|").map((s) => s.trim()) as [string, string, string];
    const bytes = hex.split(" ").map((h) => parseInt(h, 16));
    const [c, nt] = cyc.split("/").map(Number) as [number, number | undefined];
    m.set(bytes[0]!, { text, bytes, cycles: c, notTaken: nt ?? c });
  }
  // Pan Docs: 01 ddd sss = LD r[ddd],r[sss] (01 110 110 = HALT); acceso a [HL] = 2 ciclos M.
  for (let d = 0; d < 8; d++) {
    for (let s = 0; s < 8; s++) {
      const op = 0x40 | (d << 3) | s;
      if (op === 0x76) { m.set(op, { text: "halt", bytes: [op], cycles: 1, notTaken: 1 }); continue; }
      const c = d === 6 || s === 6 ? 2 : 1;
      m.set(op, { text: `ld ${REG[d]},${REG[s]}`, bytes: [op], cycles: c, notTaken: c });
    }
  }
  // 10 ooo sss = ALU[ooo] A,r[sss].
  for (let o = 0; o < 8; o++) {
    for (let s = 0; s < 8; s++) {
      const op = 0x80 | (o << 3) | s;
      const c = s === 6 ? 2 : 1;
      m.set(op, { text: `${ALU[o]}${REG[s]}`, bytes: [op], cycles: c, notTaken: c });
    }
  }
  return m;
}

function cbReference(op: number): Ref {
  // CB xx: 00 ooo rrr = rotación/desplazamiento ooo (RLC RRC RL RR SLA SRA SWAP SRL);
  // 01 bbb rrr = BIT b; 10 = RES b; 11 = SET b. r = B C D E H L [HL] A.
  // Ciclos M: 2 con registro; [HL]: 4, salvo BIT b,[HL] = 3 (sólo lee).
  const ROT = ["rlc", "rrc", "rl", "rr", "sla", "sra", "swap", "srl"];
  const r = op & 7;
  const y = (op >> 3) & 7;
  const grp = op >> 6;
  const text = grp === 0 ? `${ROT[y]} ${REG[r]}` : `${["", "bit", "res", "set"][grp]} ${y},${REG[r]}`;
  const cycles = r !== 6 ? 2 : grp === 1 ? 3 : 4;
  return { text, bytes: [0xcb, op], cycles, notTaken: cycles };
}

function asmOne(text: string): { bytes: number[]; errors: string[] } {
  const res = assemble(`SECTION "t", ROM0[$1000]\n ${text}\n`);
  const len = res.lineMap.find((l) => l.addr === 0x1000)?.len ?? 0;
  return { bytes: Array.from(res.rom.subarray(0x1000, 0x1000 + len)), errors: res.errors.map((e) => e.msg) };
}

describe("SM83 instruction table", () => {
  const ref = reference();

  it("has 244 valid base opcodes, 256 CB opcodes and 11 illegal ones", () => {
    expect(ref.size).toBe(244);
    expect(BASE_OPS.filter(Boolean).length).toBe(244);
    expect(CB_OPS.length).toBe(256);
    expect(OPS.length).toBe(500);
    expect([...ILLEGAL_OPCODES].sort((a, b) => a - b)).toEqual([0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd]);
    for (let b = 0; b < 256; b++) {
      expect(opByByte(b) !== undefined, `opcode ${b.toString(16)}`).toBe(ref.has(b));
      expect(cbOpByByte(b)?.opcode).toBe(b);
    }
  });

  it("matches the hand reference in length and M-cycles", () => {
    for (const [code, r] of ref) {
      const op = opByByte(code)!;
      expect({ op: code, len: op.length, c: op.cycles, nt: op.cyclesNotTaken }).toEqual({
        op: code, len: r.bytes.length, c: r.cycles, nt: r.notTaken,
      });
    }
    for (let b = 0; b < 256; b++) {
      const r = cbReference(b);
      const op = cbOpByByte(b)!;
      expect({ op: b, len: op.length, c: op.cycles }).toEqual({ op: b, len: 2, c: r.cycles });
    }
  });

  it("assembles every base opcode to the reference bytes", () => {
    for (const [code, r] of ref) {
      const got = asmOne(r.text);
      expect({ text: r.text, errors: got.errors, bytes: got.bytes }).toEqual({ text: r.text, errors: [], bytes: r.bytes });
      expect(code).toBe(r.bytes[0]);
    }
  });

  it("assembles every CB opcode to the reference bytes", () => {
    for (let b = 0; b < 256; b++) {
      const r = cbReference(b);
      const got = asmOne(r.text);
      expect({ text: r.text, errors: got.errors, bytes: got.bytes }).toEqual({ text: r.text, errors: [], bytes: r.bytes });
    }
  });

  it("canonical syntax of every entry round-trips through the assembler", () => {
    // Sustituye los marcadores de operando de la sintaxis canónica por valores concretos.
    for (const op of OPS) {
      const text = op.syntax
        .replace("[n16]", "[$C123]").replace("n16", "$1234").replace("[a8]", "[$FF80]")
        .replace("SP+e8", "SP+3").replace("e8", op.mnemonic === "JR" ? "$1002" : "3").replace("n8", "$12");
      const got = asmOne(text);
      expect(got.errors, op.syntax).toEqual([]);
      expect(got.bytes[0], op.syntax).toBe(op.prefix ? 0xcb : op.opcode);
      if (op.prefix) expect(got.bytes[1], op.syntax).toBe(op.opcode);
      expect(got.bytes.length, op.syntax).toBe(op.length);
    }
  });

  it("decode() finds base and CB entries by byte", () => {
    expect(decode(new Uint8Array([0xcb, 0x7e]), 0)?.syntax).toBe("BIT 7,[HL]");
    expect(decode(new Uint8Array([0xfa, 0, 0]), 0)?.syntax).toBe("LD A,[n16]");
    expect(decode(new Uint8Array([0xd3]), 0)).toBeUndefined();
  });
});
