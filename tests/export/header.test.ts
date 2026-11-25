// E1: cabecera y checksums. Los valores esperados se calculan a mano en los comentarios o
// salen de ROMs de la comunidad (rgbfix las cerró), nunca de las funciones bajo prueba.
import { describe, expect, it } from "vitest";
import {
  LOGO, checkHeader, fillHeader, globalChecksum, headerChecksum, HeaderError, ramSizeForSections,
  romSizeCode, validateCartridge,
} from "../../web/src/export/header";
import { fixture } from "../util/wasm";

const COMMUNITY = ["cgb-acid2/cgb-acid2.gbc", "dmg-acid2/dmg-acid2.gb", "blargg/halt_bug.gb"];

describe("logo", () => {
  const roms = COMMUNITY.map((f) => [f, fixture(f)] as const).filter(([, r]) => r);
  it.skipIf(roms.length === 0)("coincide con el de ROMs de la comunidad que arrancan en hardware", () => {
    for (const [, rom] of roms) expect(LOGO).toEqual(rom!.subarray(0x104, 0x134));
  });
});

describe("checksums contra ROMs de la comunidad (cerradas con rgbfix)", () => {
  const roms = COMMUNITY.map((f) => [f, fixture(f)] as const).filter(([, r]) => r);
  it.skipIf(roms.length === 0)("cabecera y global", () => {
    for (const [, rom] of roms) {
      expect(headerChecksum(rom!)).toBe(rom![0x14d]);
      expect(globalChecksum(rom!)).toBe((rom![0x14e]! << 8) | rom![0x14f]!);
      expect(validateCartridge(rom!)).toEqual([]);
    }
  });
});

describe("fillHeader", () => {
  // Imagen de 0150h bytes a cero: el exportador rellena con FFh hasta 32 KB.
  const out = fillHeader(new Uint8Array(0x150), { title: "a", cgb: "cgb" });

  it("campos de la cabecera", () => {
    expect(out.length).toBe(0x8000);
    expect([...out.subarray(0x100, 0x104)]).toEqual([0x00, 0xc3, 0x50, 0x01]); // NOP; JP $0150
    expect([...out.subarray(0x134, 0x143)]).toEqual([0x41, ...Array(14).fill(0)]); // "A" en mayúscula
    expect(out[0x143]).toBe(0x80);
    expect([out[0x144], out[0x145]]).toEqual([0x30, 0x30]); // licencia "00"
    expect(out[0x146]).toBe(0x00);
    expect(out[0x147]).toBe(0x00);
    expect(out[0x148]).toBe(0x00);
    expect(out[0x149]).toBe(0x00);
    expect(out[0x14a]).toBe(0x01);
    expect(out[0x14b]).toBe(0x33);
    expect(out[0x14c]).toBe(0x00);
    expect(out[0x150]).toBe(0xff);
    expect(out[0x7fff]).toBe(0xff);
  });

  it("checksum de cabecera calculado a mano", () => {
    // Bytes no nulos en 0134-014C: 41 (A) + 80 (CGB) + 30 + 30 (licencia) + 01 (destino)
    // + 33 (licencia antigua) = 155h. Son 25 bytes → x = −(155h + 19h) = −16Eh ≡ 92h.
    expect(out[0x14d]).toBe(0x92);
  });

  it("checksum global calculado a mano", () => {
    // 0100-0103: 00+C3+50+01 = 114h; logo: 5446 (1546h); 0134-014C: 155h; 014D: 92h;
    // 0150-7FFF: FFh × (8000h − 150h = 32432) = 8270160. Total 8276369 ≡ 4991h (mod 10000h).
    expect([out[0x14e], out[0x14f]]).toEqual([0x49, 0x91]);
  });

  it("banderas CGB 00h/80h/C0h", () => {
    const img = new Uint8Array(0x150);
    expect(fillHeader(img, { title: "", cgb: "dmg" })[0x143]).toBe(0x00);
    expect(fillHeader(img, { title: "", cgb: "cgb" })[0x143]).toBe(0x80);
    expect(fillHeader(img, { title: "", cgb: "cgbOnly" })[0x143]).toBe(0xc0);
  });

  it("título de 15 caracteres, u 11 con código de fabricante", () => {
    const img = new Uint8Array(0x150);
    const long = "ABCDEFGHIJKLMNOPQ";
    expect(checkHeader(img, { title: long, cgb: "cgb" })).toEqual([{ level: "warning", msg: "título recortado a 15 caracteres" }]);
    const a = fillHeader(img, { title: long, cgb: "cgb" });
    expect(String.fromCharCode(...a.subarray(0x134, 0x143))).toBe("ABCDEFGHIJKLMNO");
    const b = fillHeader(img, { title: long, cgb: "cgb", manufacturer: "abcd" });
    expect(String.fromCharCode(...b.subarray(0x134, 0x143))).toBe("ABCDEFGHIJKABCD");
    expect(() => fillHeader(img, { title: "ñ", cgb: "cgb" })).toThrow(HeaderError);
    expect(() => fillHeader(img, { title: "X", cgb: "cgb", manufacturer: "AB" })).toThrow(/4 caracteres/);
  });

  it("respeta la entrada del programa y no modifica la imagen original", () => {
    const img = new Uint8Array(0x150);
    img.set([0xc3, 0x00, 0x02, 0x00], 0x100); // JP $0200 (el último 00 no es parte)
    const r = fillHeader(img, { title: "", cgb: "cgb" });
    expect([...r.subarray(0x100, 0x104)]).toEqual([0xc3, 0x00, 0x02, 0x00]);
    expect(img[0x104]).toBe(0);
  });

  it("tamaño de ROM: potencia de 2, mínimo 32 KB, y MBC5 por defecto si no cabe", () => {
    expect(romSizeCode(1)).toBe(0);
    expect(romSizeCode(0x8000)).toBe(0);
    expect(romSizeCode(0x8001)).toBe(1);
    expect(romSizeCode(0xc000)).toBe(1);
    expect(romSizeCode(0x800000)).toBe(8);
    const r = fillHeader(new Uint8Array(0xc000), { title: "", cgb: "cgb" }); // 3 bancos → 64 KB
    expect(r.length).toBe(0x10000);
    expect(r[0x148]).toBe(1);
    expect(r[0x147]).toBe(0x19);
    expect(r[0xffff]).toBe(0xff);
    const fixed = fillHeader(new Uint8Array(0x8000), { title: "", cgb: "cgb", cartType: 0x19, romSize: 2 });
    expect(fixed.length).toBe(0x20000);
  });

  it("RAM deducida de las secciones SRAM", () => {
    const s = (bank: number) => ({ kind: "SRAM", bank, addr: 0xa000, size: 16 });
    expect(ramSizeForSections([])).toBe(0);
    expect(ramSizeForSections([s(0)])).toBe(2);
    expect(ramSizeForSections([s(0), s(3)])).toBe(3);
    expect(ramSizeForSections([s(7)])).toBe(5);
    expect(ramSizeForSections([s(15)])).toBe(4);
    const r = fillHeader(new Uint8Array(0x150), { title: "", cgb: "cgb", sections: [s(0)] });
    expect([r[0x147], r[0x149]]).toEqual([0x1b, 0x02]); // MBC5+RAM+BATTERY, 8 KB
  });

  const errors = (opts: Parameters<typeof checkHeader>[1], len = 0x150) =>
    checkHeader(new Uint8Array(len), opts).filter((i) => i.level === "error").map((i) => i.msg);

  it("errores de coherencia", () => {
    expect(errors({ title: "", cgb: "cgb", cartType: 0x00 }, 0x8001)).toEqual([
      "ROM admite hasta 32 KB de ROM; la imagen necesita 64 KB",
    ]);
    expect(errors({ title: "", cgb: "cgb", cartType: 0x05 }, 0x80000)).toEqual([
      "MBC2 admite hasta 256 KB de ROM; la imagen necesita 512 KB",
    ]);
    expect(errors({ title: "", cgb: "cgb", cartType: 0x20 })).toEqual(["tipo de cartucho $20 no soportado por el emulador"]);
    expect(errors({ title: "", cgb: "cgb", cartType: 0x19, ramSize: 2 })).toEqual(["MBC5 no tiene RAM pero se piden 8 KB"]);
    expect(errors({ title: "", cgb: "cgb", cartType: 0x06, ramSize: 2 })).toEqual([
      "MBC2+BATTERY lleva RAM interna: el tamaño de RAM debe ser 0",
    ]);
    expect(errors({ title: "", cgb: "cgb", cartType: 0x03, ramSize: 4 })).toEqual([
      "MBC1+RAM+BATTERY admite hasta 32 KB de RAM; se piden 128 KB",
    ]);
    expect(errors({ title: "", cgb: "cgb", ramSize: 1 })).toEqual(["código de tamaño de RAM no válido: 1 (0, 2-5)"]);
    expect(errors({ title: "", cgb: "cgb", romSize: 0 }, 0x8001)).toEqual([
      "la imagen ocupa 64 KB pero el tamaño fijado es 32 KB",
    ]);
    expect(errors({ title: "", cgb: "cgb", licensee: "A" })).toEqual(["la licencia debe tener 2 caracteres (tiene 1)"]);
    expect(errors({ title: "", cgb: "cgb", cartType: 0x1b, ramSize: 2, sections: [{ kind: "SRAM", bank: 2, addr: 0xa000, size: 1 }] }))
      .toEqual(["las secciones SRAM necesitan 32 KB pero el tamaño de RAM fijado es 8 KB"]);
    expect(errors({ title: "", cgb: "cgb" }, (8 << 20) + 1)).toContain("la imagen ocupa 8388609 bytes; el máximo es 8 MB");
  });

  it("avisos: RAM a 0 con tipo +RAM, datos en la zona de cabecera", () => {
    const img = new Uint8Array(0x150);
    img[0x120] = 0x12;
    expect(checkHeader(img, { title: "", cgb: "cgb", cartType: 0x1a, ramSize: 0 })).toEqual([
      { level: "warning", msg: "MBC5+RAM con tamaño de RAM 0: la RAM no se podrá usar" },
      { level: "warning", msg: "hay datos en la zona de la cabecera ($0120); se sobrescriben" },
    ]);
  });
});

describe("validateCartridge", () => {
  const good = fillHeader(new Uint8Array(0x150), { title: "OK", cgb: "cgb" });

  it("una ROM exportada no tiene problemas", () => {
    expect(validateCartridge(good)).toEqual([]);
  });

  it("detecta logo, checksums y tamaño", () => {
    const bad = good.slice();
    bad[0x110] = 0x01; // logo[0x0C] es 00h: la suma global sube exactamente 1
    const stored = (good[0x14e]! << 8) | good[0x14f]!;
    expect(validateCartridge(bad).map((i) => i.level + ": " + i.msg)).toEqual([
      "error: logo de la cabecera incorrecto ($0110)",
      `warning: checksum global $${h4(stored)}, debería ser $${h4(stored + 1)}`,
    ]);
    const hc = good.slice();
    hc[0x14d] = hc[0x14d]! ^ 0xff;
    expect(validateCartridge(hc)[0]).toEqual({ level: "error", msg: `checksum de cabecera $${h2(hc[0x14d]!)}, debería ser $${h2(good[0x14d]!)}` });
    expect(validateCartridge(good.subarray(0, 0x4000)).map((i) => i.msg)).toContain(
      "la cabecera indica 32 KB y el fichero tiene 16384 bytes",
    );
  });
});

const h2 = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");
const h4 = (v: number) => (v & 0xffff).toString(16).toUpperCase().padStart(4, "0");
