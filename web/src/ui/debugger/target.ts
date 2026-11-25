// Lo que el depurador necesita del núcleo, sobre las exportaciones crudas del wasm
// (core.x en la app, instantiate("core").exports en los tests). Sin DOM.
import { REG_OFFSETS } from "../../emu/regs";

export type CoreExports = Record<string, any> & { memory: WebAssembly.Memory };

/** Motivos de parada de gb_run_frame (gb.h). WATCHPOINT es la propuesta de D1. */
export const STOP_FRAME = 0;
export const STOP_BREAKPOINT = 1;
export const STOP_STEP = 2;
export const STOP_WATCHPOINT = 3;

export interface DebugTarget {
  /** gb_step: una instrucción, despacho de IRQ o ciclo M en HALT. */
  step(): void;
  pc(): number;
  sp(): number;
  halted(): boolean;
  /** Lectura sin efectos (gb_peek). */
  peek(addr: number): number;
  /** Banco ROMX mapeado (gb_rom_bank). */
  romBank(): number;
  bpSet(bank: number, addr: number, on: boolean): void;
  bpClearAll(): void;
  /** Watchpoints de escritura; undefined si el núcleo aún no los exporta. */
  wp?: {
    set(lo: number, hi: number, on: boolean): boolean;
    clearAll(): void;
  };
}

export function wasmTarget(x: CoreExports): DebugTarget {
  const regs = x.gb_regs() as number;
  const dv = (): DataView => new DataView(x.memory.buffer);
  const t: DebugTarget = {
    step: () => { x.gb_step(); },
    pc: () => dv().getUint16(regs + REG_OFFSETS.pc, true),
    sp: () => dv().getUint16(regs + REG_OFFSETS.sp, true),
    halted: () => dv().getUint8(regs + REG_OFFSETS.halted) !== 0 || dv().getUint8(regs + REG_OFFSETS.stopped) !== 0,
    peek: (a) => (x.gb_peek(a & 0xffff) as number) & 0xff,
    romBank: () => (x.gb_rom_bank() as number) >>> 0,
    bpSet: (bank, addr, on) => { x.gb_bp_set(bank, addr & 0xffff, on ? 1 : 0); },
    bpClearAll: () => { x.gb_bp_clear_all(); },
  };
  if (typeof x.gb_wp_set === "function") {
    t.wp = {
      set: (lo, hi, on) => (x.gb_wp_set(lo & 0xffff, hi & 0xffff, on ? 1 : 0) as number) === 0,
      clearAll: () => { x.gb_wp_clear_all(); },
    };
  }
  return t;
}
