// G1 · Mapa de fondo reconstruido por el decodificador de los visores frente al
// framebuffer que pinta la PPU, con cgb-acid2 (modo CGB) y dmg-acid2 (compatibilidad DMG).
//
// Por qué así y qué zonas se comparan:
//  - Las dos ROMs cambian LCDC (mapa, direccionamiento de tiles, ventana, LCDC.0/1) y WX
//    a mitad de frame con interrupciones de LY=LYC: no hay un único juego de registros
//    válido para toda la pantalla. Por eso, para cada línea L se ejecuta la máquina
//    hasta el punto 200 de esa línea (en pleno modo 3: los registros son los que la PPU
//    está usando para pintarla) y se leen allí LCDC/SCX/SCY/WX/WY/paletas/OAM con las
//    vistas de depuración (gb_io, gb_vram, gb_palettes, gb_oam).
//  - Las ROMs son estáticas tras unos pocos frames (bucle con LD B,B), así que el
//    framebuffer completo (el del frame anterior) es el mismo que se pintaría en éste.
//  - Se excluyen los píxeles cubiertos por la caja de cualquier sprite de la línea
//    (con LCDC.1 y LCDC.2 de esa línea) y los de la ventana (LCDC.5, L ≥ WY, x ≥ WX−7):
//    ahí el framebuffer no muestra el fondo. El resto debe coincidir bit a bit (sin
//    corrección de color: gb_set_color_correction(0)).
//  - En compatibilidad DMG LCDC.0 = 0 apaga el fondo: esas líneas se excluyen también.
//  - Se exige un mínimo de píxeles comparados para que el test no pase vacío.
//
// El valor esperado lo pone la PPU del núcleo (que pasa acid2 contra la captura de
// referencia en tests/core/ppu/acid2.test.ts), no el código bajo prueba.
import { describe, expect, it } from "vitest";
import { fixture, instantiate } from "../../util/wasm";
import { MAP_SIZE, decodeOam, renderMap, type ColorCtx } from "../../../web/src/ui/vram/decode";

type X = Record<string, any> & { memory: WebAssembly.Memory };

const CASES = [
  { name: "cgb-acid2 (CGB)", rom: "cgb-acid2/cgb-acid2.gbc", cgb: true },
  { name: "dmg-acid2 (compatibilidad DMG)", rom: "dmg-acid2/dmg-acid2.gb", cgb: false },
];

const now = (x: X): number => (x.gb_cycles_lo() >>> 0) + (x.gb_cycles_hi() >>> 0) * 2 ** 32;

/** Avanza hasta la línea `ly`, punto `dot` del siguiente paso por ella. */
function runToLine(x: X, ly: number, dot: number): void {
  const s = x.gb_t_ppu_state() >>> 0;
  const pos = (s & 0xff) * 456 + ((s >>> 8) & 0xfff);
  const d = (ly * 456 + dot - pos + 70224) % 70224;
  x.gb_t_run_until((now(x) + d) >>> 0);
}

describe("G1 mapa de fondo vs framebuffer (acid2)", () => {
  for (const c of CASES) {
    const rom = fixture(c.rom);
    it.skipIf(!rom)(`${c.name}${rom ? "" : ` — falta ${c.rom} (npm run fetch)`}`, async () => {
      const x = (await instantiate("core-probe")).exports as X;
      x.gb_init();
      new Uint8Array(x.memory.buffer, x.gb_rom(), rom!.length).set(rom!);
      expect(x.gb_insert(rom!.length)).toBe(0);
      expect(x.gb_cgb_mode()).toBe(c.cgb ? 1 : 0);
      x.gb_set_color_correction(0);
      for (let i = 0; i < 60; i++) x.gb_run_frame();
      const fb = new Uint32Array(x.memory.buffer.slice(x.gb_framebuffer(), x.gb_framebuffer() + 160 * 144 * 4));

      const map = new Uint32Array(MAP_SIZE * MAP_SIZE);
      let compared = 0, diff = 0, first = "";
      for (let ly = 0; ly < 144; ly++) {
        runToLine(x, ly, 200);
        const s = x.gb_t_ppu_state() >>> 0;
        expect(s & 0xff).toBe(ly);
        const io = new Uint8Array(x.memory.buffer, x.gb_io(), 0x81).slice();
        const vram = new Uint8Array(x.memory.buffer, x.gb_vram(), 0x4000);
        const oam = new Uint8Array(x.memory.buffer, x.gb_oam(), 160);
        const lcdc = io[0x40]!, scy = io[0x42]!, scx = io[0x43]!, wy = io[0x4a]!, wx = io[0x4b]!;
        if (!c.cgb && !(lcdc & 1)) continue;
        const ctx: ColorCtx = {
          cgb: c.cgb, pals: new Uint8Array(x.memory.buffer, x.gb_palettes(), 128).slice(),
          bgp: io[0x47]!, obp0: io[0x48]!, obp1: io[0x49]!,
        };
        renderMap(vram, (lcdc >> 3) & 1, lcdc, ctx, map);
        const sprites = lcdc & 2 ? decodeOam(oam, lcdc, c.cgb).filter((e) => ly >= e.y && ly < e.y + e.height) : [];
        for (let px = 0; px < 160; px++) {
          if (sprites.some((e) => px >= e.x && px < e.x + 8)) continue;
          if (lcdc & 0x20 && ly >= wy && px + 7 >= wx) continue;
          compared++;
          const want = fb[ly * 160 + px]!, got = map[((ly + scy) & 255) * MAP_SIZE + ((px + scx) & 255)]!;
          if (want !== got) {
            if (!diff) first = `(${px},${ly}) mapa ${got.toString(16)} framebuffer ${want.toString(16)}`;
            diff++;
          }
        }
      }
      expect(diff, `píxeles distintos; primero ${first}`).toBe(0);
      expect(compared).toBeGreaterThan(12000);
    });
  }
});
