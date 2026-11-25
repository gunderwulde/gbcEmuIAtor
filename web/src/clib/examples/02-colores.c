/* 02 — Las 8 paletas del fondo
 *
 * En el CGB cada celda del mapa tiene, en el banco 1 de VRAM, un byte de atributos;
 * sus 3 bits bajos eligen una de las 8 paletas del fondo (ATTR_PAL). Aquí:
 *  - 4 tiles macizos, cada uno de un color (0, 1, 2 y 3) de su paleta;
 *  - bandas horizontales: el color crece hacia abajo (filas 0-4, 5-9, 10-14, 15-17);
 *  - columnas: la paleta crece hacia la derecha (paleta = 2·x / 5, de 0 a 7).
 * Resultado: una rejilla de 8 × 4 colores distintos.
 */
#include <gbc.h>

int main(void)
{
    unsigned char x;
    unsigned char y;
    unsigned char n;
    unsigned char c;

    lcd_off();

    /* Tile c macizo en el color c: cada fila son 2 bytes (plano bajo, plano alto) y
     * el color de un píxel es (bit del plano alto)·2 + (bit del plano bajo). */
    for (c = 0; c < 4; c++) {
        unsigned int t;
        unsigned char i;
        t = 0x8000 + c * 16;
        for (i = 0; i < 8; i++) {
            vram_set(t, (c & 1) ? 0xFF : 0x00);
            vram_set(t + 1, (c & 2) ? 0xFF : 0x00);
            t += 2;
        }
    }

    /* Paleta n, color c: rojo según la paleta, verde según el color, azul al revés. */
    for (n = 0; n < 8; n++)
        for (c = 0; c < 4; c++)
            set_bg_color(n, c, RGB(n * 4, c * 10, 31 - n * 4));

    /* Mapa: el tile (color) por filas y el atributo (paleta) por columnas. */
    for (y = 0; y < 18; y++)
        fill_bg(0, y, 20, 1, y / 5);
    for (x = 0; x < 20; x++)
        fill_bg_attr(x, 0, 1, 18, ATTR_PAL(x * 2 / 5));

    lcd_on();
    for (;;)
        wait_vbl();
    return 0;
}
