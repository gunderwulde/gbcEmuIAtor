/* Musgo y la cripta del liquen — aventura cenital de ejemplo (gbcEmuIAtor).
 *
 * Musgo, un pequeño guardián del bosque, tiene que bajar a la cripta y despertar del
 * todo al Liquen Antiguo... a varazos. Busca la llave del bosque para abrir el paso a
 * la escalera, la de la cripta para la sala del fondo, y vence al jefe.
 *
 * Controles: cruceta para andar, A para golpear con la vara. En el título, START
 * continúa la partida guardada (o empieza una si no hay) y SELECT empieza una nueva.
 *
 * Todo (nombre, personajes, mapas, gráficos y textos) es original de este proyecto.
 * El código está repartido en varios ficheros (ver game.h); la ROM usa los bancos 2
 * (mapas) y 3 (gráficos) con #pragma bank y llamadas __banked.
 */
#include "game.h"

#pragma link "room.c"
#pragma link "world.c"
#pragma link "gfx.c"
#pragma link "player.c"
#pragma link "enemies.c"
#pragma link "hud.c"
#pragma link "save.c"

unsigned char pad;                  /* botones pulsados */
unsigned char pressed;              /* los que se acaban de pulsar este frame */
unsigned char tick;                 /* contador de frames de la partida */
unsigned char game_state;
unsigned char hud_dirty;
unsigned int frames_run;            /* vueltas del bucle de juego (para medir: una por VBlank) */

void new_game(void)
{
    memset(flags, 0, N_SCREENS);
    screen = SCREEN_START;
    px = 64;
    py = 80;
    hp = HP_MAX;
    keys = 0;
}

/* Pantalla de texto sobre fondo negro (título, victoria, fin). Deja el LCD apagado:
 * borrar 2 KB de mapa con el LCD encendido cuesta varios frames (la librería espera a
 * STAT byte a byte); quien llama lo vuelve a encender al terminar de dibujar. */
void text_screen(void)
{
    window_off();
    sprites_hide_all();
    wait_vbl();
    oam_flush();
    lcd_off();
    text_layer(TEXT_BG);
    text_attr(ATTR_PAL(7));
    cls();
}

void title(void)
{
    unsigned char k;
    unsigned char saved;

    text_screen();
    saved = save_valid();
    at(5, 3);  print("M U S G O");
    at(0, 5);  print("LA CRIPTA DEL LIQUEN");
    fill_bg(4, 8, 1, 1, T_HEART);
    fill_bg(15, 8, 1, 1, T_HEART);
    if (saved) {
        at(2, 11); print("START  CONTINUAR");
        at(2, 13); print("SELECT NUEVA");
    } else {
        at(2, 11); print("START  JUGAR");
    }
    at(1, 16); print("A: VARA  +: ANDAR");
    lcd_on();
    for (;;) {
        k = wait_key();
        if (k & J_SELECT) { new_game(); break; }
        if (k & J_START) {
            if (!load_game()) new_game();
            break;
        }
    }
    srand(vbl_count);
}

void play(void)
{
    unsigned char last;

    text_screen();
    hud_init();
    player_init();
    world_load(screen);                 /* vuelve a encender el LCD */
    save_game();
    game_state = ST_PLAY;
    last = 0xFF;
    while (game_state == ST_PLAY) {
        wait_vbl();
        oam_flush();
        if (hud_dirty) hud_draw();
        pad = joypad();
        pressed = pad & (last ^ 0xFF);
        last = pad;
        tick++;
        player_update();
        enemies_update();
        player_draw();
        enemies_draw();
        frames_run++;
    }
    wait_vbl();
    oam_flush();
    if (hud_dirty) hud_draw();
    if (game_state == ST_WON) save_game();
    delay(60);
}

void ending(void)
{
    text_screen();
    if (game_state == ST_WON) {
        at(5, 5);  print("VICTORIA!");
        at(1, 8);  print("EL LIQUEN ANTIGUO");
        at(1, 9);  print("VUELVE A DORMIR Y");
        at(1, 10); print("EL BOSQUE RESPIRA.");
        sfx_jump();
    } else {
        at(5, 7);  print("HAS CAIDO");
        at(2, 9);  print("EL BOSQUE ESPERA");
    }
    at(4, 14); print("PULSA START");
    lcd_on();
    while (!(wait_key() & J_START))
        ;
}

int main(void)
{
    lcd_off();
    text_init(0);
    gfx_load();
    sprites_8x16(1);
    sprites_on();
    lcd_on();
    snd_on();
    for (;;) {
        title();
        play();
        ending();
    }
    return 0;
}
