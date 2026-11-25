// Salida de audio del emulador (M2): AudioContext + AudioWorklet con un ring buffer.
//
// Uso (el bucle de W1):
//   const audio = new Audio();
//   await audio.start();                    // dentro de un gesto del usuario (clic/tecla)
//   ...cada frame emulado:
//   audio.push(core.audio(audio.sampleRate)); // estéreo intercalado L/R; se copia
//   audio.bufferedFrames / audio.targetFrames // para regular el ritmo si se quiere
//
// Las muestras se pasan por postMessage (se copian y se transfiere la copia): son ~800
// frames por frame emulado, un coste despreciable, y funciona con o sin aislamiento de
// origen. El worklet absorbe las derivas de reloj (ver audio-worklet.ts).
import workletUrl from "./audio-worklet.ts?worker&url";

/** Latencia objetivo del ring buffer del worklet (segundos). */
const TARGET_LATENCY = 0.06;

export class Audio {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private on = true;
  private vol = 1;
  private fill = 0;
  private under = 0;
  private unlock: (() => void) | null = null;

  /** Frecuencia de muestreo a pasar a gb_audio(rate). 48 000 hasta que start() la fije. */
  get sampleRate(): number { return this.ctx?.sampleRate ?? 48000; }
  /** true si el contexto existe y está sonando. */
  get running(): boolean { return this.ctx?.state === "running"; }
  get enabled(): boolean { return this.on; }
  get volume(): number { return this.vol; }
  /** Frames en el ring del worklet según su último informe (~cada 50 ms). */
  get bufferedFrames(): number { return this.fill; }
  /** Frames que el worklet intenta mantener en el ring. */
  get targetFrames(): number { return Math.round(this.sampleRate * TARGET_LATENCY); }
  /** Veces que el ring se ha vaciado (cortes). */
  get underruns(): number { return this.under; }

  /** Crea el contexto y el worklet. Llamar desde un gesto del usuario; si el navegador
   *  lo deja suspendido, se reanuda en el siguiente clic o tecla. Idempotente. */
  async start(): Promise<void> {
    if (this.ctx) { await this.resume(); return; }
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, "gb-audio", {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    node.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; frames: number; underruns: number };
      if (m.type === "fill") { this.fill = m.frames; this.under = m.underruns; }
    };
    node.port.postMessage({ type: "target", frames: this.targetFrames });
    const gain = ctx.createGain();
    gain.gain.value = this.vol;
    node.connect(gain).connect(ctx.destination);
    this.node = node;
    this.gain = gain;
    this.unlock = () => { void this.resume(); };
    window.addEventListener("pointerdown", this.unlock, true);
    window.addEventListener("keydown", this.unlock, true);
    if (this.on) await this.resume(); else await ctx.suspend();
  }

  /** Envía un frame emulado de audio (estéreo intercalado). Se ignora sin start() o
   *  con el sonido desactivado. `samples` puede ser una vista sobre la memoria del wasm. */
  push(samples: Float32Array): void {
    if (!this.node || !this.on || samples.length === 0) return;
    const copy = samples.slice();
    this.node.port.postMessage({ type: "push", data: copy }, [copy.buffer]);
  }

  /** Activa o silencia la salida. Al desactivar se suspende el contexto y se vacía el ring. */
  setEnabled(on: boolean): void {
    this.on = on;
    if (!this.ctx || !this.node) return;
    this.node.port.postMessage({ type: "reset" });
    if (on) void this.resume(); else void this.ctx.suspend();
  }

  /** Volumen 0-1 (ganancia lineal). */
  setVolume(v: number): void {
    this.vol = Math.min(1, Math.max(0, v));
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(this.vol, this.ctx.currentTime, 0.01);
  }

  /** Vacía el ring (p. ej. tras reset, cargar estado o pausa larga) para no oír audio viejo. */
  flush(): void { this.node?.port.postMessage({ type: "reset" }); }

  /** Libera el contexto. */
  async close(): Promise<void> {
    if (this.unlock) {
      window.removeEventListener("pointerdown", this.unlock, true);
      window.removeEventListener("keydown", this.unlock, true);
      this.unlock = null;
    }
    this.node?.disconnect();
    this.gain?.disconnect();
    const ctx = this.ctx;
    this.ctx = null; this.node = null; this.gain = null;
    if (ctx) await ctx.close();
  }

  private async resume(): Promise<void> {
    if (this.ctx && this.on && this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch { /* sin gesto: se reintenta en el siguiente */ }
    }
  }
}

export { Audio as GbAudio };
