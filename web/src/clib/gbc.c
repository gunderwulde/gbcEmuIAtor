/* gbc.c — variables de la librería y funciones sin prisa (sonido, fundidos).
 * Las rutinas calientes están en gbc.asm; ver gbc.h. */
#define GBC_NO_VBL_ISR             /* la IRQ de VBlank la declara gbc_vbl.c (ver gbc.h) */
#include "gbc.h"

volatile unsigned int vbl_count;   /* lo incrementa gbc_vbl_isr (gbc.asm) */
unsigned char gbc_ime;             /* copia de IME (no se puede leer): la mantienen ei/di/wait_vbl */
unsigned char gbc_pad_prev;        /* joypad_pressed: estado de la llamada anterior */
unsigned char gbc_tx;              /* texto: cursor (columna, fila) */
unsigned char gbc_ty;
unsigned char gbc_tmap;            /* texto: byte alto del mapa (98h fondo, 9Ch ventana) */
unsigned char gbc_tattr;           /* texto: atributo CGB */
unsigned char gbc_tfont;           /* texto: primer tile de la fuente − 32 */

/* ------------------------------------------------------------------------- Sonido
 * docs/gbc-hardware.md §8. NR52.7 enciende la APU (con ella apagada los registros de
 * los canales no se pueden escribir). NRx2 con los 5 bits altos a 0 apaga el DAC del
 * canal, y entonces el disparo no lo enciende. */

void snd_on(void)
{
    rNR52 = 0;      /* apagar y encender borra los registros y para los canales (el */
    rNR52 = 0x80;   /* arranque deja el canal 1 sonando con NR52 = F1h) */
    rNR50 = 0x77;   /* volumen maestro 7 a izquierda y derecha */
    rNR51 = 0xFF;   /* los 4 canales a los dos lados */
}

void snd_off(void)
{
    rNR52 = 0;
}

/* NRx1: bits 7-6 ciclo de trabajo (10 = 50 %), bits 5-0 = 64 − duración (en pasos de
 * 1/256 s del secuenciador). NRx4: bit 7 dispara, bit 6 activa la duración, bits 2-0 la
 * parte alta del periodo. */
void snd_tone(unsigned char ch, unsigned int freq, unsigned char len, unsigned char vol)
{
    unsigned char hi;
    unsigned char duty;

    hi = (freq >> 8) & 7;
    if (len) hi = hi | 0x40;
    duty = 0x80 | ((64 - len) & 63);
    if (ch == 1) {
        rNR10 = 0;              /* sin barrido */
        rNR11 = duty;
        rNR12 = vol << 4;       /* volumen inicial, sin envolvente */
        rNR13 = freq;
        rNR14 = 0x80 | hi;
    } else {
        rNR21 = duty;
        rNR22 = vol << 4;
        rNR23 = freq;
        rNR24 = 0x80 | hi;
    }
}

void snd_noise(unsigned char nr43, unsigned char len, unsigned char vol)
{
    rNR41 = (64 - len) & 63;
    rNR42 = vol << 4;
    rNR43 = nr43;
    rNR44 = len ? 0xC0 : 0x80;
}

/* Apagar el DAC del canal lo silencia y lo desactiva (NR52 deja de marcarlo). */
void snd_stop(unsigned char ch)
{
    if (ch == 1) rNR12 = 0;
    else if (ch == 2) rNR22 = 0;
    else if (ch == 3) rNR30 = 0;
    else rNR42 = 0;
}

/* Salto: el barrido del canal 1 sube la frecuencia (NR10: paso cada 1/128 s × 1,
 * suma, desplazamiento 5) y la envolvente la apaga (NR12: 15, bajando cada 2/64 s). */
void sfx_jump(void)
{
    rNR10 = 0x15;
    rNR11 = 0x80 | (64 - 20);
    rNR12 = 0xF2;
    rNR13 = NOTE_C4 & 0xFF;
    rNR14 = 0xC0 | (NOTE_C4 >> 8);
}

/* Golpe: ruido de 15 bits con la envolvente bajando cada 1/64 s. */
void sfx_hit(void)
{
    rNR41 = 0;
    rNR42 = 0xF1;
    rNR43 = 0x54;
    rNR44 = 0x80;
}

/* ------------------------------------------------------------------------- Fundidos
 * Cada canal de 5 bits se escala por (8 − level) / 8. */

static unsigned int fade_color(unsigned int c, unsigned char k)
{
    unsigned int r;
    unsigned int g;
    unsigned int b;

    r = ((c & 31) * k) >> 3;
    g = (((c >> 5) & 31) * k) >> 3;
    b = (((c >> 10) & 31) * k) >> 3;
    return r | (g << 5) | (b << 10);
}

void fade_bg(const unsigned int *pals, unsigned char count, unsigned char level)
{
    unsigned char p;
    unsigned char i;
    unsigned char k;

    k = level >= 8 ? 0 : 8 - level;
    for (p = 0; p < count; p++)
        for (i = 0; i < 4; i++)
            set_bg_color(p, i, fade_color(*pals++, k));
}

void fade_sprites(const unsigned int *pals, unsigned char count, unsigned char level)
{
    unsigned char p;
    unsigned char i;
    unsigned char k;

    k = level >= 8 ? 0 : 8 - level;
    for (p = 0; p < count; p++)
        for (i = 0; i < 4; i++)
            set_sprite_color(p, i, fade_color(*pals++, k));
}
