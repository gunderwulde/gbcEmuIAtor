/* 08 — HDMA y fundidos de paleta
 *
 * Los tiles se calculan en WRAM y se copian a VRAM con la HDMA del CGB, que mueve 16
 * bytes en cada HBlank sin que el programa tenga que esperar al modo 0 (con el LCD
 * encendido). La DMA exige origen y destino alineados a 16 bytes: un array de C en ROM
 * no tiene por qué estarlo, así que se usa un buffer con dirección fija en WRAMX
 * (D000h, libre para el usuario según docs/c-abi.md §5.1).
 *
 * Ojo: la HDMA no avanza mientras la CPU está en HALT, y wait_vbl() usa HALT. Por eso
 * se espera con un bucle sobre hdma_busy().
 *
 * Después, un fundido de negro a color y vuelta, oscureciendo las paletas por pasos.
 */
#include <gbc.h>

#define NTILES 16

__at(0xD000) unsigned char buf[NTILES * 16];

const unsigned int pals[8] = {
    RGB(31, 31, 31), RGB(31, 20, 8), RGB(20, 4, 12), RGB(4, 0, 12),
    RGB(31, 31, 31), RGB(8, 24, 31), RGB(4, 8, 24), RGB(0, 4, 8),
};

/* Tile t: una diagonal que se va engordando; la mitad de los tiles con los colores
 * 1-3 invertidos. */
void make_tiles(void)
{
    unsigned char t;
    unsigned char r;
    unsigned char *p;
    unsigned char row;

    p = buf;
    for (t = 0; t < NTILES; t++) {
        for (r = 0; r < 8; r++) {
            row = 0xFF >> ((r + t) & 7);
            *p++ = row;
            *p++ = (t & 8) ? ~row : row;
        }
    }
}

void fade_in(void)
{
    unsigned char level;
    for (level = 8; level > 0; level--) {
        wait_vbl();
        fade_bg(pals, 2, level);
        delay(3);
    }
    wait_vbl();
    fade_bg(pals, 2, 0);
}

void fade_out(void)
{
    unsigned char level;
    for (level = 1; level <= 8; level++) {
        wait_vbl();
        fade_bg(pals, 2, level);
        delay(3);
    }
}

int main(void)
{
    unsigned char x;
    unsigned char y;

    lcd_off();
    fade_bg(pals, 2, 8);                 /* todo negro */
    for (y = 0; y < 18; y++)
        for (x = 0; x < 20; x++) {
            set_bg_tile(x, y, (x + y) & 15);
        }
    fill_bg_attr(0, 0, 10, 18, ATTR_PAL(0));
    fill_bg_attr(10, 0, 10, 18, ATTR_PAL(1));
    lcd_on();

    make_tiles();
    hdma_copy(0x8000, buf, NTILES * 16);  /* 16 bloques: 16 HBlanks */
    while (hdma_busy())
        ;

    for (;;) {
        fade_in();
        delay(120);
        fade_out();
        delay(30);
    }
    return 0;
}
