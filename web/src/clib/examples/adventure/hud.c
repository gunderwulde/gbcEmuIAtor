/* hud.c — el marcador en la ventana y los efectos de sonido.
 *
 * La ventana empieza en la línea 128 y tapa las dos últimas filas de tiles: así el
 * marcador no se mueve aunque el fondo cambie. Fila 0: corazones en las columnas 1-5 y
 * la llave con el número de llaves en las 8-10. Fila 1: el nombre de la zona.
 */
#include "game.h"

void hud_init(void)
{
    text_layer(TEXT_WIN);
    text_attr(ATTR_PAL(7));
    cls();
    window(0, 128);
    window_on();
    hud_dirty = 1;
}

void hud_draw(void)
{
    unsigned char i;

    for (i = 0; i < HP_MAX; i++) fill_win(1 + i, 0, 1, 1, i < hp ? T_HEART : T_HEART_OFF);
    fill_win(8, 0, 1, 1, T_KEY);
    text_layer(TEXT_WIN);
    at(9, 0);
    printf("x%u", keys);
    at(1, 1);
    print(screen >= DUNGEON_FIRST ? "CRIPTA  " : "BOSQUE  ");
    printf("%02u", screen);
    hud_dirty = 0;
}

/* ------------------------------------------------------------------ Sonido */
void sfx_sword(void)
{
    snd_noise(0x22, 6, 8);
}

void sfx_key(void)
{
    sfx_jump();
}

void sfx_door(void)
{
    snd_tone(2, NOTE_C4, 20, 12);
}

void sfx_kill(void)
{
    snd_noise(0x55, 20, 12);
}
