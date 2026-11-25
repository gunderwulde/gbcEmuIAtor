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
