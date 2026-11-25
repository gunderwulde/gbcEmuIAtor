// Ejemplos en C (L1), de menos a más. Cada uno es un programa completo para el
// compilador de web/src/cc; la librería (gbc.h y compañía) la resuelve includeResolver.
import ex01 from "./examples/01-hola.c?raw";
import ex02 from "./examples/02-colores.c?raw";
import ex03 from "./examples/03-tiles.c?raw";
import ex04 from "./examples/04-scroll.c?raw";
import ex05 from "./examples/05-sprite.c?raw";
import ex06 from "./examples/06-sonido.c?raw";
import ex07 from "./examples/07-ventana.c?raw";
import ex08 from "./examples/08-fundido.c?raw";
import ex09 from "./examples/09-interrupciones.c?raw";
import ex10 from "./examples/10-estrellas.c?raw";
import ex10save from "./examples/10-save.asm?raw";

export interface CExample {
  /** Identificador estable (p. ej. "c01-hola"). */
  id: string;
  /** Título para el menú. */
  title: string;
  /** Ficheros del ejemplo (nombre → texto); la librería la resuelve includeResolver. */
  files: ReadonlyMap<string, string>;
  /** Fichero principal (el que define main). */
  main: string;
}

const one = (id: string, title: string, main: string, text: string, extra: [string, string][] = []): CExample => ({
  id,
  title,
  files: new Map([[main, text], ...extra]),
  main,
});

export const C_EXAMPLES: readonly CExample[] = [
  one("c01-hola", "C 01 · Hola, mundo", "01-hola.c", ex01),
  one("c02-colores", "C 02 · Las 8 paletas", "02-colores.c", ex02),
  one("c03-tiles", "C 03 · Tiles propios y mapas", "03-tiles.c", ex03),
  one("c04-scroll", "C 04 · Scroll y joypad", "04-scroll.c", ex04),
  one("c05-sprite", "C 05 · Un sprite", "05-sprite.c", ex05),
  one("c06-sonido", "C 06 · Sonido: teclado", "06-sonido.c", ex06),
  one("c07-ventana", "C 07 · La ventana como marcador", "07-ventana.c", ex07),
  one("c08-fundido", "C 08 · HDMA y fundidos", "08-fundido.c", ex08),
  one("c09-interrupciones", "C 09 · Interrupciones y doble velocidad", "09-interrupciones.c", ex09),
  one("c10-estrellas", "C 10 · Lluvia de estrellas (juego)", "10-estrellas.c", ex10, [["10-save.asm", ex10save]]),
];

export function cExampleById(id: string): CExample | undefined {
  return C_EXAMPLES.find((e) => e.id === id);
}
