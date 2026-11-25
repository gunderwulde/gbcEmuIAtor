/* gfx.c — carga los gráficos del juego (tiles.asm, dibujados para este proyecto) y sus
 * paletas. Va al banco 3 con los tiles: sólo se usa una vez, al arrancar.
 *
 * Los tiles están ya en 2bpp en la ROM (literales gráficos `0123 de tiles.asm), así que
 * cargarlos es una copia de 1600 bytes y el título sale enseguida.
 */
#pragma bank 3
#include "game.h"

#pragma link "tiles.asm"

extern const unsigned char art_tiles[];     /* N_BLOCKS × 4 tiles, desde el tile 96 */

/* Paletas de fondo: 0 hierba, 1 árbol, 2 agua, 3 roca, 4 cripta, 5 objetos sobre hierba,
 * 6 objetos sobre losa, 7 marcador y textos. */
const unsigned int bg_pals[32] = {
    RGB(18, 27, 10), RGB(10, 21, 6), RGB(5, 14, 4), RGB(2, 6, 2),
    RGB(18, 27, 10), RGB(8, 19, 6), RGB(3, 10, 3), RGB(12, 7, 3),
    RGB(8, 16, 28), RGB(16, 24, 31), RGB(4, 8, 20), RGB(31, 31, 31),
    RGB(18, 27, 10), RGB(24, 24, 22), RGB(15, 15, 14), RGB(5, 5, 6),
    RGB(7, 6, 10), RGB(11, 10, 15), RGB(17, 16, 21), RGB(2, 2, 4),
    RGB(18, 27, 10), RGB(31, 26, 6), RGB(24, 6, 6), RGB(6, 3, 2),
    RGB(7, 6, 10), RGB(31, 26, 6), RGB(24, 6, 6), RGB(6, 3, 2),
    RGB(0, 0, 0), RGB(31, 6, 6), RGB(31, 26, 6), RGB(31, 31, 31),
};

/* Paletas de sprites: 0 Musgo, 1 limo, 2 murciélago, 3 jefe, 4 vara. */
const unsigned int obj_pals[20] = {
    0, RGB(31, 24, 18), RGB(4, 20, 20), RGB(3, 6, 3),
    0, RGB(20, 31, 20), RGB(6, 24, 10), RGB(2, 8, 4),
    0, RGB(24, 16, 28), RGB(14, 6, 18), RGB(4, 2, 6),
    0, RGB(31, 20, 12), RGB(22, 8, 6), RGB(6, 2, 2),
    0, RGB(31, 31, 31), RGB(18, 18, 22), RGB(6, 6, 8),
};

/* Carga tiles y paletas. Llamar con el LCD apagado (la copia va de golpe). */
void __banked gfx_load(void)
{
    unsigned char b;

    set_sprite_tiles(TILE_BASE, N_BLOCKS * 4, art_tiles);
    for (b = 0; b < 8; b++) set_bg_palette(b, bg_pals + b * 4);
    for (b = 0; b < 5; b++) set_sprite_palette(b, obj_pals + b * 4);
}
