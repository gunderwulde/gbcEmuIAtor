/* room.c — la pantalla actual y las consultas de colisión.
 *
 * Se llama varias veces por frame (jugador y enemigos), así que vive en ROM0 (siempre
 * visible, sin pasar por el trampolín de bancos) y trabaja sobre la copia en RAM de la
 * pantalla, room[], que world_load rellena al entrar.
 */
#include "game.h"

unsigned char screen;
unsigned char flags[N_SCREENS];
unsigned char room[ROOM_CELLS];

/* Qué hace cada metatile, en el orden de los MT_* de game.h. */
const unsigned char mt_kind[N_MT] = {
    K_FLOOR,  /* hierba */
    K_SOLID,  /* árbol */
    K_SOLID,  /* agua */
    K_SOLID,  /* roca */
    K_DOOR,   /* puerta (exterior) */
    K_KEY,    /* llave (exterior) */
    K_HEART,  /* corazón (exterior) */
    K_DOWN,   /* escalera que baja */
    K_FLOOR,  /* losas de la cripta */
    K_SOLID,  /* muro de la cripta */
    K_DOOR,   /* puerta (cripta) */
    K_KEY,    /* llave (cripta) */
    K_HEART,  /* corazón (cripta) */
    K_UP,     /* escalera que sube */
};

/* Índice en room[] de la celda que contiene el píxel (x, y) del campo de juego. */
unsigned char cell_at(unsigned char x, unsigned char y)
{
    return (y >> 4) * ROOM_W + (x >> 4);
}

/* Lo que impide estar en (x, y) a algo de 16×16, mirando sólo los pies: la caja va de
 * x+2 a x+13 y de y+6 a y+15 (así la cabeza puede tapar un poco el muro de arriba, como
 * en una vista cenital). La caja mide menos de una celda, así que bastan las 4 esquinas.
 * Devuelve K_FLOOR si se puede, o K_SOLID / K_DOOR. */
unsigned char box_blocked(unsigned char x, unsigned char y)
{
    unsigned char k;
    unsigned char top;
    unsigned char bottom;
    unsigned char left;
    unsigned char right;

    top = ((y + 6) >> 4) * ROOM_W;
    bottom = ((y + 15) >> 4) * ROOM_W;
    left = (x + 2) >> 4;
    right = (x + 13) >> 4;
    k = mt_kind[room[top + left]];
    if (k == K_SOLID || k == K_DOOR) return k;
    k = mt_kind[room[top + right]];
    if (k == K_SOLID || k == K_DOOR) return k;
    k = mt_kind[room[bottom + left]];
    if (k == K_SOLID || k == K_DOOR) return k;
    k = mt_kind[room[bottom + right]];
    if (k == K_SOLID || k == K_DOOR) return k;
    return K_FLOOR;
}

/* Una figura de 16×16 con dos sprites de 8×16. El bloque de 16×16 se convirtió en orden
 * de sprites (columna izquierda: tile, tile+1; derecha: tile+2, tile+3), así que la
 * columna derecha es tile+2. En espejo horizontal también se cambian las columnas. */
void put16(unsigned char n, unsigned char x, unsigned char y, unsigned char tile, unsigned char attr)
{
    unsigned char *o;

    o = shadow_oam + (n << 2);
    o[0] = y + 16;
    o[1] = x + 8;
    o[3] = attr;
    o[4] = y + 16;
    o[5] = x + 16;
    o[7] = attr;
    if (attr & ATTR_FLIPX) {
        o[2] = tile + 2;
        o[6] = tile;
    } else {
        o[2] = tile;
        o[6] = tile + 2;
    }
}

/* Y = 0 deja el sprite fuera de la pantalla. */
void hide16(unsigned char n)
{
    shadow_oam[n << 2] = 0;
    shadow_oam[(n << 2) + 4] = 0;
}
