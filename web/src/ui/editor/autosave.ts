// Acceso a localStorage sin romper cuando no se puede usar (modo privado, cuota…). El
// guardado de las pestañas (con su espera) está en web/src/ui/tabs/editor.ts.

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
