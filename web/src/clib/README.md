# web/src/clib — librería C de usuario y ejemplos (L1)

Cabeceras `.h` y fuentes (`.c` o `.asm`) que el compilador encuentra vía
`includeResolver`. Las rutinas calientes van en ensamblador desde el principio (en
zxemuIAtor el blit de sprites en C era ~2× más lento). ABI en
[docs/c-abi.md](../../../docs/c-abi.md).

## `gbc.h` — API prevista (v1)

**Pantalla y LCD**
- `lcd_on()`, `lcd_off()` (sólo en VBlank), `wait_vbl()` (HALT con la IRQ de VBlank),
  `vbl_count` (contador de frames).
- `scroll(x, y)`, `window(x, y)`, `window_on()/off()`, `bg_on()/off()`.

**Tiles y mapas**
- `vram_bank(n)`, `set_bg_tiles(first, n, data)`, `set_sprite_tiles(first, n, data)`
  (usan HDMA/GDMA si el tamaño compensa, medido).
- `set_bg_map(x, y, w, h, tiles)`, `set_bg_attr(x, y, w, h, attrs)`, `fill_bg(...)`.
- `hdma_copy(dst, src, len)`, `gdma_copy(dst, src, len)`.

**Paletas CGB**
- `set_bg_palette(n, colors[4])`, `set_sprite_palette(n, colors[4])`, `RGB(r, g, b)`
  (5 bits por canal), `fade_to(...)` sencillo.

**Sprites**
- OAM sombra en WRAM + rutina de OAM DMA copiada a HRAM por el crt0.
- `sprite_set(n, x, y, tile, attr)`, `sprite_move(n, x, y)`, `sprite_hide(n)`,
  `oam_flush()` (lanza la DMA; llamar en VBlank).

**Texto**
- Fuente 8×8 propia (dibujada para el proyecto, dominio público/MIT; no se copia la de
  ninguna ROM). `text_init(first_tile)`, `at(x, y)`, `putchar`, `print`, `printf`
  simple (`%d %u %x %s %c`).

**Entrada**
- `joypad()` → máscara (`J_RIGHT … J_START`), `joypad_pressed()` (flanco),
  `wait_key()`.

**Sonido**
- `snd_on()/off()`, `snd_tone(ch, freq, len, vol)`, `snd_noise(...)`,
  efectos predefinidos (`sfx_jump`, `sfx_hit`).

**Sistema**
- `rom_bank(n)` (MBC5/MBC1/MBC3), `sram_on()/off()` (para partidas guardadas con pila),
  `cpu_fast()` (doble velocidad), `irq_set(vec, fn)`, `ei()/di()`.
- `memcpy/memset/memcmp/strlen/strcpy/strcmp`, `rand/srand`.

## Serie de ejemplos (`examples/*.c`)

Comentados en español y de menos a más:

1. Hola mundo con paletas de colores.
2. Bucles y aritmética (tabla de multiplicar en pantalla).
3. Cruceta: mover un carácter por el mapa.
4. Tiles y mapa: dibujar un escenario y hacer scroll.
5. Paletas animadas (arco iris por línea con la IRQ de STAT/HBlank).
6. Sonido: escala musical con el canal 1 y efectos con el ruido.
7. Sprite 16×16 con animación, movido con la cruceta, sin parpadeo (OAM DMA en VBlank).
8. Structs y arrays: lista de enemigos con sprites.
9. Ventana como marcador fijo sobre un fondo con scroll.
10. Mini-juego completo con marcador y partida guardada en SRAM.

## Tests

`tests/clib/`: cada función con un test en el núcleo real verificado por VRAM, OAM,
paletas, registros de la APU o framebuffer, con valores escritos a mano; cada ejemplo
compila sin errores ni avisos y tiene un test que verifica su efecto visible.
