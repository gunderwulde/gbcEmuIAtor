# web/src/cc — compilador C → SM83 (K1)

Genera **fuente de ensamblador** para el ensamblador de A1 (`web/src/asm`). La ABI
(convención de llamada, locales, nombres, secciones, bancos, crt0, helpers) estará en
[docs/c-abi.md](../../../docs/c-abi.md), que K1 escribe **antes** de que L1 empiece.

## Origen

El front-end (preprocesador, lexer, parser, AST con posiciones, comprobación de tipos)
se **copia** de `zxemuIAtor/web/src/cc` y se adapta; no se comparte como paquete (cada
proyecto evoluciona por su lado). El generador de código y el peephole son nuevos: el
SM83 no tiene IX/IY, `EX DE,HL`, `ADC HL`/`SBC HL`, `DJNZ` ni E/S por puertos, y sí tiene
`LD [HL+]`, `LDH`, `LD HL,SP+e` y `SWAP`.

## API

```ts
import { compile } from "./cc";

const r = compile(files, { main: "main.c" });
// files: Map<nombre, texto>  (todos los .c se compilan juntos: programa completo)
// r.asm       fuente lista para assemble(), con SECTIONs (código en ROM0/ROMX, datos y BSS en WRAM)
// r.errors    Array<{file, line, col, msg, severity: "error" | "warning"}>
// r.cLineMap  Array<{file, line, asmLine}>
```

Opciones (`CcOptions`):

| Opción | Por defecto | Qué hace |
|---|---|---|
| `main` | — | Fichero principal (debe definir `main`) |
| `includeResolver(name, from)` | ninguno | Texto de `#include`/`#pragma link` que no esté en `files` (la librería de L1) |
| `peephole` | `true` | Optimizador de mirilla |
| `crt0` | `true` | Incluir el arranque estándar (cabecera, pila, BSS, `.data`, rutina de OAM DMA en HRAM) |

Pragmas y extensiones de la GB:

| Construcción | Qué hace |
|---|---|
| `#pragma bank n` | Lo que sigue en el fichero va a ROMX banco n |
| `__banked` | Función llamable desde otro banco (trampolín en ROM0 que cambia el banco del MBC y lo restaura) |
| `__at(0xFF40) unsigned char LCDC;` | Variable en dirección fija (registros de E/S) |
| `__naked`, `__asm … __endasm;` | Como en zxemuIAtor |
| `__interrupt(vblank)` | Rutina de interrupción: guarda registros, `RETI`, y se instala en el vector |

Si hay algún error (no aviso), `asm` es la cadena vacía.

## cLineMap (para U1/D1: PC → línea C)

Igual que en zxemuIAtor: comentario `; fichero:línea: texto C` antes del código de cada
línea; `asmLine` es la línea de ese comentario. Con el `lineMap` del ensamblador (que
trae `bank`) se pasa a `banco:dirección`.

## Decisiones de diseño (desde la v1)

Lo que en zxemuIAtor llegó tarde (K2) aquí se hace de entrada, porque en el SM83 el
marco en pila es aún más caro:

1. **Locales y parámetros en direcciones fijas de WRAM** para funciones no recursivas
   (el grafo de llamadas se conoce); las zonas de funciones que nunca están vivas a la
   vez se solapan. Marco en pila sólo para las recursivas (o las llamadas por
   `__banked` desde varias ramas, a decidir).
2. **Condiciones sobre flags:** `if (x < 10)` → `cp`/`jr`, `&&`/`||` en saltos.
3. **Aritmética de 8 bits** cuando el resultado se trunca a `char`.
4. **Comprobación de tamaños**: código, datos y BSS deben caber en su zona; si no, error
   del compilador (no esperar al ensamblador).

Medición en **ciclos M** en el núcleo (`core-probe`), no en milisegundos.

## Subconjunto

Igual que zxemuIAtor v1: `char` (sin signo por defecto), `short`/`int` de 16 bits,
`unsigned`, punteros, arrays, `struct`, `typedef`, `enum`, `const`, `static`, globales
inicializados, recursión, todo el control de flujo y los operadores, preprocesador
simple. **Fuera de v1:** `float`, `long`, `union`, punteros a función, varargs de
usuario, bitfields, VLA.

## Tests

`tests/cc/`: programas C con salida esperada escrita a mano, ejecutados en el núcleo
real con la salida por el puerto serie; oráculo adicional con `cc` nativo e `int16_t`;
tests de errores con línea correcta; banco de ciclos M (fib, criba, burbuja, blit).
