// Librería de C de usuario (L1): ficheros que resuelven `#include` y `#pragma link` del
// compilador (web/src/cc), y la lista de ejemplos en C. Sin DOM: lo usan la UI (U1) y
// los tests. La API está documentada en ./README.md.
import gbcH from "./gbc.h?raw";
import gbcC from "./gbc.c?raw";
import gbcVblC from "./gbc_vbl.c?raw";
import gbcAsm from "./gbc.asm?raw";
import gbcFontAsm from "./gbc_font.asm?raw";
import stringH from "./string.h?raw";
import stringAsm from "./string.asm?raw";
import stdlibH from "./stdlib.h?raw";
import stdlibC from "./stdlib.c?raw";
import stdlibAsm from "./stdlib.asm?raw";

/** Ficheros de la librería por nombre (sin ruta). */
export const CLIB_FILES: ReadonlyMap<string, string> = new Map([
  ["gbc.h", gbcH],
  ["gbc.c", gbcC],
  ["gbc_vbl.c", gbcVblC],
  ["gbc.asm", gbcAsm],
  ["gbc_font.asm", gbcFontAsm],
  ["string.h", stringH],
  ["string.asm", stringAsm],
  ["stdlib.h", stdlibH],
  ["stdlib.c", stdlibC],
  ["stdlib.asm", stdlibAsm],
]);

/** Texto de un fichero de la librería; acepta `<gbc.h>`, `"gbc.h"` o una ruta
 *  (`lib/gbc.h`): sólo cuenta el último componente. `undefined` si no es de la librería. */
export function clibResolve(name: string): string | undefined {
  return CLIB_FILES.get(name.replace(/^.*[\\/]/, ""));
}

/** Para `compile(files, { includeResolver })`: lo que no esté en `files` se busca aquí. */
export function includeResolver(name: string, _from: string): string | undefined {
  return clibResolve(name);
}

export { C_EXAMPLES, cExampleById, type CExample } from "./examples";
