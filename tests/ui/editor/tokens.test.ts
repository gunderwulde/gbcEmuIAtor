// I1 · Tokenizador de resaltado SM83/RGBDS. Lo esperado es la clasificación de rgbasm(5):
// qué es etiqueta, instrucción, directiva, registro, condición, número… en cada posición.
import { describe, expect, it } from "vitest";
import { MNEMONICS, TOK, startState, token, tokenizeLine } from "../../../web/src/ui/editor/sm83-tokens";
import { EXAMPLES } from "../../../web/src/ui/editor/examples";

const tk = (line: string) => tokenizeLine(line);

describe("I1 tokenizador SM83", () => {
  it("los mnemónicos vienen de sm83isa", () => {
    for (const m of ["LD", "LDH", "JR", "BIT", "SWAP", "HALT", "STOP", "RETI", "DAA", "LDI", "LDHL"])
      expect(MNEMONICS.has(m)).toBe(true);
    expect(MNEMONICS.has("MOV")).toBe(false);
  });

  it("instrucción con registros e inmediato", () => {
    expect(tk("    ld a, [hl+]")).toEqual([
      ["ld", TOK.mnemonic], ["a", TOK.register], [",", TOK.separator],
      ["[", TOK.bracket], ["hl", TOK.register], ["+", TOK.operator], ["]", TOK.bracket],
    ]);
    expect(tk("\tLDH [C], A")).toEqual([
      ["LDH", TOK.mnemonic], ["[", TOK.bracket], ["C", TOK.register], ["]", TOK.bracket],
      [",", TOK.separator], ["A", TOK.register],
    ]);
  });

  it("condiciones sólo como primer operando de saltos; `c` es registro en otro caso", () => {
    expect(tk("  jr c, .loop")).toEqual([
      ["jr", TOK.mnemonic], ["c", TOK.condition], [",", TOK.separator], [".loop", TOK.label],
    ]);
    expect(tk("  ret nz")).toEqual([["ret", TOK.mnemonic], ["nz", TOK.condition]]);
    expect(tk("  jp hl")).toEqual([["jp", TOK.mnemonic], ["hl", TOK.register]]);
    expect(tk("  ld c, b")).toEqual([
      ["ld", TOK.mnemonic], ["c", TOK.register], [",", TOK.separator], ["b", TOK.register],
    ]);
  });

  it("números: $, 0x, %, 0b, &, 0o, decimales y gráficos `", () => {
    const nums = tk("  db $FF, 0x1f, %1010, 0b11, &17, 0o7, 123, 1_000");
    expect(nums.filter(([, t]) => t === TOK.number).map(([s]) => s))
      .toEqual(["$FF", "0x1f", "%1010", "0b11", "&17", "0o7", "123", "1_000"]);
    expect(tk("  dw `01233210")).toEqual([["dw", TOK.directive], ["`01233210", TOK.gfx]]);
  });

  it("% y & tras un valor son operadores (módulo y AND)", () => {
    expect(tk("  db 10 % 3, X & 1")).toEqual([
      ["db", TOK.directive], ["10", TOK.number], ["%", TOK.operator], ["3", TOK.number],
      [",", TOK.separator], ["X", TOK.label], ["&", TOK.operator], ["1", TOK.number],
    ]);
  });

  it("etiquetas globales, exportadas, locales y anónimas", () => {
    expect(tk("Main:")).toEqual([["Main:", TOK.labelDef]]);
    expect(tk("Main::  nop")).toEqual([["Main::", TOK.labelDef], ["nop", TOK.mnemonic]]);
    expect(tk(".loop:")).toEqual([[".loop:", TOK.localLabelDef]]);
    expect(tk(".loop")).toEqual([[".loop", TOK.localLabelDef]]);
    expect(tk("Main.loop: inc a")).toEqual([["Main.loop:", TOK.localLabelDef], ["inc", TOK.mnemonic], ["a", TOK.register]]);
    expect(tk("  indented: ret")).toEqual([["indented:", TOK.labelDef], ["ret", TOK.mnemonic]]);
    expect(tk(":")).toEqual([[":", TOK.labelDef]]);
    expect(tk("  jr :-")).toEqual([["jr", TOK.mnemonic], [":-", TOK.label]]);
    expect(tk("  call Main.loop")).toEqual([["call", TOK.mnemonic], ["Main.loop", TOK.label]]);
  });

  it("constantes: DEF x EQU, x EQU, x = y", () => {
    expect(tk("DEF rLY EQU $FF44 ; LY")).toEqual([
      ["DEF", TOK.directive], ["rLY", TOK.constDef], ["EQU", TOK.directive], ["$FF44", TOK.number], ["; LY", TOK.comment],
    ]);
    expect(tk("SIZE equ 16")).toEqual([["SIZE", TOK.constDef], ["equ", TOK.directive], ["16", TOK.number]]);
    expect(tk("n = n + 1")).toEqual([
      ["n", TOK.constDef], ["=", TOK.operator], ["n", TOK.label], ["+", TOK.operator], ["1", TOK.number],
    ]);
  });

  it("macros: definición, argumentos \\1, \\@, _NARG y llamada", () => {
    expect(tk("MACRO rgb")).toEqual([["MACRO", TOK.directive], ["rgb", TOK.macroDef]]);
    expect(tk("    dw (\\1) | (\\2) << 5")).toEqual([
      ["dw", TOK.directive], ["(", TOK.paren], ["\\1", TOK.macroArg], [")", TOK.paren], ["|", TOK.operator],
      ["(", TOK.paren], ["\\2", TOK.macroArg], [")", TOK.paren], ["<<", TOK.operator], ["5", TOK.number],
    ]);
    expect(tk("    rgb 31, 0, 0")).toEqual([
      ["rgb", TOK.macroCall], ["31", TOK.number], [",", TOK.separator], ["0", TOK.number], [",", TOK.separator], ["0", TOK.number],
    ]);
    expect(tk("  IF _NARG > 1")).toEqual([["IF", TOK.directive], ["_NARG", TOK.macroArg], [">", TOK.operator], ["1", TOK.number]]);
    expect(tk(".l\\@:")[0]![1]).toBe(TOK.localLabelDef);
  });

  it("secciones, funciones, cadenas y comentarios", () => {
    expect(tk('SECTION "Entry", ROM0[$100]')).toEqual([
      ["SECTION", TOK.directive], ['"Entry"', TOK.string], [",", TOK.separator], ["ROM0", TOK.sectionType],
      ["[", TOK.bracket], ["$100", TOK.number], ["]", TOK.bracket],
    ]);
    expect(tk('SECTION "x", ROMX, BANK[2]').map(([s, t]) => `${s}:${t}`)).toContain(`BANK:${TOK.sectionType}`);
    expect(tk("  ld a, HIGH(Data)")).toEqual([
      ["ld", TOK.mnemonic], ["a", TOK.register], [",", TOK.separator], ["HIGH", TOK.fn],
      ["(", TOK.paren], ["Data", TOK.label], [")", TOK.paren],
    ]);
    expect(tk('  db "a\\"b", 0 /* c */ ; d')).toEqual([
      ["db", TOK.directive], ['"a\\"b"', TOK.string], [",", TOK.separator], ["0", TOK.number],
      ["/* c */", TOK.comment], ["; d", TOK.comment],
    ]);
    expect(tk("  ds $150 - @, 0")).toEqual([
      ["ds", TOK.directive], ["$150", TOK.number], ["-", TOK.operator], ["@", TOK.here], [",", TOK.separator], ["0", TOK.number],
    ]);
  });

  it("el estado se reinicia en cada línea", () => {
    const st = startState();
    tokenizeLine("  ld a, b", st);
    expect(tokenizeLine("  jr c, x", st)[1]).toEqual(["c", TOK.condition]);
    expect(tokenizeLine("Label:", st)).toEqual([["Label:", TOK.labelDef]]);
  });

  it("avanza siempre y no deja texto sin clasificar en los ejemplos", () => {
    for (const ex of EXAMPLES) {
      const st = startState();
      for (const line of ex.source.split(/\r?\n/)) {
        const s = { string: line, pos: 0 };
        while (s.pos < line.length) {
          const from = s.pos;
          const t = token(s, st);
          expect(s.pos).toBeGreaterThan(from);
          if (t === null) expect(line.slice(from, s.pos).trim()).toBe("");
        }
      }
    }
  });
});
