/* 03 — Tiles propios y mapas
 *
 * Un tile son 8×8 píxeles de 4 colores: 16 bytes, 2 por fila (docs/gbc-hardware.md
 * §7.3). La macro TILE_ROW de gbc.h convierte una fila escrita con los colores 0-3 en
 * esos dos bytes, así que los tiles se pueden "dibujar" en el código.
 *
 * El paisaje: cielo arriba, una fila de hierba, un muro de ladrillos abajo y una casa
 * de 4×3 tiles copiada al mapa con set_bg_map. Cada zona usa su paleta (atributos).
 */
#include <gbc.h>

#define T_SKY    0
#define T_GRASS  1
#define T_BRICK  2
#define T_COLUMN 3
#define T_ROOF_L 4
#define T_ROOF_R 5
#define T_WALL   6
#define T_DOOR   7

const unsigned char tiles[8 * 16] = {
    /* 0: cielo (todo color 0) */
    TILE_ROW(0,0,0,0,0,0,0,0), TILE_ROW(0,0,0,0,0,0,0,0), TILE_ROW(0,0,0,0,0,0,0,0), TILE_ROW(0,0,0,0,0,0,0,0),
    TILE_ROW(0,0,0,0,0,0,0,0), TILE_ROW(0,0,0,0,0,0,0,0), TILE_ROW(0,0,0,0,0,0,0,0), TILE_ROW(0,0,0,0,0,0,0,0),
    /* 1: hierba */
    TILE_ROW(0,1,0,0,0,1,0,0), TILE_ROW(1,2,1,0,1,2,1,0), TILE_ROW(2,2,2,1,2,2,2,1), TILE_ROW(2,3,2,2,2,3,2,2),
    TILE_ROW(2,2,2,2,2,2,2,2), TILE_ROW(3,2,2,3,2,2,3,2), TILE_ROW(2,2,3,2,2,3,2,2), TILE_ROW(2,2,2,2,2,2,2,2),
    /* 2: ladrillos (juntas en el color 3) */
    TILE_ROW(1,1,1,3,1,1,1,1), TILE_ROW(1,2,2,3,1,2,2,2), TILE_ROW(1,2,2,3,1,2,2,2), TILE_ROW(3,3,3,3,3,3,3,3),
    TILE_ROW(1,1,1,1,1,1,1,3), TILE_ROW(2,2,1,2,2,2,2,3), TILE_ROW(2,2,1,2,2,2,2,3), TILE_ROW(3,3,3,3,3,3,3,3),
    /* 3: columna con volumen: un degradado 0-1-2-3-3-2-1-0 en cada fila */
    TILE_ROW(0,1,2,3,3,2,1,0), TILE_ROW(0,1,2,3,3,2,1,0), TILE_ROW(0,1,2,3,3,2,1,0), TILE_ROW(0,1,2,3,3,2,1,0),
    TILE_ROW(0,1,2,3,3,2,1,0), TILE_ROW(0,1,2,3,3,2,1,0), TILE_ROW(0,1,2,3,3,2,1,0), TILE_ROW(0,1,2,3,3,2,1,0),
    /* 4: tejado izquierdo */
    TILE_ROW(0,0,0,0,0,0,0,3), TILE_ROW(0,0,0,0,0,0,3,2), TILE_ROW(0,0,0,0,0,3,2,2), TILE_ROW(0,0,0,0,3,2,2,2),
    TILE_ROW(0,0,0,3,2,2,2,2), TILE_ROW(0,0,3,2,2,2,2,2), TILE_ROW(0,3,2,2,2,2,2,2), TILE_ROW(3,3,3,3,3,3,3,3),
    /* 5: tejado derecho (el izquierdo en espejo) */
    TILE_ROW(3,0,0,0,0,0,0,0), TILE_ROW(2,3,0,0,0,0,0,0), TILE_ROW(2,2,3,0,0,0,0,0), TILE_ROW(2,2,2,3,0,0,0,0),
    TILE_ROW(2,2,2,2,3,0,0,0), TILE_ROW(2,2,2,2,2,3,0,0), TILE_ROW(2,2,2,2,2,2,3,0), TILE_ROW(3,3,3,3,3,3,3,3),
    /* 6: pared con ventana */
    TILE_ROW(1,1,1,1,1,1,1,1), TILE_ROW(1,3,3,3,3,3,3,1), TILE_ROW(1,3,0,0,3,0,3,1), TILE_ROW(1,3,0,0,3,0,3,1),
    TILE_ROW(1,3,3,3,3,3,3,1), TILE_ROW(1,3,0,0,3,0,3,1), TILE_ROW(1,3,3,3,3,3,3,1), TILE_ROW(1,1,1,1,1,1,1,1),
    /* 7: puerta */
    TILE_ROW(1,1,3,3,3,3,1,1), TILE_ROW(1,3,2,2,2,2,3,1), TILE_ROW(1,3,2,2,2,2,3,1), TILE_ROW(1,3,2,2,2,2,3,1),
    TILE_ROW(1,3,2,2,2,0,3,1), TILE_ROW(1,3,2,2,2,2,3,1), TILE_ROW(1,3,2,2,2,2,3,1), TILE_ROW(1,3,2,2,2,2,3,1),
};

/* La casa: 4 columnas × 3 filas de tiles, fila a fila. */
const unsigned char house[12] = {
    T_SKY,    T_ROOF_L, T_ROOF_R, T_SKY,
    T_ROOF_L, T_WALL,   T_WALL,   T_ROOF_R,
    T_WALL,   T_DOOR,   T_WALL,   T_WALL,
};

const unsigned int palettes[12] = {
    RGB(20, 26, 31), RGB(8, 24, 8), RGB(4, 16, 4), RGB(0, 6, 0),          /* 0: cielo y hierba */
    RGB(28, 20, 14), RGB(24, 10, 6), RGB(16, 4, 2), RGB(6, 2, 0),         /* 1: ladrillos */
    RGB(20, 26, 31), RGB(31, 28, 20), RGB(22, 16, 8), RGB(8, 4, 2),       /* 2: casa */
};

int main(void)
{
    lcd_off();
    set_bg_tiles(0, 8, tiles);
    set_bg_palette(0, palettes);
    set_bg_palette(1, palettes + 4);
    set_bg_palette(2, palettes + 8);

    fill_bg(0, 0, 20, 12, T_SKY);
    fill_bg(0, 12, 20, 1, T_GRASS);
    fill_bg(0, 13, 20, 5, T_BRICK);
    fill_bg_attr(0, 0, 20, 13, ATTR_PAL(0));
    fill_bg_attr(0, 13, 20, 5, ATTR_PAL(1));

    /* Dos columnas sobre el muro, la segunda en espejo (ATTR_FLIPX): el mismo tile. */
    fill_bg(2, 8, 1, 4, T_COLUMN);
    fill_bg(17, 8, 1, 4, T_COLUMN);
    fill_bg_attr(17, 8, 1, 4, ATTR_PAL(1) | ATTR_FLIPX);
    fill_bg_attr(2, 8, 1, 4, ATTR_PAL(1));

    set_bg_map(8, 9, 4, 3, house);
    fill_bg_attr(8, 9, 4, 3, ATTR_PAL(2));

    lcd_on();
    for (;;)
        wait_vbl();
    return 0;
}
