// Utilidades de los tests de PPU (V1) sobre core-probe.wasm.
//
// Mientras sm83.c sea el stub de NOPs no hay forma de escribir registros de E/S desde
// una ROM, así que los tests inyectan registros de la PPU (y IF/VBK) a través de un
// estado guardado: gb_save_state → tocar bytes → gb_load_state. Los offsets del bloque
// de la PPU son los marcados "OFFSET FIJO" en core/src/ppu.c; los del bloque gb salen de
// machine.h (congelado) y se comprobaron con clang (-fdump-record-layouts).
import { instantiate } from "../../util/wasm";

export type Probe = Record<string, any> & { memory: WebAssembly.Memory };

export const LINE = 456;
export const FRAME = 70224;

// Offsets dentro del bloque gb (struct Gb de machine.h)
const GB_IFR = 56;
const GB_VBK = 57;

// Offsets dentro del bloque ppu (core/src/ppu.c, "OFFSET FIJO")
export const PPU_REG = {
  lcdc: 0, stat: 1, scy: 2, scx: 3, lyc: 4, bgp: 5, obp0: 6, obp1: 7, wy: 8, wx: 9,
  bcps: 10, ocps: 11, opri: 12,
} as const;
const PPU_PAL = 16;

export async function probe(): Promise<Probe> {
  return (await instantiate("core-probe")).exports as Probe;
}

/** ROM de 32 KB sin MBC; `code` va en 0150h y 0100h salta allí. Por defecto DI; IE = 0;
 *  HALT: con la CPU real, HALT avanza un ciclo M (4 puntos) por paso y nunca sale, así
 *  que gb_t_run_until llega exacto a cualquier múltiplo de 4 (un JR $ sólo daría 12). */
export function makeRom(cgb: boolean, code: number[] = [0xf3, 0xaf, 0xe0, 0xff, 0x76]): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom.set([0x00, 0xc3, 0x50, 0x01], 0x100);
  rom[0x143] = cgb ? 0x80 : 0x00;
  rom[0x147] = 0x00;
  rom[0x148] = 0x00;
  rom.set(code, 0x150);
  return rom;
}

export function boot(x: Probe, rom: Uint8Array): void {
  x.gb_init();
  new Uint8Array(x.memory.buffer, x.gb_rom(), rom.length).set(rom);
  const err = x.gb_insert(rom.length);
  if (err !== 0) throw new Error(`gb_insert: ${err}`);
}

export function ppuState(x: Probe): { ly: number; dot: number; mode: number } {
  const s = x.gb_t_ppu_state() >>> 0;
  return { ly: s & 0xff, dot: (s >>> 8) & 0xfff, mode: (s >>> 20) & 3 };
}

export const now = (x: Probe): number => (x.gb_cycles_lo() >>> 0) + (x.gb_cycles_hi() >>> 0) * 2 ** 32;

/** Ejecuta hasta el instante absoluto `t` (puntos). Con el stub de NOPs se llega exacto
 *  si t es múltiplo de 4. */
export function runTo(x: Probe, t: number): void {
  x.gb_t_run_until(t >>> 0);
}

/** Bloques del estado guardado: [offset de los datos, longitud] de gb y ppu. */
function stateBlocks(x: Probe): { len: number; gb: number; ppu: number } {
  const len = x.gb_save_state() >>> 0;
  const io = new DataView(x.memory.buffer, x.gb_io_buffer(), len);
  const gbLen = io.getUint32(8, true);
  const gb = 12;
  const ppu = gb + gbLen + 4;
  return { len, gb, ppu };
}

/** Modifica el estado de la máquina a través de un estado guardado. */
export function patchState(
  x: Probe,
  f: (io: Uint8Array, gb: number, ppu: number) => void,
): void {
  const { len, gb, ppu } = stateBlocks(x);
  const io = new Uint8Array(x.memory.buffer, x.gb_io_buffer(), len);
  f(io, gb, ppu);
  const r = x.gb_load_state(len);
  if (r !== 0) throw new Error(`gb_load_state: ${r}`);
}

export function setRegs(x: Probe, regs: Partial<Record<keyof typeof PPU_REG, number>>): void {
  patchState(x, (io, _gb, ppu) => {
    for (const [k, v] of Object.entries(regs)) io[ppu + PPU_REG[k as keyof typeof PPU_REG]] = v!;
  });
}

/** Escribe un color RGB555 en la paleta `pal` (0-7 BG, 8-15 OBJ), entrada `idx`. */
export function setColor(x: Probe, pal: number, idx: number, rgb555: number): void {
  patchState(x, (io, _gb, ppu) => {
    const o = ppu + PPU_PAL + pal * 8 + idx * 2;
    io[o] = rgb555 & 0xff;
    io[o + 1] = rgb555 >> 8;
  });
}

export function setIF(x: Probe, v: number): void {
  patchState(x, (io, gb) => { io[gb + GB_IFR] = v; });
}

export const getIF = (x: Probe): number => x.gb_peek(0xff0f) & 0x1f;

/** gb_poke en un banco de VRAM concreto (VBK se cambia por estado y se restaura). */
export function pokeVram(x: Probe, bank: number, addr: number, bytes: number[]): void {
  setVbk(x, bank);
  bytes.forEach((b, i) => x.gb_poke(addr + i, b));
  setVbk(x, 0);
}

function setVbk(x: Probe, bank: number): void {
  patchState(x, (io, gb) => { io[gb + GB_VBK] = bank; });
}

/** Píxel [r,g,b] del framebuffer completo. */
export function pixel(x: Probe, px: number, py: number): [number, number, number] {
  const fb = new Uint8Array(x.memory.buffer, x.gb_framebuffer(), 160 * 144 * 4);
  const o = (py * 160 + px) * 4;
  return [fb[o]!, fb[o + 1]!, fb[o + 2]!];
}

/** RGB555 → RGB888 sin corrección (docs §7.6: c << 3 | c >> 2), calculado aparte. */
export function rgb(c555: number): [number, number, number] {
  const e = (c: number) => (c << 3) | (c >> 2);
  return [e(c555 & 31), e((c555 >> 5) & 31), e((c555 >> 10) & 31)];
}

/** true si la CPU ya ejecuta instrucciones (no es el stub de NOPs): LD A,42h; LDH (80h),A. */
export async function cpuIsReal(): Promise<boolean> {
  const x = await probe();
  boot(x, makeRom(true, [0x3e, 0x42, 0xe0, 0x80, 0x18, 0xfe]));
  x.gb_run_frame();
  return x.gb_peek(0xff80) === 0x42;
}
