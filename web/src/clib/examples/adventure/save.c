/* save.c — partida guardada en la RAM del cartucho (MBC5 + RAM + pila: el .sav).
 *
 * Formato (A000h):
 *   0-3   firma 'M' 'S' 'G' 'O' (una RAM sin inicializar no la tiene)
 *   4     versión (1)
 *   5     pantalla
 *   6-7   x, y del jugador
 *   8     corazones
 *   9     llaves
 *   10-33 marcas de las 24 pantallas (F_ITEM, F_DOOR, F_BOSS)
 * Se guarda al entrar en cada pantalla y al recoger, abrir o vencer algo.
 */
#include "game.h"

#pragma link "save.asm"

#define SAVE_VERSION 1

__at(0xA000) unsigned char sav[64];

void save_game(void)
{
    unsigned char i;

    sram_on();
    sav[0] = 'M';
    sav[1] = 'S';
    sav[2] = 'G';
    sav[3] = 'O';
    sav[4] = SAVE_VERSION;
    sav[5] = screen;
    sav[6] = px;
    sav[7] = py;
    sav[8] = hp;
    sav[9] = keys;
    for (i = 0; i < N_SCREENS; i++) sav[10 + i] = flags[i];
    sram_off();                         /* protege la partida si se apaga a destiempo */
}

unsigned char save_valid(void)
{
    unsigned char ok;

    sram_on();
    ok = sav[0] == 'M' && sav[1] == 'S' && sav[2] == 'G' && sav[3] == 'O' &&
         sav[4] == SAVE_VERSION && sav[5] < N_SCREENS &&
         sav[6] <= MAX_X && sav[7] <= MAX_Y &&      /* fuera de rango, cell_at leería fuera de room[] */
         sav[8] != 0 && sav[8] <= HP_MAX;
    sram_off();
    return ok;
}

/* Recupera la partida; devuelve 0 (y no toca nada) si la RAM no tiene una válida. */
unsigned char load_game(void)
{
    unsigned char i;

    if (!save_valid()) return 0;
    sram_on();
    screen = sav[5];
    px = sav[6];
    py = sav[7];
    hp = sav[8];
    keys = sav[9];
    for (i = 0; i < N_SCREENS; i++) flags[i] = sav[10 + i];
    sram_off();
    return 1;
}
