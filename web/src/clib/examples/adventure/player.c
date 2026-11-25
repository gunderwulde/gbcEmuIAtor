/* player.c — Musgo, el protagonista: anda en 4 direcciones (1 píxel por frame), choca
 * con el mapa, golpea con la vara (A), recoge llaves y corazones, abre puertas y cambia
 * de pantalla al salir por un borde.
 */
#include "game.h"

unsigned char px;
unsigned char py;
unsigned char pdir;
unsigned char hp;
unsigned char keys;
unsigned char pinv;                 /* frames de invulnerabilidad tras un golpe */
unsigned char attack;               /* frames que le quedan al golpe de vara */
unsigned char pstep;                /* contador de pasos para la animación */
unsigned char sword_x;
unsigned char sword_y;

void player_init(void)
{
    pinv = 0;
    attack = 0;
    pstep = 0;
}

void player_hurt(void)
{
    if (pinv || hp == 0) return;
    hp--;
    pinv = 60;
    hud_dirty = 1;
    sfx_hit();
    if (hp == 0) game_state = ST_DEAD;
}

/* Intenta ir a (x, y). Contra una puerta cerrada con una llave en el bolsillo, la abre. */
static void try_move(unsigned char x, unsigned char y)
{
    unsigned char k;

    k = box_blocked(x, y);
    if (k == K_FLOOR) {
        px = x;
        py = y;
    } else if (k == K_DOOR && keys) {
        keys--;
        world_open_doors();
        hud_dirty = 1;
        sfx_door();
        save_game();
    }
}

/* Entra en la pantalla `id` en (x, y) y guarda la partida. */
static void enter(unsigned char id, unsigned char x, unsigned char y)
{
    px = x;
    py = y;
    attack = 0;
    hide16(OAM_SWORD);
    world_load(id);
    hud_dirty = 1;                      /* el marcador lleva el número de pantalla */
    save_game();
}

/* Sale por un borde: la pantalla vecina en la misma rejilla (4×4 fuera, 4×2 dentro). */
static void leave(unsigned char dir)
{
    unsigned char col;
    unsigned char row;
    unsigned char rows;

    col = screen & 3;
    row = (screen & 15) >> 2;
    rows = screen >= DUNGEON_FIRST ? 2 : 4;
    if (dir == DIR_LEFT && col > 0) enter(screen - 1, MAX_X, py);
    else if (dir == DIR_RIGHT && col < 3) enter(screen + 1, 0, py);
    else if (dir == DIR_UP && row > 0) enter(screen - 4, px, MAX_Y);
    else if (dir == DIR_DOWN && row < rows - 1) enter(screen + 4, px, 0);
}

/* Lo que hay bajo el centro del personaje: objetos y escaleras. */
static void touch(void)
{
    unsigned char cell;
    unsigned char k;
    unsigned char ground;

    cell = cell_at(px + 8, py + 10);
    k = mt_kind[room[cell]];
    ground = screen >= DUNGEON_FIRST ? MT_FLOOR : MT_GRASS;
    if (k == K_KEY) {
        keys++;
        flags[screen] |= F_ITEM;
        world_set_cell(cell, ground);
        hud_dirty = 1;
        sfx_key();
        save_game();
    } else if (k == K_HEART) {
        if (hp < HP_MAX) hp++;
        flags[screen] |= F_ITEM;
        world_set_cell(cell, ground);
        hud_dirty = 1;
        sfx_key();
        save_game();
    } else if (k == K_DOWN) {
        enter(SCREEN_CRYPT, 48, 48);        /* bajo la escalera que sube (celda 3,2) */
    } else if (k == K_UP) {
        enter(SCREEN_STAIRS, 80, 48);       /* bajo la escalera que baja (celda 5,2) */
    }
}

void player_update(void)
{
    unsigned char moved;

    if (pinv) pinv--;
    if (attack) {
        attack--;
        if (attack) enemies_hit(sword_x, sword_y);
        return;
    }
    if (pressed & J_A) {
        /* La vara ocupa el bloque de 16×16 de delante, solapado 4 píxeles. */
        sword_x = px;
        sword_y = py;
        if (pdir == DIR_UP) sword_y = py - 12;
        else if (pdir == DIR_DOWN) sword_y = py + 12;
        else if (pdir == DIR_LEFT) sword_x = px - 12;
        else sword_x = px + 12;
        attack = 12;
        sfx_sword();
        enemies_hit(sword_x, sword_y);
        return;
    }

    moved = 0;
    if (pad & J_LEFT) {
        pdir = DIR_LEFT;
        moved = 1;
        if (px == 0) { leave(DIR_LEFT); return; }
        try_move(px - 1, py);
    } else if (pad & J_RIGHT) {
        pdir = DIR_RIGHT;
        moved = 1;
        if (px == MAX_X) { leave(DIR_RIGHT); return; }
        try_move(px + 1, py);
    }
    if (pad & J_UP) {
        pdir = DIR_UP;
        moved = 1;
        if (py == 0) { leave(DIR_UP); return; }
        try_move(px, py - 1);
    } else if (pad & J_DOWN) {
        pdir = DIR_DOWN;
        moved = 1;
        if (py == MAX_Y) { leave(DIR_DOWN); return; }
        try_move(px, py + 1);
    }
    if (moved) {
        pstep++;
        touch();
    }
}

void player_draw(void)
{
    unsigned char tile;
    unsigned char attr;
    unsigned char step;

    /* Parpadeo de invulnerabilidad: oculto 4 de cada 8 frames. */
    if (pinv & 4) {
        hide16(OAM_PLAYER);
    } else {
        step = (pstep >> 3) & 1;
        attr = ATTR_PAL(OP_PLAYER);
        if (pdir == DIR_DOWN || pdir == DIR_UP) {
            /* De frente y de espaldas, el segundo paso es el primero en espejo. */
            tile = BLOCK(pdir == DIR_DOWN ? B_PLAYER_DOWN : B_PLAYER_UP);
            if (step) attr |= ATTR_FLIPX;
        } else {
            tile = BLOCK(B_PLAYER_SIDE + step);
            if (pdir == DIR_RIGHT) attr |= ATTR_FLIPX;
        }
        put16(OAM_PLAYER, px, py, tile, attr);
    }

    if (attack && sword_x <= MAX_X && sword_y <= MAX_Y) {
        attr = ATTR_PAL(OP_SWORD);
        if (pdir == DIR_UP || pdir == DIR_DOWN) {
            tile = BLOCK(B_SWORD_V);
            if (pdir == DIR_DOWN) attr |= ATTR_FLIPY;
        } else {
            tile = BLOCK(B_SWORD_H);
            if (pdir == DIR_RIGHT) attr |= ATTR_FLIPX;
        }
        put16(OAM_SWORD, sword_x, sword_y, tile, attr);
    } else {
        hide16(OAM_SWORD);
    }
}
