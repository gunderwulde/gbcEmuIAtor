// Formato y lectura de los datos que muestra el panel del depurador. Sin DOM.
// Los registros de E/S vienen de gb_io(): FF00-FF7F y, en [0x80], IE (FFFF).

export const hex2 = (n: number): string => (n & 0xff).toString(16).toUpperCase().padStart(2, "0");
export const hex4 = (n: number): string => (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");

/** Banco:dirección para mostrar. Fuera de ROMX (bank −1) sólo la dirección. */
export const locText = (bank: number, addr: number): string => (bank < 0 ? "" : `${bank.toString(16).toUpperCase()}:`) + hex4(addr);

/** Bits 7-4 de F: Z N H C; una letra si está a 1, «-» si no. */
export function flagsText(f: number): string {
  return (f & 0x80 ? "Z" : "-") + (f & 0x40 ? "N" : "-") + (f & 0x20 ? "H" : "-") + (f & 0x10 ? "C" : "-");
}

/** Bits de IE/IF: VBlank, STAT, temporizador, serie, joypad (bit 0 → 4). */
const IRQ_NAMES = ["VBL", "STAT", "TIM", "SER", "JOY"] as const;
export function irqText(bits: number): string {
  const on = IRQ_NAMES.filter((_, i) => bits & (1 << i));
  return on.length ? on.join(" ") : "—";
}

/** Modo de la PPU en STAT bits 1-0 (con el LCD apagado el hardware lee 0). */
const MODES = ["0 HBlank", "1 VBlank", "2 OAM", "3 Dibujo"] as const;

export interface IoSummary {
  lcdOn: boolean;
  ly: number;
  mode: string;
  lcdc: number;
  stat: number;
  ie: number;
  if: number;
  /** KEY1 bit 7: doble velocidad activa; bit 0: cambio preparado para el próximo STOP. */
  double: boolean;
  armed: boolean;
  /** SVBK: 0 selecciona también el banco 1. */
  wramBank: number;
  vramBank: number;
}

export function ioSummary(io: ArrayLike<number>): IoSummary {
  const b = (i: number): number => io[i] ?? 0;
  const lcdc = b(0x40), stat = b(0x41), key1 = b(0x4d);
  return {
    lcdOn: (lcdc & 0x80) !== 0,
    ly: b(0x44),
    mode: MODES[stat & 3]!,
    lcdc,
    stat,
    ie: b(0x80) & 0x1f,
    if: b(0x0f) & 0x1f,
    double: (key1 & 0x80) !== 0,
    armed: (key1 & 0x01) !== 0,
    wramBank: b(0x70) & 7 || 1,
    vramBank: b(0x4f) & 1,
  };
}

/** Nº de bancos de 16 KB según el byte 0x148 de la cabecera (valores 0-8). */
export function romBankCount(sizeByte: number): number {
  return sizeByte <= 8 ? 2 << sizeByte : 2;
}

/**
 * Dirección escrita por el usuario: «$1234», «0x1234», «1234» (hex), «2:4000»
 * (banco:dirección, banco en hex) o el nombre de una etiqueta. bank null = el que esté
 * mapeado.
 */
export function parseLoc(
  text: string,
  find?: (name: string) => { bank: number; addr: number } | undefined,
): { bank: number | null; addr: number } | null {
  const s = text.trim();
  if (!s) return null;
  const m = /^(?:([0-9a-f]{1,3}):)?(?:\$|0x)?([0-9a-f]{1,4})$/i.exec(s);
  if (m) {
    const addr = parseInt(m[2]!, 16);
    const bank = m[1] === undefined ? null : parseInt(m[1], 16);
    return { bank, addr };
  }
  const sym = find?.(s);
  return sym ? { bank: sym.bank, addr: sym.addr } : null;
}

/** Rango de watchpoint: «C000», «C000-C0FF», «$C000..$C0FF». */
export function parseRange(text: string): { lo: number; hi: number } | null {
  const m = /^\s*(?:\$|0x)?([0-9a-f]{1,4})\s*(?:(?:-|\.\.)\s*(?:\$|0x)?([0-9a-f]{1,4}))?\s*$/i.exec(text);
  if (!m) return null;
  const lo = parseInt(m[1]!, 16);
  const hi = m[2] === undefined ? lo : parseInt(m[2], 16);
  return lo <= hi ? { lo, hi } : { lo: hi, hi: lo };
}

/** Texto del motivo de la última parada. */
export const STOP_TEXT: Record<string, string> = {
  pause: "En pausa",
  step: "Paso",
  breakpoint: "Breakpoint",
  watchpoint: "Watchpoint (escritura)",
  over: "Paso por encima",
  out: "Salir de la función",
  runTo: "Hasta el cursor",
  limit: "Salir: límite de instrucciones alcanzado",
};
