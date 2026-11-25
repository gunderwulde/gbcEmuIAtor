// U1 · De ensamblador generado a líneas C. Lo esperado sale del contrato de cLineMap de
// web/src/cc/README.md (marca "; fichero:línea:" antes del código de cada línea C; las
// funciones, la librería y el runtime separados por línea vacía), escrito a mano.
import { describe, expect, it } from "vitest";
import { asmLineOwners, cLineOf, mapToC } from "../../../web/src/ui/tabs/srcmap";

const GEN = "(generado).asm";
const ASM = [
  "; crt0",                    // 1
  "    ld sp, $E000",          // 2
  "",                          // 3
  "_main:",                    // 4
  "; main.c:3: x = 1;",        // 5
  "    ld a, 1",               // 6
  "    ld [_x], a",            // 7
  "; util.h:2: return 2;",     // 8
  "    ld a, 2",               // 9
  "    ret",                   // 10
  "",                          // 11
  "lib_fill:",                 // 12
  "    ret",                   // 13
].join("\n");
const CMAP = [
  { file: "main.c", line: 3, asmLine: 5 },
  { file: "util.h", line: 2, asmLine: 8 },
];

describe("U1 srcmap", () => {
  it("cada línea es de la última marca hasta la siguiente o una línea vacía", () => {
    const o = asmLineOwners(ASM, CMAP);
    expect(Array.from(o.slice(1, 14))).toEqual([-1, -1, -1, -1, 0, 0, 0, 1, 1, 1, -1, -1, -1]);
    expect(cLineOf(o, CMAP, 7)).toEqual(CMAP[0]);
    expect(cLineOf(o, CMAP, 13)).toBeUndefined();
    expect(cLineOf(o, CMAP, 999)).toBeUndefined();
  });

  it("marcas fuera de rango se ignoran", () => {
    const o = asmLineOwners("a\nb", [{ file: "x.c", line: 1, asmLine: 50 }]);
    expect(Array.from(o.slice(1, 3))).toEqual([-1, -1]);
  });

  it("el lineMap del generado pasa a líneas C; lo demás se queda", () => {
    const lineMap = [
      { bank: 0, addr: 0x150, line: 2, file: GEN, len: 3 },
      { bank: 0, addr: 0x153, line: 6, file: GEN, len: 2 },
      { bank: 0, addr: 0x155, line: 7, file: GEN, len: 3 },
      { bank: 0, addr: 0x158, line: 9, file: GEN, len: 2 },
      { bank: 0, addr: 0x15a, line: 13, file: GEN, len: 1 },
      { bank: 1, addr: 0x4000, line: 4, file: "lib.asm", len: 1 },
    ];
    expect(mapToC(ASM, CMAP, lineMap, GEN)).toEqual([
      { bank: 0, addr: 0x150, line: 2, file: GEN, len: 3 },
      { bank: 0, addr: 0x153, line: 3, file: "main.c", len: 2 },
      { bank: 0, addr: 0x155, line: 3, file: "main.c", len: 3 },
      { bank: 0, addr: 0x158, line: 2, file: "util.h", len: 2 },
      { bank: 0, addr: 0x15a, line: 13, file: GEN, len: 1 },
      { bank: 1, addr: 0x4000, line: 4, file: "lib.asm", len: 1 },
    ]);
  });
});
