// E1: marca de tiempo del .sav con RTC (formato BGB/VBA, docs/gbc-hardware.md §10.4) y
// nombres de fichero.
import { describe, expect, it } from "vitest";
import { savElapsed, stampSav } from "../../web/src/export/sav";
import { fileName } from "../../web/src/export/files";

describe(".sav con RTC", () => {
  it("escribe la marca u64 little-endian en los bytes 40-47 del pie", () => {
    const sav = new Uint8Array(8192 + 48).fill(0xaa);
    const out = stampSav(sav, 8192, 0x01020304);
    expect([...out.subarray(8192 + 40)]).toEqual([0x04, 0x03, 0x02, 0x01, 0, 0, 0, 0]);
    expect(out.subarray(0, 8192 + 40).every((b) => b === 0xaa)).toBe(true);
    expect(sav[8192 + 40]).toBe(0xaa); // no toca el original
  });

  it("sin pie de RTC no cambia nada", () => {
    const sav = new Uint8Array(8192).fill(7);
    expect(stampSav(sav, 8192, 123)).toEqual(sav);
    expect(savElapsed(sav, 8192, 1000)).toBe(0);
  });

  it("segundos transcurridos desde la marca (48 y 44 bytes)", () => {
    const sav48 = new Uint8Array(48);
    sav48.set([0x10, 0x27, 0, 0, 0, 0, 0, 0], 40); // 10000
    expect(savElapsed(sav48, 0, 10_100.9)).toBe(100);
    const sav44 = new Uint8Array(512 + 44);
    sav44.set([0x10, 0x27, 0, 0], 512 + 40);
    expect(savElapsed(sav44, 512, 10_005)).toBe(5);
    expect(savElapsed(sav48, 0, 9_000)).toBe(0); // marca en el futuro
    expect(savElapsed(new Uint8Array(48), 0, 9_000)).toBe(0); // marca a 0 (sin hora)
  });
});

describe("fileName", () => {
  it("limpia el título", () => {
    expect(fileName("HELLO WORLD", "gbc")).toBe("HELLO_WORLD.gbc");
    expect(fileName("  a/b:c*  ", "sav")).toBe("a_b_c.sav");
    expect(fileName("", "gbstate")).toBe("game.gbstate");
  });
});
