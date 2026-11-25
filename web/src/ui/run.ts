// «Construir y arrancar» (I1): ensamblar → completar la cabecera (E1) → gb_insert (que
// ya hace el reset) → el llamador reanuda el bucle. Sin DOM: se prueba con el núcleo real.
//
// Bandera CGB (0143): por defecto C0h (sólo CGB), porque el IDE apunta al CGB y así el
// programa arranca en modo CGB con sus paletas aunque no lo diga. Si el programa escribe
// él mismo 80h o C0h en $0143 (p. ej. `db $80` en la zona reservada de la cabecera), se
// respeta; un 00h no se puede distinguir del relleno de `ds`, así que para el modo de
// compatibilidad DMG hay que pedirlo con `opts.cgb = "dmg"`.
import { assemble, type AsmResult } from "../asm";
import { HeaderError, fillHeader, type CgbMode } from "../export/header";
import type { Core } from "../emu/core";

export interface BuildOptions {
  /** Nombre del fichero principal (errores y lineMap). Por defecto "main.asm". */
  file?: string;
  /** Ficheros para INCLUDE/INCBIN. */
  files?: ReadonlyMap<string, string | Uint8Array>;
  /** Resolver de INCLUDE/INCBIN para lo que no esté en `files` (p. ej. la librería de C, U1). */
  include?: (name: string, from: string) => string | Uint8Array | undefined;
  /** Conservar la WRAM (8 × 4 KB) a través del reset, para iterar sin perder estado. */
  keepWram?: boolean;
  /** Fuerza la bandera CGB; si no, la que ponga el programa en $0143 o C0h. */
  cgb?: CgbMode;
  /** Título de la cabecera; por defecto el nombre del fichero sin extensión. */
  title?: string;
}

export interface BuildResult {
  ok: boolean;
  result: AsmResult;
  /** ROM con la cabecera completa (sólo si ok). */
  rom?: Uint8Array;
  /** Errores de la cabecera (p. ej. la ROM no cabe en el MBC): ok = false. */
  headerErrors: string[];
  /** Milisegundos de ensamblado + cabecera. */
  ms: number;
}

/** Lo que run.ts usa de Core (Core lo cumple; los tests pasan el núcleo real). */
export type RunTarget = Pick<Core, "insert" | "x">;

/** Bandera CGB que corresponde a la imagen ensamblada. */
export function cgbModeFor(rom: Uint8Array, forced?: CgbMode): CgbMode {
  if (forced) return forced;
  const f = rom[0x143];
  return f === 0x80 ? "cgb" : "cgbOnly";
}

export function titleFor(file: string): string {
  return file.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "").toUpperCase().replace(/[^\x20-\x7E]/g, "_").slice(0, 15);
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Ensambla y completa la cabecera, sin tocar el núcleo. */
export function build(source: string, opts: BuildOptions = {}): BuildResult {
  const t0 = now();
  const file = opts.file ?? "main.asm";
  const result = assemble(source, { file, files: opts.files, include: opts.include });
  if (result.errors.length > 0 || result.rom.length === 0)
    return { ok: false, result, headerErrors: [], ms: now() - t0 };
  try {
    const rom = fillHeader(result.rom, {
      title: opts.title ?? titleFor(file),
      cgb: cgbModeFor(result.rom, opts.cgb),
      sections: result.sections,
    });
    return { ok: true, result, rom, headerErrors: [], ms: now() - t0 };
  } catch (e) {
    const msgs = e instanceof HeaderError ? e.issues.filter((i) => i.level === "error").map((i) => i.msg) : [String(e)];
    return { ok: false, result, headerErrors: msgs, ms: now() - t0 };
  }
}

const WRAM_BYTES = 8 * 4096;

/**
 * Construye y, si no hay errores, mete la ROM en el núcleo y lo reinicia (gb_insert hace
 * el reset; sin boot ROM el programa está en pantalla en el primer frame). Con errores el
 * núcleo no se toca: sigue lo que hubiera. El llamador reanuda el bucle si `ok`.
 */
export function buildAndRun(core: RunTarget, source: string, opts: BuildOptions = {}): BuildResult {
  const r = build(source, opts);
  if (!r.ok || !r.rom) return r;
  // gb_reset borra toda la máquina (memset del struct), WRAM incluida: copia y restauración.
  const saved = opts.keepWram ? wram(core).slice() : null;
  core.insert(r.rom);
  if (saved) wram(core).set(saved);
  return r;
}

function wram(core: RunTarget): Uint8Array {
  return new Uint8Array(core.x.memory.buffer, core.x.gb_wram() as number, WRAM_BYTES);
}
