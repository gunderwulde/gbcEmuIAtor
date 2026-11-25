/* 05 — Un sprite que se mueve con la cruceta
 *
 * Los sprites (OBJ) no están en el mapa: son 40 entradas de la OAM con posición, tile
 * y atributos. La CPU no puede escribir la OAM mientras la PPU la lee, así que la
 * librería trabaja sobre una copia en WRAM (la OAM sombra) y oam_flush() la copia de
 * golpe con la OAM DMA durante el VBlank.
 *
 * Los tiles de sprite están siempre en 8000h y su color 0 es transparente. Con A el
 * sprite cambia de paleta y con B se da la vuelta (ATTR_FLIPX).
 */
#include <gbc.h>

const unsigned char ship[16] = {
    TILE_ROW(0,0,0,3,3,0,0,0),
    TILE_ROW(0,0,3,1,1,3,0,0),
    TILE_ROW(0,0,3,1,1,3,0,0),
    TILE_ROW(0,3,1,2,2,1,3,0),
    TILE_ROW(3,1,1,2,2,1,1,3),
    TILE_ROW(3,1,1,1,1,1,1,3),
    TILE_ROW(3,3,0,3,3,0,3,3),
    TILE_ROW(3,0,0,0,0,0,0,3),
};

const unsigned int bg_pal[4] = { RGB(0, 0, 8), RGB(0, 0, 0), RGB(0, 0, 0), RGB(0, 0, 0) };
const unsigned int obj_pals[8] = {
    0, RGB(31, 31, 31), RGB(31, 16, 0), RGB(8, 8, 8),    /* 0: nave blanca y naranja */
    0, RGB(16, 31, 16), RGB(0, 16, 31), RGB(8, 8, 8),    /* 1: verde y azul */
};

#define SPEED 2

int main(void)
{
    unsigned char x;
    unsigned char y;
    unsigned char attr;
    unsigned char keys;
    unsigned char hit;

    lcd_off();
    vram_fill(0x8000, 0, 16);        /* tile 0 vacío: el fondo */
    vram_fill(0x9800, 0, 32 * 32);   /* tile 0 en todo el mapa del fondo */
    set_sprite_tiles(1, 1, ship);    /* la nave, en el tile 1 */
    set_bg_palette(0, bg_pal);
    set_sprite_palette(0, obj_pals);
    set_sprite_palette(1, obj_pals + 4);

    x = 76;                          /* centro de la pantalla de 160×144 */
    y = 68;
    attr = ATTR_PAL(0);
    sprite_set(0, x, y, 1, attr);
    sprites_on();
    lcd_on();

    for (;;) {
        wait_vbl();
        oam_flush();                 /* lo primero del VBlank: la OAM DMA */

        keys = joypad();
        if ((keys & J_RIGHT) && x < 160 - 8) x += SPEED;
        if ((keys & J_LEFT) && x > 0) x -= SPEED;
        if ((keys & J_DOWN) && y < 144 - 8) y += SPEED;
        if ((keys & J_UP) && y > 0) y -= SPEED;

        hit = joypad_pressed();      /* sólo el frame en que se pulsa */
        if (hit & J_A) attr ^= 1;    /* paleta 0 ↔ 1 */
        if (hit & J_B) attr ^= ATTR_FLIPX;

        sprite_move(0, x, y);
        sprite_attr(0, attr);
    }
    return 0;
}
