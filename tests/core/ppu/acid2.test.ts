// PPU-03 · HW: cgb-acid2 y dmg-acid2 (en modo compatibilidad del CGB) idénticos a la
// imagen de referencia de la suite, sin corrección de color.
//
// Fixtures esperados (los descarga tools/fetch-tests.mjs; si faltan, el test se salta):
//   tests/fixtures/cgb-acid2/cgb-acid2.gbc     ROM (release de mattcurrie/cgb-acid2)
//   tests/fixtures/cgb-acid2/reference.png     img/reference.png del mismo repo
//   tests/fixtures/dmg-acid2/dmg-acid2.gb      ROM (release de mattcurrie/dmg-acid2)
//   tests/fixtures/dmg-acid2/reference-cgb.png img/reference-cgb.png (CGB en compatibilidad)
// También se saltan mientras la CPU sea el stub de NOPs (sin CPU no hay imagen).
import { describe, expect, it } from "vitest";
import { fixture } from "../../util/wasm";
import { decodePng } from "./png";
import { boot, cpuIsReal, probe } from "./probe";

const realCpu = await cpuIsReal();

const CASES = [
  { name: "cgb-acid2", rom: "cgb-acid2/cgb-acid2.gbc", ref: "cgb-acid2/reference.png" },
  { name: "dmg-acid2 (compatibilidad CGB)", rom: "dmg-acid2/dmg-acid2.gb", ref: "dmg-acid2/reference-cgb.png" },
];

describe("PPU-03 acid2", () => {
  for (const c of CASES) {
    const rom = fixture(c.rom);
    const ref = fixture(c.ref);
    const why = !rom || !ref ? `falta ${!rom ? c.rom : c.ref} (npm run fetch)` : !realCpu ? "CPU stub" : "";
    it.skipIf(why !== "")(`${c.name}${why ? ` — ${why}` : ""}`, async () => {
      const x = await probe();
      boot(x, rom!);
      // Las dos ROMs terminan en pocos frames y se quedan en un bucle con LD B,B.
      for (let i = 0; i < 60; i++) x.gb_run_frame();
      const img = decodePng(ref!);
      expect([img.width, img.height]).toEqual([160, 144]);
      const fb = new Uint8Array(x.memory.buffer, x.gb_framebuffer(), 160 * 144 * 4);
      let diff = 0, first = "";
      for (let i = 0; i < 160 * 144; i++) {
        const o = i * 4;
        if (fb[o] !== img.rgba[o] || fb[o + 1] !== img.rgba[o + 1] || fb[o + 2] !== img.rgba[o + 2]) {
          if (!diff) first = `(${i % 160},${Math.floor(i / 160)}) emu ${fb.subarray(o, o + 3).join(",")} ref ${img.rgba.subarray(o, o + 3).join(",")}`;
          diff++;
        }
      }
      expect(diff, `píxeles distintos; primero ${first}`).toBe(0);
    });
  }
});
