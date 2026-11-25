// I1 · Errores del ensamblador → subrayados del editor, en la línea, columna y fichero
// que da el ensamblador (A1, columnas 1-based).
import { describe, expect, it } from "vitest";
import { assemble } from "../../../web/src/asm";
import { otherFileErrors, textLines, toDiagnostics } from "../../../web/src/ui/editor/diagnostics";

const SRC = [
  'SECTION "a", ROM0[$150]',   // 1
  "Main:",                       // 2
  "    ld a, 300",               // 3
  "    frob b",                  // 4
  '    INCLUDE "defs.inc"',      // 5
  "    jp Main ; fin",           // 6
].join("\n");

describe("I1 diagnósticos", () => {
  const files = new Map([["defs.inc", "    ld b, 999\n"]]);
  const r = assemble(SRC, { file: "main.asm", files });

  it("el ensamblador da los errores esperados (premisa)", () => {
    expect(r.errors.map((e) => `${e.file}:${e.line}`).sort()).toEqual(["defs.inc:1", "main.asm:3", "main.asm:4"]);
  });

  it("subraya en la línea correcta y sólo los del fichero actual", () => {
    const doc = textLines(SRC);
    const d = toDiagnostics(doc, "main.asm", r.errors);
    expect(d).toHaveLength(2);
    const texts = d.map((x) => SRC.slice(x.from, x.to));
    const lineOf = (pos: number) => SRC.slice(0, pos).split("\n").length;
    expect(d.map((x) => lineOf(x.from)).sort()).toEqual([3, 4]);
    for (const x of d) {
      expect(x.severity).toBe("error");
      expect(x.to).toBeGreaterThan(x.from);
    }
    expect(texts.some((t) => t.includes("300") || t === "ld")).toBe(true);
    expect(texts.some((t) => t.includes("frob") || t === "b")).toBe(true);
    // Los del INCLUDE, en su propio fichero.
    const inc = toDiagnostics(textLines("    ld b, 999\n"), "defs.inc", r.errors);
    expect(inc).toHaveLength(1);
    expect(otherFileErrors("main.asm", r.errors).map((e) => e.file)).toEqual(["defs.inc"]);
  });

  it("columna → palabra; sin columna → la línea sin sangría ni comentario", () => {
    const src = "a\n  ld  foo, 1 ; x\nz";
    const doc = textLines(src);
    const [byCol] = toDiagnostics(doc, "f", [{ file: "f", line: 2, col: 7, msg: "m" }]);
    expect(src.slice(byCol!.from, byCol!.to)).toBe("foo");
    const [noCol] = toDiagnostics(doc, "f", [{ file: "f", line: 2, col: 0, msg: "m" }]);
    expect(src.slice(noCol!.from, noCol!.to)).toBe("ld  foo, 1");
    const [past] = toDiagnostics(doc, "f", [{ file: "f", line: 99, col: 1, msg: "m" }]);
    expect(src.slice(past!.from, past!.to)).toBe("z"); // se recorta a la última línea
  });

  it("avisos como warnings y CRLF", () => {
    const src = "x\r\n  WARN \"ojo\"\r\n";
    const w = assemble(src, { file: "w.asm" });
    const d = toDiagnostics(textLines(src), "w.asm", w.errors, w.warnings);
    expect(d.some((x) => x.severity === "warning")).toBe(true);
    for (const x of d) expect(src.slice(x.from, x.to)).not.toMatch(/[\r\n]/);
  });
});
