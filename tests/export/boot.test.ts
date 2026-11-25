// E1, aceptación: la ROM exportada arranca en el propio emulador (core-probe.wasm) con la
// boot ROM de prueba (tests/fixtures-own/boot-check) y sin ella; con la cabecera dañada
// la boot ROM se bloquea.
import { describe, expect, it } from "vitest";
import { LOGO, fillHeader, type CgbMode } from "../../web/src/export/header";
import { BOOT_SIZE, LOCK_PC, buildBootCheck } from "../fixtures-own/boot-check/boot-check";
import { fixture, instantiate } from "../util/wasm";

type X = Record<string, any> & { memory: WebAssembly.Memory };

// Logo esperado por la boot ROM: el de una ROM de la comunidad que arranca en hardware
// (oráculo independiente del exportador). Sin `npm run fetch`, el del exportador: la
// prueba sigue cubriendo la posición del logo y el checksum, no su contenido.
const community = fixture("cgb-acid2/cgb-acid2.gbc");
const EXPECTED_LOGO = community ? community.slice(0x104, 0x134) : LOGO;
const BOOT = buildBootCheck(EXPECTED_LOGO);

// Programa mínimo en 0150: guarda A (11h si viene de una boot ROM de CGB) y se queda quieto.
//   0150  EA 00 C0   ld [$C000], a
//   0153  18 FE      jr @
const PROGRAM = [0xea, 0x00, 0xc0, 0x18, 0xfe];
const IDLE_PC = 0x153;

function image(): Uint8Array {
  const img = new Uint8Array(0x155);
  img.set(PROGRAM, 0x150);
  return img;
}

const exported = (cgb: CgbMode) => fillHeader(image(), { title: "BOOT TEST", cgb });

async function run(rom: Uint8Array, boot: Uint8Array | null, frames = 3): Promise<X> {
  const x = (await instantiate("core-probe")).exports as X;
  x.gb_init();
  if (boot) {
    new Uint8Array(x.memory.buffer, x.gb_io_buffer(), boot.length).set(boot);
    expect(x.gb_boot_rom(boot.length)).toBe(0);
  }
  new Uint8Array(x.memory.buffer, x.gb_rom(), rom.length).set(rom);
  expect(x.gb_insert(rom.length)).toBe(0);
  for (let i = 0; i < frames; i++) x.gb_run_frame();
  return x;
}

const pc = (x: X) => new DataView(x.memory.buffer).getUint16(x.gb_regs() + 10, true);

describe("boot ROM de prueba", () => {
  it("tiene el tamaño que exige gb_boot_rom y deja el código en 0000-00FF", () => {
    expect(BOOT.length).toBe(BOOT_SIZE);
    expect([BOOT[0xfe], BOOT[0xff]]).toEqual([0xe0, 0x50]);
  });

  it.skipIf(!community)("acepta una ROM de la comunidad (cgb-acid2) y le cede el control", async () => {
    const x = await run(community!, BOOT, 1);
    expect(pc(x)).not.toBe(LOCK_PC);
    expect(x.gb_peek(0x0000)).toBe(community![0]); // FF50 escrito: boot ROM desmapeada
  });
});

describe("ROM exportada", () => {
  for (const cgb of ["cgb", "cgbOnly", "dmg"] as const) {
    it(`arranca con la boot ROM de prueba (${cgb})`, async () => {
      const x = await run(exported(cgb), BOOT);
      expect(pc(x)).toBe(IDLE_PC);
      expect(x.gb_peek(0xc000)).toBe(0x11);
      expect(x.gb_peek(0x0000)).toBe(0x00); // boot ROM desmapeada: se ve el cartucho, no 31h
      expect(x.gb_cgb_mode()).toBe(cgb === "dmg" ? 0 : 1); // KEY0 = 04h para DMG
    });
  }

  it("arranca sin boot ROM", async () => {
    const x = await run(exported("cgb"), null);
    expect(pc(x)).toBe(IDLE_PC);
    expect(x.gb_peek(0xc000)).toBe(0x11); // AF = 1180h tras el arranque (docs §11)
  });

  it("con el checksum de cabecera dañado, la boot ROM se bloquea", async () => {
    const rom = exported("cgb");
    rom[0x14d] = (rom[0x14d]! + 1) & 0xff;
    const x = await run(rom, BOOT);
    expect(pc(x)).toBe(LOCK_PC);
    expect(x.gb_peek(0xc000)).not.toBe(0x11);
    expect(x.gb_peek(0x0000)).toBe(BOOT[0]); // sigue mapeada
  });

  it("con un byte del título cambiado sin recalcular, la boot ROM se bloquea", async () => {
    const rom = exported("cgb");
    rom[0x134] = rom[0x134]! ^ 0x20;
    expect(pc(await run(rom, BOOT))).toBe(LOCK_PC);
  });

  it("con el logo dañado, la boot ROM se bloquea", async () => {
    for (const at of [0x104, 0x133]) {
      const rom = exported("cgb");
      rom[at] = rom[at]! ^ 0x01;
      expect(pc(await run(rom, BOOT))).toBe(LOCK_PC);
    }
  });

  it("el checksum global dañado no impide arrancar (el hardware no lo comprueba)", async () => {
    const rom = exported("cgb");
    rom[0x14f] = rom[0x14f]! ^ 0xff;
    expect(pc(await run(rom, BOOT))).toBe(IDLE_PC);
  });
});
