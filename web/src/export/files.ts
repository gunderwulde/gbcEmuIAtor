// Descarga y carga de ficheros (.gbc, .sav, .gbstate). Capa fina sobre el DOM: la lógica
// (cabecera, checksums) está en header.ts y el formato de .sav/estados lo decide el núcleo
// (Core.saveSav/loadSav/saveState/loadState en web/src/emu/core.ts).
import type { Core } from "../emu/core";
import { fillHeader, type HeaderOptions } from "./header";
import { savElapsed, stampSav } from "./sav";

/** Nombre de fichero a partir del título: sin caracteres problemáticos en ningún SO. */
export function fileName(title: string, ext: string): string {
  const base = title.trim().replace(/[^A-Za-z0-9 _.-]+/g, "_").replace(/\s+/g, "_").replace(/^[._]+|[._]+$/g, "");
  return `${base || "game"}.${ext}`;
}

export function downloadBytes(data: Uint8Array, name: string, mime = "application/octet-stream"): void {
  const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // El navegador ya ha tomado el blob; se libera en la siguiente vuelta del bucle.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Abre el selector de ficheros; null si el usuario cancela. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

export async function readFile(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** Completa la cabecera de la imagen ensamblada y la descarga. Devuelve la ROM final. */
export function exportGbc(image: Uint8Array, opts: HeaderOptions): Uint8Array {
  const rom = fillHeader(image, opts);
  downloadBytes(rom, fileName(opts.title, opts.cgb === "dmg" ? "gb" : "gbc"));
  return rom;
}

const unixNow = () => Date.now() / 1000;

/** Descarga la RAM con pila (+ RTC) del cartucho; false si el cartucho no tiene pila.
 *  (MBC3+TIMER sin RAM tiene sramSize 0 pero sí .sav: los 48 bytes del RTC.) */
export function exportSav(core: Core, title: string): boolean {
  const sav = core.saveSav();
  if (sav.length === 0) return false;
  downloadBytes(stampSav(sav, core.sramSize(), unixNow()), fileName(title, "sav"));
  return true;
}

/** Carga un .sav y adelanta el RTC el tiempo real transcurrido desde su marca. */
export async function importSav(core: Core, file: File): Promise<void> {
  const sav = await readFile(file);
  core.loadSav(sav);
  core.rtcAdvance(savElapsed(sav, core.sramSize(), unixNow()));
}

export function exportState(core: Core, title: string): void {
  downloadBytes(core.saveState(), fileName(title, "gbstate"));
}

export async function importState(core: Core, file: File): Promise<void> {
  core.loadState(await readFile(file));
}
