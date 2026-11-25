// Ring buffer del AudioWorklet (web/src/emu/audio-worklet.ts): orden FIFO, prellenado,
// mantener la última muestra al vaciarse y control de deriva (±1 frame por bloque).
import { describe, expect, it } from "vitest";
import { StereoRing } from "../../../web/src/emu/audio-worklet";

function stereo(from: number, n: number): Float32Array {
  const s = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { s[2 * i] = from + i; s[2 * i + 1] = -(from + i); }
  return s;
}

describe("StereoRing", () => {
  it("no suena hasta reunir el objetivo y luego entrega en orden", () => {
    const r = new StereoRing(1024, 200);
    const L = new Float32Array(128), R = new Float32Array(128);
    r.push(stereo(1, 100));
    r.pull(L, R);
    expect(L.every((v) => v === 0)).toBe(true);
    expect(r.frames).toBe(100);
    r.push(stereo(101, 150));        // 250: entre ½ y 2× el objetivo → ritmo exacto
    r.pull(L, R);
    expect(Array.from(L.subarray(0, 4))).toEqual([1, 2, 3, 4]);
    expect(L[127]).toBe(128);
    expect(R[127]).toBe(-128);
    expect(r.frames).toBe(122);
  });

  it("al vaciarse mantiene la última muestra y cuenta el corte", () => {
    const r = new StereoRing(1024, 64);
    const L = new Float32Array(128), R = new Float32Array(128);
    r.push(stereo(1, 100));
    r.pull(L, R);
    expect(L[127]).toBe(100);
    expect(r.underruns).toBe(1);
    r.pull(L, R);
    expect(L.every((v) => v === 100)).toBe(true);
  });

  it("deriva: con exceso consume un frame más por bloque; con falta, uno menos", () => {
    const L = new Float32Array(128), R = new Float32Array(128);
    const hi = new StereoRing(4096, 100);
    hi.push(stereo(0, 1000));
    hi.pull(L, R);
    expect(hi.frames).toBe(1000 - 129);
    const lo = new StereoRing(4096, 400);
    lo.push(stereo(0, 400));
    lo.pull(L, R); lo.pull(L, R);   // 400 → 272 → 144 (< 200 = ½ objetivo)
    lo.pull(L, R);
    expect(lo.frames).toBe(144 - 127);
  });

  it("lleno: descarta lo más viejo", () => {
    const r = new StereoRing(256, 10);
    r.push(stereo(0, 200));
    r.push(stereo(200, 200));
    expect(r.frames).toBe(256);
    const L = new Float32Array(1), R = new Float32Array(1);
    r.pull(L, R);
    expect(L[0]).toBe(144);
  });
});
