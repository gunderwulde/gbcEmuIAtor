/* world.c — los mapas del mundo y su dibujo. Va entero al banco 2 de la ROM: sólo se usa
 * al cambiar de pantalla o al abrir una puerta, y así no ocupa ROM0.
 *
 * Cada pantalla son 8 filas de 10 caracteres, un carácter por metatile de 16×16:
 *
 *   .  hierba        T  árbol         ~  agua          R  roca
 *   D  puerta        K  llave         H  corazón       S  escalera que baja
 *   ,  losa          #  muro          d  puerta        k  llave
 *   h  corazón       U  escalera que sube
 *   s  limo          b  murciélago    (sobre hierba)
 *   z  limo          v  murciélago    X  el jefe       (sobre losa)
 *
 * Exterior: rejilla de 4×4 (pantallas 0-15, fila a fila). Cripta: rejilla de 4×2
 * (16-23). Las salidas entre pantallas son siempre las mismas casillas: columnas 4-5 en
 * los bordes de arriba y abajo, filas 3-4 en los de los lados.
 *
 *        0  1  2  3            16 17 18 19
 *        4 [5] 6  7            20 21 22 23
 *        8  9 10 11
 *       12 13 14 15
 *
 * Se empieza en la 5. La llave del exterior está en la 1; la puerta cerrada y la
 * escalera, en la 6. En la cripta (se entra por la 20), la llave está en la 18 y la
 * puerta de la sala del jefe (23) en la 22.
 */
#pragma bank 2
#include "game.h"

const char world_map[] =
    /* 0 */
    "TTTTTTTTTT"
    "T........T"
    "T.~~~....T"
    "T.~~~..s.."
    "T........."
    "T...R....T"
    "T........T"
    "TTTT..TTTT"
    /* 1: la llave */
    "TTTTTTTTTT"
    "T...K....T"
    "TT......TT"
    ".........."
    ".........."
    "T.......sT"
    "T.TT.....T"
    "TTTT..TTTT"
    /* 2 */
    "TTTTTTTTTT"
    "T..b.....T"
    "T.RR..RR.T"
    ".........."
    ".........."
    "T.RR..RR.T"
    "T....H...T"
    "TTTTTTTTTT"
    /* 3 */
    "TTTTTTTTTT"
    "T~~~~~~~~T"
    "T~~....~~T"
    "......s.~T"
    "........~T"
    "T..b.....T"
    "T........T"
    "TTTT..TTTT"
    /* 4 */
    "TTTT..TTTT"
    "T........T"
    "T.T..T...T"
    "T........."
    "T....s...."
    "T.T..T...T"
    "T........T"
    "TTTT..TTTT"
    /* 5: el principio */
    "TTTT..TTTT"
    "T........T"
    "T.R....R.T"
    ".........."
    ".........."
    "T.....~~.T"
    "T.....~~.T"
    "TTTT..TTTT"
    /* 6: la puerta y la escalera */
    "TTTTTTTTTT"
    "T..RRRRR.T"
    "T..R.S.R.T"
    "...R...R.."
    "...RRDRR.."
    "T........T"
    "T........T"
    "TTTTTTTTTT"
    /* 7 */
    "TTTT..TTTT"
    "T....b...T"
    "T.~~~~...T"
    "..~~~~...T"
    "........sT"
    "T........T"
    "T..R..R..T"
    "TTTT..TTTT"
    /* 8 */
    "TTTT..TTTT"
    "T........T"
    "T.s...TT.T"
    "T........."
    "T........."
    "T..TT....T"
    "T........T"
    "TTTT..TTTT"
    /* 9 */
    "TTTT..TTTT"
    "T........T"
    "T.~~..~~.T"
    "...b......"
    ".........."
    "T.~~..~~.T"
    "T...H....T"
    "TTTTTTTTTT"
    /* 10 */
    "TTTTTTTTTT"
    "T........T"
    "T.RRRRRR.T"
    "...s......"
    ".........."
    "T.RRRRRR.T"
    "T.......bT"
    "TTTT..TTTT"
    /* 11 */
    "TTTT..TTTT"
    "T........T"
    "T.T.T.T..T"
    "........sT"
    ".........T"
    "T.T.T.T..T"
    "T........T"
    "TTTT..TTTT"
    /* 12 */
    "TTTT..TTTT"
    "T........T"
    "T.~~~~~..T"
    "T.~~~~~..."
    "T.....s..."
    "T..b.....T"
    "T........T"
    "TTTTTTTTTT"
    /* 13 */
    "TTTTTTTTTT"
    "T..T..T..T"
    "T........T"
    "..s......."
    ".........."
    "T..T..T..T"
    "T...b....T"
    "TTTTTTTTTT"
    /* 14 */
    "TTTT..TTTT"
    "T........T"
    "T.R....R.T"
    ".....s...."
    ".........."
    "T.R.H..R.T"
    "T........T"
    "TTTTTTTTTT"
    /* 15 */
    "TTTT..TTTT"
    "T~~....~~T"
    "T~..b...~T"
    "........~T"
    "....s...~T"
    "T~......~T"
    "T~~~..~~~T"
    "TTTTTTTTTT"
    /* 16 */
    "##########"
    "#,,,,,,,,#"
    "#,h,,,z,,#"
    "#,,,,,,,,#"
    "#,,,,,,,,#"
    "#,,,z,,,,#"
    "#,,,,,,,,#"
    "####,,####"
    /* 17 */
    "##########"
    "#,,,,,,,,#"
    "#,,v,,,,,#"
    "#,,,,,,,,,"
    "#,,,,,,,,,"
    "#,,z,,,v,#"
    "#,,,,,,,,#"
    "####,,####"
    /* 18: la llave de la cripta */
    "##########"
    "#,,,,,,,,#"
    "#,######,#"
    ",,#,k,,#,,"
    ",,#,,,,#,,"
    "#,#,,,,#,#"
    "#,,,,z,,,#"
    "##########"
    /* 19: la pantalla con más enemigos */
    "##########"
    "#,,,,,,,,#"
    "#,,v,,v,,#"
    ",,,,,,,,,#"
    ",,,,,,,,h#"
    "#,,z,,,,z#"
    "#,,,,,,,,#"
    "##########"
    /* 20: la entrada */
    "####,,####"
    "#,,,,,,,,#"
    "#,,U,,,,,#"
    "#,,,,,,,,,"
    "#,,,,,,,,,"
    "#,,,,,z,,#"
    "#,,,,,,,,#"
    "##########"
    /* 21 */
    "####,,####"
    "#,,,,,,,,#"
    "#,##,,##,#"
    ",,,,,,,,,,"
    ",,,,v,,,,,"
    "#,##,,##,#"
    "#,,,,,,,,#"
    "##########"
    /* 22: la puerta del jefe */
    "##########"
    "#,,,,,,,,#"
    "#,z,,,,z,#"
    ",,,,,,,,,d"
    ",,,,,,,,,d"
    "#,,,,,,,,#"
    "#,,,,,,,,#"
    "##########"
    /* 23: el jefe */
    "##########"
    "#,,,,,,,,#"
    "#,,,,,,,,#"
    ",,,,,,X,,#"
    ",,,,,,,,,#"
    "#,,,,,,,,#"
    "#,,,,,,,,#"
    "##########";

/* Dibujo de cada metatile: bloque de gfx.c y paleta de fondo (en el orden de MT_*). */
const unsigned char mt_block[N_MT] = { 0, 1, 2, 3, 7, 8, 11, 9, 5, 6, 7, 8, 11, 10 };
const unsigned char mt_pal[N_MT]   = { 0, 1, 2, 3, 5, 5, 5, 3, 4, 4, 6, 6, 6, 4 };

/* 20×16 tiles de la pantalla con filas de 32 como en VRAM, alineados a 16 en WRAMX:
 * así vram_copy los pasa de golpe con GDMA (con el LCD apagado). */
__at(0xD000) unsigned char map_tiles[512];
__at(0xD200) unsigned char map_attrs[512];

#pragma link "expand.asm"
void expand_room(void);             /* room[] → map_tiles y map_attrs */

/* Qué marca de la pantalla hace desaparecer cada metatile (objeto recogido, puerta
 * abierta), en el orden de MT_*. */
const unsigned char mt_hide[N_MT] = { 0, 0, 0, 0, F_DOOR, F_ITEM, F_ITEM, 0, 0, 0, F_DOOR, F_ITEM, F_ITEM, 0 };

/* Letras del mapa con metatile propio; el resto ('.', ',' y los enemigos) es suelo. */
const char map_chars[] = "T~RDKHS#dkhU";
const unsigned char map_mts[] = {
    MT_TREE, MT_WATER, MT_ROCK, MT_DOOR, MT_KEY, MT_HEART, MT_DOWN, MT_WALL,
    MT_DDOOR, MT_DKEY, MT_DHEART, MT_UP,
};
#define MT_GROUND 0x80
unsigned char char_mt[128];         /* letra del mapa → metatile (o MT_GROUND) */

/* Pone el metatile `mt` en la celda `cell` de los buffers del mapa (fuera del bucle
 * de carga, que escribe con punteros). */
static void plot(unsigned int p, unsigned char mt)
{
    unsigned char *d;
    unsigned char t;
    unsigned char a;

    t = BLOCK(mt_block[mt]);
    a = mt_pal[mt];
    d = map_tiles + p;
    d[0] = t;
    d[1] = t + 1;
    d[32] = t + 2;
    d[33] = t + 3;
    d = map_attrs + p;
    d[0] = a;
    d[1] = a;
    d[32] = a;
    d[33] = a;
}

/* Carga la pantalla `id`: decodifica el mapa en room[], quita lo que ya se recogió o se
 * abrió (flags), crea los enemigos y dibuja el fondo.
 *
 * Tiene que caber en un frame: nada de divisiones ni multiplicaciones (el compilador las
 * hace con rutinas), una tabla en vez de un switch por letra, y el paso de metatiles a
 * tiles en ensamblador (expand.asm). El mapa se copia con el LCD apagado (un frame en blanco al cambiar de
 * pantalla): encendido, la librería espera a STAT byte a byte y 640 bytes costarían
 * varios frames. */
void __banked world_load(unsigned char id)
{
    const char *m;
    unsigned char *r;
    unsigned char i;
    unsigned char c;
    unsigned char x;
    unsigned char y;
    unsigned char ch;
    unsigned char mt;
    unsigned char ground;
    unsigned char f;

    memset(char_mt, MT_GROUND, 128);
    for (i = 0; i < 12; i++) char_mt[map_chars[i]] = map_mts[i];
    screen = id;
    m = world_map;
    for (i = id; i; i--) m += ROOM_CELLS;
    f = flags[id];
    ground = id >= DUNGEON_FIRST ? MT_FLOOR : MT_GRASS;
    enemies_clear();
    r = room;
    y = 0;
    for (i = 0; i < ROOM_H; i++) {
        x = 0;
        for (c = 0; c < ROOM_W; c++) {
            ch = *m++;
            mt = char_mt[ch];
            if (mt == MT_GROUND) {
                mt = ground;
                if (ch == 's' || ch == 'z') enemy_spawn(EN_SLIME, x, y);
                else if (ch == 'b' || ch == 'v') enemy_spawn(EN_BAT, x, y);
                else if (ch == 'X' && !(f & F_BOSS)) enemy_spawn(EN_BOSS, x, y);
            } else if (mt_hide[mt] & f) {
                mt = ground;
            }
            *r++ = mt;
            x += 16;
        }
        y += 16;
    }
    expand_room();
    lcd_off();
    vram_copy(0x9800, map_tiles, 512);  /* GDMA: 16 filas de 32 */
    vram_bank(1);
    vram_copy(0x9800, map_attrs, 512);
    vram_bank(0);
    lcd_on();
}

/* Cambia una celda (llave recogida, puerta abierta) y la redibuja. */
void __banked world_set_cell(unsigned char cell, unsigned char mt)
{
    unsigned int p;
    unsigned char r;
    unsigned char c;

    room[cell] = mt;
    /* fila y columna por restas (sin división de la librería) */
    r = 0;
    c = cell;
    p = 0;
    while (c >= ROOM_W) {
        c -= ROOM_W;
        r += 2;
        p += 64;
    }
    c += c;
    p += c;
    plot(p, mt);
    set_bg_map(c, r, 2, 1, map_tiles + p);
    set_bg_map(c, r + 1, 2, 1, map_tiles + p + 32);
    fill_bg_attr(c, r, 2, 2, mt_pal[mt]);
}

/* Abre todas las puertas de la pantalla (una llave por pantalla, aunque la puerta ocupe
 * dos casillas, como en la 22). */
void __banked world_open_doors(void)
{
    unsigned char i;
    unsigned char ground;

    ground = screen >= DUNGEON_FIRST ? MT_FLOOR : MT_GRASS;
    flags[screen] |= F_DOOR;
    for (i = 0; i < ROOM_CELLS; i++) {
        if (mt_kind[room[i]] == K_DOOR) world_set_cell(i, ground);
    }
}
