# web/src/asm — ensamblador SM83 (A1)

Ensamblador de dos pasadas en TypeScript puro (sin DOM, sin dependencias, determinista)
con sintaxis **compatible con un subconjunto de RGBDS**, para que el código y los
tutoriales de la comunidad (gbdev, *GB ASM Tutorial*) funcionen sin cambios en lo
habitual. A diferencia de RGBDS no hay enlazador aparte: el ensamblador coloca las
secciones y produce directamente la imagen de ROM.

La tabla de instrucciones vive en `web/src/sm83isa/` y la comparte el desensamblador
(`opByByte`, `cbOpByByte`, `decode`).

Ficheros: `lexer.ts` (una línea → tokens), `assembler.ts` (pasadas, colocación, salida),
`index.ts` (exporta `assemble` y los tipos), `examples/hello.asm`.

## API

```ts
import { assemble } from "./asm";

const r = assemble(source, {
  file: "main.asm",                         // nombre para errores y lineMap
  files: new Map([["defs.inc", "…"], ["gfx.bin", bytes]]), // INCLUDE (texto) e INCBIN (binario)
  include: (name, from) => string | Uint8Array | undefined, // alternativa a `files`
  defines: { DEBUG: 1, NAME: "texto" },     // número → EQU, texto → EQUS
  romBanks: undefined,                      // si se da, tamaño fijo; si no, potencia de 2 mínima (≥ 2)
  entry: undefined,                         // etiqueta de entrada; por defecto 0x0100
});
// r.rom       Uint8Array: imagen completa (bancos de 16 KB, relleno 0xFF); vacía si hay errores
// r.sections  Array<{name, kind, bank, addr, size}>
// r.entry     dirección de entrada (0x0100 o la de `opts.entry`)
// r.symbols   Map<nombre, {bank, addr}>  (sólo etiquetas; locales como "Global.local")
// r.lineMap   Array<{bank, addr, line, file, len}>  (cada línea que emite bytes)
// r.errors    Array<{line, col, file, msg}>  (se acumulan, nunca se lanzan)
// r.warnings  Array<{line, col, file, msg}>  (WARN, ASSERT WARN, PRINT/PRINTLN) — extra
```

La cabecera (logo, checksums, tipo de cartucho) la completa `web/src/export` (E1), no el
ensamblador: los programas reservan `$0104–$014F` con `DS` y el ensamblador no calcula
checksums. Los errores dentro de macros apuntan a la línea del cuerpo de la macro y añaden
`(in macro 'x')`; los de un INCLUDE llevan el nombre de ese fichero.

## Sintaxis soportada

- **Instrucciones:** todas las de la tabla SM83 con la escritura de RGBDS: `ld [hl+], a`,
  `ld a, [hli]`, `ld [hld], a`, `ldi`/`ldd`, `ldh [c], a`, `ld [c], a`, `ld a, [$ff00+c]`,
  `ldh a, [$ff44]` (o `[$44]`), `ld hl, sp + 4`, `ldhl sp, 4`, `add sp, -2`, `jp hl`,
  `jp [hl]`, `stop` (emite `10 00`), `halt`, ALU con o sin `a,` (`cp 5`). Corchetes o
  paréntesis indistintamente: `(expr)` completo es memoria cuando la instrucción tiene esa
  forma (`ld a,(1+2)` = `ld a,[3]`) y si no, inmediato (`add (4)`). `bit`/`res`/`set`/`rst`
  aceptan expresiones y referencias hacia delante.
- **Números:** `$FF`, `0xFF`, `%1010`, `0b1010`, `&17`, `0o17`, `123`, `_` como separador,
  `` `01233210 `` (fila de 8 píxeles 2bpp → plano bajo en el byte bajo; con `dw` da los 2
  bytes en orden de VRAM), `"texto"` (con `CHARMAP`; un carácter en una expresión).
- **Símbolos:** etiquetas globales (`Main:`, `Main::`), locales (`.loop`, `.loop:`,
  `Main.loop`), anónimas (`:` con `:-`, `:--`, `:+`…), `@` (dirección actual).
- **Expresiones (precedencia de rgbasm(5)):** unarios `- + ~ !` > `**` (derecha) >
  `* / %` > `<< >> >>>` > `& | ^` > `+ -` > comparaciones > `&& ||`. Enteros de 32 bits,
  división y módulo redondeando hacia abajo. Funciones: `HIGH()`, `LOW()`, `BANK(sím|@|"sec")`,
  `SIZEOF("sec")`, `STARTOF("sec")`, `DEF(sím)`, `ISCONST(expr)`, `STRLEN("…")`. La resta de
  dos etiquetas de la misma sección es constante aunque la sección sea flotante.
- **Directivas:** `SECTION [FRAGMENT] "n", ROM0|ROMX|VRAM|SRAM|WRAM0|WRAMX|HRAM[$dir],
  BANK[n], ALIGN[bits[, ofs]]`, `ENDSECTION`, `PUSHS/POPS`; `DB/DW/DL`, `DS n[, relleno…]`
  (relleno 0 por defecto, como rgbasm), `INCBIN "f"[, ini[, len]]`, `INCLUDE "f"`;
  `DEF x EQU v`, `x EQU v`, `DEF x = v`, `x = v`, `x SET v`, `+= -= *= /= %= &= |= ^= <<= >>=`,
  `REDEF`, `EQUS`, `PURGE`, `RSRESET/RSSET/RB/RW/RL` (`_RS`); interpolación `{sím}` y
  `{d:sím}`/`{x:…}`/`{X:…}`/`{b:…}`; `MACRO nombre … ENDM` (y `nombre: MACRO`) con `\1…\9`,
  `\<n>`, `\#`, `\@`, `_NARG`, `SHIFT [n]`, `\,` en argumentos; `IF/ELIF/ELSE/ENDC`;
  `REPT n … ENDR`, `FOR v, [ini,] fin[, paso] … ENDR`, `BREAK`; `CHARMAP` (coincidencia más
  larga); `ASSERT [WARN|FAIL|FATAL,] cond[, "msg"]` (se reevalúa tras la colocación si no es
  constante), `STATIC_ASSERT`; `PRINT/PRINTLN`, `WARN` (van a `warnings`), `FAIL`;
  `EXPORT/GLOBAL` (se aceptan y se ignoran: todo es visible). Continuación de línea con `\`
  al final y comentarios `;` y `/* … */` (en la misma línea).

## Diferencias con RGBDS

- No hay objetos ni enlazador: un solo programa (con `INCLUDE`) → ROM directamente.
- No soportados (error explícito): `SECTION UNION`/`NEXTU`, `LOAD … ENDL`, `OPT`, `NEWCHARMAP`/
  `SETCHARMAP`, `MACRO` con `ENDM` en la misma línea, `REDEF` de macros, punto fijo
  (`MUL`, `DIV`, `.q`…), funciones de cadena salvo `STRLEN` (`STRCAT`, `STRSUB`…), `EQUS`
  multilinea, comentarios `/* */` de varias líneas.
- `PRINT/PRINTLN` no escriben en consola: generan un aviso en `warnings` (números como `$HEX`).
- `ASSERT FATAL` se trata como `FAIL` (no detiene el ensamblado; los errores se acumulan).
- `ld a, (expr)` entre paréntesis completos es memoria (`[expr]`), como en la sintaxis
  clásica; rgbasm moderno sólo acepta corchetes.
- Los límites de bancos: ROMX 1–511, VRAM 0–1, SRAM 0–15, WRAMX 1–7 (lo que permite el CGB
  con MBC5); `opts.romBanks` limita ROMX.
- La ROM se rellena con `$FF` (rgblink usa `$00` por defecto salvo `-p`).

## Colocación de secciones

1. Secciones con dirección y banco fijos; luego con banco fijo o dirección fija; luego las
   flotantes. Dentro de cada grupo, de mayor a menor tamaño (y alineación), en el primer
   hueco del tipo pedido (primer banco libre para `ROMX`/`WRAMX`/…).
2. Error si no caben, citando la sección y el espacio libre de cada banco (lección de
   zxemuIAtor: un desbordamiento silencioso cuelga el programa mucho después); error si se
   solapan dos fijas, citando ambas.
3. `ROM0` en 0000–3FFF (banco 0), `ROMX` en 4000–7FFF (bancos ≥ 1), RAM según su zona;
   las de RAM no generan bytes, sólo símbolos (en RAM sólo se admite `DS n`).
4. Tamaño de la ROM: potencia de 2 ≥ 2 bancos que contenga el banco más alto usado.

## Rendimiento

Ensamblar 5 000 líneas en menos de 50 ms (`tests/asm/asm.bench-test.ts`, en
`npm run test:perf`). Medido: mediana ≈ 17 ms.

## Tests

`tests/asm/isa.test.ts`: los 244 opcodes base contra una lista escrita a mano (texto →
bytes → ciclos M, de Pan Docs) y los bloques regulares 40–BF y CB con la fórmula de
codificación documentada. `tests/asm/assembler.test.ts`: números, expresiones, símbolos,
directivas, macros, control de flujo, secciones, errores, contrato de salida, un programa
*golden* verificado a mano y `examples/hello.asm`. No hay RGBDS en el entorno: los bytes
*golden* están verificados a mano, no generados con rgbasm.
