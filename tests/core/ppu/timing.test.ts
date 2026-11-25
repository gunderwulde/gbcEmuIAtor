// PPU-01 (parte DOC): ritmo de modos, LY, VBlank, STAT y longitud del modo 3.
// Oráculos: Pan Docs "LCD Status"/"Rendering" y docs/gbc-hardware.md §7 (DOC). Los
// tiempos se miden con el stub de NOPs de la CPU (cada paso = 1 ciclo M = 4 puntos), así
// que todas las muestras se toman en múltiplos de 4 puntos.
import { beforeEach, describe, expect, it } from "vitest";
import {
  FRAME, LINE, boot, getIF, makeRom, now, ppuState, probe, runTo, setIF, setRegs, type Probe,
} from "./probe";

let x: Probe;
let t0: number; // inicio (punto 0) de la línea 0 del primer frame completo

/** Primer instante (múltiplo de 4) en que LY = 0 y modo 2. */
function findLine0(x: Probe): number {
  for (let t = now(x); ; t += 4) {
    runTo(x, t);
    const s = ppuState(x);
    if (s.ly === 0 && s.mode === 2) return t;
  }
}

const at = (line: number, dot: number) => t0 + line * LINE + dot;

beforeEach(async () => {
  x = await probe();
  boot(x, makeRom(true));
  t0 = findLine0(x);
});

describe("PPU-01 ritmo de modos (LCD 91h tras el arranque, sin sprites)", () => {
  it("estado post-arranque: LCD encendido, en VBlank (docs §11)", async () => {
    const y = await probe();
    boot(y, makeRom(true));
    expect(y.gb_peek(0xff40)).toBe(0x91);
    expect(ppuState(y).mode).toBe(1);
    expect(y.gb_peek(0xff44)).toBeGreaterThanOrEqual(144);
  });

  it("línea visible: modo 2 80 puntos, modo 3 172, modo 0 hasta 456", () => {
    for (const line of [0, 1, 77, 143]) {
      const probes: Array<[number, number]> = [
        [0, 2], [76, 2], [80, 3], [248, 3], [252, 0], [452, 0],
      ];
      for (const [dot, mode] of probes) {
        runTo(x, at(line, dot));
        const s = ppuState(x);
        expect({ line, dot, ly: s.ly, mode: s.mode, d: s.dot }).toEqual({ line, dot, ly: line, mode, d: dot });
      }
    }
  });

  it("STAT y LY por E/S coinciden con el estado interno", () => {
    runTo(x, at(10, 100));
    expect(x.gb_peek(0xff44)).toBe(10);
    expect(x.gb_peek(0xff41) & 3).toBe(3);
    runTo(x, at(10, 300));
    expect(x.gb_peek(0xff41) & 3).toBe(0);
    expect(x.gb_peek(0xff41) & 0x80).toBe(0x80); // bit 7 lee 1
  });

  it("VBlank: líneas 144-153 en modo 1, frame de 70 224 puntos", () => {
    for (let line = 144; line <= 152; line++) {
      runTo(x, at(line, 200));
      expect(ppuState(x)).toEqual({ ly: line, dot: 200, mode: 1 });
    }
    runTo(x, at(154, 0));
    expect(ppuState(x)).toEqual({ ly: 0, dot: 0, mode: 2 });
    expect(at(154, 0) - t0).toBe(FRAME);
  });

  it("línea 153: LY = 153 sólo el primer ciclo M, luego 0 (docs §7.2)", () => {
    runTo(x, at(153, 0));
    expect(x.gb_peek(0xff44)).toBe(153);
    runTo(x, at(153, 4));
    expect(x.gb_peek(0xff44)).toBe(0);
    runTo(x, at(153, 400));
    expect(x.gb_peek(0xff44)).toBe(0);
    expect(ppuState(x).mode).toBe(1);
  });

  it("IRQ de VBlank al empezar la línea 144", () => {
    runTo(x, at(100, 0));
    setIF(x, 0);
    runTo(x, at(143, 452));
    expect(getIF(x) & 1).toBe(0);
    runTo(x, at(144, 4));
    expect(getIF(x) & 1).toBe(1);
  });

  it("gb_run_frame: el VBlank coincide con el fin del frame (fase post-arranque)", () => {
    // Con la fase elegida (docs §11) cada frame de gb_run_frame acaba en la línea 144.
    const y = x;
    y.gb_run_frame();
    const s = ppuState(y);
    expect(s.ly).toBe(144);
    expect(s.dot).toBeLessThan(8);
  });
});

describe("PPU-01 STAT", () => {
  it("LYC = LY: bit 2 de STAT e IRQ en el flanco", () => {
    runTo(x, at(40, 0));
    setRegs(x, { lyc: 50, stat: 0x40 });
    setIF(x, 0);
    runTo(x, at(49, 452));
    expect(getIF(x) & 2).toBe(0);
    expect(x.gb_peek(0xff41) & 4).toBe(0);
    runTo(x, at(50, 4));
    expect(getIF(x) & 2).toBe(2);
    expect(x.gb_peek(0xff41) & 4).toBe(4);
    runTo(x, at(51, 4));
    expect(x.gb_peek(0xff41) & 4).toBe(0);
  });

  it("IRQ de modo 0 y de modo 2 en sus puntos", () => {
    runTo(x, at(20, 100));
    setRegs(x, { stat: 0x08 });
    setIF(x, 0);
    runTo(x, at(20, 248));
    expect(getIF(x) & 2).toBe(0);
    runTo(x, at(20, 252));
    expect(getIF(x) & 2).toBe(2);

    // El estado inyectado no recalcula la OR de STAT (una escritura real sí): se cambia
    // a la fuente de modo 2 en el modo 3 de la línea siguiente, con la OR ya a 0.
    runTo(x, at(21, 100));
    setRegs(x, { stat: 0x20 });
    setIF(x, 0);
    runTo(x, at(21, 452));
    expect(getIF(x) & 2).toBe(0);
    runTo(x, at(22, 0));
    expect(getIF(x) & 2).toBe(2);
  });

  it("bloqueo de STAT: modo 0 seguido de LYC no da un segundo flanco (Pan Docs)", () => {
    runTo(x, at(49, 100));
    setRegs(x, { lyc: 50, stat: 0x48 });
    setIF(x, 0);
    runTo(x, at(49, 300));
    expect(getIF(x) & 2).toBe(2); // flanco del modo 0
    setIF(x, 0);
    runTo(x, at(50, 40));
    expect(getIF(x) & 2).toBe(0); // la OR no bajó: sin IRQ en la línea 50
    // Control: sólo LYC → sí hay IRQ en la línea 50 del frame siguiente.
    runTo(x, at(140, 0));
    setRegs(x, { lyc: 50, stat: 0x40 });
    setIF(x, 0);
    runTo(x, at(154 + 50, 40));
    expect(getIF(x) & 2).toBe(2);
  });

  it("modo 1: IRQ de STAT al entrar en VBlank", () => {
    runTo(x, at(100, 0));
    setRegs(x, { stat: 0x10 });
    setIF(x, 0);
    runTo(x, at(144, 4));
    expect(getIF(x) & 3).toBe(3);
  });
});

describe("PPU-02 longitud del modo 3 (Pan Docs: 172 + SCX%8 + ventana + sprites)", () => {
  /** Mide el inicio del modo 0 de la línea `line` con resolución de 4 puntos. */
  function mode0Start(line: number): number {
    for (let d = 80; d < LINE; d += 4) {
      runTo(x, at(line, d));
      if (ppuState(x).mode === 0) return d;
    }
    throw new Error("sin modo 0");
  }

  it("SCX % 8 retrasa el modo 0", () => {
    // Registros fijados en la línea anterior; el modo 3 empieza en el punto 80.
    for (const [scx, start] of [[0, 252], [3, 256], [4, 256], [5, 260], [8, 252]] as const) {
      const line = 10 + scx;
      runTo(x, at(line - 1, 300));
      setRegs(x, { scx });
      expect({ scx, start: mode0Start(line) }).toEqual({ scx, start });
    }
  });

  it("ventana visible en la línea: +6", () => {
    runTo(x, at(4, 300));
    setRegs(x, { lcdc: 0xb1, wy: 0, wx: 7 });
    // 172 + 6 = 178 → modo 0 en 258, primer múltiplo de 4 ≥ 258 = 260.
    expect(mode0Start(5)).toBe(260);
  });

  it("un sprite en X = 8 con SCX = 0: 6 + 5 = 11 puntos", () => {
    runTo(x, at(4, 300));
    setRegs(x, { lcdc: 0x93 });
    x.gb_poke(0xfe00, 5 + 16); // Y de la línea 5
    x.gb_poke(0xfe01, 8);
    // 183 → modo 0 en 263 → 264
    expect(mode0Start(5)).toBe(264);
    // Sin OBJ activos no hay penalización.
    runTo(x, at(5, 300));
    setRegs(x, { lcdc: 0x91 });
    expect(mode0Start(6)).toBe(252);
  });
});
