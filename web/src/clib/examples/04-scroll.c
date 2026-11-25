/* 04 — Scroll y joypad
 *
 * El mapa del fondo mide 32×32 tiles (256×256 píxeles) y la pantalla enseña una
 * ventana de 160×144 que empieza en (SCX, SCY). Cambiar esos dos registros en cada
 * frame desplaza todo el fondo sin redibujar nada; al pasar de 255 vuelve a 0, así que
 * el mapa se repite como un mosaico.
 *
 * El fondo avanza solo hacia la derecha; la cruceta cambia la dirección y A lo para.
 */
#include <gbc.h>

const unsigned char tiles[2 * 16] = {
    /* 0: cuadro claro con borde */
    TILE_ROW(1,1,1,1,1,1,1,1), TILE_ROW(1,0,0,0,0,0,0,2), TILE_ROW(1,0,0,0,0,0,0,2), TILE_ROW(1,0,0,0,0,0,0,2),
    TILE_ROW(1,0,0,0,0,0,0,2), TILE_ROW(1,0,0,0,0,0,0,2), TILE_ROW(1,0,0,0,0,0,0,2), TILE_ROW(1,2,2,2,2,2,2,2),
    /* 1: cuadro oscuro con un rombo */
    TILE_ROW(3,3,3,3,3,3,3,3), TILE_ROW(3,3,3,0,0,3,3,3), TILE_ROW(3,3,0,1,1,0,3,3), TILE_ROW(3,0,1,2,2,1,0,3),
    TILE_ROW(3,0,1,2,2,1,0,3), TILE_ROW(3,3,0,1,1,0,3,3), TILE_ROW(3,3,3,0,0,3,3,3), TILE_ROW(3,3,3,3,3,3,3,3),
};

const unsigned int pal[4] = { RGB(31, 31, 24), RGB(24, 20, 12), RGB(12, 8, 4), RGB(4, 2, 10) };

int main(void)
{
    unsigned char x;
    unsigned char y;
    unsigned char sx;
    unsigned char sy;
    signed char dx;
    signed char dy;
    unsigned char keys;

    lcd_off();
    set_bg_tiles(0, 2, tiles);
    set_bg_palette(0, pal);
    /* Tablero de ajedrez en todo el mapa de 32×32, con una diagonal para que se note
     * hacia dónde va. */
    for (y = 0; y < 32; y++)
        for (x = 0; x < 32; x++)
            set_bg_tile(x, y, ((x ^ y) & 1) | (x == y));
    lcd_on();

    sx = 0;
    sy = 0;
    dx = 1;
    dy = 0;
    for (;;) {
        wait_vbl();
        scroll(sx, sy);         /* en VBlank: todo el frame se dibuja con el mismo scroll */

        keys = joypad();
        if (keys & J_RIGHT) { dx = 1;  dy = 0; }
        if (keys & J_LEFT)  { dx = -1; dy = 0; }
        if (keys & J_UP)    { dx = 0;  dy = -1; }
        if (keys & J_DOWN)  { dx = 0;  dy = 1; }
        if (keys & J_A)     { dx = 0;  dy = 0; }
        sx += dx;
        sy += dy;
    }
    return 0;
}
