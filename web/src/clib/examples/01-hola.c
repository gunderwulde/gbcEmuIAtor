/* 01 — Hola, mundo
 *
 * Lo mínimo para ver algo en la pantalla de la Game Boy Color:
 *  1. Apagar el LCD (sólo con él apagado se puede escribir en VRAM sin esperas).
 *  2. Cargar la fuente de la librería en los tiles y una paleta de colores.
 *  3. Escribir el texto en el mapa del fondo.
 *  4. Encender el LCD y esperar para siempre.
 *
 * Al arrancar, las 8 paletas del CGB están en blanco: sin set_bg_palette el texto
 * existiría en VRAM pero no se vería.
 */
#include <gbc.h>

/* Una paleta son 4 colores RGB de 5 bits (0-31). La fuente dibuja el fondo con el
 * color 0 y la tinta con el 3. */
const unsigned int paleta[4] = {
    RGB(31, 31, 31),    /* 0: papel blanco */
    RGB(20, 20, 20),
    RGB(10, 10, 10),
    RGB(0, 0, 16),      /* 3: tinta azul oscuro */
};

int main(void)
{
    lcd_off();
    text_init(0);               /* fuente en los tiles 0-95: ' ' es el tile 0 */
    set_bg_palette(0, paleta);
    cls();

    at(4, 8);                   /* columna 4, fila 8 (en tiles de 8×8) */
    print("Hola, mundo!");
    at(3, 10);
    print("Game Boy Color");

    lcd_on();
    for (;;)
        wait_vbl();             /* dormir hasta el siguiente frame */
    return 0;
}
