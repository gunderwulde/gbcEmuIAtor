/* 06 — Sonido: un pequeño teclado
 *
 * La APU tiene 4 canales: dos de pulso (1 y 2), uno de onda (3) y uno de ruido (4).
 * Para que suene algo hay que encenderla (snd_on), elegir el volumen y "disparar" el
 * canal. La frecuencia de los canales de pulso es un periodo de 11 bits:
 * f = 131072 / (2048 − x) Hz (las constantes NOTE_* de gbc.h).
 *
 *   Izquierda/derecha: elegir nota      A: canal 1 (corto)    B: canal 2 (largo)
 *   SELECT: ruido (canal 4)             START: efecto de salto (barrido del canal 1)
 */
#include <gbc.h>

const unsigned int notes[8] = {
    NOTE_C4, NOTE_D4, NOTE_E4, NOTE_F4, NOTE_G4, NOTE_A4, NOTE_B4, NOTE_C5,
};
const char *const names[8] = { "Do4", "Re4", "Mi4", "Fa4", "Sol4", "La4", "Si4", "Do5" };

const unsigned int pal[4] = { RGB(2, 4, 10), 0, 0, RGB(31, 31, 20) };

void show(unsigned char n)
{
    at(2, 6);
    printf("Nota: %s     ", names[n]);
    at(2, 7);
    printf("Periodo: %4u", notes[n]);
}

int main(void)
{
    unsigned char n;
    unsigned char hit;

    lcd_off();
    text_init(0);
    set_bg_palette(0, pal);
    cls();
    at(2, 1);  print("TECLADO");
    at(2, 11); print("A: canal 1");
    at(2, 12); print("B: canal 2");
    at(2, 13); print("SELECT: ruido");
    at(2, 14); print("START: salto");
    n = 0;
    show(n);
    lcd_on();

    snd_on();
    for (;;) {
        wait_vbl();
        hit = joypad_pressed();
        if ((hit & J_RIGHT) && n < 7) show(++n);
        if ((hit & J_LEFT) && n > 0) show(--n);
        if (hit & J_A) snd_tone(1, notes[n], 32, 15);          /* 32/256 s = 1/8 s */
        if (hit & J_B) snd_tone(2, notes[n], 0, 10);           /* hasta soltar B */
        if (hit & J_SELECT) snd_noise(0x34, 16, 12);
        if (hit & J_START) sfx_jump();
        if (!(joypad() & J_B)) snd_stop(2);
    }
    return 0;
}
