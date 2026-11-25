// Tests del ensamblador. No hay RGBDS disponible en el entorno: los bytes esperados están
// verificados a mano con la tabla de opcodes de Pan Docs y la semántica de rgbasm(5).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assemble, type AsmOptions } from "../../web/src/asm";

/** Ensambla en ROM0[$1000] y devuelve los bytes emitidos (hasta `n`). */
function code(src: string, n?: number, opts?: AsmOptions): number[] {
  const r = assemble(`SECTION "t", ROM0[$1000]\n${src}\n`, opts);
  expect(r.errors.map((e) => `${e.line}:${e.col} ${e.msg}`)).toEqual([]);
  const size = r.sections.find((s) => s.name === "t")!.size;
  return Array.from(r.rom.subarray(0x1000, 0x1000 + (n ?? size)));
}

/** Valor de una expresión, vía `dl`. */
function val(expr: string, pre = ""): number {
  const b = code(`${pre}\n dl ${expr}`);
  return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) | 0;
}

function errs(src: string, opts?: AsmOptions): string[] {
  return assemble(src, opts).errors.map((e) => e.msg);
}

describe("numbers and expressions", () => {
  it("parses all number formats", () => {
    expect(val("$FF")).toBe(255);
    expect(val("0x1F")).toBe(31);
    expect(val("%1010")).toBe(10);
    expect(val("0b11")).toBe(3);
    expect(val("&17")).toBe(15);
    expect(val("0o17")).toBe(15);
    expect(val("1_000")).toBe(1000);
    expect(val("$12_34")).toBe(0x1234);
  });

  it("encodes 2bpp graphics literals (low plane first, leftmost pixel = bit 7)", () => {
    // `01230123: plano bajo 0 1 0 1 0 1 0 1 = $55, plano alto 0 0 1 1 0 0 1 1 = $33.
    expect(code("dw `01230123")).toEqual([0x55, 0x33]);
    expect(code("dw `33333333")).toEqual([0xff, 0xff]);
  });

  it("follows RGBDS operator precedence", () => {
    expect(val("2 + 3 * 4")).toBe(14);
    expect(val("4 + 1 & 2")).toBe(4); // & va antes que +
    expect(val("1 << 2 + 1")).toBe(5); // << antes que +
    expect(val("2 ** 3 ** 2")).toBe(512); // ** asocia a la derecha
    expect(val("-2 ** 2")).toBe(4); // unario antes que **
    expect(val("1 + 2 == 3 && 2 < 1 || 1")).toBe(1);
    expect(val("~0")).toBe(-1);
    expect(val("!5")).toBe(0);
    expect(val("-7 / 2")).toBe(-4); // división entera hacia abajo
    expect(val("-7 % 2")).toBe(1);
    expect(val("$80000000 >> 4")).toBe(0xf8000000 | 0);
    expect(val("$80000000 >>> 4")).toBe(0x08000000);
    expect(val("HIGH($1234) + LOW($1234)")).toBe(0x12 + 0x34);
  });

  it("supports strings, STRLEN, DEF() and ISCONST()", () => {
    expect(val(`"A"`)).toBe(65);
    expect(val(`STRLEN("hola")`)).toBe(4);
    expect(val("DEF(X) * 10 + DEF(Y)", "DEF X EQU 1")).toBe(10);
    expect(val("ISCONST(3) + ISCONST(Fwd)")).toBe(1);
  });

  it("reports division by zero and undefined symbols", () => {
    expect(errs(`SECTION "a", ROM0\n db 1/0`)).toEqual(["division by zero"]);
    expect(errs(`SECTION "a", ROM0\n db Nope`)).toEqual(["undefined symbol 'Nope'"]);
  });
});

describe("symbols", () => {
  it("handles EQU, DEF, =, SET, compound assignment and REDEF", () => {
    const src = `
DEF A1 EQU 5
B1 EQU A1 * 2
DEF v = 1
v += 4
v SET v * 2
REDEF A1 EQU 7
 db A1, B1, v`;
    expect(code(src)).toEqual([7, 10, 10]);
  });

  it("rejects redefining a constant", () => {
    expect(errs(`DEF X EQU 1\nDEF X EQU 2`)[0]).toMatch(/already defined/);
    expect(errs(`DEF X EQU 1\nX = 2`)[0]).toMatch(/already defined as a constant/);
  });

  it("expands EQUS and {interpolation}", () => {
    const src = `
DEF REG EQUS "a"
DEF N EQU 3
 ld REG, N
 db {N} + 1
DEF NAME EQUS "lbl{d:N}"
{NAME}:
 jr {NAME}`;
    expect(code(src)).toEqual([0x3e, 3, 4, 0x18, 0xfe]);
  });

  it("supports RSRESET / RB / RW", () => {
    expect(code(`RSRESET\nDEF oA RB 1\nDEF oB RW 2\nDEF oC RB\n db oA, oB, oC, _RS`)).toEqual([0, 1, 5, 6]);
  });

  it("resolves local labels, Global.local and anonymous labels", () => {
    const src = `
Main:
.loop:
 jr .loop
Other:
 jp Main.loop
:
 jr :-
 jr :+
:
 db LOW(Other.x), 0
.x`;
    // Main=$1000 .loop=$1000 | Other=$1002: C3 00 10 | anon0=$1005: 18 FE | 18 00 | anon1=$1009
    expect(code(src)).toEqual([0x18, 0xfe, 0xc3, 0x00, 0x10, 0x18, 0xfe, 0x18, 0x00, 0x0b, 0x00]);
  });

  it("exports labels with bank and address", () => {
    const r = assemble(`SECTION "x", ROMX[$4100], BANK[3]\nStart:\n nop\n.l: nop`);
    expect(r.errors).toEqual([]);
    expect(r.symbols.get("Start")).toEqual({ bank: 3, addr: 0x4100 });
    expect(r.symbols.get("Start.l")).toEqual({ bank: 3, addr: 0x4101 });
    expect(r.rom.length).toBe(4 * 0x4000);
    expect(r.rom[3 * 0x4000 + 0x100]).toBe(0);
  });

  it("reports duplicate labels", () => {
    expect(errs(`SECTION "a", ROM0\nL:\nL:`)[0]).toMatch(/'L' already defined at main.asm:2/);
  });
});

describe("data directives", () => {
  it("DB/DW/DL with strings and expressions", () => {
    expect(code(`db "AB", 1, -1\n dw $1234, "C"\n dl $11223344`)).toEqual([
      0x41, 0x42, 1, 0xff, 0x34, 0x12, 0x43, 0x00, 0x44, 0x33, 0x22, 0x11,
    ]);
  });

  it("DS with and without fill", () => {
    expect(code(`ds 3\n ds 4, 1, 2\n db 9`)).toEqual([0, 0, 0, 1, 2, 1, 2, 9]);
  });

  it("CHARMAP with longest match", () => {
    expect(code(`CHARMAP "A", 1\nCHARMAP "AB", 9\nCHARMAP "<end>", $FF\n db "AAB<end>"`)).toEqual([1, 9, 0xff]);
  });

  it("checks value ranges", () => {
    expect(errs(`SECTION "a", ROM0\n db 256`)).toEqual(["value 256 does not fit in 8 bits"]);
    expect(errs(`SECTION "a", ROM0\n dw $10000`)).toEqual(["value 65536 does not fit in 16 bits"]);
  });

  it("INCLUDE and INCBIN from opts.files", () => {
    const files = new Map<string, string | Uint8Array>([
      ["inc/defs.inc", "DEF K EQU 42\n"],
      ["gfx.bin", new Uint8Array([1, 2, 3, 4, 5])],
    ]);
    expect(code(`INCLUDE "inc/defs.inc"\n db K\n incbin "gfx.bin", 1, 3\n incbin "gfx.bin"`, undefined, { files })).toEqual([
      42, 2, 3, 4, 1, 2, 3, 4, 5,
    ]);
    const r = assemble(`SECTION "a", ROM0\n incbin "nope.bin"`);
    expect(r.errors[0]).toMatchObject({ line: 2, msg: "file 'nope.bin' not found" });
  });

  it("INCLUDE via opts.include callback and errors carry the included file name", () => {
    const r = assemble(`SECTION "a", ROM0\nINCLUDE "x.inc"`, {
      include: (name) => (name === "x.inc" ? "nop\n db 999\n" : undefined),
    });
    expect(r.errors).toEqual([{ file: "x.inc", line: 2, col: 5, msg: "value 999 does not fit in 8 bits" }]);
  });
});

describe("instruction syntax variants", () => {
  it("accepts () and [] memory operands and HLI/HLD/LDI/LDD forms", () => {
    expect(code(`ld a,(hl)\n ld a,[hli]\n ld (hld),a\n ldi a,[hl]\n ldd [hl],a\n ld a,($C000)`)).toEqual([
      0x7e, 0x2a, 0x32, 0x2a, 0x32, 0xfa, 0x00, 0xc0,
    ]);
  });

  it("accepts LDH forms, [C] and [$FF00+C]", () => {
    expect(code(`ldh [$FF40],a\n ldh a,[$44]\n ld [c],a\n ldh a,[$FF00+c]\n ld [$FF00+C],a`)).toEqual([
      0xe0, 0x40, 0xf0, 0x44, 0xe2, 0xf2, 0xe2,
    ]);
    expect(errs(`SECTION "a", ROM0\n ldh a,[$1234]`)[0]).toMatch(/not in \$FF00-\$FFFF/);
  });

  it("parenthesised immediates are still immediates", () => {
    expect(code(`ld a,(1+2)*2\n add (4)`)).toEqual([0x3e, 6, 0xc6, 4]);
  });

  it("ALU short forms, JP [HL], LDHL, SP offsets, BIT/RST with expressions", () => {
    expect(code(`cp 5\n xor a\n jp [hl]\n ldhl sp,-1\n ld hl,sp-2\n add sp,$7F\n bit 1+2,a\n rst 8*7`)).toEqual([
      0xfe, 5, 0xaf, 0xe9, 0xf8, 0xff, 0xf8, 0xfe, 0xe8, 0x7f, 0xcb, 0x5f, 0xff,
    ]);
  });

  it("forward references in BIT/RST/JR are patched", () => {
    expect(code(`bit BN, [hl]\n rst V\n jr Fwd\n nop\nFwd:\nDEF BN EQU 7\nDEF V EQU $28`)).toEqual([
      0xcb, 0x7e, 0xef, 0x18, 0x01, 0x00,
    ]);
  });

  it("is case-insensitive for mnemonics, registers and directives", () => {
    expect(code(`LD A,B\n Ld hL,$1234\n DB 1`)).toEqual([0x78, 0x21, 0x34, 0x12, 1]);
  });

  it("reports bad operands, ranges and unknown mnemonics with column", () => {
    const r = assemble(`SECTION "a", ROM0[$0]\n ld [bc],b\n jr Far\n bit 8,a\n rst 3\n foo\nds $200\nFar:`);
    const msgs = r.errors.map((e) => `${e.line}:${e.col} ${e.msg}`).sort();
    expect(msgs).toEqual([
      "2:2 invalid operands for 'ld'",
      "3:5 JR target out of range (distance 515, must be -128..127)",
      "4:6 bit number 8 out of range (0-7)",
      "5:6 invalid RST vector $03 ($00, $08, … $38)",
      "6:2 unknown instruction, directive or macro 'foo'",
    ]);
    expect(r.rom.length).toBe(0);
  });
});

describe("macros and control flow", () => {
  it("expands macro arguments, \\@, _NARG and SHIFT", () => {
    const src = `
MACRO sum
  DEF acc = 0
  REPT _NARG
    DEF acc += \\1
    SHIFT
  ENDR
  db acc
ENDM
 sum 1, 2, 3
 sum 10
MACRO pair
  ld \\1, \\2
ENDM
 pair a, LOW($1203)
 pair a, (1+2)
 pair b, "\\,"`;
    // pair a, (1+2) → ld a,[3] (paréntesis completos = memoria); pair b, "," → ld b, 44
    expect(code(src)).toEqual([6, 10, 0x3e, 3, 0xfa, 3, 0, 0x06, 44]);
  });

  it("unique labels with \\@ inside macros", () => {
    const src = `
MACRO wait
.w\\@:
  dec a
  jr nz, .w\\@
ENDM
Top:
 wait
 wait`;
    expect(code(src)).toEqual([0x3d, 0x20, 0xfd, 0x3d, 0x20, 0xfd]);
  });

  it("IF / ELIF / ELSE / ENDC, nested and skipping invalid code", () => {
    const src = `
DEF M EQU 2
IF M == 1
  db 1
ELIF M == 2
  IF 0
    this is not valid code
  ELSE
    db 2
  ENDC
ELSE
  db 3
ENDC`;
    expect(code(src)).toEqual([2]);
  });

  it("REPT, FOR and BREAK", () => {
    expect(code(`REPT 3\n db 7\nENDR`)).toEqual([7, 7, 7]);
    expect(code(`FOR i, 4\n db i * 2\nENDR`)).toEqual([0, 2, 4, 6]);
    expect(code(`FOR i, 10, 0, -3\n db i\nENDR`)).toEqual([10, 7, 4, 1]);
    expect(code(`FOR i, 100\n IF i == 3\n BREAK\n ENDC\n db i\nENDR`)).toEqual([0, 1, 2]);
    expect(code(`REPT 2\n REPT 2\n db 1\n ENDR\n db 2\nENDR`)).toEqual([1, 1, 2, 1, 1, 2]);
  });

  it("errors inside macros point to the macro body line", () => {
    const r = assemble(`SECTION "a", ROM0\nMACRO bad\n  db \\1\nENDM\n bad 300`);
    expect(r.errors).toEqual([{ file: "main.asm", line: 3, col: 6, msg: "value 300 does not fit in 8 bits (in macro 'bad')" }]);
  });

  it("detects runaway recursion and unterminated blocks", () => {
    expect(errs(`MACRO r\n r\nENDM\n r`)[0]).toMatch(/recursion too deep/);
    expect(errs(`MACRO m\n nop`)).toEqual(["unterminated MACRO 'm' (missing ENDM)"]);
    expect(errs(`IF 1\n`)).toEqual(["unterminated IF (missing ENDC)"]);
    expect(errs(`REPT 2\n`)).toEqual(["unterminated REPT/FOR (missing ENDR)"]);
  });

  it("ASSERT (immediate and deferred), WARN, PRINTLN, FAIL", () => {
    const r = assemble(`
SECTION "a", ROM0
Start:
 ds 4
End:
ASSERT End - Start == 4
ASSERT WARN, Start == 1, "not one"
ASSERT Later == 3, "later"
PRINTLN "size=", End - Start
DEF Later EQU 2`);
    expect(r.errors.map((e) => [e.line, e.msg])).toEqual([[8, "assertion failed: later"]]);
    expect(r.warnings.map((e) => e.msg)).toEqual(["size=$4", "assertion failed: not one"]);
    expect(errs(`FAIL "boom"`)).toEqual(["boom"]);
  });
});

describe("sections and placement", () => {
  it("places fixed sections first, then floating ones by size, and reports the layout", () => {
    const r = assemble(`
SECTION "small", ROM0
 ds 2, $AA
SECTION "big", ROM0
 ds 16, $BB
SECTION "fixed", ROM0[$0000]
 ds 8, $CC
SECTION "x", ROMX
 db 1
SECTION "ram", WRAM0
Var: ds 2
SECTION "h", HRAM
hVar: ds 1
SECTION "w", WRAMX, BANK[2]
wVar: ds 1`);
    expect(r.errors).toEqual([]);
    expect(r.sections).toEqual([
      { name: "small", kind: "ROM0", bank: 0, addr: 0x18, size: 2 },
      { name: "big", kind: "ROM0", bank: 0, addr: 0x08, size: 16 },
      { name: "fixed", kind: "ROM0", bank: 0, addr: 0x00, size: 8 },
      { name: "x", kind: "ROMX", bank: 1, addr: 0x4000, size: 1 },
      { name: "ram", kind: "WRAM0", bank: 0, addr: 0xc000, size: 2 },
      { name: "h", kind: "HRAM", bank: 0, addr: 0xff80, size: 1 },
      { name: "w", kind: "WRAMX", bank: 2, addr: 0xd000, size: 1 },
    ]);
    expect(r.symbols.get("Var")).toEqual({ bank: 0, addr: 0xc000 });
    expect(r.symbols.get("wVar")).toEqual({ bank: 2, addr: 0xd000 });
    expect(r.rom.length).toBe(0x8000);
    expect(r.rom[0x18]).toBe(0xaa);
    expect(r.rom[0x4000]).toBe(1);
    expect(r.rom[0x4001]).toBe(0xff); // relleno
  });

  it("ROM size is the next power of two of the highest bank", () => {
    const r = assemble(`SECTION "a", ROMX, BANK[5]\n db 1`);
    expect(r.rom.length).toBe(8 * 0x4000);
    expect(r.rom[5 * 0x4000]).toBe(1);
    expect(assemble(`SECTION "a", ROMX, BANK[5]\n db 1`, { romBanks: 16 }).rom.length).toBe(16 * 0x4000);
  });

  it("floating ROMX sections spill into new banks", () => {
    const r = assemble(`SECTION "a", ROMX\n ds $3000\nSECTION "b", ROMX\n ds $3000`);
    expect(r.errors).toEqual([]);
    expect(r.sections.map((s) => s.bank)).toEqual([1, 2]);
    expect(r.rom.length).toBe(4 * 0x4000);
  });

  it("BANK(), SIZEOF(), STARTOF() and ALIGN", () => {
    const src = `
SECTION "code", ROM0
 db BANK(Far), BANK("far"), LOW(STARTOF("far")), HIGH(STARTOF("far")), SIZEOF("far"), BANK(@)
SECTION "far", ROMX, BANK[2], ALIGN[8]
Far: ds 3
SECTION "al", ROM0, ALIGN[4, 2]
 db 0`;
    const r = assemble(src);
    expect(r.errors).toEqual([]);
    const c = r.sections.find((s) => s.name === "code")!;
    expect(Array.from(r.rom.subarray(c.addr, c.addr + 6))).toEqual([2, 2, 0x00, 0x40, 3, 0]);
    expect(r.sections.find((s) => s.name === "al")!.addr & 15).toBe(2);
  });

  it("SECTION FRAGMENT, PUSHS/POPS and label differences across floating sections", () => {
    const r = assemble(`
SECTION FRAGMENT "f", ROM0
A: db 1
SECTION "o", ROM0
 db 9
PUSHS
SECTION "p", ROM0
 db B - A
POPS
 db 8
SECTION FRAGMENT "f", ROM0
B: db 2`);
    expect(r.errors).toEqual([]);
    const f = r.sections.find((s) => s.name === "f")!;
    const o = r.sections.find((s) => s.name === "o")!;
    const p = r.sections.find((s) => s.name === "p")!;
    expect(Array.from(r.rom.subarray(f.addr, f.addr + 2))).toEqual([1, 2]);
    expect(Array.from(r.rom.subarray(o.addr, o.addr + 2))).toEqual([9, 8]);
    expect(r.rom[p.addr]).toBe(1);
  });

  it("reports overlaps, overflow and invalid placements", () => {
    expect(errs(`SECTION "a", ROM0[$100]\n ds 16\nSECTION "b", ROM0[$108]\n ds 1`)).toEqual([
      "section 'b' ($0108-$0108) overlaps section 'a' ($0100-$010F)",
    ]);
    expect(errs(`SECTION "a", ROM0\n ds $4001`)).toEqual(["section 'a' is too big: 16385 bytes (ROM0 holds 16384)"]);
    expect(errs(`SECTION "a", ROM0[$3FFF]\n ds 2`)[0]).toMatch(/goes past the end of ROM0/);
    expect(errs(`SECTION "a", ROM0, BANK[1]`)).toEqual(["BANK[] is not allowed in ROM0 sections"]);
    expect(errs(`SECTION "a", ROMX[$1000]`)[0]).toMatch(/outside ROMX/);
    expect(errs(`SECTION "a", HRAM\n ds 128`)[0]).toMatch(/too big/);
    expect(errs(`SECTION "a", ROM0[0]\n ds $3000\nSECTION "b", ROM0\n ds $2000`)[0]).toMatch(
      /cannot place section 'b' \(8192 bytes\) in ROM0 — bank 0: 4096 free, largest block 4096/,
    );
    expect(errs(`SECTION "w", WRAM0\n nop`)[0]).toMatch(/not allowed in WRAM0/);
    expect(errs(` nop`)).toEqual(["not inside a section"]);
  });
});

describe("output contract", () => {
  it("lineMap maps every emitted line to bank:addr and length", () => {
    const r = assemble(`SECTION "a", ROMX[$4000], BANK[1]\n nop\n ld a,1\n\n db 1,2,3`, { file: "m.asm" });
    expect(r.lineMap).toEqual([
      { bank: 1, addr: 0x4000, line: 2, file: "m.asm", len: 1 },
      { bank: 1, addr: 0x4001, line: 3, file: "m.asm", len: 2 },
      { bank: 1, addr: 0x4003, line: 5, file: "m.asm", len: 3 },
    ]);
  });

  it("entry defaults to $0100 and can name a label", () => {
    expect(assemble(`SECTION "a", ROM0\n nop`).entry).toBe(0x100);
    expect(assemble(`SECTION "a", ROM0[$150]\nGo: nop`, { entry: "Go" }).entry).toBe(0x150);
    expect(errs(`SECTION "a", ROM0\n nop`, { entry: "Nope" })).toEqual(["entry label 'Nope' not found"]);
  });

  it("predefined symbols via opts.defines", () => {
    expect(code(`db N, STR`, undefined, { defines: { N: 5, STR: "6 + 1" } })).toEqual([5, 7]);
  });

  it("never throws and collects multiple errors", () => {
    const r = assemble(`garbage ###\n"unterminated\n ld a,\nSECTION`);
    expect(r.errors.length).toBe(4);
    expect(r.rom.length).toBe(0);
  });

  it("is deterministic", () => {
    const src = readFileSync(fileURLToPath(new URL("../../web/src/asm/examples/hello.asm", import.meta.url)), "utf8");
    const a = assemble(src);
    const b = assemble(src);
    expect(a.rom).toEqual(b.rom);
    expect(a.lineMap).toEqual(b.lineMap);
  });
});

describe("golden program (hand-verified bytes)", () => {
  it("assembles a small program to the expected image", () => {
    const src = `
DEF rLCDC EQU $FF40
SECTION "Entry", ROM0[$100]
  nop
  jp Main
  ds $150 - @, 0
Main:
  di
  ld sp, $FFFE
  xor a
  ldh [rLCDC], a
  ld hl, $C000
  ld b, 16
.clear:
  ld [hl+], a
  dec b
  jr nz, .clear
  call Sub
.end:
  jr .end
Sub:
  ld a, [Data]
  ret
Data:
  db $5A`;
    const r = assemble(src);
    expect(r.errors).toEqual([]);
    // $0100: 00 C3 50 01 | $0104-$014F: 00
    expect(Array.from(r.rom.subarray(0x100, 0x104))).toEqual([0x00, 0xc3, 0x50, 0x01]);
    expect(r.rom.subarray(0x104, 0x150).every((b) => b === 0)).toBe(true);
    // $0150 Main: F3 | $0151 31 FE FF | $0154 AF | $0155 E0 40 | $0157 21 00 C0 | $015A 06 10
    // $015C .clear: 22 | 05 | 20 FC (PC tras JR = $0160, $015C - $0160 = -4) | $0160 CD 65 01
    // $0163 .end: 18 FE | $0165 Sub: FA 69 01 | $0168 C9 | $0169 Data: 5A
    expect(Array.from(r.rom.subarray(0x150, 0x16a))).toEqual([
      0xf3, 0x31, 0xfe, 0xff, 0xaf, 0xe0, 0x40, 0x21, 0x00, 0xc0, 0x06, 0x10,
      0x22, 0x05, 0x20, 0xfc, 0xcd, 0x65, 0x01, 0x18, 0xfe, 0xfa, 0x69, 0x01, 0xc9, 0x5a,
    ]);
    expect(r.rom[0x16a]).toBe(0xff);
    expect(r.symbols.get("Main.clear")).toEqual({ bank: 0, addr: 0x15c });
    expect(r.rom.length).toBe(0x8000);
  });
});

describe("examples/hello.asm", () => {
  it("assembles cleanly into a 32 KB ROM with nop/jp at $0100", () => {
    const src = readFileSync(fileURLToPath(new URL("../../web/src/asm/examples/hello.asm", import.meta.url)), "utf8");
    const r = assemble(src, { file: "hello.asm" });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.rom.length).toBe(0x8000);
    const main = r.symbols.get("Main")!;
    expect(main.addr).toBe(0x150);
    expect(Array.from(r.rom.subarray(0x100, 0x104))).toEqual([0x00, 0xc3, 0x50, 0x01]);
    // La cabecera queda a cero para que el exportador la rellene.
    expect(r.rom.subarray(0x104, 0x150).every((b) => b === 0)).toBe(true);
    // El mensaje se codifica con el CHARMAP: H E L L O ␠ W O R L D ! + $FF.
    const msg = r.symbols.get("Message")!.addr;
    expect(Array.from(r.rom.subarray(msg, msg + 13))).toEqual([4, 3, 5, 5, 6, 0, 8, 6, 7, 5, 2, 1, 0xff]);
    // Blanco CGB = $7FFF (color 3 de la paleta).
    const pal = r.symbols.get("Palette")!.addr;
    expect([r.rom[pal + 6], r.rom[pal + 7]]).toEqual([0xff, 0x7f]);
  });
});
