// Fase 0.5/0.6: los tres wasm se instancian, exportan el ABI de gb.h/testbus.h y el
// layout de GbRegs coincide con su espejo TS (oráculo: offsets escritos a mano en gb.h).
import { describe, expect, it } from "vitest";
import { instantiate } from "../util/wasm";
import { RegsView } from "../../web/src/emu/regs";

const GB_EXPORTS = [
  "gb_init", "gb_insert", "gb_boot_rom", "gb_reset", "gb_run_frame", "gb_step",
  "gb_cycles_lo", "gb_cycles_hi", "gb_frame", "gb_framebuffer", "gb_set_color_correction",
  "gb_rom", "gb_sram", "gb_sram_size", "gb_sram_dirty", "gb_regs", "gb_io_buffer",
  "gb_cgb_mode", "gb_audio", "gb_audio_buffer", "gb_vram", "gb_wram", "gb_oam", "gb_hram",
  "gb_palettes", "gb_io", "gb_peek", "gb_rom_bank", "gb_joypad", "gb_load_sav", "gb_save_sav",
  "gb_rtc_advance", "gb_save_state", "gb_load_state", "gb_bp_set", "gb_bp_clear_all",
  "gb_poke", "gb_set_pc", "gb_wp_set", "gb_wp_clear_all", "gb_wp_addr",
];
const HOOKS = [
  "gb_t_run_until", "gb_t_buslog_enable", "gb_t_buslog", "gb_t_buslog_len", "gb_t_serial_log",
  "gb_t_serial_len", "gb_t_ld_b_b", "gb_t_ppu_state", "gb_t_sched_disable",
];
const TESTBUS = ["gbt_reset", "gbt_mem", "gbt_regs", "gbt_step", "gbt_log", "gbt_log_len", "gbt_log_clear"];

describe("ABI", () => {
  it("core.wasm exporta gb.h sin hooks", async () => {
    const x = (await instantiate("core")).exports;
    expect(x.memory).toBeInstanceOf(WebAssembly.Memory);
    for (const n of GB_EXPORTS) expect(typeof x[n], n).toBe("function");
    for (const n of HOOKS) expect(x[n], n).toBeUndefined();
  });

  it("core-probe.wasm exporta gb.h y los hooks", async () => {
    const x = (await instantiate("core-probe")).exports;
    for (const n of [...GB_EXPORTS, ...HOOKS]) expect(typeof x[n], n).toBe("function");
  });

  it("core-test.wasm exporta testbus.h", async () => {
    const x = (await instantiate("core-test")).exports;
    for (const n of TESTBUS) expect(typeof x[n], n).toBe("function");
  });

  it("GbRegs: offsets de gb.h", async () => {
    const x = (await instantiate("core-test")).exports as Record<string, any>;
    x.gbt_reset();
    const ptr = x.gbt_regs() as number;
    const mem = new Uint8Array(x.memory.buffer);
    const r = new RegsView(x.memory, ptr);
    r.a = 0x12; r.b = 0x34; r.e = 0x56; r.l = 0x78; r.sp = 0xABCD; r.pc = 0x1234; r.ime = 1;
    expect(mem[ptr + 1]).toBe(0x12);
    expect(mem[ptr + 3]).toBe(0x34);
    expect(mem[ptr + 4]).toBe(0x56);
    expect(mem[ptr + 6]).toBe(0x78);
    expect(mem[ptr + 8]! | mem[ptr + 9]! << 8).toBe(0xABCD);
    expect(mem[ptr + 10]! | mem[ptr + 11]! << 8).toBe(0x1234);
    expect(mem[ptr + 12]).toBe(1);
  });

  it("gb_insert rechaza ROMs demasiado cortas y MBC desconocidos", async () => {
    const x = (await instantiate("core")).exports as Record<string, any>;
    x.gb_init();
    const rom = new Uint8Array(x.memory.buffer, x.gb_rom(), 0x8000);
    rom.fill(0);
    expect(x.gb_insert(0x100)).toBe(-1);
    rom[0x147] = 0xFE; // HuC3: fuera de alcance
    expect(x.gb_insert(0x8000)).toBe(-3);
    rom[0x147] = 0x00;
    expect(x.gb_insert(0x8000)).toBe(0);
    expect(x.gb_run_frame()).toBe(0);
    expect(x.gb_frame()).toBe(1);
    expect(x.gb_cycles_lo()).toBeGreaterThanOrEqual(70224);
  });

  // Oráculo: la semántica declarada en gb.h (GB_STOP_WATCHPOINT: la instrucción que
  // escribe ya se ha ejecutado; gb_wp_addr da la dirección escrita).
  it("watchpoint de escritura: para tras la instrucción que escribe en el rango", async () => {
    const x = (await instantiate("core")).exports as Record<string, any>;
    x.gb_init();
    const rom = new Uint8Array(x.memory.buffer, x.gb_rom(), 0x8000);
    rom.fill(0);
    // 0100: LD A,$42 · 0102: LD ($C010),A · 0105: JR 0105
    rom.set([0x3E, 0x42, 0xEA, 0x10, 0xC0, 0x18, 0xFE], 0x100);
    expect(x.gb_insert(0x8000)).toBe(0);
    expect(x.gb_wp_set(0xC000, 0xC0FF, 1)).toBe(0);
    expect(x.gb_run_frame()).toBe(3);
    expect(x.gb_wp_addr()).toBe(0xC010);
    expect(x.gb_peek(0xC010)).toBe(0x42);
    const regs = new RegsView(x.memory, x.gb_regs());
    expect(regs.pc).toBe(0x105);
    // El bucle ya no escribe: el siguiente frame termina sin parar.
    expect(x.gb_run_frame()).toBe(0);
    x.gb_wp_clear_all();
    x.gb_set_pc(0x100);
    expect(x.gb_run_frame()).toBe(0);
  });
});
