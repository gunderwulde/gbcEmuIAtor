/*
 * ppu.c — PPU del CGB (V1). Referencia: docs/gbc-hardware.md §7.
 *
 * Modelo: la PPU avanza por segmentos entre los sucesos de la línea (ver "Línea: sucesos
 * punto a punto" más abajo). En cada suceso cambia el modo o LY, se reevalúa la línea de
 * STAT y se piden IRQs. Dentro del modo 3 los
 * píxeles se emiten de uno en uno a medida que pasan los puntos, leyendo registros, VRAM
 * y OAM en ese instante: un cambio a mitad de línea (SCX, paletas, LCDC…) afecta a los
 * píxeles posteriores al acceso, porque gbc.c pone al día la PPU antes de cada acceso.
 *
 * La longitud del modo 3 se calcula al empezarlo (172 + SCX%8 + ventana + sprites,
 * docs §7.3) y las penalizaciones se cargan al principio: el píxel x sale en el punto
 * 80 + (len − 160) + x. No es un FIFO real; basta para acid2 y para el ritmo de modos.
 *
 * Estado: todo en el struct P (plano, sin punteros; se guarda tal cual en .gbstate).
 * Los dos framebuffers y la tabla de color quedan fuera: se derivan del estado.
 *
 * Layout de P: los tests de tests/core/ppu inyectan registros a través de un estado
 * guardado y dependen de los offsets marcados "OFFSET FIJO" (ver tests/core/ppu/probe.ts).
 */
#include "machine.h"

typedef struct {
    /* OFFSET FIJO 0-12: registros tal cual se escribieron */
    uint8_t  lcdc;      /* 0  FF40 */
    uint8_t  stat;      /* 1  FF41 bits 3-6 (fuentes de IRQ) */
    uint8_t  scy;       /* 2  FF42 */
    uint8_t  scx;       /* 3  FF43 */
    uint8_t  lyc;       /* 4  FF45 */
    uint8_t  bgp;       /* 5  FF47 */
    uint8_t  obp0;      /* 6  FF48 */
    uint8_t  obp1;      /* 7  FF49 */
    uint8_t  wy;        /* 8  FF4A */
    uint8_t  wx;        /* 9  FF4B */
    uint8_t  bcps;      /* 10 FF68 bits 0-5 índice, bit 7 autoincremento */
    uint8_t  ocps;      /* 11 FF6A */
    uint8_t  opri;      /* 12 FF6C bit 0: 1 = prioridad de sprites por X (como DMG) */
    uint8_t  _pad0[3];
    uint8_t  pal[128];  /* OFFSET FIJO 16: 64 bytes BG + 64 OBJ, RGB555 little-endian */

    /* Estado interno */
    uint64_t time;      /* gb.now que corresponde a `dot` */
    uint64_t pend_time; /* escritura de registro aplazada (docs §7.2): instante */
    uint16_t pend_addr; /* 0 = ninguna */
    uint8_t  pend_val;
    uint8_t  first;     /* primera línea tras encender el LCD (temporización propia) */
    uint16_t dot;       /* 0-455 dentro de la línea */
    uint16_t m3len;     /* longitud visible del modo 3 de la línea actual */
    uint16_t m3start;   /* punto en que STAT pasa a 3 (84; 78 en la primera línea) */
    uint16_t line_len;  /* 456 (448 la primera línea tras encender) */
    int16_t  ly_cmp;    /* LY que ve el comparador de LYC; −1 = ninguno (flag congelado) */
    int8_t   mfi;       /* modo que alimenta la IRQ de STAT (−1 = ninguno), docs §7.2 */
    uint8_t  ly;        /* registro LY */
    uint8_t  lyc_eq;    /* flag LY=LYC (bit 2 de STAT); se conserva con el LCD apagado */
    uint8_t  line;      /* línea interna 0-153 */
    uint8_t  mode;      /* modo visible en STAT */
    uint8_t  stat_line; /* OR de las fuentes de STAT: la IRQ sale en su flanco de subida */
    uint8_t  hblank;    /* entró en modo 0 de una línea visible (para la HDMA) */
    uint8_t  wy_hit;    /* WY == LY se cumplió en este frame */
    uint8_t  win_line;  /* contador interno de líneas de la ventana */
    uint8_t  win_drawn; /* la ventana se ha dibujado en esta línea */
    uint8_t  skip_frame;/* el primer frame tras encender no se muestra */
    uint8_t  px;        /* siguiente píxel a emitir en el modo 3 */
    uint8_t  back;      /* framebuffer en el que se dibuja (el otro es el completo) */
    uint8_t  nspr;      /* sprites de la línea (búsqueda en OAM) */
    uint8_t  spr[10];   /* índices de OAM, ordenados por prioridad */
    uint8_t  spr_y[10]; /* Y y X leídas en la búsqueda */
    uint8_t  spr_x[10];
} PpuState;

static PpuState P;

static uint32_t fbuf[2][GB_FB_WIDTH * GB_FB_HEIGHT];
static uint32_t lut[32768];     /* RGB555 → RGBA (R en el byte bajo) */
static uint8_t  lut_cc = 0xFF;  /* corrección con la que se construyó lut; FF = sin construir */
static uint8_t  cc_on;          /* preferencia del frontend: no es estado de la máquina */

/* Paleta de compatibilidad sin boot ROM (docs §7.5): la que elige la boot ROM del CGB
 * para un cartucho no reconocido. BG: blanco, verde claro, azul, negro; OBJ0 = OBJ1:
 * blanco, rosa, granate, negro. */
static const uint16_t compat_bg[4]  = { 0x7FFF, 0x1BEF, 0x6180, 0x0000 };
static const uint16_t compat_obj[4] = { 0x7FFF, 0x421F, 0x1CF2, 0x0000 };

/* ------------------------------------------------------------------------------------
 * Color (docs §7.6)
 * ---------------------------------------------------------------------------------- */

static void build_lut(void)
{
    for (uint32_t c = 0; c < 32768; c++) {
        uint32_t r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31, R, G, B;
        if (cc_on) {
            /* Curva de byuu/Near (higan): mezcla entre canales del LCD del CGB. */
            R = r * 26 + g * 4 + b * 2;
            G = g * 24 + b * 8;
            B = r * 6 + g * 4 + b * 22;
            R = (R > 960 ? 960 : R) >> 2;
            G = (G > 960 ? 960 : G) >> 2;
            B = (B > 960 ? 960 : B) >> 2;
        } else {
            R = r << 3 | r >> 2;
            G = g << 3 | g >> 2;
            B = b << 3 | b >> 2;
        }
        lut[c] = R | G << 8 | B << 16 | 0xFF000000u;
    }
    lut_cc = cc_on;
}

static void fill_white(uint32_t *fb)
{
    uint32_t w = lut[0x7FFF];
    for (int i = 0; i < GB_FB_WIDTH * GB_FB_HEIGHT; i++) fb[i] = w;
}

/* ------------------------------------------------------------------------------------
 * STAT
 * ---------------------------------------------------------------------------------- */

static inline int cgb_regs(void) { return gb.cgb || gb.boot_mapped; }

/* Reevalúa el flag LY=LYC y la OR de fuentes de STAT (docs §7.2). La fuente de modo no
 * es el modo visible sino `mfi`, que va desfasado respecto a él (la IRQ de modo 2 sale un
 * punto antes de que STAT lea 2 y sólo dura ese instante; la de modo 0, un punto después
 * de que STAT lea 0). Con ly_cmp = −1 el comparador no ve ninguna línea y en el CGB-E el
 * flag conserva su valor (SameBoy GB_STAT_update).
 *
 * En el punto 454 de una línea visible (salvo la 143) la fuente pasa ya a modo 2. Sólo
 * lo ve una escritura en STAT/LYC antes del punto 3 siguiente, así que no es un suceso:
 * se deduce aquí del punto y new_line deja mfi = 2. */
static void stat_update(void)
{
    if (!(P.lcdc & 0x80)) return;
    if (P.ly_cmp >= 0) P.lyc_eq = P.ly_cmp == P.lyc;
    int s = 0, m = P.mfi;
    if (P.dot >= 454 && P.line < 143 && !P.first) m = 2;
    switch (m) {
    case 0: s = P.stat & 0x08; break;
    case 1: s = P.stat & 0x10; break;
    case 2: s = P.stat & 0x20; break;
    default: break;
    }
    if ((P.stat & 0x40) && P.lyc_eq) s = 1;
    if (s && !P.stat_line) gb.ifr |= IRQ_STAT;
    P.stat_line = s != 0;
}

/* ------------------------------------------------------------------------------------
 * Búsqueda en OAM y longitud del modo 3
 * ---------------------------------------------------------------------------------- */

static void oam_scan(void)
{
    P.nspr = 0;
    /* Con la OAM DMA en marcha la PPU lee FFh: ningún sprite coincide. */
    if (gb.oam_dma_active) return;
    int h = (P.lcdc & 0x04) ? 16 : 8;
    int y = P.line + 16;
    for (int i = 0; i < 40 && P.nspr < 10; i++) {
        uint8_t sy = gb.oam[i * 4];
        if (y >= sy && y < sy + h) {
            P.spr[P.nspr] = (uint8_t)i;
            P.spr_y[P.nspr] = sy;
            P.spr_x[P.nspr] = gb.oam[i * 4 + 1];
            P.nspr++;
        }
    }
    /* OPRI=1 (y siempre en compatibilidad DMG): gana la X menor; a igual X, el índice
     * menor. Ordenación estable por inserción (como mucho 10). */
    if (P.opri & 1) {
        for (int i = 1; i < P.nspr; i++) {
            uint8_t s = P.spr[i], sy = P.spr_y[i], sx = P.spr_x[i];
            int j = i - 1;
            while (j >= 0 && P.spr_x[j] > sx) {
                P.spr[j + 1] = P.spr[j]; P.spr_y[j + 1] = P.spr_y[j]; P.spr_x[j + 1] = P.spr_x[j];
                j--;
            }
            P.spr[j + 1] = s; P.spr_y[j + 1] = sy; P.spr_x[j + 1] = sx;
        }
    }
}

static inline int window_on_line(void)
{
    int win_ok = gb.cgb ? 1 : (P.lcdc & 1);
    return win_ok && (P.lcdc & 0x20) && P.wy_hit && P.wx <= 166;
}

static uint16_t mode3_length(void)
{
    /* docs §7.3: 172 + SCX%8 + 6 si la ventana empieza en la línea + penalización por
     * sprite (Pan Docs "OBJ penalty algorithm"): 6 puntos, más max(0, 5 − alineación)
     * si es el primer sprite en ese tile del fetcher; X = 0 cuesta 11. */
    uint32_t len = 172 + (P.scx & 7);
    int win = window_on_line();
    if (win) len += 6;
    if (P.lcdc & 0x02) {
        uint64_t seen = 0;
        for (int i = 0; i < P.nspr; i++) {
            int x = P.spr_x[i];
            if (x >= 168) continue;
            if (x == 0) { len += 11; continue; }
            int tile, off;
            if (win && x - 8 >= P.wx - 7) {
                int wp = x - P.wx - 1;
                tile = 32 + (wp >> 3);
                off = wp & 7;
            } else {
                tile = (x + (P.scx & 7)) >> 3;
                off = (x + P.scx) & 7;
            }
            len += 6;
            if (!(seen & (1ull << tile))) {
                seen |= 1ull << tile;
                if (off < 5) len += (uint32_t)(5 - off);
            }
        }
    }
    return (uint16_t)len;
}

/* ------------------------------------------------------------------------------------
 * Píxeles
 * ---------------------------------------------------------------------------------- */

static inline uint16_t pal_color(int base, int idx)
{
    return (uint16_t)(P.pal[base + idx * 2] | (P.pal[base + idx * 2 + 1] & 0x7F) << 8);
}

/* Emite el tramo [x0, x1) de la línea. Dentro del tramo registros, VRAM y OAM son
 * constantes: gbc.c pone al día la PPU antes de cualquier acceso que los cambie, así que
 * los cambios a mitad de línea cortan el tramo justo en su punto. Mapa y tile se leen una
 * vez por tile y cada sprite una vez por tramo (P1/E1, bench/REPORT.md). */
static void render_span(int x0, int x1)
{
    uint8_t lcdc = P.lcdc;
    int cgb = gb.cgb;
    int line = P.line;
    uint8_t bgc[160], battr[160], sc[160], sat[160];

    /* Fondo / ventana. En modo CGB LCDC.0 no los apaga (es la prioridad maestra); en
     * compatibilidad DMG sí (fondo y ventana en blanco). La ventana empieza en WX−7. */
    if (cgb || (lcdc & 1)) {
        int wstart = ((lcdc & 0x20) && P.wy_hit) ? (int)P.wx - 7 : 1000;
        for (int part = 0; part < 2; part++) {
            int a = part ? (x0 > wstart ? x0 : wstart) : x0;
            int b = part ? x1 : (x1 < wstart ? x1 : wstart);
            if (a >= b) continue;
            uint32_t map, ty, tx0;
            if (part) {
                map = (lcdc & 0x40) ? 0x1C00 : 0x1800;
                tx0 = (uint32_t)(a + 7 - P.wx);
                ty = P.win_line;
                P.win_drawn = 1;
            } else {
                map = (lcdc & 0x08) ? 0x1C00 : 0x1800;
                tx0 = (uint32_t)(a + P.scx);
                ty = (uint32_t)(line + P.scy) & 255;
            }
            uint32_t mrow = map + (ty >> 3) * 32;
            uint32_t tx = tx0;
            int x = a;
            while (x < b) {
                tx &= 255;
                uint32_t moff = mrow + ((tx >> 3) & 31);
                uint8_t tile = gb.vram[0][moff];
                uint8_t at = cgb ? gb.vram[1][moff] : 0;
                uint32_t row = ty & 7;
                if (at & 0x40) row = 7 - row;
                uint32_t ta = (lcdc & 0x10) ? (uint32_t)tile * 16 : (uint32_t)(0x1000 + (int8_t)tile * 16);
                ta += row * 2;
                const uint8_t *v = gb.vram[(at >> 3) & 1];
                uint32_t lo = v[ta], hi = v[ta + 1];
                int col = (int)(tx & 7);
                for (; col < 8 && x < b; col++, x++, tx++) {
                    uint32_t c = (at & 0x20) ? (uint32_t)col : 7u - (uint32_t)col;
                    bgc[x] = (uint8_t)(((lo >> c) & 1) | ((hi >> c) & 1) << 1);
                    battr[x] = at;
                }
            }
        }
    } else {
        for (int x = x0; x < x1; x++) { bgc[x] = 0; battr[x] = 0; }
    }

    /* Sprites: en cada punto gana el primero de la lista (ya ordenada por prioridad) con
     * color ≠ 0; recorrerlos en ese orden rellenando sólo huecos da lo mismo. */
    for (int x = x0; x < x1; x++) sc[x] = 0;
    if (lcdc & 0x02) {
        int h = (lcdc & 0x04) ? 16 : 8;
        for (int i = 0; i < P.nspr; i++) {
            int sx = P.spr_x[i] - 8;
            int a = sx > x0 ? sx : x0, b = sx + 8 < x1 ? sx + 8 : x1;
            if (a >= b) continue;
            const uint8_t *o = &gb.oam[P.spr[i] * 4];
            uint8_t at = o[3];
            uint32_t row = (uint32_t)(line + 16 - P.spr_y[i]) & (uint32_t)(h - 1);
            if (at & 0x40) row = (uint32_t)(h - 1) - row;
            uint8_t tile = o[2];
            if (h == 16) tile &= 0xFE;
            const uint8_t *v = gb.vram[cgb ? (at >> 3) & 1 : 0];
            uint32_t ta = (uint32_t)tile * 16 + row * 2;
            uint32_t lo = v[ta], hi = v[ta + 1];
            for (int x = a; x < b; x++) {
                if (sc[x]) continue;
                uint32_t col = (uint32_t)(x - sx);
                if (at & 0x20) col = 7 - col;
                uint32_t sh = 7 - col;
                uint8_t c = (uint8_t)(((lo >> sh) & 1) | ((hi >> sh) & 1) << 1);
                if (c) { sc[x] = c; sat[x] = at; }
            }
        }
    }

    uint32_t *fb = &fbuf[P.back][line * GB_FB_WIDTH];
    for (int x = x0; x < x1; x++) {
        uint16_t rgb;
        uint8_t b = bgc[x], ba = battr[x], s = sc[x], sa = s ? sat[x] : 0;
        if (cgb) {
            /* Gana el sprite si LCDC.0 = 0, si el fondo es color 0, o si ni el atributo
             * del mapa ni el del sprite piden prioridad del fondo (docs §7.4). */
            if (s && (!(lcdc & 1) || b == 0 || !((ba | sa) & 0x80)))
                rgb = pal_color(64 + (sa & 7) * 8, s);
            else
                rgb = pal_color((ba & 7) * 8, b);
        } else {
            /* Compatibilidad DMG: BGP/OBPn eligen el tono, que indexa BG0/OBJ0/OBJ1. Con
             * el fondo apagado se ve el tono 0 sin pasar por BGP [VERIFICAR V1]. */
            uint8_t shade = (lcdc & 1) ? (uint8_t)((P.bgp >> (b * 2)) & 3) : 0;
            if (s && (b == 0 || !(sa & 0x80))) {
                uint8_t obp = (sa & 0x10) ? P.obp1 : P.obp0;
                rgb = pal_color(64 + ((sa & 0x10) ? 8 : 0), (obp >> (s * 2)) & 3);
            } else {
                rgb = pal_color(0, shade);
            }
        }
        fb[x] = lut[rgb];
    }
}

/* Emite los píxeles que corresponden hasta el punto `dot` del modo 3. */
static inline void render_to(uint32_t dot)
{
    int upto = (int)dot - (int)P.m3start - ((int)P.m3len - 160);
    if (upto > 160) upto = 160;
    if (P.px < upto) { render_span(P.px, upto); P.px = (uint8_t)upto; }
}

/* ------------------------------------------------------------------------------------
 * Línea: sucesos punto a punto (docs §7.2, tomados de SameBoy GB_display_run para el
 * CGB-E). `dot` cuenta desde el inicio de la línea; E = m3start + m3len es el fin del
 * modo 3.
 *
 *   visible:  0 OAM bloqueada para escribir · 3 LY, IRQ de modo 2 · 4 STAT = 2, LYC
 *             84 STAT = 3, búsqueda en OAM hecha · E STAT = 0 · E+1 IRQ de modo 0
 *             · 454 fuente de modo 2 (deducida en stat_update, no es suceso)
 *   VBlank:   0 comparador sin línea · 2 LY · 4 LYC · 5 (sólo 144) STAT = 1, IRQ VBlank
 *   153:      2 LY = 153 · 4 LYC = 153 · 8 LY = 0 · 12 LYC = 0
 *   1ª línea tras encender: 78 STAT = 3; dura 448 puntos.
 *
 * Los bloqueos de VRAM, OAM y paletas (docs §7.8) no son sucesos: sólo los ve un acceso
 * de la CPU, que ya pone al día la PPU, así que se calculan en ese momento a partir del
 * punto (ver *_blocked al final).
 * ---------------------------------------------------------------------------------- */

static inline uint32_t mode3_end(void) { return (uint32_t)P.m3start + P.m3len; }

/* Siguiente punto > d con algún suceso en la línea actual. */
static uint32_t next_boundary(uint32_t d)
{
    if (P.line < 144) {
        if (P.first) {
            if (d < 78) return 78;
        } else {
            if (d < 3) return 3;
            if (d < 4) return 4;
            if (d < 84) return 84;
        }
        uint32_t e = mode3_end();
        if (d < e) return e;
        if (d < e + 1) return e + 1;
        return P.line_len;
    }
    if (d < 2) return 2;
    if (d < 4) return 4;
    if (P.line == 144 && d < 5) return 5;
    if (P.line == 153) {
        if (d < 8) return 8;
        if (d < 12) return 12;
    }
    return 456;
}

/* ¿Puede el suceso del punto d de la línea `line` pedir una IRQ o una HDMA con la
 * configuración actual de STAT, LYC y HDMA? Los demás sucesos (LY, modo visible) sólo
 * los observa un acceso, que ya pone al día la PPU: no hace falta despertar a la máquina
 * para ellos (AGENTS.md §4.1.8). La IRQ de STAT sólo sale en un flanco de subida de la
 * OR de fuentes (stat_update), así que basta mirar qué entrada cambia en cada suceso:
 *   - 3: la fuente pasa a modo 2 (líneas 1-143) o el comparador ve LY = 0 (línea 0).
 *   - 4: el comparador ve LY; en la línea 0 además la fuente pasa de modo 1 a 2.
 *   - m3start: aún no se sabe dónde cae E (m3len se calcula ahí): si E o E+1 importan,
 *     hay que despertar para conocerlo.
 *   - E: HBlank (HDMA). E+1: fuente de modo 0 (y HBlank en doble velocidad).
 *   - VBlank: 2 y 5 de la línea 144 (fuente de modo 2 / IRQ de VBlank), 4 (comparador),
 *     8 y 12 de la 153 (comparador a 153 otra vez, tras una escritura de LYC entre 4 y
 *     8, y a 0).
 * El cambio de línea nunca sube la OR: en VBlank sólo deja el comparador sin línea (el
 * flag se conserva) y en las visibles no reevalúa. Quien cambia STAT, LYC o la HDMA
 * llama a machine_reschedule(). */
static int observable(uint32_t line, uint32_t d, uint32_t m3start, uint32_t e, int first)
{
    uint8_t s = P.stat;
    int lyc = (s & 0x40) != 0, hb = (s & 0x08) || gb.hdma_active;
    if (line < 144) {
        if (!first) {
            if (d == 3) return line ? (s & 0x20) != 0 : lyc && P.lyc == 0;
            if (d == 4) return (lyc && P.lyc == line) || (!line && (s & 0x20));
        }
        if (d == m3start) return hb;
        if (d == e) return gb.hdma_active;
        if (d == e + 1) return hb;
        return 0;
    }
    if (d == 2) return line == 144 && (s & 0x20);
    if (d == 4) return lyc && P.lyc == line;
    if (d == 5) return line == 144;
    if (d == 8) return line == 153 && lyc && P.lyc == 153;
    if (d == 12) return line == 153 && lyc && P.lyc == 0;
    return 0;
}

static void start_mode3(void)
{
    P.m3len = mode3_length();
    P.px = 0;
    P.win_drawn = 0;
    P.mode = 3;
    P.mfi = 3;
}

static void end_mode3(void)
{
    if (P.mode != 3) return;
    if (P.win_drawn) P.win_line++;
    P.mode = 0;
    P.mfi = 0;
    P.hblank = 1;
}

static void new_line(void)
{
    int was_first = P.first;
    P.dot = 0;
    P.first = 0;
    P.line_len = 456;
    P.line++;
    if (P.line == 154) {
        P.line = 0;
        P.wy_hit = 0;
        P.win_line = 0;
    }
    if (P.line < 144) {
        /* La condición WY == LY se comprueba al empezar cada línea y queda fijada
         * para el resto del frame [VERIFICAR V1: CGB la evalúa también con la ventana
         * apagada]. */
        if (P.wy == P.line) P.wy_hit = 1;
        P.m3start = 84;
        /* Fuente de modo 2 desde el punto 454 de la línea anterior (ver stat_update);
         * la primera línea tras encender no la tiene. */
        if (P.line && !was_first) P.mfi = 2;
    } else {
        P.ly_cmp = -1;
        stat_update();
    }
}

static void at_event(void)
{
    uint32_t d = P.dot;
    if (d == P.line_len) { new_line(); return; }
    if (P.line < 144) {
        uint32_t e = mode3_end();
        if (P.first) {
            if (d == 78) { P.nspr = 0; start_mode3(); return; }
        } else {
            if (d == 3) {
                /* LY cambia y la IRQ de modo 2 sale un punto antes de que STAT lea 2
                 * (STAT lee 0 mientras tanto), salvo en la línea 0, que sigue en modo 1
                 * hasta el punto 4. El comparador de LYC no ve ninguna línea. */
                P.ly = P.line;
                if (P.line) { P.ly_cmp = -1; P.mfi = 2; P.mode = 0; }
                else P.ly_cmp = 0;
                stat_update();
                return;
            }
            if (d == 4) {
                P.mode = 2;
                P.mfi = 2;
                P.ly_cmp = P.line;
                stat_update();
                P.mfi = -1;
                stat_update();
                return;
            }
            if (d == 84) {
                oam_scan();
                start_mode3();
                stat_update();
                return;
            }
        }
        if (d == e) {
            /* Fin del modo 3: en velocidad normal STAT lee 0 ya, pero la OR de STAT no se
             * reevalúa hasta el punto siguiente (CGB-E). En doble velocidad todo pasa en
             * E+1. */
            if (!gb.double_speed) end_mode3();
            return;
        }
        if (d == e + 1) {
            end_mode3();
            stat_update();
            return;
        }
        return;
    }
    if (d == 2) {
        P.ly = P.line;
        /* Al entrar en VBlank la fuente de modo 2 pide IRQ (sin subir la OR) en el punto
         * 2 y otra vez en el 5 (mooneye vblank_stat_intr). */
        if (P.line == 144 && !P.stat_line && (P.stat & 0x20)) gb.ifr |= IRQ_STAT;
        return;
    }
    if (d == 4) { P.ly_cmp = P.line; stat_update(); return; }
    if (d == 5) {
        P.mode = 1;
        gb.ifr |= IRQ_VBLANK;
        if (!P.stat_line && (P.stat & 0x20)) gb.ifr |= IRQ_STAT;
        P.mfi = 1;
        stat_update();
        if (P.skip_frame) P.skip_frame = 0;
        else P.back ^= 1;
        return;
    }
    /* Línea 153 (CGB-E): LY vuelve a 0 en el punto 8, pero el comparador sigue viendo
     * 153 hasta el 12. */
    if (d == 8) { P.ly = 0; P.ly_cmp = 153; stat_update(); return; }
    if (d == 12) { P.ly_cmp = 0; stat_update(); return; }
}

static void apply_pending(void);

/* La PPU se pone al día hasta gb.now − 1: un suceso del punto T sólo lo ve un acceso
 * posterior a T, y una escritura en el punto T llega antes que los sucesos de ese punto
 * (en SameBoy GB_SLEEP sólo despierta cuando el tiempo disponible supera el pedido). */
void ppu_catch_up(void)
{
    if (!(P.lcdc & 0x80)) { P.time = gb.now; return; }
    if (gb.now <= P.time) return;
    uint64_t to = gb.now - 1;
    while (P.time < to) {
        uint32_t next = next_boundary(P.dot);
        uint64_t left = to - P.time;
        if (P.pend_addr && P.pend_time - P.time < left) left = P.pend_time - P.time;
        uint32_t target = (left < next - P.dot) ? P.dot + (uint32_t)left : next;
        if (P.mode == 3) render_to(target);
        P.time += target - P.dot;
        P.dot = (uint16_t)target;
        if (target == next) at_event();
        if (P.pend_addr && P.time == P.pend_time) apply_pending();
    }
}

/* Próximo suceso observable (ver observable()), mirando más allá del fin de la línea si
 * hace falta. En las líneas futuras m3len aún no se conoce: si E importa se despierta en
 * el punto 84, y entonces ya se sabe. Siempre termina: el punto 5 de la línea 144 (IRQ de
 * VBlank) cae dentro de las 154 líneas siguientes. */
uint64_t ppu_next_event(void)
{
    if (!(P.lcdc & 0x80)) return GB_NEVER;
    uint64_t t = P.time - P.dot;   /* inicio de la línea actual */
    uint32_t d = P.dot, e = mode3_end();
    while ((d = next_boundary(d)) < P.line_len)
        if (observable(P.line, d, P.m3start, e, P.first)) goto found;
    /* Sin modo 2/0 ni HDMA, sólo las líneas 0, 144, 153 y LYC pueden tener algo. */
    int every = (P.stat & 0x28) || gb.hdma_active;
    t += P.line_len;
    for (uint32_t l = P.line + 1u;; l++, t += 456) {
        if (l == 154) l = 0;
        if (!every && l != 0 && l != 144 && l != 153 && l != P.lyc) continue;
        static const uint8_t vis[] = { 3, 4, 84, 0 }, vbl[] = { 2, 4, 5, 8, 12, 0 };
        for (const uint8_t *c = l < 144 ? vis : vbl; *c; c++)
            if (observable(l, *c, 84, 0, 0)) { d = *c; goto found; }
    }
found:
    t += d;
    if (P.pend_addr && P.pend_time < t) t = P.pend_time;
    return t + 1;
}

void ppu_reset(int boot)
{
    gb_memset(&P, 0, sizeof P);
    if (lut_cc != cc_on) build_lut();
    P.time = gb.now;
    P.line_len = 456;
    P.m3start = 84;
    P.mfi = -1;
    if (boot) {
        /* Encendido: LCD apagado; la boot ROM lo configura todo. */
        fill_white(fbuf[0]);
        fill_white(fbuf[1]);
        return;
    }
    /* Estado que deja la boot ROM en 0100h (docs §11): LCD encendido y recién entrado
     * en VBlank (línea 144, recién pasado el punto 5: IF.0 = 1). Con esta fase el VBlank coincide con el
     * fin de cada frame de gb_run_frame [VERIFICAR V1: línea y punto exactos con mooneye
     * boot_hwio-C]. */
    P.lcdc = 0x91;
    P.bgp = 0xFC;
    P.obp0 = 0xFF;
    P.obp1 = 0xFF;
    P.line = 144;
    P.ly = 144;
    P.dot = 6;   /* gb.now = 0 ve ya los sucesos del punto 5 (ver ppu_catch_up) */
    P.ly_cmp = 144;
    P.mode = 1;
    P.mfi = 1;
    if (gb.cgb) {
        for (int i = 0; i < 128; i += 2) { P.pal[i] = 0xFF; P.pal[i + 1] = 0x7F; }
    } else {
        P.opri = 1;
        for (int i = 0; i < 4; i++) {
            P.pal[i * 2] = (uint8_t)compat_bg[i];
            P.pal[i * 2 + 1] = (uint8_t)(compat_bg[i] >> 8);
            P.pal[64 + i * 2] = (uint8_t)compat_obj[i];
            P.pal[64 + i * 2 + 1] = (uint8_t)(compat_obj[i] >> 8);
            P.pal[72 + i * 2] = (uint8_t)compat_obj[i];
            P.pal[72 + i * 2 + 1] = (uint8_t)(compat_obj[i] >> 8);
        }
    }
    stat_update();
    fill_white(fbuf[0]);
    fill_white(fbuf[1]);
}

static void lcd_on(void)
{
    /* Al encender, la línea 0 empieza en modo 0 sin búsqueda en OAM (STAT pasa a 3 en el
     * punto 78), dura 448 puntos y su frame no se ve (docs §7.2, SameBoy). */
    P.time = gb.now;
    P.line = 0;
    P.ly = 0;
    P.dot = 0;
    P.first = 1;
    P.line_len = 448;
    P.m3start = 78;
    P.m3len = 172;
    P.mode = 0;
    P.mfi = -1;
    P.ly_cmp = 0;
    P.skip_frame = 1;
    P.win_line = 0;
    P.wy_hit = P.wy == 0;
    P.px = 0;
    P.nspr = 0;
    stat_update();
}

static void lcd_off(void)
{
    /* Apagado: LY = 0, modo 0, VRAM/OAM libres; la pantalla queda en blanco. El flag
     * LY=LYC y la OR de STAT conservan su valor (SameBoy GB_lcd_off). */
    P.line = 0;
    P.ly = 0;
    P.dot = 0;
    P.first = 0;
    P.mode = 0;
    P.ly_cmp = 0;
    P.hblank = 0;
    P.wy_hit = 0;
    fill_white(fbuf[P.back ^ 1]);
}

/* Bloqueos de la CPU (docs §7.8), como función del punto de la línea. Sólo se consultan
 * tras ppu_catch_up (P.dot = último punto cuyos sucesos ya se aplicaron), así que dan lo
 * mismo que unos flags puestos en cada suceso, sin coste en el bucle de la PPU. Antes de
 * m3start m3len es el de la línea anterior, pero todas las ventanas que dependen de E
 * empiezan en m3start o después, y E ≥ m3start + 172 > cualquier punto anterior.
 * Puntos de SameBoy GB_display_run (CGB-E); `ds` = doble velocidad. El fin de la ventana
 * es exclusivo:
 *   VRAM:          84 (1ª línea: 83; 78 en ds) → E (E+1 en ds)
 *   OAM, lectura:  3 (1ª línea: 78) → E+1
 *   OAM, escritura: 0 (2 en ds; 1ª línea: 76) → E (E+1 en ds)
 *   paletas:       87 (1ª línea: 80) → E+5 (E+3 en ds). SameBoy no las libera en E:
 *                  cgb_palettes_blocked sigue a 1 hasta E+3, donde pasa a !ds, y a 0 en
 *                  E+5. */
static inline int blocked(uint32_t from, uint32_t to_after_e)
{
    if (!(P.lcdc & 0x80) || P.line >= 144) return 0;
    return P.dot >= from && P.dot < mode3_end() + to_after_e;
}
static inline int pal_blocked(void)
{
    return blocked(P.first ? 80 : 87, gb.double_speed ? 3 : 5);
}
int ppu_vram_blocked(void)
{
    int ds = gb.double_speed;
    return blocked(P.first ? (ds ? 78 : 83) : 84, (uint32_t)ds);
}
int ppu_oam_blocked(void) { return blocked(P.first ? 78 : 3, 1); }
int ppu_oam_write_blocked(void)
{
    int ds = gb.double_speed;
    return blocked(P.first ? 76 : (ds ? 2 : 0), (uint32_t)ds);
}

uint8_t ppu_read(uint16_t addr)
{
    ppu_catch_up();
    switch (addr) {
    case 0xFF40: return P.lcdc;
    case 0xFF41: return (uint8_t)(0x80 | P.stat | P.mode | (P.lyc_eq ? 4 : 0));
    case 0xFF42: return P.scy;
    case 0xFF43: return P.scx;
    case 0xFF44: return P.ly;
    case 0xFF45: return P.lyc;
    case 0xFF47: return P.bgp;
    case 0xFF48: return P.obp0;
    case 0xFF49: return P.obp1;
    case 0xFF4A: return P.wy;
    case 0xFF4B: return P.wx;
    default: break;
    }
    /* Registros sólo del CGB: inaccesibles en compatibilidad DMG [VERIFICAR V1]. */
    if (!cgb_regs()) return 0xFF;
    switch (addr) {
    case 0xFF68: return (uint8_t)(P.bcps | 0x40);
    case 0xFF69: return pal_blocked() ? 0xFF : P.pal[P.bcps & 0x3F];
    case 0xFF6A: return (uint8_t)(P.ocps | 0x40);
    case 0xFF6B: return pal_blocked() ? 0xFF : P.pal[64 + (P.ocps & 0x3F)];
    case 0xFF6C: return (uint8_t)(0xFE | P.opri);
    default: return 0xFF;
    }
}

/* LYC escrito: el comparador lo ve al momento, salvo en los puntos en que la propia
 * PPU va a reevaluarlo (cambio de LY), y con los arreglos de la línea 153 del CGB
 * (SameBoy write_high_memory, GB_IO_LYC). */
static void write_lyc(uint8_t v)
{
    uint32_t d = P.dot;
    int l153 = P.line == 153;
    if (l153 && d >= 12 && d < 24) { P.ly_cmp = 153; stat_update(); P.ly_cmp = 0; }
    P.lyc = v;
    if (!(P.lcdc & 0x80)) return;
    if (!P.first && d < 2 && P.line < 153) return;
    if (l153 && d >= 4 && d < 12) return;
    if (l153 && d >= 2 && d < 4) { P.ly_cmp = 153; stat_update(); P.ly_cmp = -1; return; }
    stat_update();
}

static void apply_pending(void)
{
    uint16_t a = P.pend_addr;
    P.pend_addr = 0;
    switch (a) {
    case 0xFF41: P.stat = P.pend_val; stat_update(); break;
    case 0xFF45: write_lyc(P.pend_val); break;
    case 0xFF4B: P.wx = P.pend_val; break;
    default: break;
    }
}

/* Escritura que el hardware aplica un punto después del acceso de la CPU (SameBoy
 * sm83_cpu.c, cgb_conflict_map: GB_CONFLICT_WRITE_CPU y la segunda mitad de
 * GB_CONFLICT_STAT_CGB). Sólo en velocidad normal y con el LCD encendido. La aplica
 * ppu_catch_up al llegar a pend_time; si puede pedir una IRQ (STAT, LYC), quien llama
 * debe reprogramar para que ppu_next_event despierte en ese instante. */
static int defer(uint16_t addr, uint8_t v)
{
    if (gb.double_speed || !(P.lcdc & 0x80)) return 0;
    P.pend_addr = addr;
    P.pend_val = v;
    P.pend_time = gb.now;   /* tras los sucesos del punto actual (ver ppu_catch_up) */
    return 1;
}

void ppu_write(uint16_t addr, uint8_t v)
{
    ppu_catch_up();
    /* La anterior ya se aplicó: pend_time = gb.now de su escritura, y esta llega al menos
     * un ciclo M (4 puntos) después, con la PPU al día hasta gb.now − 1. */
    GB_ASSERT(!P.pend_addr);
    switch (addr) {
    case 0xFF40: {
        uint8_t old = P.lcdc;
        P.lcdc = v;
        if ((old ^ v) & 0x80) {
            if (v & 0x80) lcd_on(); else lcd_off();
            machine_reschedule();
        }
        return;
    }
    case 0xFF41: {
        /* Escribir STAT: durante un punto el bit 6 (fuente LYC) conserva el valor
         * anterior (velocidad normal); en doble velocidad es el bit 3 (modo 0). */
        uint8_t nv = v & 0x78;
        uint8_t keep = gb.double_speed ? 0x08 : 0x40;
        P.stat = (uint8_t)((P.stat & keep) | (nv & ~keep));
        stat_update();
        if (P.stat != nv && !defer(addr, nv)) { P.stat = nv; stat_update(); }
        machine_reschedule();
        return;
    }
    case 0xFF42: P.scy = v; return;
    case 0xFF43: P.scx = v; return;
    case 0xFF44: return;   /* sólo lectura */
    case 0xFF45:
        if (!defer(addr, v)) write_lyc(v);
        machine_reschedule();   /* cambia qué líneas pueden dar IRQ de LYC */
        return;
    case 0xFF47: P.bgp = v; return;
    case 0xFF48: P.obp0 = v; return;
    case 0xFF49: P.obp1 = v; return;
    case 0xFF4A: P.wy = v; return;
    case 0xFF4B: if (!defer(addr, v)) P.wx = v; return;
    default: break;
    }
    if (!cgb_regs()) return;
    switch (addr) {
    /* En modo 3 la escritura en BCPD/OCPD se pierde, pero el índice avanza igual
     * [VERIFICAR V1 con SameSuite]. */
    case 0xFF68: P.bcps = v & 0xBF; return;
    case 0xFF69:
        if (!pal_blocked()) P.pal[P.bcps & 0x3F] = v;
        if (P.bcps & 0x80) P.bcps = (uint8_t)(0x80 | ((P.bcps + 1) & 0x3F));
        return;
    case 0xFF6A: P.ocps = v & 0xBF; return;
    case 0xFF6B:
        if (!pal_blocked()) P.pal[64 + (P.ocps & 0x3F)] = v;
        if (P.ocps & 0x80) P.ocps = (uint8_t)(0x80 | ((P.ocps + 1) & 0x3F));
        return;
    case 0xFF6C: P.opri = v & 1; return;
    default: return;
    }
}

int ppu_hblank(void) { int h = P.hblank; P.hblank = 0; return h; }
uint8_t *ppu_framebuffer(void) { return (uint8_t *)fbuf[P.back ^ 1]; }
uint8_t *ppu_palettes(void) { return P.pal; }

void ppu_set_color_correction(int on)
{
    cc_on = (uint8_t)(on != 0);
    if (lut_cc != cc_on) build_lut();
}

uint32_t ppu_debug_state(void)
{
    if (!(P.lcdc & 0x80)) return 0;
    return (uint32_t)P.ly | (uint32_t)P.dot << 8 | (uint32_t)P.mode << 20;
}

void *ppu_state(uint32_t *len) { *len = sizeof P; return &P; }
