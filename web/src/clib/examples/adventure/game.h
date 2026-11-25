/* game.h — declaraciones compartidas de «Musgo y la cripta del liquen».
 *
 * Aventura cenital original hecha para gbcEmuIAtor. El mundo son pantallas fijas de
 * 10×8 metatiles (16×16 píxeles = 2×2 tiles) que ocupan las 16 primeras filas de tiles
 * del fondo (160×128 píxeles); las 2 filas de abajo son la ventana con el marcador.
 *
 * Reparto en ficheros (cada uno con su pestaña en el IDE):
 *   main.c     título, bucle de juego, victoria y fin de partida
 *   room.c     la pantalla actual en RAM y las consultas de colisión (camino caliente)
 *   world.c    mapas y su dibujo (banco 2 de ROM)
 *   gfx.c      gráficos y paletas como texto, convertidos a tiles al arrancar (banco 3)
 *   player.c   el protagonista: movimiento, ataque, objetos, cambio de pantalla
 *   enemies.c  enemigos y jefe: IA, vida, daño
 *   hud.c      marcador en la ventana
 *   save.c     partida guardada en la RAM con pila del cartucho (+ save.asm)
 */
#ifndef GAME_H
#define GAME_H

#include <gbc.h>

/* ------------------------------------------------------------------ Pantallas */
#define ROOM_W      10              /* metatiles por fila */
#define ROOM_H      8
#define ROOM_CELLS  80
#define MAX_X       144             /* x máxima de algo de 16×16 (160 − 16) */
#define MAX_Y       112             /* y máxima (128 − 16) */

#define N_SCREENS     24            /* 16 exteriores (4×4) + 8 de mazmorra (4×2) */
#define DUNGEON_FIRST 16
#define SCREEN_START  5
#define SCREEN_STAIRS 6             /* la de la escalera que baja a la mazmorra */
#define SCREEN_CRYPT  20            /* la de la escalera que sube */

/* Comportamiento de cada metatile (mt_kind). */
#define K_FLOOR  0
#define K_SOLID  1
#define K_DOOR   2                  /* sólido hasta que se abre con una llave */
#define K_KEY    3
#define K_HEART  4
#define K_DOWN   5                  /* escalera que baja */
#define K_UP     6                  /* escalera que sube */

/* Metatiles (índices de mt_kind, mt_block y mt_pal). */
#define MT_GRASS   0
#define MT_TREE    1
#define MT_WATER   2
#define MT_ROCK    3
#define MT_DOOR    4
#define MT_KEY     5
#define MT_HEART   6
#define MT_DOWN    7
#define MT_FLOOR   8
#define MT_WALL    9
#define MT_DDOOR   10
#define MT_DKEY    11
#define MT_DHEART  12
#define MT_UP      13
#define N_MT       14

/* Marcas por pantalla (flags[]): lo que ya no vuelve a aparecer. */
#define F_ITEM  1                   /* llave o corazón recogido */
#define F_DOOR  2                   /* puertas abiertas */
#define F_BOSS  4                   /* jefe derrotado */

/* ------------------------------------------------------------------ Tiles */
/* Fuente en los tiles 0-95; cada bloque de 16×16 de gfx.c ocupa 4 tiles desde el 96. */
#define TILE_BASE   96
#define BLOCK(n)    (TILE_BASE + 4 * (n))
#define B_HUD       12              /* corazón lleno, corazón vacío, llave, vacío */
#define T_HEART     BLOCK(B_HUD)
#define T_HEART_OFF (BLOCK(B_HUD) + 1)
#define T_KEY       (BLOCK(B_HUD) + 2)
#define B_PLAYER_DOWN 13
#define B_PLAYER_UP   14
#define B_PLAYER_SIDE 15            /* 15 y 16: dos pasos mirando a la izquierda */
#define B_SWORD_V     17
#define B_SWORD_H     18
#define B_SLIME       19            /* 19 y 20 */
#define B_BAT         21            /* 21 y 22 */
#define B_BOSS        23            /* 23 (mitad de arriba) y 24 (de abajo), lado izquierdo */
#define N_BLOCKS      25
#define FIRST_SPRITE_BLOCK 13

/* Paletas de objetos */
#define OP_PLAYER 0
#define OP_SLIME  1
#define OP_BAT    2
#define OP_BOSS   3
#define OP_SWORD  4

/* Sprites (modo 8×16: cada cosa de 16×16 son dos entradas de OAM) */
#define OAM_PLAYER  0
#define OAM_SWORD   2
#define OAM_ENEMY   4               /* 4-11: 4 enemigos × 2, o el jefe (8) */

/* ------------------------------------------------------------------ Estado */
#define DIR_DOWN  0
#define DIR_UP    1
#define DIR_LEFT  2
#define DIR_RIGHT 3

#define HP_MAX 5

#define ST_PLAY 0
#define ST_DEAD 1
#define ST_WON  2

extern unsigned char screen;            /* pantalla actual (0-23) */
extern unsigned char flags[N_SCREENS];
extern unsigned char room[ROOM_CELLS];  /* metatiles de la pantalla actual */
extern const unsigned char mt_kind[N_MT];

extern unsigned char px, py, pdir, hp, keys;
extern unsigned char pad, pressed, tick, game_state, hud_dirty;
extern unsigned int frames_run;

/* room.c */
unsigned char cell_at(unsigned char x, unsigned char y);
unsigned char box_blocked(unsigned char x, unsigned char y);
void put16(unsigned char n, unsigned char x, unsigned char y, unsigned char tile, unsigned char attr);
void hide16(unsigned char n);

/* world.c (banco 2) */
void __banked world_load(unsigned char id);
void __banked world_set_cell(unsigned char cell, unsigned char mt);
void __banked world_open_doors(void);

/* gfx.c (banco 3) */
void __banked gfx_load(void);

/* player.c */
void player_init(void);
void player_update(void);
void player_draw(void);
void player_hurt(void);

/* enemies.c */
#define EN_NONE  0
#define EN_SLIME 1
#define EN_BAT   2
#define EN_BOSS  3
void enemies_clear(void);
void enemy_spawn(unsigned char type, unsigned char x, unsigned char y);
void enemies_update(void);
void enemies_hit(unsigned char x, unsigned char y);
void enemies_draw(void);

/* hud.c */
void hud_init(void);
void hud_draw(void);

/* save.c */
void save_game(void);
unsigned char save_valid(void);
unsigned char load_game(void);

/* sonido (hud.c) */
void sfx_sword(void);
void sfx_key(void);
void sfx_door(void);
void sfx_kill(void);

#endif
