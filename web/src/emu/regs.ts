// Espejo TypeScript de GbRegs (core/include/gb.h). Mismos offsets; little-endian.
export const REGS_SIZE = 20;
export const REG_OFFSETS = {
  f: 0, a: 1, c: 2, b: 3, e: 4, d: 5, l: 6, h: 7,
  sp: 8, pc: 10, ime: 12, ei_delay: 13, halted: 14, halt_bug: 15, stopped: 16, locked: 17,
} as const;

export class RegsView {
  private v: DataView;
  constructor(memory: WebAssembly.Memory, private ptr: number) {
    this.v = new DataView(memory.buffer);
  }
  private dv(): DataView {
    // La memoria del núcleo no crece, pero si el buffer cambiara, se recrea la vista.
    return this.v.buffer.byteLength ? this.v : this.v;
  }
  private u8(o: number): number { return this.dv().getUint8(this.ptr + o); }
  private u16(o: number): number { return this.dv().getUint16(this.ptr + o, true); }
  private set8(o: number, x: number): void { this.dv().setUint8(this.ptr + o, x); }
  private set16(o: number, x: number): void { this.dv().setUint16(this.ptr + o, x, true); }

  get a(): number { return this.u8(1); }    set a(x: number) { this.set8(1, x); }
  get f(): number { return this.u8(0); }    set f(x: number) { this.set8(0, x & 0xF0); }
  get b(): number { return this.u8(3); }    set b(x: number) { this.set8(3, x); }
  get c(): number { return this.u8(2); }    set c(x: number) { this.set8(2, x); }
  get d(): number { return this.u8(5); }    set d(x: number) { this.set8(5, x); }
  get e(): number { return this.u8(4); }    set e(x: number) { this.set8(4, x); }
  get h(): number { return this.u8(7); }    set h(x: number) { this.set8(7, x); }
  get l(): number { return this.u8(6); }    set l(x: number) { this.set8(6, x); }
  get af(): number { return this.u16(0); }
  get bc(): number { return this.u16(2); }  set bc(x: number) { this.set16(2, x); }
  get de(): number { return this.u16(4); }  set de(x: number) { this.set16(4, x); }
  get hl(): number { return this.u16(6); }  set hl(x: number) { this.set16(6, x); }
  get sp(): number { return this.u16(8); }  set sp(x: number) { this.set16(8, x); }
  get pc(): number { return this.u16(10); } set pc(x: number) { this.set16(10, x); }
  get ime(): number { return this.u8(12); } set ime(x: number) { this.set8(12, x); }
  get eiDelay(): number { return this.u8(13); }
  get halted(): number { return this.u8(14); }
  get haltBug(): number { return this.u8(15); }
  get stopped(): number { return this.u8(16); }
  get locked(): number { return this.u8(17); }
}
