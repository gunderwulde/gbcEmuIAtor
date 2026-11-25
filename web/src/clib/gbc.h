/* gbc.h — librería básica de la Game Boy Color para el compilador de C (L1).
 *
 * Contrato de llamada: docs/c-abi.md. Las rutinas calientes (copias a VRAM, mapas,
 * paletas, sprites, texto, joypad, cadenas) están en ensamblador (gbc.asm, string.asm,
 * stdlib.asm); las envolturas sencillas y las variables de la librería, en gbc.c.
 *
 * Reglas de hardware que la librería respeta por ti (docs/gbc-hardware.md §7.8):
 *  - VRAM y paletas sólo se pueden escribir fuera del modo 3. Con el LCD encendido las
 *    funciones que escriben en VRAM o en paletas esperan, byte a byte, a que STAT diga
 *    modo 0 (HBlank) o 1 (VBlank); con el LCD apagado escriben sin esperar (y usan GDMA
 *    si origen, destino y longitud están alineados a 16).
 *  - La OAM no se escribe directamente: los sprites van a la OAM sombra (shadow_oam, en
 *    C000h) y oam_flush() la copia con la OAM DMA, que hay que lanzar en VBlank.
 *  - lcd_off() espera a VBlank antes de apagar (apagar fuera de VBlank daña el LCD real).
 *
 * Mapas: el fondo usa siempre el mapa de 9800h y la ventana el de 9C00h (window_on()
 * pone LCDC.6). Tiles: 8000h (LCDC.4 = 1, como deja el arranque) salvo que el programa
 * cambie LCDC.4; set_bg_tiles sigue a LCDC.4.
 *
 * La librería instala la rutina de la interrupción de VBlank (cuenta vbl_count). Si el
 * programa quiere la suya, debe definir GBC_NO_VBL_ISR antes de incluir gbc.h (entonces
 * wait_vbl y delay no funcionan: tiene que incrementar vbl_count él mismo).
 */
#ifndef GBC_H
#define GBC_H

#pragma link "gbc.c"
#pragma link "gbc.asm"
#pragma link "gbc_font.asm"

#include "string.h"
#include "stdlib.h"

#ifndef NULL
#define NULL ((void *)0)
#endif

/* ---------------------------------------------------------------- Registros de E/S */
__at(0xFF00) volatile unsigned char rP1;     /* joypad */
__at(0xFF01) volatile unsigned char rSB;     /* serie: dato */
__at(0xFF02) volatile unsigned char rSC;     /* serie: control */
__at(0xFF04) volatile unsigned char rDIV;
__at(0xFF05) volatile unsigned char rTIMA;
__at(0xFF06) volatile unsigned char rTMA;
__at(0xFF07) volatile unsigned char rTAC;
__at(0xFF0F) volatile unsigned char rIF;
__at(0xFF10) volatile unsigned char rNR10;
__at(0xFF11) volatile unsigned char rNR11;
__at(0xFF12) volatile unsigned char rNR12;
__at(0xFF13) volatile unsigned char rNR13;
__at(0xFF14) volatile unsigned char rNR14;
__at(0xFF16) volatile unsigned char rNR21;
__at(0xFF17) volatile unsigned char rNR22;
__at(0xFF18) volatile unsigned char rNR23;
__at(0xFF19) volatile unsigned char rNR24;
__at(0xFF1A) volatile unsigned char rNR30;
__at(0xFF1B) volatile unsigned char rNR31;
__at(0xFF1C) volatile unsigned char rNR32;
__at(0xFF1D) volatile unsigned char rNR33;
__at(0xFF1E) volatile unsigned char rNR34;
__at(0xFF20) volatile unsigned char rNR41;
__at(0xFF21) volatile unsigned char rNR42;
__at(0xFF22) volatile unsigned char rNR43;
__at(0xFF23) volatile unsigned char rNR44;
__at(0xFF24) volatile unsigned char rNR50;
__at(0xFF25) volatile unsigned char rNR51;
__at(0xFF26) volatile unsigned char rNR52;
__at(0xFF30) volatile unsigned char rWAVE[16];
__at(0xFF40) volatile unsigned char rLCDC;
__at(0xFF41) volatile unsigned char rSTAT;
__at(0xFF42) volatile unsigned char rSCY;
__at(0xFF43) volatile unsigned char rSCX;
__at(0xFF44) volatile unsigned char rLY;
__at(0xFF45) volatile unsigned char rLYC;
__at(0xFF46) volatile unsigned char rDMA;
__at(0xFF47) volatile unsigned char rBGP;
__at(0xFF48) volatile unsigned char rOBP0;
__at(0xFF49) volatile unsigned char rOBP1;
__at(0xFF4A) volatile unsigned char rWY;
__at(0xFF4B) volatile unsigned char rWX;
__at(0xFF4D) volatile unsigned char rKEY1;
__at(0xFF4F) volatile unsigned char rVBK;
__at(0xFF51) volatile unsigned char rHDMA1;
__at(0xFF52) volatile unsigned char rHDMA2;
__at(0xFF53) volatile unsigned char rHDMA3;
__at(0xFF54) volatile unsigned char rHDMA4;
__at(0xFF55) volatile unsigned char rHDMA5;
__at(0xFF68) volatile unsigned char rBCPS;
__at(0xFF69) volatile unsigned char rBCPD;
__at(0xFF6A) volatile unsigned char rOCPS;
__at(0xFF6B) volatile unsigned char rOCPD;
__at(0xFF70) volatile unsigned char rSVBK;
__at(0xFFFF) volatile unsigned char rIE;

/* Bits de LCDC */
#define LCDC_ON        0x80
#define LCDC_WIN_9C00  0x40
#define LCDC_WIN_ON    0x20
#define LCDC_TILES_8000 0x10
#define LCDC_BG_9C00   0x08
#define LCDC_OBJ_16    0x04
#define LCDC_OBJ_ON    0x02
#define LCDC_BG_PRIO   0x01

/* Bits de STAT (fuentes de la IRQ de STAT) */
#define STAT_LYC_IRQ   0x40
#define STAT_MODE2_IRQ 0x20
#define STAT_MODE1_IRQ 0x10
#define STAT_MODE0_IRQ 0x08

/* Bits de IE / IF */
#define IRQ_VBLANK 0x01
#define IRQ_STAT   0x02
#define IRQ_TIMER  0x04
#define IRQ_SERIAL 0x08
#define IRQ_JOYPAD 0x10

/* ---------------------------------------------------------------- Pantalla y LCD */
extern volatile unsigned int vbl_count;   /* +1 en cada VBlank (IRQ de la librería) */

void lcd_on(void);
void lcd_off(void);                 /* espera a VBlank; no hace nada si ya está apagado */
void wait_vbl(void);                /* activa la IRQ de VBlank y EI; HALT hasta el próximo VBlank */
void delay(unsigned int frames);    /* frames × wait_vbl() */
void scroll(unsigned char x, unsigned char y);   /* SCX, SCY */
void window(unsigned char x, unsigned char y);   /* esquina de la ventana en pantalla (WX = x + 7) */
void window_on(void);               /* LCDC.5 y LCDC.6 (mapa de 9C00h) */
void window_off(void);
void sprites_on(void);              /* LCDC.1 */
void sprites_off(void);
void sprites_8x16(unsigned char on);/* LCDC.2 */
void bg_priority(unsigned char on); /* LCDC.0: en CGB, a 0 los sprites quedan siempre encima */

/* ---------------------------------------------------------------- Tiles y mapas */
#define BG_MAP  0x9800
#define WIN_MAP 0x9C00

/* Atributos de mapa (VRAM banco 1) y de sprite */
#define ATTR_PAL(n)  ((n) & 7)
#define ATTR_BANK1   0x08
#define ATTR_FLIPX   0x20
#define ATTR_FLIPY   0x40
#define ATTR_PRIO    0x80          /* fondo por encima de los sprites */

/* Una fila de 8 píxeles (colores 0-3) en formato 2bpp: dos bytes, plano bajo primero. */
#define TILE_ROW(a, b, c, d, e, f, g, h) \
    (((a) & 1) << 7 | ((b) & 1) << 6 | ((c) & 1) << 5 | ((d) & 1) << 4 | \
     ((e) & 1) << 3 | ((f) & 1) << 2 | ((g) & 1) << 1 | ((h) & 1)), \
    (((a) >> 1) << 7 | ((b) >> 1) << 6 | ((c) >> 1) << 5 | ((d) >> 1) << 4 | \
     ((e) >> 1) << 3 | ((f) >> 1) << 2 | ((g) >> 1) << 1 | ((h) >> 1))

void vram_bank(unsigned char n);    /* VBK: banco de VRAM para set_*_tiles y vram_* */
void vram_copy(unsigned int dst, const void *src, unsigned int len);
void vram_fill(unsigned int dst, unsigned char v, unsigned int len);
void vram_set(unsigned int addr, unsigned char v);
unsigned char vram_get(unsigned int addr);

void set_bg_tiles(unsigned char first, unsigned int n, const void *data);     /* según LCDC.4 */
void set_sprite_tiles(unsigned char first, unsigned int n, const void *data); /* 8000h + 16·first */

/* Rectángulos de w×h celdas en (x, y) del mapa de 32×32; filas de w bytes seguidas.
 * No dan la vuelta: x + w ≤ 32 (si no, la fila sigue en la de abajo) e y + h ≤ 32. */
void set_bg_map(unsigned char x, unsigned char y, unsigned char w, unsigned char h, const unsigned char *tiles);
void set_bg_attr(unsigned char x, unsigned char y, unsigned char w, unsigned char h, const unsigned char *attrs);
void fill_bg(unsigned char x, unsigned char y, unsigned char w, unsigned char h, unsigned char tile);
void fill_bg_attr(unsigned char x, unsigned char y, unsigned char w, unsigned char h, unsigned char attr);
void set_bg_tile(unsigned char x, unsigned char y, unsigned char tile);
unsigned char get_bg_tile(unsigned char x, unsigned char y);
void set_win_map(unsigned char x, unsigned char y, unsigned char w, unsigned char h, const unsigned char *tiles);
void set_win_attr(unsigned char x, unsigned char y, unsigned char w, unsigned char h, const unsigned char *attrs);
void fill_win(unsigned char x, unsigned char y, unsigned char w, unsigned char h, unsigned char tile);
void fill_win_attr(unsigned char x, unsigned char y, unsigned char w, unsigned char h, unsigned char attr);

/* DMA de VRAM. Origen y destino alineados a 16 (el hardware ignora los 4 bits bajos);
 * len múltiplo de 16, hasta 2048. El origen no puede estar en VRAM ni en E000h-FFFFh. */
void gdma_copy(unsigned int dst, const void *src, unsigned int len);  /* de golpe; la CPU se para */
void hdma_copy(unsigned int dst, const void *src, unsigned int len);  /* 16 bytes por HBlank; vuelve enseguida */
unsigned char hdma_busy(void);      /* 1 mientras la HDMA no ha terminado */
/* La HDMA sólo avanza en los HBlank en que la CPU está despierta: durante el HALT de
 * wait_vbl/delay no copia nada. Para esperarla: while (hdma_busy()); */

/* ---------------------------------------------------------------- Paletas CGB */
#define RGB(r, g, b) ((unsigned int)(r) | (unsigned int)(g) << 5 | (unsigned int)(b) << 10)  /* 0-31 */
#define RGB_WHITE RGB(31, 31, 31)
#define RGB_BLACK 0

void set_bg_palette(unsigned char n, const unsigned int *colors);      /* 4 colores */
void set_sprite_palette(unsigned char n, const unsigned int *colors);
void set_bg_color(unsigned char pal, unsigned char idx, unsigned int color);
void set_sprite_color(unsigned char pal, unsigned char idx, unsigned int color);
/* Escribe `count` paletas oscurecidas: level 0 = colores tal cual … 8 = negro. */
void fade_bg(const unsigned int *pals, unsigned char count, unsigned char level);
void fade_sprites(const unsigned int *pals, unsigned char count, unsigned char level);

/* ---------------------------------------------------------------- Sprites */
extern unsigned char shadow_oam[160];   /* OAM sombra del crt0 (C000h): Y+16, X+8, tile, atributos */

void sprite_set(unsigned char n, unsigned char x, unsigned char y, unsigned char tile, unsigned char attr);
void sprite_move(unsigned char n, unsigned char x, unsigned char y);   /* coordenadas de pantalla */
void sprite_tile(unsigned char n, unsigned char tile);
void sprite_attr(unsigned char n, unsigned char attr);
void sprite_hide(unsigned char n);
void sprites_hide_all(void);
void oam_flush(void);               /* OAM DMA de la sombra; llamar en VBlank */

/* ---------------------------------------------------------------- Texto */
#define TEXT_BG  0
#define TEXT_WIN 1

void text_init(unsigned char first_tile); /* carga la fuente (96 tiles, ASCII 32-127) */
void text_layer(unsigned char layer);     /* TEXT_BG (9800h) o TEXT_WIN (9C00h) */
void text_attr(unsigned char attr);       /* atributo CGB de lo que se escriba después */
void cls(void);                           /* espacios en todo el mapa; cursor a (0, 0) */
void at(unsigned char x, unsigned char y);/* columna 0-19, fila 0-17 */
int  putchar(int c);                      /* '\n' = nueva línea; tras la fila 17 vuelve a la 0 */
void print(const char *s);
void printf(const char *fmt, ...);        /* %d %i %u %x %X %c %s %%; anchura y 0: "%05u" */

/* ---------------------------------------------------------------- Entrada */
#define J_RIGHT  0x01
#define J_LEFT   0x02
#define J_UP     0x04
#define J_DOWN   0x08
#define J_A      0x10
#define J_B      0x20
#define J_SELECT 0x40
#define J_START  0x80

unsigned char joypad(void);          /* botones pulsados ahora (1 = pulsado) */
unsigned char joypad_pressed(void);  /* los que se han pulsado desde la llamada anterior */
unsigned char wait_key(void);        /* espera a soltar todo y a pulsar algo; lo devuelve */

/* ---------------------------------------------------------------- Sonido */
/* Periodo de 11 bits de los canales 1 y 2: f = 131072 / (2048 − x) Hz, así que
 * x = 2048 − 131072 / f, redondeado (escala temperada, La4 = 440 Hz). */
#define NOTE_C3  1046
#define NOTE_CS3 1102
#define NOTE_D3  1155
#define NOTE_DS3 1205
#define NOTE_E3  1253
#define NOTE_F3  1297
#define NOTE_FS3 1339
#define NOTE_G3  1379
#define NOTE_GS3 1417
#define NOTE_A3  1452
#define NOTE_AS3 1486
#define NOTE_B3  1517
#define NOTE_C4  1547
#define NOTE_CS4 1575
#define NOTE_D4  1602
#define NOTE_DS4 1627
#define NOTE_E4  1650
#define NOTE_F4  1673
#define NOTE_FS4 1694
#define NOTE_G4  1714
#define NOTE_GS4 1732
#define NOTE_A4  1750
#define NOTE_AS4 1767
#define NOTE_B4  1783
#define NOTE_C5  1798
#define NOTE_CS5 1812
#define NOTE_D5  1825
#define NOTE_DS5 1837
#define NOTE_E5  1849
#define NOTE_F5  1860
#define NOTE_FS5 1871
#define NOTE_G5  1881
#define NOTE_GS5 1890
#define NOTE_A5  1899
#define NOTE_AS5 1907
#define NOTE_B5  1915
#define NOTE_C6  1923

void snd_on(void);                   /* NR52 = 80h, volumen máximo, los 4 canales a los dos lados */
void snd_off(void);
/* Canal 1 o 2, pulso al 50 %. len: 1-64 en 1/256 s (0 = hasta snd_stop); vol: 0-15. */
void snd_tone(unsigned char ch, unsigned int freq, unsigned char len, unsigned char vol);
/* Canal 4. nr43: reloj del ruido (bits 7-4 desplazamiento, 3 = 7 bits, 2-0 divisor). */
void snd_noise(unsigned char nr43, unsigned char len, unsigned char vol);
void snd_stop(unsigned char ch);
void sfx_jump(void);                 /* canal 1: barrido hacia arriba */
void sfx_hit(void);                  /* canal 4: golpe de ruido que se apaga */

/* ---------------------------------------------------------------- Sistema */
/* MBC1/3/5: banco en 4000h-7FFFh (actualiza __cur_bank). MBC1: bancos 1-31. Con n = 0,
 * MBC1 y MBC3 mapean el banco 1, pero MBC5 mapea de verdad el banco 0. */
void rom_bank(unsigned char n);
void sram_on(void);                  /* habilita la RAM del cartucho (A000h-BFFFh) */
void sram_off(void);                 /* deshabilitarla al acabar protege la partida */
/* Banco de RAM del cartucho en A000h-BFFFh (MBC3: 0-3, MBC5: 0-15). En MBC1 sólo surte
 * efecto en el modo 1: antes hay que escribir 1 en 6000h, p. ej. con
 * *(volatile unsigned char *)0x6000 = 1; (en ese modo, con ROM de 1 MB o más, también
 * cambia el banco visto en 0000h-3FFFh). En el modo 0, el del arranque, siempre se ve el
 * banco 0 de RAM. */
void sram_bank(unsigned char n);
void wram_bank(unsigned char n);     /* SVBK: banco 1-7 en D000h-DFFFh */
void cpu_fast(void);                 /* doble velocidad (KEY1 + STOP) */
void cpu_slow(void);
unsigned char cpu_is_fast(void);
void irq_enable(unsigned char mask); /* IE |= mask */
void irq_disable(unsigned char mask);/* IE &= ~mask */
/* IME no se puede leer: ei() y di() guardan una copia en gbc_ime (también wait_vbl, que
 * hace EI). Con gbc_ime a 1, las escrituras a VRAM y paletas hacen di/ei alrededor de
 * cada byte para que una interrupción entre la espera a STAT y la escritura no la lleve
 * al modo 3. Por eso IME se cambia sólo con ei()/di() (no con ei/di en ensamblador), y
 * una ISR que llame a vram_*, set_*_map, set_*_palette, printf… mientras gbc_ime es 1
 * vuelve a habilitar las interrupciones dentro de sí misma. */
extern unsigned char gbc_ime;
void ei(void);
void di(void);

/* La declaración de la IRQ de VBlank va en un fichero aparte para que sólo la vea la
 * unidad que la pide: así gbc.c (que define GBC_NO_VBL_ISR) no choca con la rutina del
 * usuario cuando éste define GBC_NO_VBL_ISR en la suya. */
#ifndef GBC_NO_VBL_ISR
#pragma link "gbc_vbl.c"
#endif

#endif
