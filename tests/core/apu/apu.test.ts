// M2 — APU aislada (harness.c) y su integración en core-probe.wasm.
// Oráculos: máscaras de lectura y efectos de NR52 de Pan Docs ("Audio Registers") y Blargg
// cgb_sound (01-registers, 08-len ctr during power); frecuencias de Pan Docs
// (pulso 131072/(2048−x) Hz, onda 65536/(2048−x) Hz); 4 194 304 / 70 224 frames por segundo.
import { beforeAll, describe, expect, it } from "vitest";
import { instantiate } from "../../util/wasm";
import { type ApuHarness, left, loadApuHarness, zeroCrossFreq } from "./apu-harness";

const NR52 = 0xff26;
const FRAME = 70224;
const RATE = 48000;

/** Máscaras de Pan Docs (bits no usados / de sólo escritura leen 1), FF10-FF2F; NR52 aparte. */
const MASKS: Record<number, number> = {
  0xff10: 0x80, 0xff11: 0x3f, 0xff12: 0x00, 0xff13: 0xff, 0xff14: 0xbf,
  0xff15: 0xff, 0xff16: 0x3f, 0xff17: 0x00, 0xff18: 0xff, 0xff19: 0xbf,
  0xff1a: 0x7f, 0xff1b: 0xff, 0xff1c: 0x9f, 0xff1d: 0xff, 0xff1e: 0xbf,
  0xff1f: 0xff, 0xff20: 0xff, 0xff21: 0x00, 0xff22: 0x00, 0xff23: 0xbf,
  0xff24: 0x00, 0xff25: 0x00,
  0xff27: 0xff, 0xff28: 0xff, 0xff29: 0xff, 0xff2a: 0xff, 0xff2b: 0xff,
  0xff2c: 0xff, 0xff2d: 0xff, 0xff2e: 0xff, 0xff2f: 0xff,
};

let h: ApuHarness;
beforeAll(async () => { h = await loadApuHarness(); });

function powerOn() {
  h.reset(1);
  h.write(NR52, 0x80);
  h.write(0xff24, 0x77);
}

/** Ejecuta `frames` frames y devuelve el audio concatenado y los recuentos por frame. */
function runFrames(frames: number, rate = RATE): { s: Float32Array; counts: number[] } {
  const parts: Float32Array[] = [];
  const counts: number[] = [];
  for (let f = 0; f < frames; f++) {
    h.advance(FRAME);
    const a = h.audio(rate);
    counts.push(a.length / 2);
    parts.push(a);
  }
  const s = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { s.set(p, o); o += p.length; }
  return { s, counts };
}

function triggerSquare1(x: number, nr11 = 0x80, nr12 = 0xf0) {
  h.write(0xff11, nr11);
  h.write(0xff12, nr12);
  h.write(0xff13, x & 0xff);
  h.write(0xff14, 0x80 | (x >> 8));
}

describe("APU: registros", () => {
  it("máscaras de lectura con la APU encendida", () => {
    powerOn();
    for (const [a, m] of Object.entries(MASKS)) {
      h.write(Number(a), 0x00);
      expect(h.read(Number(a)), Number(a).toString(16)).toBe(m);
    }
    expect(h.read(NR52)).toBe(0xf0);
    // Valores sin disparo: lo legible vuelve tal cual.
    h.write(0xff11, 0x80); expect(h.read(0xff11)).toBe(0xbf);
    h.write(0xff12, 0xa5); expect(h.read(0xff12)).toBe(0xa5);
    h.write(0xff1c, 0x40); expect(h.read(0xff1c)).toBe(0xdf);
    h.write(0xff22, 0x5a); expect(h.read(0xff22)).toBe(0x5a);
    h.write(0xff25, 0xc3); expect(h.read(0xff25)).toBe(0xc3);
    h.write(0xff14, 0x40); expect(h.read(0xff14)).toBe(0xff);
  });

  it("NR52 = 0 borra FF10-FF25, ignora escrituras y conserva la RAM de onda", () => {
    powerOn();
    for (let i = 0; i < 16; i++) h.write(0xff30 + i, i * 17);
    h.write(0xff12, 0xf0); h.write(0xff25, 0xff); h.write(0xff22, 0x77);
    triggerSquare1(0x700);
    expect(h.read(NR52)).toBe(0xf1);
    h.write(NR52, 0x00);
    expect(h.read(NR52)).toBe(0x70);
    for (const [a, m] of Object.entries(MASKS)) expect(h.read(Number(a)), Number(a).toString(16)).toBe(m);
    h.write(0xff12, 0xf0); h.write(0xff24, 0x77);   // apagada: sólo lectura
    expect(h.read(0xff12)).toBe(0x00);
    expect(h.read(0xff24)).toBe(0x00);
    for (let i = 0; i < 16; i++) expect(h.read(0xff30 + i)).toBe(i * 17);
    h.write(NR52, 0x80);
    expect(h.read(NR52)).toBe(0xf0);
    expect(h.read(0xff12)).toBe(0x00);
  });

  it("CGB: apagar borra los contadores de longitud", () => {
    // Con longitud 1 cargada antes de apagar, al disparar tras encender debe cargarse 64.
    powerOn();
    h.write(0xff11, 0x3f);          // longitud = 64 − 63 = 1
    h.write(NR52, 0x00);
    h.write(NR52, 0x80);
    h.write(0xff12, 0xf0);
    h.write(0xff14, 0xc0);          // disparo + longitud habilitada
    h.advance(8192 * 4);            // 2 pulsos de longitud: con 1 ya estaría apagado
    expect(h.read(NR52) & 1).toBe(1);
    h.advance(8192 * 2 * 70);       // 70 pulsos de longitud (256 Hz) > 64
    expect(h.read(NR52) & 1).toBe(0);
  });

  it("longitud: el canal se apaga tras N pulsos de 256 Hz", () => {
    powerOn();
    h.write(0xff12, 0xf0);
    h.write(0xff11, 64 - 10);       // longitud 10
    h.advance(8192 - 100);          // justo antes del paso 0 (cuenta longitud: sin pulso extra)
    h.write(0xff14, 0xc0);
    h.advance(8192 * 2 * 9 + 50);
    expect(h.read(NR52) & 1).toBe(1);
    h.advance(8192 * 2);
    expect(h.read(NR52) & 1).toBe(0);
  });

  it("longitud: habilitarla cuando el próximo paso no la cuenta da un pulso extra", () => {
    // Blargg cgb_sound 03-trigger / Pan Docs "Obscure behavior".
    powerOn();
    h.write(0xff12, 0xf0);
    h.write(0xff11, 64 - 10);
    h.advance(8192 * 2 - 100);      // tras el paso 0: el próximo (1) no cuenta longitud
    h.write(0xff14, 0xc0);          // 10 − 1 (extra) = 9 pulsos por delante
    h.advance(8192 * 2 * 8 + 50);
    expect(h.read(NR52) & 1).toBe(1);
    h.advance(8192 * 2);
    expect(h.read(NR52) & 1).toBe(0);
  });

  it("DAC apagado: el disparo no enciende el canal", () => {
    powerOn();
    triggerSquare1(0x700, 0x80, 0x00);
    expect(h.read(NR52) & 1).toBe(0);
    h.write(0xff12, 0xf0);
    h.write(0xff14, 0x87);
    expect(h.read(NR52) & 1).toBe(1);
    h.write(0xff12, 0x07);          // apagar el DAC apaga el canal
    expect(h.read(NR52) & 1).toBe(0);
  });

  it("barrido: desbordamiento en el cálculo inmediato del disparo apaga el canal 1", () => {
    powerOn();
    h.write(0xff10, 0x11);          // periodo 1, suma, desplazamiento 1
    triggerSquare1(0x7ff);          // 2047 + 1023 > 2047
    expect(h.read(NR52) & 1).toBe(0);
  });

  it("PCM12 refleja la envolvente del canal 1", () => {
    powerOn();
    triggerSquare1(0x700, 0xc0, 0xf1);   // 75 %, volumen 15 que baja cada 1/64 s
    let max = 0;
    for (let i = 0; i < 64; i++) { h.advance(64); max = Math.max(max, h.read(0xff76) & 15); }
    expect(max).toBe(15);
    h.advance(8192 * 8 * 16);       // 16 pasos de envolvente: volumen 0
    max = 0;
    for (let i = 0; i < 64; i++) { h.advance(64); max = Math.max(max, h.read(0xff76) & 15); }
    expect(max).toBe(0);
    expect(h.read(NR52) & 1).toBe(1);  // la envolvente no apaga el canal
  });
});

describe("APU: salida", () => {
  it("≈ rate/59,73 muestras por frame", () => {
    powerOn();
    const { counts } = runFrames(120);
    for (const c of counts) expect([803, 804]).toContain(c);
    const total = counts.reduce((a, b) => a + b, 0);
    expect(Math.abs(total - (RATE * 120 * FRAME) / 4194304)).toBeLessThanOrEqual(1);
  });

  it("pulso al 50 %: frecuencia 131072/(2048−x) ± 0,5 % y sin continua", () => {
    for (const x of [1750, 1900, 1024]) {
      powerOn();
      h.write(0xff25, 0x11);
      triggerSquare1(x);
      const { s } = runFrames(60);
      const l = left(s).subarray(RATE / 4);   // tras asentarse el paso alto
      const f = zeroCrossFreq(l, RATE);
      const want = 131072 / (2048 - x);
      expect(Math.abs(f - want) / want, `x=${x} f=${f}`).toBeLessThan(0.005);
      let mean = 0, peak = 0;
      for (const v of l) { mean += v; peak = Math.max(peak, Math.abs(v)); }
      mean /= l.length;
      expect(peak).toBeGreaterThan(0.1);
      expect(Math.abs(mean)).toBeLessThan(peak * 0.01);
    }
  });

  it("canal 2 y panorámica: sólo suena por la derecha", () => {
    powerOn();
    h.write(0xff25, 0x02);
    h.write(0xff16, 0x80); h.write(0xff17, 0xf0);
    h.write(0xff18, 1800 & 0xff); h.write(0xff19, 0x80 | (1800 >> 8));
    expect(h.read(NR52) & 2).toBe(2);
    const { s } = runFrames(30);
    let lp = 0, rp = 0;
    for (let i = RATE / 4; i < s.length / 2; i++) { lp = Math.max(lp, Math.abs(s[2 * i]!)); rp = Math.max(rp, Math.abs(s[2 * i + 1]!)); }
    expect(lp).toBe(0);
    expect(rp).toBeGreaterThan(0.1);
    const r = new Float32Array(s.length / 2);
    for (let i = 0; i < r.length; i++) r[i] = s[2 * i + 1]!;
    const want = 131072 / (2048 - 1800);
    expect(Math.abs(zeroCrossFreq(r.subarray(RATE / 4), RATE) - want) / want).toBeLessThan(0.005);
  });

  it("canal 3: frecuencia 65536/(2048−x)", () => {
    powerOn();
    h.write(0xff25, 0x44);
    for (let i = 0; i < 16; i++) h.write(0xff30 + i, i < 8 ? 0xff : 0x00);
    h.write(0xff1a, 0x80); h.write(0xff1c, 0x20);
    const x = 1800;
    h.write(0xff1d, x & 0xff); h.write(0xff1e, 0x80 | (x >> 8));
    expect(h.read(NR52) & 4).toBe(4);
    const { s } = runFrames(60);
    const want = 65536 / (2048 - x);
    const f = zeroCrossFreq(left(s).subarray(RATE / 4), RATE);
    expect(Math.abs(f - want) / want, `f=${f}`).toBeLessThan(0.005);
  });

  it("canal 4: el ruido suena y cambia PCM34", () => {
    powerOn();
    h.write(0xff25, 0x88);
    h.write(0xff21, 0xf0); h.write(0xff22, 0x21); h.write(0xff23, 0x80);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) { h.advance(37); seen.add(h.read(0xff77) >> 4); }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 15]);
    const { s } = runFrames(10);
    let peak = 0;
    for (const v of s) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.05);
  });

  it("silencio exacto con todos los DAC apagados", () => {
    powerOn();
    h.write(0xff25, 0xff);
    triggerSquare1(1750, 0x80, 0x00);
    const { s } = runFrames(10);
    expect(s.length).toBeGreaterThan(0);
    for (const v of s) expect(v).toBe(0);
  });

  it("determinismo: misma secuencia → mismo audio y mismo estado", () => {
    const run = () => {
      powerOn();
      h.write(0xff25, 0xff);
      triggerSquare1(1600, 0x40, 0xf3);
      h.write(0xff21, 0xa0); h.write(0xff22, 0x13); h.write(0xff23, 0x80);
      const { s } = runFrames(20, 44100);
      return { s, st: h.state() };
    };
    const a = run(), b = run();
    expect(b.s).toEqual(a.s);
    expect(b.st).toEqual(a.st);
  });
});

describe("APU en core-probe.wasm", () => {
  async function machine(program: number[] = [0x18, 0xfe]) {
    const x = (await instantiate("core-probe")).exports as Record<string, any>;
    x.gb_init();
    const rom = new Uint8Array(x.memory.buffer, x.gb_rom(), 0x8000);
    rom.fill(0);
    rom[0x143] = 0x80;               // CGB
    rom.set([0x00, 0xc3, 0x50, 0x01], 0x100);
    rom.set(program, 0x150);
    expect(x.gb_insert(0x8000)).toBe(0);
    return x;
  }

  it("estado sin boot ROM: NR52 = F1, NR50 = 77, NR51 = F3 (Pan Docs)", async () => {
    const x = await machine();
    expect(x.gb_peek(0xff26)).toBe(0xf1);
    expect(x.gb_peek(0xff24)).toBe(0x77);
    expect(x.gb_peek(0xff25)).toBe(0xf3);
    expect(x.gb_peek(0xff10)).toBe(0x80);
    expect(x.gb_peek(0xff1a)).toBe(0x7f);
  });

  it("gb_audio da ≈ rate/59,73 frames estéreo por gb_run_frame", async () => {
    const x = await machine();
    let total = 0;
    for (let f = 0; f < 60; f++) {
      x.gb_run_frame();
      const n = x.gb_audio(RATE) as number;
      expect([803, 804]).toContain(n);
      total += n;
    }
    expect(Math.abs(total - (RATE * 60 * FRAME) / 4194304)).toBeLessThanOrEqual(1);
  });

  it("pulso disparado por la CPU (se salta mientras la CPU sea el stub NOP)", async (ctx) => {
    const x0 = 1750;
    const w = (reg: number, v: number) => [0x3e, v, 0xe0, reg & 0xff];   // LD A,v ; LDH (reg),A
    const x = await machine([
      ...w(0xff80, 0x42),
      ...w(0xff25, 0x11), ...w(0xff11, 0x80), ...w(0xff12, 0xf0),
      ...w(0xff13, x0 & 0xff), ...w(0xff14, 0x80 | (x0 >> 8)),
      0x18, 0xfe,
    ]);
    x.gb_run_frame();
    if (x.gb_peek(0xff80) !== 0x42) ctx.skip();
    x.gb_audio(RATE);
    const parts: number[] = [];
    for (let f = 0; f < 60; f++) {
      x.gb_run_frame();
      const n = x.gb_audio(RATE) as number;
      const s = new Float32Array(x.memory.buffer, x.gb_audio_buffer(), n * 2);
      for (let i = 0; i < n; i++) parts.push(s[2 * i]!);
    }
    const l = Float32Array.from(parts).subarray(RATE / 4);
    const want = 131072 / (2048 - x0);
    expect(Math.abs(zeroCrossFreq(l, RATE) - want) / want).toBeLessThan(0.005);
  });
});
