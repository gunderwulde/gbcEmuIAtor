// AudioWorklet de salida (M2). Vite lo empaqueta aparte: audio.ts lo importa con
// `?worker&url` y lo carga con audioWorklet.addModule().
//
// Protocolo (MessagePort):
//   principal → worklet  { type: "push", data: Float32Array }   estéreo intercalado (se transfiere)
//                        { type: "reset" }                       vacía el buffer
//                        { type: "target", frames: number }      latencia objetivo en frames
//   worklet → principal  { type: "fill", frames, underruns }      cada ~50 ms
//
// El emulador produce a 4 194 304 / 70 224 frames/s según el reloj del bucle principal y la
// tarjeta consume a su ritmo: las derivas se absorben aquí. Por encima de 2× el objetivo se
// descarta 1 frame de cada 128 (+0,8 %), por debajo de ½ se repite 1 de cada 128 (−0,8 %):
// cambios de tono inaudibles. Si se vacía, se mantiene la última muestra (sin clic) y no se
// vuelve a sonar hasta reunir el objetivo. Si se llena, se descarta lo más viejo.

export class StereoRing {
  readonly capacity: number;
  private buf: Float32Array;
  private r = 0;       // índice de frame de lectura
  private n = 0;       // frames almacenados
  target: number;
  underruns = 0;
  private primed = false;
  private lastL = 0;
  private lastR = 0;

  constructor(capacity: number, target: number) {
    this.capacity = capacity;
    this.buf = new Float32Array(capacity * 2);
    this.target = target;
  }

  get frames(): number { return this.n; }

  reset(): void { this.r = 0; this.n = 0; this.primed = false; }

  push(data: Float32Array): void {
    let frames = data.length >> 1;
    let src = 0;
    if (frames > this.capacity) { src = (frames - this.capacity) * 2; frames = this.capacity; }
    const over = this.n + frames - this.capacity;
    if (over > 0) { this.r = (this.r + over) % this.capacity; this.n -= over; }
    let w = (this.r + this.n) % this.capacity;
    for (let i = 0; i < frames; i++) {
      this.buf[2 * w] = data[src + 2 * i]!;
      this.buf[2 * w + 1] = data[src + 2 * i + 1]!;
      if (++w === this.capacity) w = 0;
    }
    this.n += frames;
  }

  /** Rellena `outL`/`outR` (mismo tamaño) con control de latencia. */
  pull(outL: Float32Array, outR: Float32Array): void {
    const len = outL.length;
    if (!this.primed && this.n >= this.target) this.primed = true;
    if (!this.primed) { outL.fill(this.lastL); outR.fill(this.lastR); return; }
    // Ajuste suave: un frame más o uno menos por bloque, repartido por el bloque.
    let consume = len;
    if (this.n > this.target * 2) consume = len + 1;
    else if (this.n < this.target >> 1) consume = len - 1;
    for (let i = 0; i < len; i++) {
      const k = Math.floor((i * consume) / len);
      if (k < this.n) {
        const j = (this.r + k) % this.capacity;
        this.lastL = this.buf[2 * j]!;
        this.lastR = this.buf[2 * j + 1]!;
      }
      outL[i] = this.lastL;
      outR[i] = this.lastR;
    }
    const adv = Math.min(consume, this.n);
    this.r = (this.r + adv) % this.capacity;
    this.n -= adv;
    if (adv < consume) { this.primed = false; this.underruns++; }
  }
}

// ---- Parte que sólo existe dentro de AudioWorkletGlobalScope ----

interface WorkletProcessorBase { readonly port: MessagePort }
declare const AudioWorkletProcessor: { prototype: WorkletProcessorBase; new (): WorkletProcessorBase } | undefined;
declare const registerProcessor: ((name: string, ctor: unknown) => void) | undefined;
declare const sampleRate: number;

if (typeof registerProcessor === "function" && typeof AudioWorkletProcessor !== "undefined") {
  class GbAudioProcessor extends AudioWorkletProcessor {
    private ring = new StereoRing(sampleRate, Math.round(sampleRate * 0.06));
    private ticks = 0;

    constructor() {
      super();
      this.port.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; data?: Float32Array; frames?: number };
        if (m.type === "push" && m.data) this.ring.push(m.data);
        else if (m.type === "reset") this.ring.reset();
        else if (m.type === "target" && m.frames) this.ring.target = Math.min(m.frames, this.ring.capacity >> 1);
      };
    }

    process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
      const out = outputs[0];
      if (out && out.length >= 2) this.ring.pull(out[0]!, out[1]!);
      else if (out && out.length === 1) { const tmp = new Float32Array(out[0]!.length); this.ring.pull(out[0]!, tmp); }
      if (++this.ticks * 128 >= sampleRate / 20) {
        this.ticks = 0;
        this.port.postMessage({ type: "fill", frames: this.ring.frames, underruns: this.ring.underruns });
      }
      return true;
    }
  }
  registerProcessor("gb-audio", GbAudioProcessor);
}
