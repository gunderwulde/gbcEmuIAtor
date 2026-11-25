// U1: ejemplos del menú del editor. Los de ensamblador (I1, web/src/asm/examples) y los
// de C de la librería (L1, web/src/clib/examples.ts). Todo homebrew propio, sin material
// de Nintendo.
import { EXAMPLES } from "../editor/examples";
import { clibExamples } from "./deps";

export interface TabExample {
  id: string;
  title: string;
  lang: "asm" | "c";
  /** Ficheros que se abren como pestañas (nombre → texto). */
  files: ReadonlyMap<string, string>;
  /** El que se ejecuta. */
  main: string;
}

const asmExamples: TabExample[] = EXAMPLES.map((e) => ({
  id: `asm:${e.id}`, title: e.title, lang: "asm", files: new Map([[`${e.id}.asm`, e.source]]), main: `${e.id}.asm`,
}));

export const C_EXAMPLES: readonly TabExample[] =
  clibExamples.map((e) => ({ id: `c:${e.id}`, title: e.title, lang: "c" as const, files: e.files, main: e.main }));
export const ASM_EXAMPLES: readonly TabExample[] = asmExamples;

/** Ejemplo C con el que arranca un proyecto nuevo: el 01 de L1 (hola mundo). Sin ejemplos de
 *  L1 (no debería pasar) el proyecto arranca sólo con main.asm. */
export const DEFAULT_C_EXAMPLE: TabExample | undefined = C_EXAMPLES[0];
export const DEFAULT_ASM_EXAMPLE: TabExample = asmExamples[0]!;

export function tabExampleById(id: string): TabExample | undefined {
  return C_EXAMPLES.find((e) => e.id === id) ?? ASM_EXAMPLES.find((e) => e.id === id);
}

/** ¿Es `text` el de algún ejemplo? (para no pedir confirmación al sustituirlo). */
export function isExampleText(text: string): boolean {
  for (const e of [...C_EXAMPLES, ...ASM_EXAMPLES]) for (const t of e.files.values()) if (t === text) return true;
  return false;
}
