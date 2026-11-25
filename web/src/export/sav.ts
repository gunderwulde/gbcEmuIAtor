// Marca de tiempo del .sav con RTC (MBC3). TS puro, sin DOM.
//
// Formato BGB/VBA (docs/gbc-hardware.md §10.4, core/src/cart.c): la RAM tal cual y, si
// hay RTC, 48 bytes al final: 5 × u32 registros actuales, 5 × u32 latcheados y una marca
// de tiempo Unix u64 little-endian (VBA antiguo: 44 bytes, marca u32). El núcleo escribe
// la marca a 0 porque no conoce la hora real (determinismo): la pone el frontend al
// exportar y, al importar, le pasa los segundos transcurridos con gb_rtc_advance.

export const RTC_FOOTER = 48;

/** Copia del .sav con la marca de tiempo `unixSeconds` (sin cambios si no hay RTC). */
export function stampSav(sav: Uint8Array, ramSize: number, unixSeconds: number): Uint8Array {
  const out = sav.slice();
  if (sav.length !== ramSize + RTC_FOOTER) return out;
  const v = new DataView(out.buffer, out.byteOffset + ramSize + 40, 8);
  v.setBigUint64(0, BigInt(Math.max(0, Math.floor(unixSeconds))), true);
  return out;
}

/** Segundos reales desde que se guardó el .sav (0 si no hay RTC, marca o es futura). */
export function savElapsed(sav: Uint8Array, ramSize: number, nowSeconds: number): number {
  const extra = sav.length - ramSize;
  if (extra !== RTC_FOOTER && extra !== RTC_FOOTER - 4) return 0;
  const v = new DataView(sav.buffer, sav.byteOffset + ramSize + 40, extra - 40);
  const ts = extra === RTC_FOOTER ? Number(v.getBigUint64(0, true)) : v.getUint32(0, true);
  if (ts === 0 || ts > nowSeconds) return 0;
  return Math.floor(nowSeconds - ts);
}
