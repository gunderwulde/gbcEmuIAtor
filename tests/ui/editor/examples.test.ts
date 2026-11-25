// I1 · Ejemplos precargados: ensamblan sin errores y, ejecutados en el núcleo real
// (construir → cabecera → gb_insert, como el botón del IDE), hacen visiblemente lo suyo.
// Lo esperado sale de la intención de cada programa (texto, scroll, sprite que sigue a
// la cruceta, paletas que cambian), medido en el framebuffer de la PPU.
import { describe, expect, it } from "vitest";
import { assemble } from "../../../web/src/asm";
import { EXAMPLES, exampleById } from "../../../web/src/ui/editor/examples";
import { buildAndRun } from "../../../web/src/ui/run";
import { PAD } from "../../../web/src/emu/core";
import { differs, distinctColors, frame, loadCore, runFrames } from "./core-helper";

function src(id: string): string {
  const e = exampleById(id);
  if (!e) throw new Error(`falta el ejemplo ${id}`);
  return e.source;
}

describe("I1 ejemplos", () => {
  it("hay cuatro ejemplos con id únicos", () => {
    expect(EXAMPLES.map((e) => e.id)).toEqual(["hello", "scroll", "sprite", "palettes"]);
  });

  for (const ex of EXAMPLES) {
    it(`${ex.id} ensambla sin errores ni avisos`, () => {
      const r = assemble(ex.source, { file: `${ex.id}.asm` });
      expect(r.errors.map((e) => `${e.line}:${e.col} ${e.msg}`)).toEqual([]);
      expect(r.warnings).toEqual([]);
      expect(r.rom.length).toBe(0x8000);
    });

    it(`${ex.id} no contiene datos con copyright (sólo tiles propios en dw \`)`, () => {
      expect(ex.source).not.toMatch(/INCBIN/i);
    });
  }

  // Sin boot ROM el programa arranca en el frame 0; apaga el LCD para cargar VRAM y, al
  // encenderlo, el primer frame del LCD sale en blanco (hardware). Borrar los dos mapas
  // (2 × 1024 iteraciones) lleva más de un frame: el texto llega en el 4.º o 5.º.
  it("hello: el texto aparece en los primeros frames (sin boot ROM)", async () => {
    const core = await loadCore();
    const r = buildAndRun(core, src("hello"), { file: "hello.asm" });
    expect(r.ok).toBe(true);
    expect(core.cgbMode()).toBe(true);
    let first = -1;
    for (let f = 1; f <= 10 && first < 0; f++) {
      runFrames(core, 1);
      if (distinctColors(frame(core)) > 1) first = f;
    }
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(5);
    const px = frame(core);
    expect(distinctColors(px)).toBeGreaterThanOrEqual(2);
    // Fila 8 de tiles (y = 64..71): el texto; la fila 2 (y = 16..23): fondo liso.
    const row = (y: number) => new Set(px.subarray(y * 160, y * 160 + 160)).size;
    let textRows = 0;
    for (let y = 64; y < 72; y++) if (row(y) > 1) textRows++;
    expect(textRows).toBeGreaterThanOrEqual(6);
    for (let y = 16; y < 24; y++) expect(row(y)).toBe(1);
  });

  it("scroll: el fondo no es liso y se desplaza cada frame", async () => {
    const core = await loadCore();
    expect(buildAndRun(core, src("scroll"), { file: "scroll.asm" }).ok).toBe(true);
    runFrames(core, 3);
    const a = frame(core);
    expect(distinctColors(a)).toBeGreaterThanOrEqual(8); // 4 paletas × varios colores
    runFrames(core, 1);
    const b = frame(core);
    expect(differs(a, b)).toBeGreaterThan(1000);
    // Desplazamiento diagonal: tras 16 frames (SCX +16, SCY +8) el damero (periodo 16 en
    // X) se ve igual en horizontal pero bajado 8 píxeles: la línea y de ahora es la y+8 de antes.
    runFrames(core, 16);
    const c = frame(core);
    let same = 0;
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 160; x++) if (c[y * 160 + x] === b[(y + 8) * 160 + x]) same++;
    expect(same).toBeGreaterThan(100 * 160 * 0.95);
  });

  it("sprite: la carita se mueve con la cruceta y se detiene en el borde", async () => {
    const core = await loadCore();
    expect(buildAndRun(core, src("sprite"), { file: "sprite.asm" }).ok).toBe(true);
    // Píxeles amarillos (31,31,0 sin corrección de color): sólo la cara del sprite.
    const centre = (): { x: number; y: number; n: number } => {
      const fb = core.framebuffer();
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < 160 * 144; i++) {
        if (fb[i * 4]! > 200 && fb[i * 4 + 1]! > 200 && fb[i * 4 + 2]! < 80) { sx += i % 160; sy += (i / 160) | 0; n++; }
      }
      return { x: n ? sx / n : -1, y: n ? sy / n : -1, n };
    };
    runFrames(core, 5);
    const p0 = centre();
    expect(p0.n).toBeGreaterThan(10);
    runFrames(core, 20, PAD.right);
    const p1 = centre();
    expect(p1.x - p0.x).toBeGreaterThan(15);
    expect(Math.abs(p1.y - p0.y)).toBeLessThan(0.5);
    runFrames(core, 10, PAD.up);
    const p2 = centre();
    expect(p1.y - p2.y).toBeGreaterThan(7);
    runFrames(core, 2);
    const still = centre(); // sin entrada, quieta
    runFrames(core, 5);
    expect(centre()).toEqual(still);
    runFrames(core, 200, PAD.left);
    expect(centre().x).toBeLessThan(8); // pegada al borde izquierdo, sin dar la vuelta
  });

  it("palettes: muchos colores y cambian con el tiempo sin tocar VRAM", async () => {
    const core = await loadCore();
    expect(buildAndRun(core, src("palettes"), { file: "palettes.asm" }).ok).toBe(true);
    runFrames(core, 3);
    const a = frame(core);
    expect(distinctColors(a)).toBeGreaterThanOrEqual(16);
    const vram0 = new Uint8Array(core.x.memory.buffer, core.x.gb_vram() as number, 0x4000).slice();
    runFrames(core, 8);
    const b = frame(core);
    expect(differs(a, b)).toBeGreaterThan(160 * 144 / 2);
    const vram1 = new Uint8Array(core.x.memory.buffer, core.x.gb_vram() as number, 0x4000);
    expect(differs(new Uint32Array(vram0.buffer), new Uint32Array(vram1.slice().buffer))).toBe(0);
  });
});
