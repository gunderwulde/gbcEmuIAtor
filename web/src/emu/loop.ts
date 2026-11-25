// Bucle principal: requestAnimationFrame con acumulador de tiempo al ritmo real de la
// Game Boy (≈59,73 Hz), independiente de la frecuencia del monitor. El núcleo es
// determinista: el bucle sólo decide CUÁNTOS frames emular, nunca cómo.
import { FRAME_HZ } from "./core";

const FRAME_MS = 1000 / FRAME_HZ;
const MAX_CATCH_UP = 4; // tras una pausa de la pestaña no se intenta recuperar el tiempo perdido

export interface LoopHooks {
  /** Emula un frame; devuelve false para detener el bucle (breakpoint). */
  frame(): boolean;
  /** Se llama una vez por rAF si se emuló al menos un frame. */
  present(): void;
}

export class Loop {
  private raf = 0;
  private last = 0;
  private acc = 0;
  running = false;
  /** Multiplicador de velocidad (avance rápido). */
  speed = 1;
  /** Frames emulados por segundo, medido. */
  fps = 0;
  private fpsCount = 0;
  private fpsT = 0;

  constructor(private hooks: LoopHooks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.fpsT = this.last;
    this.acc = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.acc += (now - this.last) * this.speed;
    this.last = now;
    const limit = MAX_CATCH_UP * Math.max(1, this.speed);
    if (this.acc > FRAME_MS * limit) this.acc = FRAME_MS * limit;
    let ran = 0;
    while (this.acc >= FRAME_MS) {
      this.acc -= FRAME_MS;
      ran++;
      if (!this.hooks.frame()) { this.running = false; break; }
    }
    if (ran) this.hooks.present();
    this.fpsCount += ran;
    if (now - this.fpsT >= 1000) {
      this.fps = (this.fpsCount * 1000) / (now - this.fpsT);
      this.fpsCount = 0;
      this.fpsT = now;
    }
    if (this.running) this.raf = requestAnimationFrame(this.tick);
  };
}
