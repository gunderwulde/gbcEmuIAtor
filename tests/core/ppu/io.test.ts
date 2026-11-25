// PPU-05/06 · DOC: registros escritos por la CPU (paletas con autoincremento, LCD
// apagado/encendido, bloqueo de VRAM/OAM por modo). Necesitan la CPU real: se saltan
// mientras sm83.c sea el stub de NOPs. Programas ensamblados a mano (sin A1).
import { describe, expect, it } from "vitest";
import { boot, cpuIsReal, makeRom, probe } from "./probe";

const realCpu = await cpuIsReal();
const why = realCpu ? "" : " — CPU stub";

describe("PPU-05/06 por E/S", () => {
  it.skipIf(!realCpu)(`BCPS/BCPD y OCPS/OCPD con autoincremento; LCD off/on${why}`, async () => {
    const x = await probe();
    // prettier-ignore
    boot(x, makeRom(true, [
      0x3e, 0x00, 0xe0, 0x40,   // LCDC = 0 (apagado)
      0xf0, 0x44, 0xe0, 0x83,   // [FF83] = LY → 0
      0x3e, 0x80, 0xe0, 0x68,   // BCPS = 80h (índice 0, autoincremento)
      0x3e, 0x11, 0xe0, 0x69,
      0x3e, 0x22, 0xe0, 0x69,
      0x3e, 0x33, 0xe0, 0x69,
      0x3e, 0x02, 0xe0, 0x68,   // BCPS = 02h (sin autoincremento)
      0xf0, 0x69, 0xe0, 0x80,   // [FF80] = BCPD → 33h
      0xf0, 0x68, 0xe0, 0x81,   // [FF81] = BCPS → 42h (bit 6 lee 1)
      0x3e, 0xbf, 0xe0, 0x68,   // índice 63 con autoincremento
      0x3e, 0x55, 0xe0, 0x69,   // escribe y da la vuelta a 0
      0xf0, 0x68, 0xe0, 0x82,   // → C0h
      0x3e, 0x81, 0xe0, 0x6a,   // OCPS = 81h
      0x3e, 0x77, 0xe0, 0x6b,
      0xf0, 0x6a, 0xe0, 0x85,   // → C2h
      0x3e, 0x91, 0xe0, 0x40,   // LCD encendido
      0xf0, 0x41, 0xe0, 0x84,   // STAT: modo 0 (primera línea sin modo 2), LYC = LY → 84h
      0xf0, 0x44, 0xe0, 0x86,   // LY = 0
      0x18, 0xfe,
    ]));
    x.gb_run_frame();
    const pal = new Uint8Array(x.memory.buffer, x.gb_palettes(), 128);
    expect([pal[0], pal[1], pal[2], pal[63], pal[65]]).toEqual([0x11, 0x22, 0x33, 0x55, 0x77]);
    const h = (a: number) => x.gb_peek(a);
    expect([h(0xff80), h(0xff81), h(0xff82), h(0xff83), h(0xff84), h(0xff85), h(0xff86)])
      .toEqual([0x33, 0x42, 0xc0, 0x00, 0x84, 0xc2, 0x00]);
  });

  // La PPU sólo despierta a la máquina en los sucesos que pueden pedir IRQ con la
  // configuración de STAT/LYC (ppu_next_event). Con HALT la CPU sólo ve el IF que el
  // planificador le entrega a tiempo: si un suceso no se programa, la CPU se despierta en
  // otro (VBlank, otra línea) y LY/STAT lo delatan. Oráculo: docs §7.2 (Pan Docs "STAT
  // interrupt"): LYC en el punto 4 de la línea LYC (modo 2), modo 0 al acabar el modo 3,
  // modo 2 en la línea 0 en el punto 4.
  it.skipIf(!realCpu)(`HALT despierta con la IRQ de STAT de cada fuente${why}`, async () => {
    for (const { stat, lyc, ly, mode } of [
      { stat: 0x40, lyc: 50, ly: 50, mode: 2 },
      { stat: 0x40, lyc: 150, ly: 150, mode: 1 },
      { stat: 0x08, lyc: 200, ly: 0, mode: 0 },
      { stat: 0x20, lyc: 200, ly: 0, mode: 2 },
    ]) {
      const x = await probe();
      // prettier-ignore
      boot(x, makeRom(true, [
        0xf3,                     // DI (arranca en la línea 144, ya pasado el punto 5)
        0x3e, lyc, 0xe0, 0x45,    // LYC
        0x3e, stat, 0xe0, 0x41,   // STAT
        0x3e, 0x02, 0xe0, 0xff,   // IE = STAT
        0xaf, 0xe0, 0x0f,         // IF = 0
        0x76,                     // HALT (IME = 0: sale sin atender la IRQ)
        0xf0, 0x44, 0xe0, 0x80,   // [FF80] = LY
        0xf0, 0x41, 0xe0, 0x81,   // [FF81] = STAT
        0x18, 0xfe,
      ]));
      x.gb_run_frame();
      x.gb_run_frame();
      expect({ stat, ly: x.gb_peek(0xff80), mode: x.gb_peek(0xff81) & 3 }).toEqual({ stat, ly, mode });
    }
  });

  it.skipIf(!realCpu)(`VRAM bloqueada en modo 3, OAM en modos 2-3${why}`, async () => {
    const x = await probe();
    // prettier-ignore
    boot(x, makeRom(true, [
      0xf0, 0x41, 0xe6, 0x03, 0xfe, 0x03, 0x20, 0xf8, // espera modo 3
      0xfa, 0x00, 0x80, 0xe0, 0x80,                   // [FF80] = (8000h) → FFh
      0xfa, 0x00, 0xfe, 0xe0, 0x82,                   // [FF82] = (FE00h) → FFh
      0xf0, 0x41, 0xe6, 0x03, 0x20, 0xfa,             // espera modo 0
      0xfa, 0x00, 0x80, 0xe0, 0x81,                   // → 42h
      0xfa, 0x00, 0xfe, 0xe0, 0x83,                   // → 24h
      0x18, 0xfe,
    ]));
    x.gb_poke(0x8000, 0x42);
    x.gb_poke(0xfe00, 0x24);
    x.gb_run_frame();
    x.gb_run_frame();
    expect([0xff80, 0xff81, 0xff82, 0xff83].map((a) => x.gb_peek(a))).toEqual([0xff, 0x42, 0xff, 0x24]);
  });
});
