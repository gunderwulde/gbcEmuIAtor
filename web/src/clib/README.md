# web/src/clib — librería C de usuario y ejemplos (L1)

Cabeceras `.h` y fuentes (`.c` o `.asm`) que el compilador de [`web/src/cc`](../cc/README.md)
encuentra vía `includeResolver`, y la serie de 10 ejemplos en C. ABI de llamada en
[docs/c-abi.md](../../../docs/c-abi.md). Todo es TS/texto puro, sin DOM.

## API para la UI (`index.ts`)

```ts
import { includeResolver, clibResolve, CLIB_FILES, C_EXAMPLES, cExampleById, type CExample } from "../clib";

compile(files, { main: "main.c", includeResolver });   // lo que no esté en `files`, de la librería
```

| Export | Qué es |
|---|---|
| `CLIB_FILES: ReadonlyMap<string, string>` | `gbc.h`, `gbc.c`, `gbc_vbl.c` (declara la IRQ de VBlank; lo enlaza `gbc.h` salvo con `GBC_NO_VBL_ISR`), `gbc.asm`, `gbc_font.asm`, `string.h`, `string.asm`, `stdlib.h`, `stdlib.c`, `stdlib.asm` |
| `clibResolve(name)` | Texto del fichero; sólo cuenta el último componente de la ruta (`lib/gbc.h` = `gbc.h`); `undefined` si no es de la librería |
| `includeResolver(name, from)` | Lo mismo con la firma que pide `compile` (sirve para `#include` y `#pragma link`) |
| `C_EXAMPLES: readonly CExample[]` | Los 10 ejemplos, en orden de dificultad |
| `cExampleById(id)` | Busca por `id` |
| `CExample` | `{ id, title, files: ReadonlyMap<nombre, texto>, main }`. `files` trae sólo los ficheros del ejemplo (el 10 tiene además `10-save.asm`); la librería no se copia en las pestañas: la resuelve `includeResolver` |

Para abrir un ejemplo en el IDE: una pestaña por entrada de `files`, y compilar con
`compile(new Map(files), { main, includeResolver })`.

## `gbc.h` — lo que hay

`#include <gbc.h>` trae también `string.h` y `stdlib.h`, y enlaza (`#pragma link`) lo
necesario. Registros de E/S como variables `__at` (`rLCDC`, `rSTAT`, `rNR52`, `rKEY1`…),
bits con nombre (`LCDC_*`, `STAT_*_IRQ`, `IRQ_*`, `ATTR_*`, `J_*`), `RGB(r, g, b)` (5 bits),
`TILE_ROW(p0…p7)` (una fila de tile a partir de 8 índices de color) y `NOTE_C3…NOTE_C6`.

| Grupo | Funciones |
|---|---|
| LCD | `lcd_on`, `lcd_off` (espera a VBlank), `wait_vbl` (HALT hasta el VBlank), `delay(frames)`, `vbl_count`, `scroll`, `window`, `window_on/off`, `sprites_on/off`, `sprites_8x16`, `bg_priority` |
| VRAM | `vram_bank`, `vram_copy`, `vram_fill`, `vram_set`, `vram_get`, `set_bg_tiles`, `set_sprite_tiles` |
| Mapas | `set_bg_map`, `set_bg_attr`, `fill_bg`, `fill_bg_attr`, `set_bg_tile`, `get_bg_tile` y los mismos `*_win_*` (mapa 9C00h) |
| DMA | `gdma_copy`, `hdma_copy`, `hdma_busy` |
| Paletas | `set_bg_palette`, `set_sprite_palette`, `set_bg_color`, `set_sprite_color`, `fade_bg`, `fade_sprites` (nivel 0 = original … 8 = negro) |
| Sprites | `shadow_oam`, `sprite_set`, `sprite_move`, `sprite_tile`, `sprite_attr`, `sprite_hide`, `sprites_hide_all`, `oam_flush` |
| Texto | `text_init(first_tile)` (fuente propia 8×8, ASCII 32–127, 96 tiles), `text_layer(TEXT_BG/TEXT_WIN)`, `text_attr`, `cls`, `at`, `putchar`, `print`, `printf` (`%d %i %u %x %X %c %s %%`, anchura y relleno con 0) |
| Joypad | `joypad`, `joypad_pressed` (flancos), `wait_key` |
| Sonido | `snd_on/off`, `snd_tone(ch, periodo, len, vol)`, `snd_noise(nr43, len, vol)`, `snd_stop`, `sfx_jump`, `sfx_hit` |
| Sistema | `rom_bank`, `sram_on/off`, `sram_bank`, `wram_bank`, `cpu_fast/slow`, `cpu_is_fast`, `irq_enable/disable`, `ei`, `di` |
| string.h | `memcpy`, `memset`, `memcmp`, `strlen`, `strcpy`, `strcat`, `strcmp` |
| stdlib.h | `rand` (xorshift de 16 bits (7, 9, 8), 0…32767), `srand`, `abs` |

### Reglas del hardware que la librería cumple

- VRAM y paletas sólo se escriben fuera del modo 3: con el LCD encendido cada byte espera
  a que STAT diga modo 0 o 1; con el LCD apagado se escribe de golpe (GDMA si origen,
  destino y longitud están alineados a 16).
- Una interrupción entre la espera a STAT y la escritura la llevaría al modo 3 (se
  pierde). IME no se puede leer, así que `ei()`/`di()` (y `wait_vbl`, que hace EI)
  guardan una copia en `gbc_ime`; si vale 1, cada byte se escribe entre `di` y `ei` (y
  `lcd_off` igual entre ver LY ≥ 144 y escribir LCDC). Con IME a 0 se usa el bucle sin
  protección, sin coste extra. Por eso IME se cambia sólo con `ei()`/`di()`, y una ISR
  que escriba en VRAM con `gbc_ime` a 1 rehabilita las interrupciones dentro de sí misma.
- La OAM nunca se escribe directamente: `sprite_*` tocan la sombra (`shadow_oam`, C000h)
  y `oam_flush()` lanza la OAM DMA desde HRAM. Llamarla justo después de `wait_vbl()`.
- `lcd_off()` espera a LY ≥ 144 (apagar fuera de VBlank daña el LCD real).

### Avisos

- **La HDMA no avanza mientras la CPU está en HALT** (sólo copia en los HBlank con la CPU
  despierta; ver `core/src/gbc.c`). Como `wait_vbl`/`delay` hacen HALT, para esperar una
  `hdma_copy` hay que hacer `while (hdma_busy());`.
- La librería instala la IRQ de VBlank (`gbc_vbl_isr`, cuenta `vbl_count`). Para usar la
  tuya: `#define GBC_NO_VBL_ISR` antes de `#include <gbc.h>` y declara
  `void mi_vbl(void) __interrupt(vblank)` incrementando `vbl_count` (si no, `wait_vbl` y
  `delay` no vuelven nunca).
- `wait_vbl()` pone IE.0 y hace EI; `irq_enable` sólo añade bits a IE.
- `bg_priority(0)` en CGB no apaga el fondo: hace que los sprites queden siempre encima.
- `NOTE_*`: periodo = 2048 − 131072 / f (f de la escala temperada, La4 = 440 Hz),
  redondeado.
- RAM del cartucho: el programa la declara con una sección `SRAM` en un `.asm`
  (ver `examples/10-save.asm`) para que la cabecera pida RAM con pila, y la usa con
  variables `__at(0xA000…)` entre `sram_on()` y `sram_off()`.
- `sram_bank` en MBC1 sólo surte efecto en el modo 1 (escribir 1 en 6000h antes; en ese
  modo, con ROM ≥ 1 MB, también cambia el banco de 0000h–3FFFh). La librería no lo pone.
- `rom_bank(0)`: MBC1/MBC3 mapean el banco 1; MBC5 mapea de verdad el banco 0. En MBC1
  sólo bancos 1–31.
- Los rectángulos de mapa (`set_*_map`, `set_*_attr`, `fill_*`) no dan la vuelta: con
  x + w > 32 la fila continúa en la de abajo.

### Qué está en ensamblador y por qué

En **asm** (`gbc.asm`, `string.asm`, `stdlib.asm`): todo lo que copia o espera por bytes
(VRAM, mapas, paletas, texto, `printf`, OAM), lo que depende del orden exacto de los
accesos al hardware (`lcd_off`, `wait_vbl`, `cpu_fast/slow` con STOP, la rutina de OAM DMA
en HRAM, la IRQ de VBlank, el joypad con la selección de grupo en P1) y las funciones de
memoria/cadenas y `rand`. Son bucles calientes o necesitan instrucciones que C no expresa
(`halt`, `stop`, `ei`/`di`, `ldh`); en zxemuIAtor el mismo trabajo en C era ~2× más lento.
`printf` además necesita leer los varargs de la pila a mano.

En **C** (`gbc.c`, `stdlib.c`): las variables de la librería (`vbl_count`, cursor de
texto, semilla), el sonido (unas pocas escrituras a registros) y los fundidos (aritmética
por canal sin bucles largos).

## Ejemplos (`examples/*.c`)

| id | Fichero | Qué enseña |
|---|---|---|
| `c01-hola` | `01-hola.c` | LCD apagado/encendido, fuente, paleta, `at` + `print` |
| `c02-colores` | `02-colores.c` | Tiles a mano con `vram_set`, las 8 paletas de fondo y atributos del mapa |
| `c03-tiles` | `03-tiles.c` | `TILE_ROW`, `set_bg_tiles`, `set_bg_map`, atributos (paleta, espejo) |
| `c04-scroll` | `04-scroll.c` | `scroll` y el joypad: la cruceta cambia la dirección, A para |
| `c05-sprite` | `05-sprite.c` | Un sprite con la OAM sombra, `joypad_pressed`, paleta y espejo |
| `c06-sonido` | `06-sonido.c` | Teclado musical: canales 1, 2 y 4, `printf` con anchura |
| `c07-ventana` | `07-ventana.c` | La ventana como marcador fijo sobre un fondo que se desplaza |
| `c08-fundido` | `08-fundido.c` | Tiles en WRAM copiados con HDMA, fundidos de paleta |
| `c09-interrupciones` | `09-interrupciones.c` | IRQ de temporizador y de STAT (cambio de color a mitad de pantalla), doble velocidad |
| `c10-estrellas` | `10-estrellas.c` + `10-save.asm` | Minijuego: puntos, vidas, `rand`, sonido y récord en SRAM |

## Tests

- `tests/clib/lib-asm.test.ts`: cada rutina asm llamada con el ABI desde un programa en
  ensamblador y verificada en `core-probe.wasm` (VRAM, OAM, paletas, registros, tiempos).
- `tests/clib/lib-c.test.ts`: la parte en C y la interacción C ↔ asm (sonido, fundidos,
  `delay`, `printf` con varargs, `rand`, cadenas, SRAM, `GBC_NO_VBL_ISR`).
- `tests/clib/examples.test.ts`: cada ejemplo compila sin errores ni avisos, ensambla, y
  su efecto visible (framebuffer, mapas, OAM, paletas, APU, SRAM) se comprueba, con el
  joypad simulado donde hace falta (el 10 se juega con un jugador automático).
