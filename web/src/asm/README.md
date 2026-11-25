# web/src/asm — ensamblador SM83 (A1)

Ensamblador de dos pasadas en TypeScript puro (sin DOM, sin dependencias, determinista)
con sintaxis **compatible con un subconjunto de RGBDS**, para que el código y los
tutoriales de la comunidad (gbdev, *GB ASM Tutorial*) funcionen sin cambios en lo
habitual. A diferencia de RGBDS no hay enlazador aparte: el ensamblador coloca las
secciones y produce directamente la imagen de ROM.

La tabla de instrucciones vive en `web/src/sm83isa/` y la comparte el desensamblador.

## API

```ts
import { assemble } from "./assembler";

const r = assemble(source, {
  file: "main.asm",
  include: (name, from) => string | Uint8Array | undefined,  // INCLUDE e INCBIN
  defines: { DEBUG: 1 },
  romBanks: undefined,          // si se da, tamaño fijo; si no, la potencia de 2 mínima (≥ 2)
});
// r.rom       Uint8Array con la imagen completa (bancos de 16 KB); sin cabecera completada
// r.sections  Array<{name, kind, bank, addr, size}>
// r.entry     dirección de la etiqueta de entrada (por defecto 0100h)
// r.symbols   Map<nombre, {bank, addr}>
// r.lineMap   Array<{file, line, bank, addr, len}>  (para depurador y breakpoints)
// r.errors    Array<{file, line, col, msg}>
```

La cabecera (logo, checksums, tipo de cartucho) la completa `web/src/export` (E1), no el
ensamblador: así se puede probar cada cosa por separado. Si hay errores, `rom` va vacía.

## Sintaxis soportada (v1)

- **Instrucciones:** las de la tabla SM83 con la escritura de RGBDS: `ld [hl+], a`,
  `ld a, [hli]`, `ldh [c], a`, `ldh a, [$ff44]`, `ld hl, sp + 4`, `add sp, -2`,
  `jp hl`, `stop`, `halt`. Corchetes o paréntesis indistintamente.
- **Números:** `$FF`, `%1010`, `&17` (octal), `123`, `` `01233210 `` (fila de 8 píxeles
  2bpp → 2 bytes), `"texto"` (con `CHARMAP`).
- **Símbolos:** etiquetas globales (`Main:` y `Main::` exportada), locales (`.loop`,
  `Main.loop`), anónimas (`:` con `:-`/`:+`), `@` (dirección actual).
- **Expresiones:** `+ - * / % & | ^ ~ << >> == != < > <= >= && || !`, `HIGH()`, `LOW()`,
  `BANK(sím)`, `BANK("sección")`, `SIZEOF("sección")`, `STARTOF("sección")`, `DEF(sím)`.
- **Directivas:** `SECTION "nombre", ROM0|ROMX|VRAM|SRAM|WRAM0|WRAMX|HRAM[$dir], BANK[n],
  ALIGN[n]`; `DB/DW/DS` (también `DS n, valor`), `INCBIN "f"[, ini[, len]]`,
  `INCLUDE "f"`, `DEF x EQU v`, `x EQU v`, `DEF x = v` (redefinible), `EQUS`,
  `MACRO nombre … ENDM` con `\1…\9`, `\@`, `_NARG`, `SHIFT`; `IF/ELIF/ELSE/ENDC`,
  `REPT n … ENDR`, `FOR v, n … ENDR`, `CHARMAP`, `ASSERT cond, "msg"`, `PRINTLN`
  (aviso en la salida), `EXPORT`.
- **Fuera de v1:** `UNION/NEXTU`, `LOAD` (código que se copia a RAM: se escribe a mano),
  `RSRESET/RB/RW` `[decidir en A1 si se añaden; los usan muchos tutoriales]`,
  `PUSHS/POPS`, `OPT`, enlazado de varios objetos.

## Colocación de secciones

1. Secciones con dirección y banco fijos.
2. Secciones flotantes de mayor a menor tamaño, en el primer hueco del tipo pedido.
3. Error si no caben, citando la sección y el espacio libre de cada banco (lección de
   zxemuIAtor: un desbordamiento silencioso cuelga el programa mucho después).
4. `ROM0` en 0000–3FFF (banco 0), `ROMX` en 4000–7FFF (bancos ≥ 1), RAM según su zona;
   las de RAM no generan bytes, sólo símbolos (salvo `DB` en RAM, que es error).

## Rendimiento

Ensamblar 5 000 líneas en menos de 50 ms (`tests/asm/*.bench-test.ts`, en
`npm run test:perf`).

## Tests

`tests/asm/`: tabla de opcodes contra referencia escrita a mano; cada directiva; macros;
colocación y errores; ROM *golden* generada una vez con RGBDS real fuera del repo e
idéntica byte a byte.
