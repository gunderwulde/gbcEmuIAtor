# ABI de C para SM83 (compilador K1)

Este documento es el contrato entre el compilador de C (`web/src/cc`), la librería de
usuario (`web/src/clib`, L1) y cualquier código en ensamblador que se mezcle con C. Lo
que aquí se fija no cambia sin avisar a los dos lados.

Resumen en una línea: **`char` sin signo, `int` de 16 bits, primer argumento en A/HL,
el resto en la pila (o en WRAM fija si el compilador lo sabe seguro), retorno en A/HL,
la función llamada puede pisar AF, BC, DE y HL.**

## 1. Tipos

| Tipo | Tamaño | Notas |
|---|---|---|
| `char` | 1 | **sin signo** (como en SDCC para SM83 y GBDK) |
| `signed char` | 1 | |
| `short`, `int` | 2 | con signo; `unsigned` sin signo |
| punteros | 2 | |
| `enum` | 2 | como `int` |
| `struct` | suma de los campos | **sin relleno ni alineación** (todo alineado a 1) |

- Orden de bytes **little-endian** (byte bajo en la dirección menor), como el SM83.
- No hay `long`, `float`, `double`, `union`, campos de bits ni punteros a función (v1).
- Aritmética de C estándar: `char` se promociona a `int`; las operaciones se hacen en
  16 bits salvo cuando el compilador puede demostrar que basta con 8 (el resultado se
  trunca a `char`, comparaciones entre `char`).
- División y módulo truncan hacia cero (C99). División por cero: cociente `0xFFFF`
  (sin signo) y resto = dividendo; con signo, el resultado de la versión sin signo con
  los signos aplicados. No hay excepción.
- `>>` sobre un valor con signo es aritmético (replica el bit de signo).
- Desplazamientos de 16 o más bits o negativos (comportamiento indefinido en C99 6.5.7;
  esto es lo que hace este compilador, no algo en lo que apoyarse): `<<` da 0; `>>` da 0
  o −1 (según el signo del operando izquierdo). La diferencia está en qué número de bits
  se mira:
  - Constante: se toma como valor de 16 bits, así que cualquier constante de 16 o más
    (`x << 256` incluido) o negativa da 0 / 0 o −1.
  - Variable: el helper sólo mira el byte bajo, así que con `n = 256`, `x << n` es
    `x << 0`; un negativo (byte bajo ≥ 128) sigue siendo un desplazamiento grande.
- Structs: dos declaraciones de la misma etiqueta con los mismos miembros en unidades
  distintas (la misma cabecera incluida por dos `.c`) son el mismo tipo (C99 6.2.7).

## 2. Nombres

- Toda función o variable global `x` de C es la etiqueta **`_x`** en ensamblador.
- Las `static` de fichero se llaman `_x` salvo que choquen con otra del mismo nombre en
  otro fichero; entonces `__s<n>_x`. Las `static` locales, `__sl_<función>_<x>_<n>`.
- Las etiquetas que empiezan por dos guiones bajos (`__…`) son del compilador y del
  runtime; el código de usuario no debe definirlas.
- Dentro de una función, el compilador usa sólo etiquetas locales (`.l1`, `.lret`, …).

## 3. Convención de llamada

### 3.1 Argumentos

- **El primer argumento** va en registro: **A** si es de 8 bits, **HL** si es de 16.
- **Los demás** (2.º, 3.º, …):
  - Convención **de pila** (la general, la que ve el ensamblador): el llamador los
    apila **de derecha a izquierda**, cada uno en una palabra de 2 bytes (los de 8 bits
    en el byte bajo; el alto no está definido). Al entrar en la función:
    `[SP+0..1]` = dirección de retorno, `[SP+2..3]` = 2.º argumento,
    `[SP+4..5]` = 3.º, etc. **El llamador** saca los argumentos al volver
    (`ADD SP,2·(n−1)`).
  - Convención **estática** (sólo entre funciones C, la decide el compilador): el
    llamador escribe los argumentos directamente en las direcciones fijas de WRAM que el
    compilador ha asignado a los parámetros de la función llamada (§4). Ni la pila ni el
    ensamblador del usuario intervienen.
- Funciones variádicas: el primer argumento en A/HL y los demás en la pila, ya
  promocionados a `int`.

Qué convención usa cada función (lo decide el compilador con el programa completo):

| Función | Convención |
|---|---|
| C, con cuerpo, no recursiva, no reentrante | **estática** |
| C recursiva (directa o mutuamente) | pila |
| C alcanzable desde más de una raíz (p. ej. desde `main` y desde una interrupción) | pila (reentrante) |
| C nombrada desde ensamblador (`__asm`, ficheros `.asm` enlazados) o cuya dirección se toma (`&f`) | pila |
| `__naked` | pila |
| Sin cuerpo en C (definida en ensamblador) | pila |

Así, **el ensamblador sólo ve la convención de pila**: una función en ensamblador
llamada desde C y una función C llamada desde ensamblador siguen siempre las reglas de
pila de arriba.

### 3.2 Valor de retorno

| Tipo | Registro |
|---|---|
| `char`, `signed char` | **A** |
| `int`, `unsigned`, punteros | **HL** |
| `void` | — |

No hay structs por valor (ni como argumento ni como retorno). Una función que devuelve
`char` no tiene por qué dejar nada útil en H/L, ni una de 16 bits en A.

Por qué HL y no DE ni BC (por construcción, no por medida): el generador evalúa todas las
expresiones de 16 bits en HL (es el único par con `ADD HL,rr`, `LD A,[HL+]`, `JP HL` y
`LD SP,HL`), así que un retorno en HL cuesta 0 instrucciones en el llamado y en el
llamador; en DE costaría `LD D,H`/`LD E,L` en uno y `LD H,D`/`LD L,E` en el otro (4
ciclos M más por llamada). Lo mismo vale para el 1.er argumento en A/HL.

### 3.3 Registros

- La función llamada **puede pisar AF, BC, DE y HL**. El llamador no guarda nada en
  registros a través de una llamada.
- **SP** se conserva (la función deja la pila como la encontró, salvo los argumentos,
  que saca el llamador).
- Las rutinas `__interrupt` guardan y restauran todos los registros (§7).
- IME: una función no cambia IME salvo que sea su propósito (`ei()`, `di()`).

### 3.4 Funciones en ensamblador llamables desde C

```c
/* C */
unsigned char add3(unsigned char a, unsigned char b, unsigned char c);
```

```asm
; ensamblador: A = a, [SP+2] = b, [SP+4] = c; resultado en A
_add3:
    ld hl, sp+2
    add a, [hl]        ; + b
    ld hl, sp+4
    add a, [hl]        ; + c
    ret                ; el llamador saca b y c
```

Con 16 bits: `int f(int x, int y)` recibe `x` en HL y `y` en `[SP+2]` (bajo) y
`[SP+3]` (alto), y devuelve en HL. Para leer `y` sin perder HL:

```asm
_f:
    ld d, h            ; DE = x
    ld e, l
    ld hl, sp+2
    ld a, [hl+]
    ld h, [hl]
    ld l, a            ; HL = y
    add hl, de         ; x + y
    ret
```

Se declara en C con su prototipo y se define en un fichero `.asm` enlazado con
`#pragma link "fichero.asm"` o en un bloque `__asm … __endasm;` a nivel de fichero. El
compilador da error si la función se usa y no está definida ni en C ni en ensamblador.

### 3.5 Funciones C llamables desde ensamblador

Basta con nombrarlas (`call _f`): el compilador ve la referencia en el texto del
ensamblador (bloques `__asm` y ficheros enlazados), la conserva aunque C no la llame y le
da la convención de pila. El ensamblador pone el primer argumento en A/HL, apila el
resto de derecha a izquierda, hace `call _f` y luego `add sp, 2·(n−1)`.

Restricción: una función C llamada desde ensamblador no debe llamarse además desde una
rutina de interrupción si el ensamblador que la llama puede ser interrumpido (sería
reentrante sin que el compilador lo sepa). Con la convención de pila no hay problema de
datos (cada llamada tiene su marco), pero sí lo habría con las variables `static`.

## 4. Marcos: parámetros y locales

### 4.1 Funciones con convención estática

Los parámetros y las variables locales viven en **direcciones fijas de WRAM**, en la
**zona de marcos** (§5). El compilador conoce el grafo de llamadas completo (no hay
punteros a función) y **solapa** los marcos de funciones que nunca están vivas a la
vez: cada función se coloca por encima de todas sus llamadoras posibles (el camino más
largo en el grafo de llamadas desde la raíz), así que dos hermanas comparten bytes y una
función nunca pisa a ninguna de sus antecesoras.

- Raíces: `main`, cada rutina `__interrupt` y cada función nombrada desde ensamblador.
  `main` y sus descendientes ocupan la parte baja de la zona; cada otra raíz tiene una
  región propia por encima (no se solapa con nada), porque puede ejecutarse en mitad de
  cualquier otra.
- Disposición de un marco estático: primero los parámetros en orden (cada uno con su
  tamaño: 1 byte los de 8 bits), después las locales. Al entrar, la función guarda A/HL
  (el primer argumento) en su hueco; los demás ya los ha escrito el llamador.
- Si un argumento contiene a su vez una llamada, el llamador evalúa todos los argumentos
  en la pila antes de escribir ninguno en el marco (la llamada anidada podría pisar los
  huecos ya escritos).
- Las locales de bloques que no están vivos a la vez dentro de una función también
  comparten bytes.

### 4.2 Funciones con convención de pila

```
         direcciones altas
[SP+L+2+2(n-2)] ...         n-ésimo argumento
[SP+L+2]        2.º argumento   (lo apiló el llamador)
[SP+L]          dirección de retorno
[SP+L-2]        copia del 1.er argumento (PUSH AF / PUSH HL en el prólogo)
[SP+0]          ...  locales (L-2 bytes, ADD SP,-(L-2))
         direcciones bajas
```

- Prólogo: `PUSH AF` (1.er argumento de 8 bits; el valor queda en el byte alto del
  hueco) o `PUSH HL` (de 16 bits), y `ADD SP,-n` con los bytes de locales. Sin
  parámetros no hay hueco y L = bytes de locales.
- Epílogo: `ADD SP,L` (en trozos de 127 si L es mayor) y `RET`. El valor de retorno
  (A/HL) no se toca (`ADD SP,e` sólo cambia flags).
- Los accesos usan `LD HL,SP+e` si el desplazamiento cabe en 0..127, y si no
  `LD HL,n` / `ADD HL,SP` (2 ciclos M más). No hay límite de tamaño del marco salvo la
  pila (`stackSize`).
- El generador sigue la profundidad de la pila durante las expresiones (los
  temporales apilados), así que los desplazamientos son siempre exactos.

## 5. Memoria

### 5.1 Mapa

| Zona | Dirección | Qué |
|---|---|---|
| Cabecera | `$0100–$014F` | `nop`/`jp __start` y hueco de cabecera (la rellena `fillHeader`) |
| Vectores | `$0040–$0060` | `jp` a la rutina `__interrupt`, o `reti` si no hay |
| Código | ROM0 | crt0, runtime y funciones sin `#pragma bank` |
| Código banco n | ROMX banco n | funciones tras `#pragma bank n` |
| `.rodata` | ROM0 (o el banco del fichero) | cadenas literales y globales `const` inicializadas |
| Imagen de `.data` | ROM0 | valores iniciales que el crt0 copia a WRAM |
| OAM sombra | `$C000–$C09F` | **`_shadow_oam`**, 160 bytes alineados a 256 (para la OAM DMA) |
| Marcos estáticos | `$C0A0–…` | parámetros y locales de las funciones con convención estática (§4.1) |
| `.data` | WRAM0, sección `"C data"` | globales inicializadas no `const` |
| BSS | WRAM0, sección `"C bss"` | globales sin inicializar (a cero) |
| Pila | `$D000` hacia abajo | `stackSize` bytes reservados (512 por defecto) dentro de WRAM0 |
| WRAMX | `$D000–$DFFF` | **libre para el usuario** (bancos 1–7 con SVBK); el compilador no la usa |
| HRAM | sección `"C hram"` | `__cur_bank` (1 byte) y `__oam_dma_hram` (rutina de OAM DMA) |

- SP empieza en `$D000` (el primer `push` escribe en `$CFFF`): la pila está en WRAM0 y
  no desaparece al cambiar el banco de WRAMX.
- Si la OAM sombra, los marcos, `.data`, BSS y la pila no caben en los 4 KB de WRAM0, es
  **error del compilador** (con el desglose). Igual con el código y los datos que no
  caben en ROM0 o en su banco.
- El resto de HRAM (`$FF80–$FFFE` menos lo de `"C hram"`) es libre; lo coloca el
  ensamblador.

### 5.2 Variables en dirección fija: `__at`

```c
__at(0xFF40) unsigned char LCDC;      /* registro de E/S */
__at(0xD000) unsigned char big[4096];  /* WRAMX */
```

Es una declaración sin almacenamiento: la etiqueta `_LCDC` se define con `DEF … EQU`.
No admite inicializador. Puede ir en una cabecera incluida por varios `.c`: si el nombre,
la dirección y el tipo coinciden es la misma variable (un solo `DEF`); si no, error. Un
`extern` del mismo nombre en otra unidad también la nombra. Las direcciones `$FF00–$FFFF` se acceden con `LDH`. Usar
`volatile` es opcional (el compilador no guarda valores de memoria en registros entre
sentencias), pero recomendable por portabilidad.

## 6. Arranque (crt0)

El compilador emite el crt0 (salvo con `crt0: false`):

1. Vectores de interrupción (`$40`, `$48`, `$50`, `$58`, `$60`): `jp _rutina` o `reti`.
2. Entrada en `$0100`: `nop` / `jp __start` y hueco hasta `$0150` para la cabecera (logo,
   título, checksums: los pone `fillHeader` de `web/src/export/header.ts`).
3. `__start`:
   1. `di`, `ld sp, $D000`.
   2. Pone a cero **toda WRAM0** (`$C000–$CFFF`: OAM sombra, marcos, `.data`, BSS y
      pila) en un bucle de 4 bytes por vuelta (1024 vueltas × 13 ciclos M ≈ 13,3 K ciclos M, 12,7 ms a
      velocidad normal). Es más corto que
      tres bucles con sus límites y deja también la pila determinista.
   3. Copia `.data` desde su imagen en ROM.
   4. Copia la rutina de OAM DMA a HRAM (`__oam_dma_hram`).
   5. `__cur_bank` = 1 (el banco que el MBC tiene puesto al arrancar).
   6. `call _main`.
   7. `__exit`: `ld b,b` (punto de parada para depuradores y tests) y bucle `halt`
      infinito con IME a 0. El valor de `main` queda en HL.

No activa interrupciones ni toca el LCD: eso lo hace el programa (`ei()`, `lcd_on()`…).
El valor inicial de A (`$11` en CGB) no se conserva.

### 6.1 OAM DMA

`__oam_dma_hram` (en HRAM, porque durante la DMA la CPU sólo puede leer HRAM):

- Entrada: **A = byte alto de la dirección origen** (`HIGH(_shadow_oam)` = `$C0`).
- Pisa AF. Tarda 160 ciclos M de espera + llamada.
- Lanzarla en VBlank (o con el LCD apagado).

En C: `extern unsigned char shadow_oam[160];` es la OAM sombra (40 × 4 bytes: Y+16, X+8,
tile, atributos). El crt0 la deja a cero (todos los sprites fuera de pantalla).

## 7. Interrupciones: `__interrupt`

```c
void vbl(void) __interrupt(vblank) { vbl_count++; }
```

- Fuentes: `vblank` ($40), `stat` ($48), `timer` ($50), `serial` ($58), `joypad` ($60).
  Una sola rutina por fuente.
- Sin parámetros, devuelve `void`. Debe estar en ROM0 (no en un fichero con
  `#pragma bank`).
- El compilador pone `jp _vbl` en el vector y genera: `push af/bc/de/hl`, cuerpo,
  `pop hl/de/bc/af`, `reti`.
- Una rutina de interrupción es una raíz del grafo de llamadas (§4.1): sus marcos no se
  solapan con los de `main`. Una función a la que llaman `main` y una interrupción se
  compila con convención de pila (reentrante).
- Con `__naked` el compilador no genera prólogo ni epílogo (el cuerpo `__asm` debe
  guardar lo que use y acabar en `reti`).
- Para escribir la rutina en ensamblador: declararla en C sin cuerpo,
  `void vbl_isr(void) __interrupt(vblank);`, y definir `_vbl_isr` en el `.asm`; el
  compilador pone el `jp` en el vector. **Los vectores son del compilador**: un `.asm`
  no debe declarar secciones en `$40–$60`.
- Activar: el programa escribe IE (`$FFFF`) y hace `ei()`.

## 8. Bancos de ROM: `#pragma bank` y `__banked`

```c
#pragma bank 2
int __banked level_load(int n) { ... }     /* en ROMX banco 2 */
```

- `#pragma bank n` (1–255): todo lo que sigue en esa unidad de compilación (funciones,
  sus cadenas y sus `const` inicializadas) va al banco n de ROMX. `#pragma bank 0` vuelve
  a ROM0.
- Una función de un banco sólo se puede llamar directamente desde el mismo banco. Desde
  otro sitio tiene que ser `__banked` (si no, error del compilador).
- Una llamada a una función `__banked` de ROMX pasa **siempre** por el trampolín de ROM0
  `__bcall` (aunque llame alguien del mismo banco). Si la función `__banked` está en ROM0
  (sin `#pragma bank`), siempre está visible y se llama directamente con `call`:
  ```asm
      ; argumentos ya colocados (1.º en A/HL, resto en la pila o en su marco)
      ld de, _level_load
      ld b, BANK(_level_load)
      call __bcall
  ```
  `__bcall` guarda `__cur_bank` en la pila, escribe el banco nuevo en `__cur_bank` y en
  `$2000` (MBC1/MBC3/MBC5), llama a la función conservando A y HL, y al volver restaura
  el banco anterior conservando A (retorno de 8 bits) y HL (de 16).
- Por el trampolín, en una función `__banked` con convención de pila **los argumentos
  2.º y siguientes empiezan en `[SP+6]`** en vez de `[SP+2]` (hay en medio el banco
  guardado y la vuelta al trampolín). Para el compilador es transparente; quien escriba
  una función `__banked` en ensamblador debe tenerlo en cuenta.
- `__cur_bank` (HRAM) es el banco de ROMX puesto. Quien cambie de banco a mano (p. ej.
  `rom_bank(n)` de la librería) debe actualizarlo **antes** de escribir en el MBC, para
  que una interrupción que haga una llamada `__banked` restaure el correcto.
- Datos en bancos: un puntero a datos de un banco sólo vale mientras ese banco está
  puesto. Bancos de 0 a 255 (hasta 4 MB con MBC5).

## 9. Otras extensiones

- **`__naked`**: sin prólogo ni epílogo; convención de pila; el cuerpo (normalmente un
  `__asm`) termina en `ret`.
- **`__asm … __endasm;`**: texto de ensamblador A1 que se copia tal cual. Dentro de una
  función, sólo es seguro leer variables globales y llamar a funciones (`call _f`), no
  suponer nada de los registros entre sentencias C. Las referencias `_nombre` cuentan
  como uso (el compilador no elimina lo que nombran).
- **`#pragma link "fichero"`**: añade un `.c` (se compila) o un `.asm` (se copia) a la
  salida, una sola vez.
- Macros predefinidas: `__SM83__`, `__GBC__`, `__K1CC__` (todas a 1).

## 10. Runtime

Rutinas en ROM0 que el compilador emite sólo si se usan. Convención propia (no la de C):
**HL = operando izquierdo, DE = derecho, resultado en HL**; pisan AF, BC, DE.

| Rutina | Qué |
|---|---|
| `__mul16` | HL = HL × DE (16 bits bajos; vale con y sin signo) |
| `__divu16` | HL = HL / DE, DE = HL % DE (sin signo) |
| `__divs16` | HL = HL / DE con signo (trunca hacia cero) |
| `__mods16` | HL = HL % DE con signo (signo del dividendo) |
| `__shl16` | HL = HL << A |
| `__shru16` | HL = HL >> A (lógico) |
| `__shrs16` | HL = HL >> A (aritmético) |
| `__bcall` | trampolín de bancos (§8) |

Multiplicaciones y divisiones por constantes se generan en línea cuando sale a cuenta
(desplazamientos y sumas); desplazamientos por constante, siempre en línea.

Medidas (ciclos M en `core-probe.wasm`, programas de `tests/cc/cc.bench-test.ts`): ver
[web/src/cc/README.md](../web/src/cc/README.md).
