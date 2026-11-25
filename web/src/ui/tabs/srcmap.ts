// U1: de un programa C ensamblado a (fichero C, línea). Puro (sin DOM).
//
// El compilador (K1, web/src/cc/README.md) devuelve cLineMap = {file, line, asmLine}: la
// línea del ensamblador generado (1-based) donde empieza el código de cada sentencia C
// (un comentario "; main.c:9: …"). El código de esa sentencia son las líneas que la
// siguen hasta la próxima marca o hasta la primera línea vacía: el generador separa cada
// función, la librería enlazada, el runtime y los datos con una línea vacía (como en
// zxemuIAtor). Así el epílogo cuenta como la última sentencia de la función y el código
// del crt0 o de la librería en ensamblador no es de ninguna línea C.
//
// Con eso, el lineMap del ensamblador (banco, dirección, línea del generado) se reescribe
// a líneas C, y el depurador de D1 (que sólo entiende lineMap) pone breakpoints en líneas
// C y resalta la línea C actual sin saber que existe C. Lo que no es de ninguna línea C
// queda en la pestaña del ensamblador generado.
import type { AsmLineMapEntry } from "../../asm";
import type { CLine } from "./deps";

/** Para cada línea del ensamblador generado (1-based), índice en cLineMap o −1. */
export function asmLineOwners(asm: string, cLineMap: readonly CLine[]): Int32Array {
  const lines = asm.split("\n");
  const mark = new Int32Array(lines.length + 2).fill(-1);
  cLineMap.forEach((c, k) => { if (c.asmLine >= 1 && c.asmLine <= lines.length) mark[c.asmLine] = k; });
  const owner = new Int32Array(lines.length + 2).fill(-1);
  let cur = -1;
  for (let l = 1; l <= lines.length; l++) {
    if (mark[l]! >= 0) cur = mark[l]!;
    else if (lines[l - 1]!.trim() === "") cur = -1;
    owner[l] = cur;
  }
  return owner;
}

/**
 * lineMap del ensamblado del texto generado (`genName`) → lineMap sobre los ficheros C.
 * Las entradas de otros ficheros (INCLUDE) se dejan tal cual.
 */
export function mapToC(
  asm: string,
  cLineMap: readonly CLine[],
  lineMap: readonly AsmLineMapEntry[],
  genName: string,
): AsmLineMapEntry[] {
  const owner = asmLineOwners(asm, cLineMap);
  return lineMap.map((e) => {
    if (e.file !== genName) return e;
    const k = owner[e.line] ?? -1;
    if (k < 0) return e;
    const c = cLineMap[k]!;
    return { ...e, file: c.file, line: c.line };
  });
}

/** Línea C de la que sale la línea `asmLine` del generado, o undefined. */
export function cLineOf(owners: Int32Array, cLineMap: readonly CLine[], asmLine: number): CLine | undefined {
  const k = owners[asmLine] ?? -1;
  return k < 0 ? undefined : cLineMap[k];
}
