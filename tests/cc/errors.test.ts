// Errores del compilador: se informan con el fichero y la línea correctos, y los de
// tamaño (ROM0, banco, WRAM0) los da el compilador, no el ensamblador.
import { describe, expect, it } from "vitest";
import { compile, type CcError } from "../../web/src/cc";

const cc = (src: string | Map<string, string>, opts = {}) =>
  compile(typeof src === "string" ? new Map([["main.c", src]]) : src, { main: "main.c", ...opts });
const errs = (r: { errors: CcError[] }) => r.errors.filter((e) => e.severity === "error");
const first = (src: string | Map<string, string>, opts = {}) => {
  const e = errs(cc(src, opts));
  expect(e.length).toBeGreaterThan(0);
  return e[0]!;
};

describe("cc: errores con su línea", () => {
  it.each([
    // Como gcc y clang: falta el ';' al final de la línea 2.
    ["sintaxis", "void main(void) {\n  int a = 1\n  a++;\n}\n", 2],
    ["expresión incompleta", "void main(void) {\n  int a;\n  a = 3 *;\n}\n", 3],
    ["variable no declarada", "void main(void) {\n  int a;\n  a = b + 1;\n}\n", 3],
    ["tipos incompatibles", "struct s { int a; };\nvoid main(void) {\n  struct s x;\n  int y;\n  y = x;\n}\n", 5],
    ["llamada con argumentos de menos", "int f(int a, int b) { return a + b; }\nvoid main(void) {\n\n  f(1);\n}\n", 4],
    ["función usada y no definida", "int g(int);\nvoid main(void) {\n  g(2);\n}\n", 1],
    ["break fuera de bucle", "void main(void) {\n  break;\n}\n", 2],
    ["float no soportado", "void main(void) {\n  float f;\n}\n", 2],
    ["dos rutinas para la misma interrupción", "void a(void) __interrupt(vblank) {}\nvoid b(void) __interrupt(vblank) {}\nvoid main(void) {}\n", 2],
  ])("%s", (_, src, line) => {
    const e = first(src);
    expect(e.file).toBe("main.c");
    expect(e.line).toBe(line);
  });

  it("falta main", () => {
    expect(errs(cc("int x;\n")).some((e) => /main/.test(e.msg))).toBe(true);
  });

  it("error en un fichero incluido: fichero y línea del incluido", () => {
    const files = new Map([
      ["main.c", '#include "lib.h"\nvoid main(void) { f(); }\n'],
      ["lib.h", "/* cabecera */\nint f(void) { return 1 +; }\n"],
    ]);
    const e = first(files);
    expect(e.file).toBe("lib.h");
    expect(e.line).toBe(2);
  });

  it("llamada a una función de otro banco que no es __banked", () => {
    const files = new Map([
      ["main.c", "int far(void);\nvoid main(void) {\n  far();\n}\n"],
      ["b.c", "#pragma bank 3\nint far(void) { return 1; }\n"],
    ]);
    const e = first(files);
    expect(e.file).toBe("main.c");
    expect(e.line).toBe(3);
    expect(e.msg).toMatch(/banked|banco/);
  });

  it("una variable __at de una cabecera incluida por dos unidades da un solo DEF", () => {
    const files = new Map([
      ["a.h", "__at(0xFF26) volatile unsigned char rNR52;\n"],
      ["main.c", '#include "a.h"\n#pragma link "b.c"\nvoid f(void);\nint main(void) { rNR52 = 0x80; f(); return 0; }\n'],
      ["b.c", '#include "a.h"\nvoid f(void) { rNR52 = 0; }\n'],
    ]);
    const r = cc(files);
    expect(errs(r)).toEqual([]);
    expect(r.asm.match(/^\s*DEF\s+_rNR52\b/gm)?.length).toBe(1);
    // Un extern en una unidad y el __at en otra: también un solo DEF.
    const ext = new Map(files);
    ext.set("main.c", '#pragma link "b.c"\nextern volatile unsigned char rNR52;\nvoid f(void);\nint main(void) { rNR52 = 0x80; f(); return 0; }\n');
    const r2 = cc(ext);
    expect(errs(r2)).toEqual([]);
    expect(r2.asm.match(/^\s*DEF\s+_rNR52\s+EQU\s+\$FF26/gim)?.length).toBe(1);
    // Dos __at con el mismo nombre y direcciones distintas sí es un error.
    const bad = new Map(files);
    bad.set("b.c", "__at(0xFF25) volatile unsigned char rNR52;\nvoid f(void) { rNR52 = 0; }\n");
    expect(errs(cc(bad)).length).toBeGreaterThan(0);
  });

  it("__interrupt definida tras #pragma bank", () => {
    const e = first("#pragma bank 2\nvoid v(void) __interrupt(vblank) {}\nvoid main(void) {}\n");
    expect(e.line).toBe(2);
  });
});

describe("cc: tamaños (error del compilador, no del ensamblador)", () => {
  it("WRAM0 llena: señala la variable que no cabe, con el desglose", () => {
    const src = "unsigned char a[1000];\nunsigned char b[1000];\nunsigned char c[1500];\nvoid main(void) { a[0] = b[0] + c[0]; }\n";
    const e = first(src);
    expect(e.line).toBe(3); // 160 + 1000 + 1000 + 512 de pila = 2672; con c, 4172 > 4096
    expect(e.msg).toMatch(/WRAM0/);
    expect(e.msg).toMatch(/BSS 3500/);
    // Con menos pila, cabe.
    expect(errs(cc(src, { stackSize: 256 }))).toEqual([]);
  });

  it("ROM0 llena: señala el dato que no cabe", () => {
    const big = Array.from({ length: 9000 }, (_, i) => i & 255).join(",");
    const src = `const unsigned char t1[9000] = {${big}};\nconst unsigned char t2[9000] = {${big}};\nvoid main(void) { }\nint use(void) { return t1[0] + t2[0]; }\n`;
    // use() no es alcanzable: t1 y t2 no se emiten y cabe.
    expect(errs(cc(src))).toEqual([]);
    const src2 = src.replace("void main(void) { }", "int use(void);\nvoid main(void) { use(); }");
    const e = first(src2);
    expect(e.line).toBe(2);
    expect(e.msg).toMatch(/ROM0/);
  });

  it("banco lleno", () => {
    const big = Array.from({ length: 9000 }, () => 1).join(",");
    const files = new Map([
      ["main.c", "int __banked g(void);\nvoid main(void) { g(); }\n"],
      ["b.c", `#pragma bank 1\nconst unsigned char t1[9000] = {${big}};\nconst unsigned char t2[9000] = {${big}};\nint __banked g(void) { return t1[0] + t2[0]; }\n`],
    ]);
    const e = first(files);
    expect(e.file).toBe("b.c");
    expect(e.msg).toMatch(/banco 1/);
  });
});
