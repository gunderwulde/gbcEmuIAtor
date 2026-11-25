/* 09 — Interrupciones y doble velocidad
 *
 * Tres interrupciones a la vez:
 *  - VBlank: la de la librería (cuenta vbl_count; wait_vbl duerme hasta ella).
 *  - Temporizador: TIMA cuenta a 4096 Hz desde TMA = 0 y desborda cada 256 cuentas,
 *    16 veces por segundo. Su rutina, en C, suma 1 a `ticks`.
 *  - STAT con LYC: cambia el color de fondo a mitad de pantalla (un "raster").
 *
 * Con A se pasa a doble velocidad (cpu_fast): la CPU y el temporizador van al doble,
 * pero la PPU no, así que salen 32 ticks por segundo y los frames siguen a ~60 Hz.
 */
#include <gbc.h>

#define SPLIT_LINE 72

const unsigned int pal[4] = { RGB(0, 8, 16), 0, 0, RGB(31, 31, 31) };
const unsigned int top_color = RGB(0, 8, 16);
const unsigned int bottom_color = RGB(16, 0, 8);

volatile unsigned int ticks;

void timer_isr(void) __interrupt(timer)
{
    ticks++;
}

/* Salta en la línea anterior a la del cambio (LYC) y espera a su HBlank: en el modo 3
 * las paletas no se pueden escribir (docs/gbc-hardware.md §7.8). El color nuevo se ve
 * desde el principio de la línea siguiente. */
void stat_isr(void) __interrupt(stat)
{
    while (rSTAT & 3)
        ;
    rBCPS = 0x80;                      /* paleta 0, color 0, autoincremento */
    if (rLYC == SPLIT_LINE - 1) {
        rBCPD = bottom_color & 0xFF;
        rBCPD = bottom_color >> 8;
        rLYC = 143;                    /* la última línea: prepara el frame siguiente */
    } else {
        rBCPD = top_color & 0xFF;
        rBCPD = top_color >> 8;
        rLYC = SPLIT_LINE - 1;
    }
}

/* `ticks` son 2 bytes y la interrupción puede llegar entre la lectura de uno y otro:
 * se lee con las interrupciones desactivadas. */
unsigned int read_ticks(void)
{
    unsigned int t;
    di();
    t = ticks;
    ei();
    return t;
}

void show_speed(void)
{
    at(12, 4);
    print(cpu_is_fast() ? "doble " : "normal");
}

int main(void)
{
    unsigned int last;
    unsigned int now;
    unsigned char hit;
    unsigned char frame;

    lcd_off();
    text_init(0);
    set_bg_palette(0, pal);
    cls();
    at(1, 1);  print("INTERRUPCIONES");
    at(1, 3);  print("Ticks/s:");
    at(1, 4);  print("Velocidad:");
    at(1, 12); print("A: cambiar");
    at(1, 13); print("   velocidad");
    lcd_on();

    rTMA = 0;
    rTIMA = 0;
    rTAC = 0x04;                       /* en marcha, 4096 Hz */
    rLYC = SPLIT_LINE - 1;
    rSTAT = STAT_LYC_IRQ;
    irq_enable(IRQ_TIMER | IRQ_STAT);
    ei();

    show_speed();
    last = 0;
    frame = 0;
    for (;;) {
        wait_vbl();
        hit = joypad_pressed();
        if (hit & J_A) {
            if (cpu_is_fast()) cpu_slow(); else cpu_fast();
            show_speed();
            frame = 0;                 /* medir un segundo entero desde aquí */
            last = read_ticks();
        }
        if (++frame == 60) {           /* 60 frames ≈ un segundo */
            frame = 0;
            now = read_ticks();
            at(10, 3);
            printf("%3u", now - last);
            last = now;
        }
    }
    return 0;
}
