// PPU-01 (parte DOC): ritmo de modos, LY, VBlank, STAT y longitud del modo 3.
// Oráculos: docs/gbc-hardware.md §7.1–7.3 (línea de tiempo de SameBoy para CGB-E, que
// fijan las ROMs de AGE y mooneye) y Pan Docs "LCD Status"/"Mode 3 length". Los tiempos se
// miden con el stub de NOPs de la CPU (cada paso = 1 ciclo M = 4 puntos): un suceso del
// punto T de una línea lo ve un acceso posterior a T, y con resolución de 4 puntos sólo se
// comprueba "antes" (muestra ≤ T: aún no se ve) y "después" (muestra > T: ya se ve).
import { beforeEach, describe, expect, it } from "vitest";
import {
  FRAME, LINE, boot, getIF, makeRom, now, ppuState, probe, runTo, setColor, setIF, setRegs,
  type Probe,
} from "./probe";

let x: Probe;
let t0: number; // instante absoluto del punto 0 de la línea 0 del primer frame completo

/** La PPU está al día hasta gb.now − 1, así que el punto interno corresponde a ese instante.
 *  Se busca una muestra de la línea 0 (LY = 0 y fuera de VBlank, a distinguir de la 153). */
function findLine0(x: Probe): number {
  for (let t = Math.ceil(now(x) / 4) * 4; ; t += 4) {
    runTo(x, t);
    const s = ppuState(x);
    if (s.ly === 0 && s.mode !== 1 && s.dot >= 16) return t - 1 - s.dot;
  }
}

const at = (line: number, dot: number) => t0 + line * LINE + dot;
/** Última muestra que aún no ve el suceso del punto `dot`. */
const before = (line: number, dot: number) => runTo(x, Math.floor(at(line, dot) / 4) * 4);
/** Primera muestra que ya ve el suceso del punto `dot`. */
const after = (line: number, dot: number) => runTo(x, Math.ceil((at(line, dot) + 1) / 4) * 4);
const stat = () => x.gb_peek(0xff41);
const ly = () => x.gb_peek(0xff44);

beforeEach(async () => {
  x = await probe();
  boot(x, makeRom(true));
  t0 = findLine0(x) + FRAME; // la búsqueda ya ha pasado el principio de su línea 0
});

describe("PPU-01 ritmo de modos (LCD 91h tras el arranque, sin sprites)", () => {
  it("estado post-arranque: LCD encendido, recién entrado en VBlank (docs §11)", async () => {
    const y = await probe();
    boot(y, makeRom(true));
    expect(y.gb_peek(0xff40)).toBe(0x91);
    expect(ppuState(y).mode).toBe(1);
    expect(y.gb_peek(0xff44)).toBe(144);
    expect(y.gb_peek(0xff0f) & 1).toBe(1);
  });

  it("línea visible: LY en el punto 3, modo 2 en el 4, modo 3 en el 84, modo 0 en el 256", () => {
    for (const line of [1, 77, 143]) {
      before(line, 3);
      expect({ line, ly: ly(), m: stat() & 3 }).toEqual({ line, ly: line - 1, m: 0 });
      after(line, 4);
      expect({ line, ly: ly(), m: stat() & 3 }).toEqual({ line, ly: line, m: 2 });
      before(line, 84);
      expect({ line, m: stat() & 3 }).toEqual({ line, m: 2 });
      after(line, 84);
      expect({ line, m: stat() & 3 }).toEqual({ line, m: 3 });
      before(line, 256);
      expect({ line, m: stat() & 3 }).toEqual({ line, m: 3 });
      after(line, 256);
      expect({ line, m: stat() & 3 }).toEqual({ line, m: 0 });
    }
  });

  it("línea 0: sigue en modo 1 hasta el punto 4", () => {
    before(0, 4);
    expect({ ly: ly(), m: stat() & 3 }).toEqual({ ly: 0, m: 1 });
    after(0, 4);
    expect({ ly: ly(), m: stat() & 3 }).toEqual({ ly: 0, m: 2 });
  });

  it("VBlank: LY = 144 en el punto 2, modo 1 e IF.0 en el 5; frame de 70 224 puntos", () => {
    runTo(x, at(100, 0));
    setIF(x, 0);
    before(144, 2);
    expect(ly()).toBe(143);
    expect(getIF(x) & 1).toBe(0);
    after(144, 5);
    expect(ly()).toBe(144);
    expect(stat() & 3).toBe(1);
    expect(getIF(x) & 1).toBe(1);
    for (let line = 145; line <= 152; line++) {
      after(line, 2);
      expect({ line, ly: ly(), m: stat() & 3 }).toEqual({ line, ly: line, m: 1 });
    }
    before(154, 4);
    expect({ ly: ly(), m: stat() & 3 }).toEqual({ ly: 0, m: 1 });
    after(154, 4);
    expect({ ly: ly(), m: stat() & 3 }).toEqual({ ly: 0, m: 2 });
    expect(at(154, 0) - t0).toBe(FRAME);
  });

  it("línea 153: LY = 153 en los puntos 2–7 y 0 desde el 8; LYC ve 153 hasta el 12 (CGB-E)", () => {
    runTo(x, at(152, 100));
    setRegs(x, { lyc: 0 });
    after(153, 2);
    expect(ly()).toBe(153);
    before(153, 8);
    expect(ly()).toBe(153);
    after(153, 8);
    expect(ly()).toBe(0);
    before(153, 12);
    expect(stat() & 4).toBe(0); // el comparador aún ve 153
    after(153, 12);
    expect(stat() & 4).toBe(4);
    expect(stat() & 3).toBe(1);
  });

  it("gb_run_frame: cada frame acaba recién pasado el punto 5 de la línea 144", () => {
    x.gb_run_frame();
    const s = ppuState(x);
    expect(s.ly).toBe(144);
    expect(s.dot).toBe(5);
    expect(getIF(x) & 1).toBe(1);
  });
});

describe("PPU-01 STAT", () => {
  it("LYC = LY: bit 2 de STAT e IRQ en el punto 4; el flag se mantiene hasta el 4 siguiente", () => {
    runTo(x, at(40, 0));
    setRegs(x, { lyc: 50, stat: 0x40 });
    setIF(x, 0);
    before(50, 4);
    expect(getIF(x) & 2).toBe(0);
    expect(stat() & 4).toBe(0);
    after(50, 4);
    expect(getIF(x) & 2).toBe(2);
    expect(stat() & 4).toBe(4);
    before(51, 4);
    expect(stat() & 4).toBe(4);
    after(51, 4);
    expect(stat() & 4).toBe(0);
  });

  it("IRQ de modo 0 un punto después del fin del modo 3; de modo 2 en el punto 3", () => {
    runTo(x, at(20, 100));
    setRegs(x, { stat: 0x08 });
    setIF(x, 0);
    before(20, 257);
    expect(getIF(x) & 2).toBe(0);
    after(20, 257);
    expect(getIF(x) & 2).toBe(2);

    // El estado inyectado no recalcula la OR de STAT (una escritura real sí): se cambia
    // a la fuente de modo 2 en el modo 3 de la línea siguiente, con la OR ya a 0.
    runTo(x, at(21, 100));
    setRegs(x, { stat: 0x20 });
    setIF(x, 0);
    before(22, 3);
    expect(getIF(x) & 2).toBe(0);
    after(22, 3);
    expect(getIF(x) & 2).toBe(2);
  });

  it("bloqueo de STAT: con LYC alta, el modo 0 de la misma línea no da IRQ (Pan Docs)", () => {
    runTo(x, at(49, 300));
    setRegs(x, { lyc: 50, stat: 0x48 });
    setIF(x, 0);
    after(50, 4);
    expect(getIF(x) & 2).toBe(2); // flanco de LYC
    setIF(x, 0);
    after(50, 300);
    expect(getIF(x) & 2).toBe(0); // la OR no bajó: sin IRQ de modo 0
    // Control: la línea 51 (LYC ya no coincide) sí da la IRQ de modo 0.
    after(51, 300);
    expect(getIF(x) & 2).toBe(2);
  });

  it("modo 1: IRQ de STAT al entrar en VBlank", () => {
    runTo(x, at(100, 0));
    setRegs(x, { stat: 0x10 });
    setIF(x, 0);
    after(144, 5);
    expect(getIF(x) & 3).toBe(3);
  });
});

describe("PPU-06 bloqueo de paletas (docs §7.8)", () => {
  // Oráculo: SameBoy display.c (GB_display_run, CGB): cgb_palettes_blocked = true 3 puntos
  // después del inicio del modo 3 (84 + 3 = 87), NO se libera en E (fin del modo 3) sino
  // que en E+3 pasa a !cgb_double_speed y en E+5 a false. En velocidad normal: 87 ≤ p <
  // E+5. BCPD y OCPD leen FFh bloqueadas; la escritura usa el mismo predicado.
  it("BCPD/OCPD leen FFh desde el punto 87 hasta E+4, incluidos E+1 y E+2", () => {
    // Paleta BG 0 color 0 = 1234h, OBJ 0 color 0 = 1256h; BCPS = OCPS = 0.
    setColor(x, 0, 0, 0x1234);
    setColor(x, 8, 0, 0x1256);
    const covered = new Set<number>();
    // SCX 0..3 desplaza E un punto cada vez: con muestras cada 4 puntos se ven todos los
    // puntos alrededor de E.
    for (let scx = 0; scx < 4; scx++) {
      const line = 30 + 2 * scx;
      runTo(x, at(line - 1, 300));
      setRegs(x, { scx });
      const e = 256 + scx;
      for (let t = Math.ceil(at(line, 0) / 4) * 4 + 4; t < at(line + 1, 0); t += 4) {
        runTo(x, t);
        const s = ppuState(x);
        if (s.dot < 4) continue; // puntos 0-2 de la línea siguiente (LY aún no cambia)
        expect(s.ly).toBe(line);
        const blocked = s.dot >= 87 && s.dot < e + 5;
        const got = [x.gb_peek(0xff69), x.gb_peek(0xff6b)];
        expect({ scx, dot: s.dot, got }).toEqual({
          scx, dot: s.dot, got: blocked ? [0xff, 0xff] : [0x34, 0x56],
        });
        covered.add(s.dot - e);
      }
    }
    for (const rel of [-1, 0, 1, 2, 3, 4, 5, 6]) expect(covered.has(rel)).toBe(true);
  });
});

describe("PPU-02 longitud del modo 3 (Pan Docs: 172 + SCX%8 + ventana + sprites)", () => {
  /** Comprueba que el modo 0 de la línea `line` empieza en el punto `e` (resolución 4). */
  function expectMode0At(line: number, e: number): void {
    let t = Math.ceil(at(line, 84) / 4) * 4;
    for (; ; t += 4) {
      runTo(x, t);
      if ((stat() & 3) === 0) break;
    }
    const seen = t - at(line, 0); // primera muestra con modo 0: E ∈ [seen − 4, seen − 1]
    expect({ line, ok: seen - 4 <= e && e <= seen - 1, seen }).toEqual({ line, ok: true, seen });
  }

  it("SCX % 8 retrasa el modo 0", () => {
    for (const scx of [0, 3, 4, 5, 7, 8]) {
      const line = 10 + scx;
      runTo(x, at(line - 1, 300));
      setRegs(x, { scx });
      expectMode0At(line, 256 + (scx % 8));
    }
  });

  it("ventana visible en la línea: +6", () => {
    runTo(x, at(4, 300));
    setRegs(x, { lcdc: 0xb1, wy: 0, wx: 7 });
    expectMode0At(5, 262);
  });

  it("un sprite en X = 8 con SCX = 0: 6 + 5 = 11 puntos", () => {
    runTo(x, at(4, 300));
    setRegs(x, { lcdc: 0x93 });
    x.gb_poke(0xfe00, 5 + 16); // Y de la línea 5
    x.gb_poke(0xfe01, 8);
    expectMode0At(5, 267);
    // Sin OBJ activos no hay penalización.
    runTo(x, at(5, 300));
    setRegs(x, { lcdc: 0x91 });
    expectMode0At(6, 256);
  });
});
