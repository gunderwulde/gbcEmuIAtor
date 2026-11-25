// Envoltorio del núcleo wasm (core/include/gb.h). Lo único de JS que conoce el ABI.
import { RegsView } from "./regs";

export const FB_W = 160;
export const FB_H = 144;
export const DOTS_PER_FRAME = 70224;
export const DOT_HZ = 4194304;
export const FRAME_HZ = DOT_HZ / DOTS_PER_FRAME; // ≈ 59.7275

export const enum Stop { Frame = 0, Breakpoint = 1, Step = 2 }

export const PAD = {
  right: 1, left: 2, up: 4, down: 8, a: 16, b: 32, select: 64, start: 128,
} as const;

const ERRORS: Record<number, string> = {
  [-1]: "tamaño no válido",
  [-2]: "formato no válido",
  [-3]: "tipo de cartucho (MBC) no soportado",
  [-4]: "versión de estado incompatible",
};

export class GbError extends Error {
  constructor(public code: number, what: string) {
    super(`${what}: ${ERRORS[code] ?? `error ${code}`}`);
  }
}

type Exports = Record<string, any> & { memory: WebAssembly.Memory };

/** Información de la cabecera del cartucho (0x134-0x14F). */
export interface CartInfo {
  title: string;
  cgbFlag: number;
  type: number;
  romSize: number;
  ramSize: number;
  headerChecksum: number;
  globalChecksum: number;
}

export function parseHeader(rom: Uint8Array): CartInfo {
  let title = "";
  for (let i = 0x134; i < 0x144; i++) {
    const c = rom[i] ?? 0;
    if (c === 0) break;
    if (c >= 0x20 && c < 0x7F) title += String.fromCharCode(c);
  }
  return {
    title: title.trim(),
    cgbFlag: rom[0x143] ?? 0,
    type: rom[0x147] ?? 0,
    romSize: rom[0x148] ?? 0,
    ramSize: rom[0x149] ?? 0,
    headerChecksum: rom[0x14D] ?? 0,
    globalChecksum: ((rom[0x14E] ?? 0) << 8) | (rom[0x14F] ?? 0),
  };
}

export class Core {
  readonly x: Exports;
  readonly regs: RegsView;
  private fb: Uint8ClampedArray;

  private constructor(instance: WebAssembly.Instance) {
    this.x = instance.exports as Exports;
    this.x.gb_init();
    this.regs = new RegsView(this.x.memory, this.x.gb_regs());
    this.fb = new Uint8ClampedArray(this.x.memory.buffer, this.x.gb_framebuffer(), FB_W * FB_H * 4);
  }

  static async load(url: string): Promise<Core> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`no se pudo cargar ${url}: ${res.status}`);
    const { instance } = await WebAssembly.instantiateStreaming(res, {});
    return new Core(instance);
  }

  private u8(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.x.memory.buffer, ptr, len);
  }

  insert(rom: Uint8Array): void {
    if (rom.length > 8 * 1024 * 1024) throw new GbError(-1, "ROM");
    this.u8(this.x.gb_rom(), rom.length).set(rom);
    const r = this.x.gb_insert(rom.length) as number;
    if (r !== 0) throw new GbError(r, "ROM");
  }

  /** Boot ROM del usuario (null = quitarla). Efecto en el próximo reset. */
  bootRom(data: Uint8Array | null): void {
    if (!data) { this.x.gb_boot_rom(0); return; }
    this.u8(this.x.gb_io_buffer(), data.length).set(data);
    const r = this.x.gb_boot_rom(data.length) as number;
    if (r !== 0) throw new GbError(r, "boot ROM");
  }

  reset(): void { this.x.gb_reset(); }
  runFrame(): Stop { return this.x.gb_run_frame(); }
  step(): Stop { return this.x.gb_step(); }
  frame(): number { return this.x.gb_frame() >>> 0; }
  cgbMode(): boolean { return this.x.gb_cgb_mode() !== 0; }
  joypad(mask: number): void { this.x.gb_joypad(mask); }
  setColorCorrection(on: boolean): void { this.x.gb_set_color_correction(on ? 1 : 0); }

  framebuffer(): Uint8ClampedArray {
    // La memoria del núcleo es fija, pero si el buffer se separase la vista se rehace.
    if (this.fb.byteLength === 0)
      this.fb = new Uint8ClampedArray(this.x.memory.buffer, this.x.gb_framebuffer(), FB_W * FB_H * 4);
    return this.fb;
  }

  /** Muestras estéreo intercaladas del último frame, remuestreadas a `rate`. */
  audio(rate: number): Float32Array {
    const n = this.x.gb_audio(rate) as number;
    return new Float32Array(this.x.memory.buffer, this.x.gb_audio_buffer(), n * 2);
  }

  sramSize(): number { return this.x.gb_sram_size() >>> 0; }
  sramDirty(): boolean { return this.x.gb_sram_dirty() !== 0; }

  saveSav(): Uint8Array {
    const n = this.x.gb_save_sav() as number;
    return this.u8(this.x.gb_io_buffer(), n).slice();
  }

  loadSav(data: Uint8Array): void {
    this.u8(this.x.gb_io_buffer(), data.length).set(data);
    const r = this.x.gb_load_sav(data.length) as number;
    if (r !== 0) throw new GbError(r, ".sav");
  }

  rtcAdvance(seconds: number): void {
    if (seconds > 0) this.x.gb_rtc_advance(Math.min(seconds, 0xFFFFFFFF) >>> 0);
  }

  saveState(): Uint8Array {
    const n = this.x.gb_save_state() as number;
    if (n === 0) throw new Error("estado demasiado grande");
    return this.u8(this.x.gb_io_buffer(), n).slice();
  }

  loadState(data: Uint8Array): void {
    this.u8(this.x.gb_io_buffer(), data.length).set(data);
    const r = this.x.gb_load_state(data.length) as number;
    if (r !== 0) throw new GbError(r, "estado");
  }
}
