/* enemies.c — enemigos y jefe.
 *
 *  - Limo: deambula. Elige una dirección al azar durante un rato y cambia al chocar.
 *    Medio píxel por frame, respeta el mapa. 2 golpes.
 *  - Murciélago: vuela hacia Musgo (por encima de todo), medio píxel por frame. 1 golpe.
 *  - El Liquen Antiguo (jefe, 32×32): persigue a Musgo a un píxel por frame durante
 *    80 frames y descansa 40. 8 golpes.
 * Tocar a un enemigo quita un corazón; cada golpe de vara le quita uno a él, y los dos
 * quedan un rato invulnerables (parpadeando).
 */
#include "game.h"

#define MAX_ENEMIES 4

struct enemy {
    unsigned char type;
    unsigned char x;
    unsigned char y;
    unsigned char hp;
    unsigned char inv;              /* frames de invulnerabilidad */
    unsigned char dir;
    unsigned char timer;
};

struct enemy enemies[MAX_ENEMIES];

void enemies_clear(void)
{
    unsigned char i;

    for (i = 0; i < MAX_ENEMIES; i++) enemies[i].type = EN_NONE;
    for (i = 0; i < 8; i++) shadow_oam[(OAM_ENEMY + i) << 2] = 0;
}

void enemy_spawn(unsigned char type, unsigned char x, unsigned char y)
{
    unsigned char i;
    struct enemy *e;

    for (i = 0; i < MAX_ENEMIES; i++) {
        e = &enemies[i];
        if (e->type == EN_NONE) {
            e->type = type;
            e->x = x;
            e->y = y;
            e->hp = type == EN_BOSS ? 8 : type == EN_SLIME ? 2 : 1;
            e->inv = 0;
            e->dir = 0;
            e->timer = 0;
            return;
        }
    }
}

/* Un paso de limo en su dirección; si choca, se le acaba el rato y elegirá otra. */
static void slime_step(struct enemy *e)
{
    unsigned char x;
    unsigned char y;

    if (e->timer == 0) {
        e->dir = rand() & 3;
        e->timer = 32 + (rand() & 31);
    }
    e->timer--;
    x = e->x;
    y = e->y;
    if (e->dir == DIR_DOWN) y++;
    else if (e->dir == DIR_UP) y--;
    else if (e->dir == DIR_LEFT) x--;
    else x++;
    if (x <= MAX_X && y <= MAX_Y && box_blocked(x, y) == K_FLOOR) {
        e->x = x;
        e->y = y;
    } else {
        e->timer = 0;
    }
}

/* Acerca (x, y) a (tx, ty) un píxel en cada eje. */
static void chase(struct enemy *e, unsigned char tx, unsigned char ty)
{
    if (e->x < tx) e->x++;
    else if (e->x > tx) e->x--;
    if (e->y < ty) e->y++;
    else if (e->y > ty) e->y--;
}

/* ¿Se solapan la caja de Musgo y la del enemigo (16×16 o 32×32, con 2 px de margen)? */
static unsigned char touching(struct enemy *e)
{
    unsigned char size;

    size = e->type == EN_BOSS ? 28 : 12;
    return px + 3 <= e->x + 2 + size && e->x + 2 <= px + 12 &&
           py + 3 <= e->y + 2 + size && e->y + 2 <= py + 14;
}

void enemies_update(void)
{
    unsigned char i;
    unsigned char tx;
    unsigned char ty;
    struct enemy *e;

    for (i = 0; i < MAX_ENEMIES; i++) {
        e = &enemies[i];
        if (e->type == EN_NONE) continue;
        if (e->inv) e->inv--;
        if (e->type == EN_SLIME) {
            if (tick & 1) slime_step(e);
        } else if (e->type == EN_BAT) {
            if (tick & 1) chase(e, px, py);
        } else {
            /* El jefe apunta a que su centro coincida con el de Musgo, dentro de la sala
             * (x 16-112, y 16-80: la parte de dentro de los muros). */
            e->timer++;
            if (e->timer == 120) e->timer = 0;
            if (e->timer < 80) {
                tx = px < 24 ? 16 : px - 8;
                ty = py < 24 ? 16 : py - 8;
                if (tx > 112) tx = 112;
                if (ty > 80) ty = 80;
                chase(e, tx, ty);
            }
        }
        if (touching(e)) player_hurt();
    }
}

/* Golpe de vara: la caja de 16×16 en (x, y). */
void enemies_hit(unsigned char x, unsigned char y)
{
    unsigned char i;
    unsigned char size;
    struct enemy *e;

    for (i = 0; i < MAX_ENEMIES; i++) {
        e = &enemies[i];
        if (e->type == EN_NONE || e->inv) continue;
        size = e->type == EN_BOSS ? 28 : 12;
        if (x + 2 <= e->x + 2 + size && e->x + 2 <= x + 13 &&
            y + 2 <= e->y + 2 + size && e->y + 2 <= y + 13) {
            e->inv = 20;
            e->hp--;
            if (e->hp == 0) {
                if (e->type == EN_BOSS) {
                    flags[screen] |= F_BOSS;
                    game_state = ST_WON;
                }
                e->type = EN_NONE;
                sfx_kill();
            } else {
                sfx_hit();
            }
        }
    }
}

void enemies_draw(void)
{
    unsigned char i;
    unsigned char n;
    unsigned char tile;
    unsigned char attr;
    unsigned char step;
    struct enemy *e;

    step = (tick >> 4) & 1;
    for (i = 0; i < MAX_ENEMIES; i++) {
        e = &enemies[i];
        n = OAM_ENEMY + i * 2;
        if (e->type == EN_NONE) {
            /* Si el jefe (siempre en el hueco 0) vive, las entradas de los huecos 1-3
             * son suyas. */
            if (enemies[0].type != EN_BOSS) hide16(n);
            continue;
        }
        if (e->inv & 2) {
            if (e->type == EN_BOSS) {
                hide16(OAM_ENEMY);
                hide16(OAM_ENEMY + 2);
                hide16(OAM_ENEMY + 4);
                hide16(OAM_ENEMY + 6);
            } else {
                hide16(n);
            }
            continue;
        }
        if (e->type == EN_SLIME) {
            put16(n, e->x, e->y, BLOCK(B_SLIME + step), ATTR_PAL(OP_SLIME));
        } else if (e->type == EN_BAT) {
            put16(n, e->x, e->y, BLOCK(B_BAT + step), ATTR_PAL(OP_BAT));
        } else {
            /* 32×32: la mitad izquierda dibujada y la derecha, la misma en espejo. */
            attr = ATTR_PAL(OP_BOSS);
            tile = BLOCK(B_BOSS);
            put16(OAM_ENEMY, e->x, e->y, tile, attr);
            put16(OAM_ENEMY + 2, e->x + 16, e->y, tile, attr | ATTR_FLIPX);
            tile = BLOCK(B_BOSS + 1);
            put16(OAM_ENEMY + 4, e->x, e->y + 16, tile, attr);
            put16(OAM_ENEMY + 6, e->x + 16, e->y + 16, tile, attr | ATTR_FLIPX);
        }
    }
}
