# web/src/cc — compilador C → SM83 (K1)

Genera **fuente de ensamblador** para el ensamblador de A1 (`web/src/asm`). La ABI
(tipos, convención de llamada, marcos, mapa de memoria, crt0, interrupciones, bancos,
runtime) está en [docs/c-abi.md](../../../docs/c-abi.md).

## Ficheros

| Fichero | Qué |
|---|---|
| `preproc.ts` | Preprocesador: `#include` (con `includeResolver`), `#define` con parámetros, `#if/#ifdef/#elif`, `#pragma bank/link`, `__LINE__`/`__FILE__` |
| `lexer.ts` | Tokens con fichero:línea:columna |
| `parser.ts` | Parser + comprobación de tipos (C99 6.5) → AST tipado; grafo de referencias para el enlace |
| `types.ts` | Tipos, `sizeOf`, compatibilidad (`sameType`, structs entre unidades C99 6.2.7) |
| `codegen.ts` | Generador SM83: expresiones en HL/A, condiciones sobre flags, marcos estáticos o de pila |
| `runtime.ts` | Vectores, crt0, OAM DMA en HRAM, `__bcall` y helpers (`__mul16`, `__divu16`…) |
| `peephole.ts` | Optimizador de mirilla (respeta `volatile`/`__at` y los bloques `__asm`) |
| `index.ts` | `compile()`: unidades, enlace, eliminación de código muerto, marcos, tamaños, secciones, `cLineMap` |

El front-end se copió de `zxemuIAtor/web/src/cc` y se adaptó (16 bits, `char` sin signo,
`__at`, `__banked`, `__interrupt`, `#pragma bank`). El generador, el runtime y el
peephole son nuevos: el SM83 no tiene IX/IY, `EX DE,HL`, `ADC HL`/`SBC HL`, `DJNZ` ni
E/S por puertos, y sí tiene `LD [HL+]`, `LDH`, `LD HL,SP+e`, `ADD SP,e` y `SWAP`.

## API

```ts
import { compile } from "./cc";

const r = compile(files, { main: "main.c", includeResolver });
// files: Map<nombre, texto>; se compila main y lo que traiga con #pragma link "x.c" / "x.asm"
// r.asm       fuente lista para assemble()/build() (vacía si hay errores)
// r.errors    Array<{file, line, col, msg, severity: "error" | "warning"}>
// r.cLineMap  Array<{file, line, asmLine}>   (asmLine 1-based en r.asm)
// r.emitted / r.removed   funciones emitidas / eliminadas por no alcanzables
// r.frames    Map<función, {conv: "static" | "stack", base?, size}>
// r.usage     {rom0, banks: Map<banco, bytes>, wram0: {oam, frames, data, bss, stack}}
```

Opciones (`CcOptions`):

| Opción | Por defecto | Qué hace |
|---|---|---|
| `main` | — | Fichero principal (debe definir `main`) |
| `includeResolver(name, from)` | ninguno | Texto de `#include`/`#pragma link` que no esté en `files` (la librería de L1) |
| `peephole` | `true` | Optimizador de mirilla |
| `crt0` | `true` | Vectores, entrada en `$100` y arranque estándar |
| `stackSize` | `512` | Bytes de pila reservados en WRAM0 (cuentan en la comprobación de tamaño) |

Pragmas y extensiones de la GB (detalle en docs/c-abi.md §5–§9):

| Construcción | Qué hace |
|---|---|
| `#pragma bank n` | Lo que sigue en el fichero (código, cadenas, `const`) va a ROMX banco n |
| `__banked` | Llamable desde otro banco, por el trampolín `__bcall` de ROM0 |
| `__at(0xFF40) unsigned char LCDC;` | Variable en dirección fija (`DEF … EQU`) |
| `__naked`, `__asm … __endasm;` | Sin prólogo/epílogo; ensamblador en línea |
| `__interrupt(vblank)` | Rutina de interrupción: guarda registros, `reti`, `jp` en su vector |
| `#pragma link "f.c"` / `"f.asm"` | Añade una unidad C o un fichero de ensamblador (una vez) |

## cLineMap (para U1/D1: PC → línea C)

Antes del código de cada línea C se emite `; fichero:línea: texto C`; `asmLine` es la
línea (1-based) de ese comentario en `r.asm`. Con el `lineMap` del ensamblador (que trae
`bank`) se pasa a `banco:dirección`.

## Decisiones (y por qué)

1. **Marcos estáticos por defecto.** Parámetros y locales de las funciones no recursivas
   y no reentrantes viven en direcciones fijas de WRAM (`__fr_<f>`), solapadas entre
   funciones que nunca están vivas a la vez (Tarjan para las recursivas, una región por
   raíz: main, cada ISR, cada función nombrada desde asm). Leer una local cuesta lo
   mismo en los dos casos (`ld hl,nn` y `ld hl,sp+n` son 3 ciclos M), pero en un marco
   estático las de 8 bits se leen y escriben con `ld a,[nn]`/`ld [nn],a` sin tocar HL, una
   de 16 se guarda desde HL sin otro par para la dirección, y no hay prólogo `add sp` ni
   copia de argumentos (el llamador los escribe directamente en el marco). Convención de
   pila sólo cuando hace falta: recursión, reentrada, asm, `&f`, `__naked`, variádicas.
2. **Primer argumento y retorno en A/HL**: el generador evalúa todo en A (8 bits) o HL
   (16 bits); así llamar y volver no mueve registros.
3. **Condiciones sobre flags** (`branch`): `if (x < 10)`, `&&`, `||` y `!` saltan
   directamente sin materializar 0/1; comparaciones con signo con `xor $80` sobre el
   byte alto.
4. **Aritmética de 8 bits** cuando el resultado se trunca a `char` (`+ - & | ^`), y
   comparaciones y `switch` sobre `char` con `cp`.
5. **Por constante, en línea**: desplazamientos siempre; multiplicación por potencias
   de 2 y por constantes pequeñas con sumas; división por potencias de 2 con
   desplazamientos (con signo, con la corrección de redondeo hacia cero) y módulo sin
   signo con `and`. El resto, helpers del runtime (HL op DE → HL).
6. **`switch` denso** (≥ 4 casos, rango ≤ 3·casos) con tabla de saltos `jp hl`.
7. **Eliminación de código muerto** desde main, las ISR y lo nombrado en asm: la
   librería entera puede enlazarse y sólo se emite lo usado.
8. **Tamaños comprobados por el compilador** (ROM0, cada banco, WRAM0 con desglose
   OAM/marcos/data/BSS/pila), señalando la función o variable que ya no cabe.

## Medidas

`npm run test:perf` (`tests/cc/cc.bench-test.ts`), Node 26, Windows 11:

| Medida | Valor |
|---|---|
| Compilar 2110 líneas de C (7 ficheros, 100 funciones `__banked` en 5 bancos, 41 K líneas de asm) | mediana **160 ms** (mín 157, máx 190) |
| Ejemplos de L1 (10, con la librería) | 11–38 ms cada uno |

Ciclos M del código generado (`core-probe.wasm`, de la entrada en `main` a la vuelta al
crt0, a paso de instrucción):

| Programa | Ciclos M | Comprobación |
|---|---|---|
| `fib(15)` recursivo (convención de pila) | 119 372 | 610 |
| Criba de Eratóstenes hasta 1024 | 202 739 | 172 primos |
| Burbuja de 64 `int` | 358 823 | −20…43 ordenado |
| Blit de 40 sprites × 10 frames (structs, `signed char`) | 122 978 | sprite 5 = (27, 38, 5, 0) |

Un frame son 17 556 ciclos M a velocidad normal: el blit de 40 sprites cuesta ~0,7 frame
por frame de animación (~12 300 ciclos M).

## Subconjunto

`char` (sin signo por defecto), `signed char`, `short`/`int` de 16 bits, `unsigned`,
punteros, arrays (multidimensionales), `struct` (por puntero; asignación de struct
completa sí), `typedef`, `enum`, `const`, `volatile`, `static` (globales y locales),
globales inicializadas (incluidos punteros a globales y cadenas), recursión, todo el
control de flujo (`switch`, `goto`, `do`), todos los operadores, preprocesador simple.

**Fuera de v1:** `float`/`double`, `long`, `union`, llamar a través de punteros a función
(sí se puede tomar `&f` para pasarla a ensamblador), structs por valor como argumento o
retorno, `?:` entre structs, `va_list` (las funciones variádicas se pueden declarar para
implementarlas en ensamblador), bitfields, VLA.

## Tests

`tests/cc/` (en `npm test`):

- `exec.test.ts`: programas con resultados calculados a mano, ejecutados en
  `core-probe.wasm` hasta el `ld b,b` del crt0 (aritmética 8/16 con y sin signo,
  comparaciones, mul/div/mod/desplazamientos y sus bordes, punteros/arrays/structs/enums,
  globales y BSS, recursión, marcos anidados, control y cortocircuito, `__at`, ISR de
  VBlank, `#pragma bank` + `__banked`, `__asm`, asm ↔ C, structs entre unidades).
- `oracle.test.ts`: `oracle.c` (26 pares × 46 operaciones de 8/16 bits) compilado también
  con clang a wasm32 con `short`; los 1196 resultados deben coincidir. Se salta si no
  está clang (`$LLVM_BIN` o `C:\Program Files\LLVM\bin`).
- `errors.test.ts`: errores con su fichero y línea, y errores de tamaño del compilador.

`tests/cc/cc.bench-test.ts` (en `npm run test:perf`): tiempo de compilación y ciclos M.
