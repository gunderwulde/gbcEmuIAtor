/* 10 — Lluvia de estrellas (minijuego)
 *
 * Mueve la cesta con la cruceta y recoge las estrellas antes de que lleguen al suelo.
 * Cada estrella recogida suma un punto; cada una que cae resta una vida. Con 3 fallos
 * se acaba la partida. Cada 10 puntos las estrellas caen más deprisa.
 *
 * El récord se guarda en la RAM del cartucho, alimentada por una pila: sobrevive al
 * apagado (en el emulador, en el .sav). 10-save.asm reserva esa RAM y aquí se usa con
 * una variable en dirección fija. Una "firma" al principio distingue una partida
 * guardada de una RAM sin inicializar.
 *
 * Junta casi todo lo de los ejemplos anteriores: tiles propios, paletas, sprites con la
 * OAM sombra, texto, joypad con flancos, sonido, números aleatorios y SRAM.
 */
#include <gbc.h>

#pragma link "10-save.asm"

/* ----------------------------------------------------------------- Partida guardada */
__at(0xA000) unsigned char save[8];   /* 'S' 'T' 'A' 'R', récord (2 bytes) */

unsigned int record;

void load_record(void)
{
    sram_on();
    if (save[0] == 'S' && save[1] == 'T' && save[2] == 'A' && save[3] == 'R') {
        record = save[4] | (save[5] << 8);
    } else {
        record = 0;
    }
    sram_off();
}

void save_record(void)
{
    sram_on();
    save[0] = 'S';
    save[1] = 'T';
    save[2] = 'A';
    save[3] = 'R';
    save[4] = record & 0xFF;
    save[5] = record >> 8;
    sram_off();                        /* protege la RAM si se apaga a destiempo */
}

/* ----------------------------------------------------------------- Gráficos */
#define TILE_FONT   0                  /* fuente: tiles 0-95 */
#define TILE_GROUND 96
#define TILE_STAR   97                 /* sprites */
#define TILE_BASKET 98                 /* dos tiles: 98 y 99 */

const unsigned char gfx[4 * 16] = {
    /* suelo */
    TILE_ROW(1,1,1,1,1,1,1,1), TILE_ROW(2,1,2,1,2,1,2,1), TILE_ROW(2,2,2,2,2,2,2,2), TILE_ROW(2,3,2,2,2,3,2,2),
    TILE_ROW(2,2,2,2,2,2,2,2), TILE_ROW(2,2,3,2,2,2,2,3), TILE_ROW(2,2,2,2,2,2,2,2), TILE_ROW(3,2,2,2,3,2,2,2),
    /* estrella */
    TILE_ROW(0,0,0,1,1,0,0,0), TILE_ROW(0,0,0,1,1,0,0,0), TILE_ROW(1,1,1,2,2,1,1,1), TILE_ROW(0,1,2,3,3,2,1,0),
    TILE_ROW(0,0,1,3,3,1,0,0), TILE_ROW(0,1,2,1,1,2,1,0), TILE_ROW(0,1,1,0,0,1,1,0), TILE_ROW(1,1,0,0,0,0,1,1),
    /* cesta, mitad izquierda */
    TILE_ROW(3,0,0,0,0,0,0,0), TILE_ROW(3,3,0,0,0,0,0,0), TILE_ROW(3,1,3,3,3,3,3,3), TILE_ROW(3,1,2,1,2,1,2,1),
    TILE_ROW(0,3,1,2,1,2,1,2), TILE_ROW(0,3,2,1,2,1,2,1), TILE_ROW(0,0,3,2,1,2,1,2), TILE_ROW(0,0,3,3,3,3,3,3),
    /* cesta, mitad derecha */
    TILE_ROW(0,0,0,0,0,0,0,3), TILE_ROW(0,0,0,0,0,0,3,3), TILE_ROW(3,3,3,3,3,3,1,3), TILE_ROW(2,1,2,1,2,1,1,3),
    TILE_ROW(1,2,1,2,1,2,3,0), TILE_ROW(2,1,2,1,2,1,3,0), TILE_ROW(1,2,1,2,1,3,0,0), TILE_ROW(3,3,3,3,3,3,0,0),
};

const unsigned int bg_pals[8] = {
    RGB(2, 2, 8), 0, 0, RGB(31, 31, 24),                     /* 0: cielo y texto */
    RGB(2, 2, 8), RGB(10, 20, 6), RGB(6, 12, 2), RGB(2, 6, 0),  /* 1: suelo */
};
const unsigned int obj_pals[8] = {
    0, RGB(31, 31, 10), RGB(31, 24, 0), RGB(31, 31, 31),     /* 0: estrella */
    0, RGB(24, 16, 8), RGB(16, 8, 4), RGB(8, 4, 0),          /* 1: cesta */
};

/* ----------------------------------------------------------------- Juego */
#define NSTARS     4
#define GROUND_Y   136                 /* primera línea del suelo */
#define BASKET_Y   (GROUND_Y - 8)
#define SPR_BASKET 0                   /* sprites 0 y 1 */
#define SPR_STAR   2                   /* sprites 2-5 */

struct star {
    unsigned char x;
    unsigned char y;
    unsigned char wait;                /* frames hasta caer (0 = cayendo) */
};

struct star stars[NSTARS];
unsigned char px;                      /* x de la cesta (16 píxeles de ancho) */
unsigned int score;
unsigned char lives;
unsigned char speed;

void star_reset(struct star *s)
{
    s->x = 8 + rand() % 144;
    s->y = 0;
    s->wait = 10 + rand() % 60;
}

void draw_hud(void)
{
    at(0, 0);
    printf("PUNTOS %3u  VIDAS %u", score, lives);
}

void draw_basket(void)
{
    sprite_move(SPR_BASKET, px, BASKET_Y);
    sprite_move(SPR_BASKET + 1, px + 8, BASKET_Y);
}

/* Devuelve 1 si la estrella ha tocado la cesta. */
unsigned char caught(struct star *s)
{
    return s->y + 8 > BASKET_Y && s->y < BASKET_Y + 8 && s->x + 8 > px && s->x < px + 16;
}

void play(void)
{
    unsigned char i;
    unsigned char keys;
    struct star *s;

    score = 0;
    lives = 3;
    speed = 1;
    px = 72;
    for (i = 0; i < NSTARS; i++) {
        star_reset(&stars[i]);
        sprite_set(SPR_STAR + i, 0, 0, TILE_STAR, ATTR_PAL(0));
        sprite_hide(SPR_STAR + i);
    }
    sprite_set(SPR_BASKET, 0, 0, TILE_BASKET, ATTR_PAL(1));
    sprite_set(SPR_BASKET + 1, 0, 0, TILE_BASKET + 1, ATTR_PAL(1));
    draw_basket();
    cls();
    fill_bg(0, 17, 20, 1, TILE_GROUND);
    fill_bg_attr(0, 17, 20, 1, ATTR_PAL(1));
    draw_hud();

    while (lives) {
        wait_vbl();
        oam_flush();

        keys = joypad();
        if ((keys & J_LEFT) && px > 2) px -= 2;
        if ((keys & J_RIGHT) && px < 160 - 16 - 2) px += 2;
        draw_basket();

        for (i = 0; i < NSTARS; i++) {
            s = &stars[i];
            if (s->wait) {
                s->wait--;
                continue;
            }
            s->y += speed;
            if (caught(s)) {
                score++;
                if (score % 10 == 0 && speed < 3) speed++;
                sfx_jump();
                star_reset(s);
                sprite_hide(SPR_STAR + i);
                draw_hud();
            } else if (s->y >= GROUND_Y) {
                lives--;
                sfx_hit();
                star_reset(s);
                sprite_hide(SPR_STAR + i);
                draw_hud();
            } else {
                sprite_move(SPR_STAR + i, s->x, s->y);
            }
        }
    }
    sprites_hide_all();
    wait_vbl();
    oam_flush();
}

void title(void)
{
    cls();
    fill_bg(0, 17, 20, 1, TILE_GROUND);
    fill_bg_attr(0, 17, 20, 1, ATTR_PAL(1));
    at(3, 4);  print("LLUVIA  DE");
    at(5, 6);  print("ESTRELLAS");
    at(4, 10); printf("RECORD %3u", record);
    at(4, 13); print("PULSA START");
    while (!(wait_key() & J_START))
        ;
    srand(vbl_count);                  /* el momento de pulsar START siembra el azar */
}

void game_over(void)
{
    at(3, 7);  print("FIN DE PARTIDA");
    if (score > record) {
        record = score;
        save_record();
        at(3, 9); print("NUEVO RECORD!");
    }
    delay(30);
    while (!(wait_key() & J_START))
        ;
}

int main(void)
{
    lcd_off();
    text_init(TILE_FONT);
    set_bg_tiles(TILE_GROUND, 1, gfx);
    set_sprite_tiles(TILE_STAR, 3, gfx + 16);
    set_bg_palette(0, bg_pals);
    set_bg_palette(1, bg_pals + 4);
    set_sprite_palette(0, obj_pals);
    set_sprite_palette(1, obj_pals + 4);
    sprites_on();
    lcd_on();
    snd_on();

    load_record();
    for (;;) {
        title();
        play();
        game_over();
    }
    return 0;
}
