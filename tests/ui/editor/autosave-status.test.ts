// I1 · Guardado automático (debounce) y línea de estado tras construir.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Autosave, type KeyValue } from "../../../web/src/ui/editor/autosave";
import { buildStatus } from "../../../web/src/ui/editor/status";
import { build } from "../../../web/src/ui/run";

class MemKV implements KeyValue {
  m = new Map<string, string>();
  writes = 0;
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.writes++; this.m.set(k, v); }
}

describe("I1 autoguardado", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("escribe sólo la última versión tras la espera", () => {
    const kv = new MemKV();
    const a = new Autosave(kv, "k", 500);
    expect(a.load()).toBeNull();
    a.schedule("a"); vi.advanceTimersByTime(200);
    a.schedule("ab"); vi.advanceTimersByTime(200);
    a.schedule("abc");
    expect(kv.writes).toBe(0);
    vi.advanceTimersByTime(500);
    expect(kv.writes).toBe(1);
    expect(a.load()).toBe("abc");
  });

  it("flush escribe ya y no repite; sin almacén o con cuota llena no falla", () => {
    const kv = new MemKV();
    const a = new Autosave(kv, "k", 500);
    a.schedule("x");
    a.flush();
    expect(kv.m.get("k")).toBe("x");
    vi.advanceTimersByTime(1000);
    a.flush();
    expect(kv.writes).toBe(1);
    const none = new Autosave(null, "k");
    none.schedule("y"); none.flush();
    expect(none.load()).toBeNull();
    const full = new Autosave({ getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); } }, "k");
    full.schedule("z");
    expect(() => full.flush()).not.toThrow();
  });
});

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
