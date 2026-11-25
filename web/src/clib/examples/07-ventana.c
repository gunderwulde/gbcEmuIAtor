/* 07 — La ventana como marcador
 *
 * La ventana es una segunda capa de fondo, con su propio mapa (9C00h), que se dibuja
 * encima del fondo a partir de (WX − 7, WY) y no se desplaza con SCX/SCY. Es el sitio
 * natural para un marcador fijo mientras el fondo hace scroll.
 *
 * vbl_count lo incrementa la interrupción de VBlank de la librería: sirve de reloj
 * (60 frames ≈ 1 segundo; exactamente 59,73).
 */
#include <gbc.h>

const unsigned int bg_pal[4] = { RGB(4, 10, 4), 0, 0, RGB(12, 24, 12) };
const unsigned int win_pal[4] = { RGB(31, 31, 31), 0, 0, RGB(16, 0, 0) };

int main(void)
{
    unsigned char y;
    unsigned char sx;
    unsigned int frames;

    lcd_off();
    text_init(0);
    set_bg_palette(0, bg_pal);
    set_bg_palette(1, win_pal);

    /* Fondo: texto repetido en las 32 filas del mapa (paleta 0). */
    text_layer(TEXT_BG);
    text_attr(ATTR_PAL(0));
    cls();
    for (y = 0; y < 18; y++) {
        at(y & 3, y);
        print("Scroll infinito");
    }

    /* Ventana: dos filas en la parte de abajo (paleta 1). */
    text_layer(TEXT_WIN);
    text_attr(ATTR_PAL(1));
    cls();
    print("TIEMPO      FRAMES");
    window(0, 144 - 16);
    window_on();
    lcd_on();

    sx = 0;
    for (;;) {
        wait_vbl();
        scroll(sx, 0);
        sx++;
        frames = vbl_count;
        at(0, 1);
        printf("%5u s    %6u", frames / 60, frames);
    }
    return 0;
}
