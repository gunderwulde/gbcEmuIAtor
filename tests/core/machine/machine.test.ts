// Regresiones de la máquina (gbc.c) y del cartucho (cart.c): GBC-1, GBC-2, GBC-3, GBC-5 y
// CART-1. Cada ROM es un programa mínimo escrito a mano; el valor esperado sale de la
// referencia de hardware citada en cada caso, no del núcleo.
import { describe, expect, it } from "vitest";
import { loadRom, regs, type Probe } from "../../util/runners";

const LOOP = 0x0200; // jr -2 al final de cada programa

/** ROM de 32 KB: salto a 0x150, el programa y un bucle infinito en LOOP. */
function rom(code: number[], { cgb = 0x80, type = 0x00, ram = 0x00 } = {}): Uint8Array {
  const r = new Uint8Array(0x8000);
  r.set([0x00, 0xc3, 0x50, 0x01], 0x100); // nop; jp 0x150
  r[0x143] = cgb;
  r[0x147] = type;
  r[0x149] = ram;
  let c = 0;
  for (let i = 0x134; i <= 0x14c; i++) c = (c - r[i]! - 1) & 0xff;
  r[0x14d] = c;
  if (0x150 + code.length + 3 > LOOP) throw new Error("programa demasiado largo");
  r.set([...code, 0xc3, LOOP & 0xff, LOOP >> 8], 0x150);
  r.set([0x18, 0xfe], LOOP);
  return r;
}

async function run(code: number[], opts?: Parameters<typeof rom>[1]): Promise<Probe> {
  const x = await loadRom(rom(code, opts));
  for (let i = 0; i < 200_000; i++) {
    if (regs(x).pc === LOOP) return x;
    x.gb_step();
  }
  throw new Error("el programa no llegó al bucle final");
}

// Opcodes SM83
const ldA = (n: number) => [0x3e, n];
const ldh = (a: number) => [0xe0, a & 0xff];          // ldh (a),A
const ldhA = (a: number) => [0xf0, a & 0xff];         // ldh A,(a)
const st = (a: number) => [0xea, a & 0xff, a >> 8];   // ld (a),A
const ldHL = (a: number) => [0x21, a & 0xff, a >> 8];
const fill16 = (base: number) => {                    // (hl+) ← base, base+1, … (16 bytes)
  const out: number[] = [];
  for (let i = 0; i < 16; i++) out.push(...ldA(base + i), 0x22);
  return out;
};

describe("GBC-1: HDMA arrancada fuera de modo 3", () => {
  // Pan Docs (CGB Registers, FF55): con el LCD apagado, o arrancando en HBlank, la HDMA
  // copia el primer bloque de inmediato. Mealybug hdma_lcd_off / hdma_mode0.
  it("con el LCD apagado copia un bloque nada más escribir FF55", async () => {
    const x = await run([
      ...ldA(0x00), ...ldh(0xff40),             // LCD apagado
      ...ldHL(0xc100), ...fill16(0x40),
      ...ldA(0xc1), ...ldh(0xff51), ...ldA(0x00), ...ldh(0xff52),
      ...ldA(0x80), ...ldh(0xff53), ...ldA(0x00), ...ldh(0xff54),
      ...ldA(0x81), ...ldh(0xff55),             // HDMA de 2 bloques
      ...ldhA(0xff55), ...st(0xc000),
    ]);
    expect(x.gb_peek(0xc000)).toBe(0x00);     // queda 1 bloque (len-1 = 0), activa (bit 7 = 0)
    for (let i = 0; i < 16; i++) expect(x.gb_peek(0x8000 + i)).toBe(0x40 + i);
    for (let i = 16; i < 32; i++) expect(x.gb_peek(0x8000 + i)).toBe(0x00);
  });
});

describe("GBC-2: fuente de HDMA/GDMA en VRAM o E000+", () => {
  // Las fuentes 8000–9FFF y E000–FFFF leen FFh (Mealybug gdma_addr_mask; Pan Docs FF51).
  for (const src of [0xe0, 0x80]) {
    it(`GDMA desde ${src.toString(16).toUpperCase()}00 escribe FFh`, async () => {
      const x = await run([
        ...ldA(0x00), ...ldh(0xff40),
        ...ldHL(0xc100), ...fill16(0x10),     // por si el bus las espejara a C100
        ...ldA(src), ...ldh(0xff51), ...ldA(0x00), ...ldh(0xff52),
        ...ldA(0x88), ...ldh(0xff53), ...ldA(0x00), ...ldh(0xff54),
        ...ldA(0x00), ...ldh(0xff55),           // GDMA de 16 bytes
      ]);
      for (let i = 0; i < 16; i++) expect(x.gb_peek(0x8800 + i)).toBe(0xff);
    });
  }
});

describe("GBC-5: estado tras el arranque", () => {
  // DIV tras la boot ROM: mooneye misc/boot_div-cgbABCDE (CGB) y la fase equivalente en
  // compatibilidad DMG. FF4F se lee FEh|VBK también en compatibilidad (misc/boot_hwio-C).
  it("DIV vale 1Eh en modo CGB y 26h en compatibilidad nada más arrancar", async () => {
    expect((await loadRom(rom([], { cgb: 0x80 }))).gb_peek(0xff04)).toBe(0x1e);
    expect((await loadRom(rom([], { cgb: 0x00 }))).gb_peek(0xff04)).toBe(0x26);
  });
  it("FF4F se lee FEh en compatibilidad DMG", async () => {
    const x = await run([...ldhA(0xff4f), ...st(0xc000)], { cgb: 0x00 });
    expect(x.gb_peek(0xc000)).toBe(0xfe);
  });
});

describe("GBC-3: cambio de velocidad", () => {
  // STOP con KEY1 armado: DIV se pone a 0 y la CPU se para 32767 ciclos M (2050 no basta:
  // AGE spsw-div). KEY1 queda con el bit 7 a 1 y el bit 0 a 0.
  it("STOP cambia a doble velocidad y desarma KEY1", async () => {
    const x = await run([
      ...ldA(0x30), ...ldh(0xff00), ...ldA(0x01), ...ldh(0xff4d),
      0x10, 0x00,                               // stop
      ...ldhA(0xff4d), ...st(0xc000),
    ]);
    expect(x.gb_peek(0xc000)).toBe(0xfe);
  });
});

describe("CART-1: RTC del MBC3", () => {
  // Lo escrito en un registro del RTC no se lee hasta el siguiente latch (Mealybug
  // mbc3_rtc, TestWrittenValueIsNotReadableUntilLatched).
  it("una escritura en el RTC sólo se ve tras latch", async () => {
    const latch = [...ldA(0x00), ...st(0x6000), ...ldA(0x01), ...st(0x6000)];
    const x = await run([
      ...ldA(0x0a), ...st(0x0000),              // RAM/RTC habilitados
      ...ldA(0x08), ...st(0x4000),              // registro de segundos
      ...latch,
      ...ldA(0x2a), ...st(0xa000),
      0xfa, 0x00, 0xa0, ...st(0xc000),          // ld a,(A000) sin latch nuevo
      ...latch,
      0xfa, 0x00, 0xa0, ...st(0xc001),          // tras el latch
    ], { type: 0x10, ram: 0x02 });
    expect(x.gb_peek(0xc000)).toBe(0x00);
    expect(x.gb_peek(0xc001)).toBe(0x2a);
  });
});
