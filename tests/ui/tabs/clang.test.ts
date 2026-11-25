// U1 · Resaltado de C. Lo esperado es la clasificación léxica de C99 (palabras clave,
// tipos, preprocesador, literales, comentarios) y las extensiones de web/src/cc/README.md.
import { StringStream } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { C_BUILTINS, cParser, libNames, type CState } from "../../../web/src/ui/tabs/clang";

/** [texto, estilo] de cada token no vacío de cada línea (estado compartido entre líneas). */
function tokens(src: string): Array<Array<[string, string | null]>> {
  const st: CState = cParser.startState!(4);
  return src.split("\n").map((line) => {
    const out: Array<[string, string | null]> = [];
    if (line === "") { cParser.blankLine?.(st, 4); return out; }
    const s = new StringStream(line, 4, 4);
    while (!s.eol()) {
      const style = cParser.token(s, st);
      const text = s.current();
      if (text.trim() !== "") out.push([text, style]);
      s.start = s.pos;
    }
    return out;
  });
}
const one = (line: string) => tokens(line)[0]!;

describe("U1 resaltado de C", () => {
  it("declaración con tipos, palabras clave, números y puntuación", () => {
    expect(one("static const unsigned char t[2] = { 0x1F, 7 };")).toEqual([
      ["static", "keyword"], ["const", "keyword"], ["unsigned", "typeName"], ["char", "typeName"],
      ["t", "variableName"], ["[", "bracket"], ["2", "number"], ["]", "bracket"], ["=", "operator"],
      ["{", "bracket"], ["0x1F", "number"], [",", "punctuation"], ["7", "number"], ["}", "bracket"],
      [";", "punctuation"],
    ]);
  });

  it("llamadas, cadenas y caracteres con escapes", () => {
    expect(one('dibuja("a\\"b", \'\\n\');')).toEqual([
      ["dibuja", "variableName.function"], ["(", "bracket"], ['"a\\"b"', "string"], [",", "punctuation"],
      ["'\\n'", "character"], [")", "bracket"], [";", "punctuation"],
    ]);
    expect(one('x = "sin cerrar')).toContainEqual(['"sin cerrar', "invalid"]);
  });

  it("números inválidos (sin float)", () => {
    expect(one("1.5")[0]).toEqual(["1.5", "invalid"]);
    expect(one("0x1G")[0]).toEqual(["0x1G", "invalid"]);
    expect(one("10u")[0]).toEqual(["10u", "number"]);
    expect(one("0b101")[0]).toEqual(["0b101", "number"]);
  });

  it("preprocesador: directiva, <cabecera>, macros y continuación con \\", () => {
    const t = tokens('#include <gbc.h>\n  # define SQR(x) \\\n  ((x) * (x))\nint y;');
    expect(t[0]).toEqual([["#include", "meta"], ["<gbc.h>", "string"]]);
    expect(t[1]!.slice(0, 2)).toEqual([["# define", "meta"], ["SQR", "macroName"]]);
    expect(t[2]).toContainEqual(["x", "macroName"]); // sigue siendo preprocesador
    expect(t[3]).toEqual([["int", "typeName"], ["y", "variableName"], [";", "punctuation"]]);
  });

  it("comentarios de línea y de bloque que cruzan líneas", () => {
    const t = tokens("a /* uno\ndos */ b // fin");
    expect(t[0]).toEqual([["a", "variableName"], ["/* uno", "comment"]]);
    expect(t[1]).toEqual([["dos */", "comment"], ["b", "variableName"], ["// fin", "comment"]]);
  });

  it("extensiones de la GB y __asm … __endasm", () => {
    expect(one("__at(0xFF40) unsigned char LCDC;").slice(0, 2)).toEqual([["__at", "keyword"], ["(", "bracket"]]);
    const t = tokens("__asm\n  ld a, 1 ; uno\n__endasm;");
    expect(t[0]).toEqual([["__asm", "keyword"]]);
    expect(t[1]).toEqual([["ld a, 1 ", "string.special"], ["; uno", "comment"]]);
    expect(t[2]).toEqual([["__endasm", "keyword"], [";", "punctuation"]]);
  });

  it("las funciones de la librería de L1 se resaltan aparte", () => {
    if (C_BUILTINS.size === 0) return; // L1 aún sin cabeceras
    const f = [...C_BUILTINS][0]!;
    expect(one(`${f}();`)[0]).toEqual([f, "variableName.standard"]);
  });

  it("nombres de la librería sacados de las cabeceras", () => {
    const n = libNames(new Map([
      ["gbc.h", "#ifndef GBC_H\n#define GBC_H\n#define J_START 0x80\n/* void nada(void); */\nvoid wait_vbl(void);\nunsigned char joypad(void);\n#endif"],
      ["x.c", "void no_es_cabecera(void);"],
    ]));
    expect([...n.funcs].sort()).toEqual(["joypad", "wait_vbl"]);
    expect([...n.consts]).toEqual(["J_START"]);
  });
});
