// D1: formato del panel. Los valores esperados salen de la documentación de los
// registros (docs/gbc-hardware.md: STAT, KEY1, SVBK, VBK, IE/IF, cabecera 0x148).
import { describe, expect, it } from "vitest";
import { flagsText, ioSummary, irqText, locText, parseLoc, parseRange, romBankCount } from "../../../web/src/ui/debugger/format";

describe("D1 formato", () => {
  it("flags Z N H C en los bits 7-4 de F", () => {
    expect(flagsText(0x00)).toBe("----");
    expect(flagsText(0xf0)).toBe("ZNHC");
    expect(flagsText(0xa0)).toBe("Z-H-");
    expect(flagsText(0x10)).toBe("---C");
  });

  it("bits de interrupción y ubicación", () => {
    expect(irqText(0)).toBe("—");
    expect(irqText(0x15)).toBe("VBL TIM JOY");
    expect(locText(-1, 0x150)).toBe("0150");
    expect(locText(0x1a, 0x4000)).toBe("1A:4000");
  });

  it("resumen de E/S: STAT, LY, KEY1, SVBK 0 → 1, VBK, IE en [0x80]", () => {
    const io = new Uint8Array(0x81);
    io[0x40] = 0x91; io[0x41] = 0x83; io[0x44] = 144; io[0x4d] = 0x81; io[0x70] = 0; io[0x4f] = 0xff;
    io[0x0f] = 0xe1; io[0x80] = 0x05;
    const s = ioSummary(io);
    expect(s.lcdOn).toBe(true);
    expect(s.mode).toBe("3 Dibujo");
    expect(s.ly).toBe(144);
    expect(s.double).toBe(true);
    expect(s.armed).toBe(true);
    expect(s.wramBank).toBe(1);
    expect(s.vramBank).toBe(1);
    expect(s.if).toBe(0x01);
    expect(s.ie).toBe(0x05);
    io[0x70] = 5;
    expect(ioSummary(io).wramBank).toBe(5);
  });

  it("bancos de ROM según la cabecera", () => {
    expect(romBankCount(0)).toBe(2);
    expect(romBankCount(5)).toBe(64);
    expect(romBankCount(8)).toBe(512);
  });

  it("direcciones, banco:dirección y etiquetas", () => {
    const find = (n: string) => (n === "Main" ? { bank: 2, addr: 0x4100 } : undefined);
    expect(parseLoc("$0150")).toEqual({ bank: null, addr: 0x150 });
    expect(parseLoc("0x1234")).toEqual({ bank: null, addr: 0x1234 });
    expect(parseLoc("c000")).toEqual({ bank: null, addr: 0xc000 });
    expect(parseLoc("1a:4000")).toEqual({ bank: 0x1a, addr: 0x4000 });
    expect(parseLoc("Main", find)).toEqual({ bank: 2, addr: 0x4100 });
    expect(parseLoc("Nada", find)).toBeNull();
    expect(parseLoc("")).toBeNull();
  });

  it("rangos de watchpoint", () => {
    expect(parseRange("C000")).toEqual({ lo: 0xc000, hi: 0xc000 });
    expect(parseRange("$C0FF-$C000")).toEqual({ lo: 0xc000, hi: 0xc0ff });
    expect(parseRange("c000..c00f")).toEqual({ lo: 0xc000, hi: 0xc00f });
    expect(parseRange("zz")).toBeNull();
  });
});
