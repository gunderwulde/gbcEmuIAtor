// Teclado + Gamepad API → máscara de botones de gb_joypad (GB_PAD_*).
import { PAD } from "./core";

/** Asignación por defecto (KeyboardEvent.code). */
export const DEFAULT_KEYS: Record<string, number> = {
  ArrowRight: PAD.right, ArrowLeft: PAD.left, ArrowUp: PAD.up, ArrowDown: PAD.down,
  KeyX: PAD.a, KeyZ: PAD.b, Enter: PAD.start, ShiftRight: PAD.select, Backspace: PAD.select,
  KeyD: PAD.right, KeyA: PAD.left, KeyW: PAD.up, KeyS: PAD.down,
  KeyK: PAD.a, KeyJ: PAD.b,
};

export class Input {
  private keys = 0;
  enabled = true;

  constructor(private map: Record<string, number> = DEFAULT_KEYS) {
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => { this.keys = 0; });
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const bit = this.map[e.code];
    if (bit === undefined || !this.enabled) return;
    // No robar teclas a los campos de texto (el editor del IDE vivirá a la izquierda).
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    e.preventDefault();
    this.keys = down ? this.keys | bit : this.keys & ~bit;
  }

  /** Estado actual: teclado OR primer mando con mapeo estándar. */
  mask(): number {
    let m = this.keys;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const b = (i: number): boolean => !!p.buttons[i]?.pressed;
      const ax = p.axes[0] ?? 0, ay = p.axes[1] ?? 0;
      if (b(0)) m |= PAD.a;            // abajo del rombo (A/Cruz)
      if (b(1) || b(2)) m |= PAD.b;    // derecha / izquierda del rombo
      if (b(8)) m |= PAD.select;
      if (b(9)) m |= PAD.start;
      if (b(12) || ay < -0.5) m |= PAD.up;
      if (b(13) || ay > 0.5) m |= PAD.down;
      if (b(14) || ax < -0.5) m |= PAD.left;
      if (b(15) || ax > 0.5) m |= PAD.right;
      break;
    }
    // El hardware no puede pulsar direcciones opuestas a la vez; algunos juegos fallan.
    if ((m & (PAD.left | PAD.right)) === (PAD.left | PAD.right)) m &= ~(PAD.left | PAD.right);
    if ((m & (PAD.up | PAD.down)) === (PAD.up | PAD.down)) m &= ~(PAD.up | PAD.down);
    return m;
  }
}
