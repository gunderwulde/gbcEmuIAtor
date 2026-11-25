// CPU-03 (interrupciones, HALT, EI) y CPU-04 (ilegales, STOP) sobre core-test.wasm.
// Oráculo DOC: docs/gbc-hardware.md §4 (Pan Docs "Interrupts", "halt bug", "Using the
// STOP instruction"; mooneye acceptance/interrupts/ie_push). Bytes escritos a mano.
import { beforeAll, describe, expect, it } from "vitest";
import { instantiate } from "../../util/wasm";

const IE = 0xffff, IF = 0xff0f;
let x: Record<string, any>;

beforeAll(async () => {
  x = (await instantiate("core-test")).exports as Record<string, any>;
});

function mem(): Uint8Array {
  return new Uint8Array(x.memory.buffer, x.gbt_mem(), 65536);
}
function regs(): DataView {
  return new DataView(x.memory.buffer, x.gbt_regs(), 20);
}
const pc = () => regs().getUint16(10, true);
const sp = () => regs().getUint16(8, true);
const ime = () => regs().getUint8(12);
const halted = () => regs().getUint8(14);
const stopped = () => regs().getUint8(16);
const locked = () => regs().getUint8(17);

/** Estado limpio: programa en `at`, SP = FFFE salvo que se indique. */
function setup(prog: number[], opts: { at?: number; sp?: number; ime?: number; ie?: number; iff?: number } = {}) {
  x.gbt_reset();
  const m = mem();
  const at = opts.at ?? 0x0100;
  m.set(prog, at);
  m[IE] = opts.ie ?? 0;
  m[IF] = opts.iff ?? 0;
  const r = regs();
  r.setUint16(10, at, true);
  r.setUint16(8, opts.sp ?? 0xfffe, true);
  r.setUint8(12, opts.ime ?? 0);
}

/** Ciclos del último paso como texto: "R addr", "W addr=val", "-". */
function step(): string[] {
  x.gbt_log_clear();
  x.gbt_step();
  const n = x.gbt_log_len() as number;
  const log = new DataView(x.memory.buffer, x.gbt_log(), n * 8);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = log.getUint16(i * 8 + 4, true), k = log.getUint8(i * 8 + 6), v = log.getUint8(i * 8 + 7);
    out.push(k === 2 ? "-" : k === 0 ? `R ${a.toString(16)}` : `W ${a.toString(16)}=${v.toString(16)}`);
  }
  return out;
}

describe("CPU-03 despacho de interrupciones", () => {
  it("5 ciclos M: 2 internos, PC alto, PC bajo, interno; prioridad al bit más bajo", () => {
    setup([0x00], { at: 0x1234, ime: 1, ie: 0x1f, iff: 0x14 });
    expect(step()).toEqual(["-", "-", "W fffd=12", "W fffc=34", "-"]);
    expect(pc()).toBe(0x50);
    expect(mem()[IF]).toBe(0x10);
    expect(ime()).toBe(0);
    expect(sp()).toBe(0xfffc);
  });

  it("sin IME no se despacha", () => {
    setup([0x00], { ime: 0, ie: 1, iff: 1 });
    expect(step()).toEqual(["R 100"]);
    expect(pc()).toBe(0x101);
  });

  it("ie_push: el byte alto escrito en IE anula la IRQ → PC = 0000", () => {
    setup([0x00], { at: 0x0234, sp: 0x0000, ime: 1, ie: 0x01, iff: 0x01 });
    expect(step()).toEqual(["-", "-", "W ffff=2", "W fffe=34", "-"]);
    expect(pc()).toBe(0x0000);
    expect(mem()[IF]).toBe(0x01); // no se atendió ninguna
  });

  it("ie_push: si el byte alto deja otra IRQ habilitada, se atiende ésa", () => {
    setup([0x00], { at: 0x0434, sp: 0x0000, ime: 1, ie: 0x01, iff: 0x05 });
    step();
    expect(pc()).toBe(0x50); // IE = 04 → Timer
    expect(mem()[IF]).toBe(0x01);
  });

  it("ie_push: el byte bajo llega tarde para anularla", () => {
    setup([0x00], { at: 0x0300, sp: 0x0001, ime: 1, ie: 0x01, iff: 0x01 });
    expect(step()).toEqual(["-", "-", "W 0=3", "W ffff=0", "-"]);
    expect(pc()).toBe(0x40);
    expect(mem()[IF]).toBe(0x00);
  });
});

describe("CPU-03 EI, DI, RETI", () => {
  it("EI: la IRQ no se atiende hasta después de la instrucción siguiente", () => {
    setup([0xfb, 0x00, 0x00], { ie: 1, iff: 1 });
    step(); // EI
    expect(ime()).toBe(0);
    expect(step()).toEqual(["R 101"]); // NOP, todavía sin despacho
    expect(ime()).toBe(1);
    expect(step()).toEqual(["-", "-", "W fffd=1", "W fffc=2", "-"]);
    expect(pc()).toBe(0x40);
  });

  it("EI; DI no atiende", () => {
    setup([0xfb, 0xf3, 0x00], { ie: 1, iff: 1 });
    step(); step();
    expect(ime()).toBe(0);
    expect(step()).toEqual(["R 102"]);
  });

  it("RETI: IME = 1 sin retardo", () => {
    setup([0xd9], { sp: 0xc000, ie: 1, iff: 1 });
    mem()[0xc000] = 0x00; mem()[0xc001] = 0x20;
    expect(step()).toEqual(["R 100", "R c000", "R c001", "-"]);
    expect(ime()).toBe(1);
    expect(pc()).toBe(0x2000);
    expect(step()).toEqual(["-", "-", "W c001=20", "W c000=0", "-"]);
  });
});

describe("CPU-03 HALT", () => {
  it("IME = 0, sin IRQ: espera 1 ciclo por paso; al llegar la IRQ sigue sin atenderla", () => {
    setup([0x76, 0x00], { ie: 1 });
    expect(step()).toEqual(["R 100"]);
    expect(halted()).toBe(1);
    expect(step()).toEqual(["-"]);
    expect(step()).toEqual(["-"]);
    mem()[IF] = 1;
    expect(step()).toEqual(["R 101"]);
    expect(halted()).toBe(0);
    expect(pc()).toBe(0x102);
    expect(mem()[IF]).toBe(1);
  });

  it("IME = 1: despierta y atiende; la vuelta es la instrucción tras HALT", () => {
    setup([0x76, 0x00], { ime: 1, ie: 1 });
    step();
    expect(step()).toEqual(["-"]);
    mem()[IF] = 1;
    expect(step()).toEqual(["-", "-", "W fffd=1", "W fffc=1", "-"]);
    expect(pc()).toBe(0x40);
  });

  it("halt bug: IME = 0 con IE & IF != 0 → el byte siguiente se lee dos veces", () => {
    setup([0x76, 0x04, 0x00], { ie: 1, iff: 1 }); // HALT; INC B
    step();
    expect(halted()).toBe(0);
    expect(step()).toEqual(["R 101"]);
    expect(pc()).toBe(0x101);
    expect(step()).toEqual(["R 101"]);
    expect(pc()).toBe(0x102);
    expect(regs().getUint8(3)).toBe(2);
  });

  it("EI; HALT con IRQ pendiente: halt bug y la vuelta apunta al propio HALT", () => {
    setup([0xfb, 0x76, 0x00], { ie: 1, iff: 1 });
    step(); // EI
    step(); // HALT (IME aún 0 → halt bug)
    expect(halted()).toBe(0);
    expect(ime()).toBe(1);
    expect(step()).toEqual(["-", "-", "W fffd=1", "W fffc=1", "-"]);
    expect(pc()).toBe(0x40);
  });
});

describe("CPU-04 opcodes ilegales y STOP", () => {
  for (const op of [0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd]) {
    it(`${op.toString(16)} bloquea la CPU`, () => {
      setup([op, 0x04], { ime: 1, ie: 1 });
      expect(step()).toEqual(["R 100"]);
      expect(locked()).toBe(1);
      expect(pc()).toBe(0x100);
      mem()[IF] = 1; // ni las interrupciones la sacan
      expect(step()).toEqual(["-"]);
      expect(step()).toEqual(["-"]);
      expect(pc()).toBe(0x100);
      expect(regs().getUint8(3)).toBe(0);
    });
  }

  it("STOP sin IRQ pendiente: 2 bytes y la CPU queda parada", () => {
    setup([0x10, 0x00, 0x04]);
    expect(step()).toEqual(["R 100", "R 101"]);
    expect(pc()).toBe(0x102);
    expect(stopped()).toBe(1);
    expect(step()).toEqual(["-"]);
  });

  it("STOP con IRQ pendiente: 1 byte", () => {
    setup([0x10, 0x00], { ie: 1, iff: 1 });
    expect(step()).toEqual(["R 100"]);
    expect(pc()).toBe(0x101);
    expect(stopped()).toBe(1);
  });
});
