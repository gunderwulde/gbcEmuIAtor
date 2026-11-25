// I1 · Línea de estado tras construir.
import { describe, expect, it } from "vitest";
import { buildStatus } from "../../../web/src/ui/editor/status";
import { build } from "../../../web/src/ui/run";

describe("I1 línea de estado", () => {
  const OK = 'SECTION "e", ROM0[$100]\n    nop\n    jp $150\n    ds $150 - @, 0\n    halt\n';

  it("sin errores: tamaño de la ROM y tiempo", () => {
    const s = buildStatus(build(OK), "main.asm");
    expect(s.level).toBe("ok");
    expect(s.text).toMatch(/^Sin errores · ROM 32 KB · [\d.]+ ms$/);
  });

  it("con errores: número, línea del primero y mensaje", () => {
    const s = buildStatus(build('SECTION "a", ROM0\n  ld a, 999\n  frob\n'), "main.asm");
    expect(s.level).toBe("error");
    expect(s.text).toMatch(/^2 errores · línea 2: /);
  });

  it("error de un INCLUDE: cita el fichero", () => {
    const s = buildStatus(build('  INCLUDE "x.inc"\n', { files: new Map([["x.inc", "  frob\n"]]) }), "main.asm");
    expect(s.text).toMatch(/^1 error · x\.inc:1: /);
  });

  it("avisos", () => {
    const s = buildStatus(build(OK + '  WARN "ojo"\n'), "main.asm");
    expect(s.level).toBe("warning");
    expect(s.text).toContain("1 aviso");
  });
});
