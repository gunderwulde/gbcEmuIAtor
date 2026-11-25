// I1 · run.ts: construir (ensamblar + cabecera E1) y arrancar en el núcleo real.
import { describe, expect, it } from "vitest";
import { build, buildAndRun, cgbModeFor, titleFor } from "../../web/src/ui/run";
import { validateCartridge } from "../../web/src/export/header";
import { parseHeader } from "../../web/src/emu/core";
import { loadCore, runFrames } from "./editor/core-helper";

// Escribe $42 en $C000 (WRAM0) y $D000 (banco 1) sólo si no estaba ya, y se para.
const PROG = (flag = "") => `
SECTION "Entry", ROM0[$100]
    nop
    jp Main
    ds $143 - @, 0
    ${flag ? `db ${flag}` : "db 0"}
    ds $150 - @, 0
Main:
    ld a, [$C001]
    inc a
    ld [$C001], a          ; contador de arranques en WRAM
.l: halt
    jr .l
`;

describe("I1 run.ts", () => {
  it("build: cabecera válida, C0h por defecto, título del fichero", () => {
    const r = build(PROG(), { file: "demo/prueba.asm" });
    expect(r.ok).toBe(true);
    expect(validateCartridge(r.rom!).filter((i) => i.level === "error")).toEqual([]);
    const h = parseHeader(r.rom!);
    expect(h.cgbFlag).toBe(0xc0);
    expect(h.title).toBe("PRUEBA");
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("bandera CGB: se respeta $80 escrito por el programa; opts.cgb manda", () => {
    expect(parseHeader(build(PROG("$80")).rom!).cgbFlag).toBe(0x80);
    expect(parseHeader(build(PROG("$C0")).rom!).cgbFlag).toBe(0xc0);
    expect(parseHeader(build(PROG(), { cgb: "dmg" }).rom!).cgbFlag).toBe(0x00);
    expect(cgbModeFor(new Uint8Array(0x8000))).toBe("cgbOnly");
    expect(titleFor("C:\\x\\hola mundo.asm")).toBe("HOLA MUNDO");
  });

  it("con errores no toca el núcleo", async () => {
    const core = await loadCore();
    expect(buildAndRun(core, PROG(), {}).ok).toBe(true);
    runFrames(core, 2);
    const before = core.x.gb_cycles_lo() >>> 0;
    const r = buildAndRun(core, "    ld a, 999\n    frob\n", { file: "main.asm" });
    expect(r.ok).toBe(false);
    expect(r.result.errors.length).toBe(2);
    expect(r.rom).toBeUndefined();
    expect(core.x.gb_cycles_lo() >>> 0).toBe(before); // sin reset
  });

  it("errores de cabecera → ok = false con el motivo", () => {
    const r = build(PROG(), { title: "ÑANDÚ" }); // la cabecera sólo admite ASCII
    expect(r.ok).toBe(false);
    expect(r.headerErrors.join()).toMatch(/ASCII/);
  });

  it("insert + reset: arranca en el primer frame y keepWram conserva la WRAM", async () => {
    const core = await loadCore();
    const wram = () => new Uint8Array(core.x.memory.buffer, core.x.gb_wram() as number, 0x8000);
    expect(buildAndRun(core, PROG(), {}).ok).toBe(true);
    runFrames(core, 1);
    expect(wram()[1]).toBe(1);
    wram()[0x1234] = 0x5a;   // banco 1 de WRAM ($D234)
    // Sin keepWram, el reset borra la WRAM y el contador vuelve a 1.
    expect(buildAndRun(core, PROG(), {}).ok).toBe(true);
    runFrames(core, 1);
    expect(wram()[1]).toBe(1);
    expect(wram()[0x1234]).toBe(0);
    // Con keepWram, el programa ve el valor anterior: 1 → 2.
    wram()[0x1234] = 0x5a;
    expect(buildAndRun(core, PROG(), { keepWram: true }).ok).toBe(true);
    expect(wram()[0x1234]).toBe(0x5a);
    runFrames(core, 1);
    expect(wram()[1]).toBe(2);
  });
});
