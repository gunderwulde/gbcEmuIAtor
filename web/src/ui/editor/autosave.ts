// Guardado automático del código en localStorage, con espera (debounce) para no escribir
// en cada tecla. Sin DOM: el almacén se inyecta (localStorage en la app, un Map en tests).

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage si existe y se puede usar (modo privado, cuota…); si no, null. */
export function browserStorage(): KeyValue | null {
  try {
    const s = globalThis.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export class Autosave {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: string | null = null;

  constructor(private kv: KeyValue | null, readonly key: string, private delayMs = 500) {}

  load(): string | null {
    try { return this.kv?.getItem(this.key) ?? null; } catch { return null; }
  }

  /** Programa el guardado de `text`; las llamadas seguidas sólo escriben la última. */
  schedule(text: string): void {
    this.pending = text;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /** Escribe ya lo pendiente (al construir, al cerrar la pestaña). */
  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.pending === null) return;
    const text = this.pending;
    this.pending = null;
    try { this.kv?.setItem(this.key, text); } catch { /* cuota llena: se pierde el autoguardado, no el código */ }
  }
}
