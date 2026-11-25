/*
 * ppu.c — PPU del CGB (V1). Referencia: docs/gbc-hardware.md §7.
 *
 * Modelo: la PPU avanza por segmentos entre "fronteras" de la línea (inicio de línea,
 * inicio del modo 3, inicio del modo 0, y el punto 4 de la línea 153). En cada frontera
 * cambia el modo, se reevalúa la línea de STAT y se piden IRQs. Dentro del modo 3 los
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
    uint16_t dot;       /* 0-455 dentro de la línea */
    uint16_t m3len;     /* longitud del modo 3 de la línea actual */
    uint8_t  line;      /* línea interna 0-153 (LY lee 0 en casi toda la 153) */
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

static inline uint8_t ly_reg(void)
{
    /* Línea 153: LY vale 153 sólo el primer ciclo M y después 0 (docs §7.2). */
    return (P.line == 153 && P.dot >= 4) ? 0 : P.line;
}

static inline int cgb_regs(void) { return gb.cgb || gb.boot_mapped; }

static void stat_update(void)
{
    if (!(P.lcdc & 0x80)) { P.stat_line = 0; return; }
    int s = 0;
    if ((P.stat & 0x40) && ly_reg() == P.lyc) s = 1;
    switch (P.mode) {
    case 0: if (P.stat & 0x08) s = 1; break;
    case 1:
        if (P.stat & 0x10) s = 1;
        /* Al entrar en VBlank también se activa la fuente de modo 2 (mooneye
         * vblank_stat_intr) [VERIFICAR V1: cuánto dura]. */
        if (P.line == 144 && (P.stat & 0x20)) s = 1;
        break;
    case 2: if (P.stat & 0x20) s = 1; break;
    default: break;
    }
    if (s && !P.stat_line) gb.ifr |= IRQ_STAT;
    P.stat_line = (uint8_t)s;
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

static void render_pixel(int x)
{
    uint8_t lcdc = P.lcdc;
    int cgb = gb.cgb;
    int line = P.line;
    uint8_t bgc = 0, battr = 0;

    /* Fondo / ventana. En modo CGB LCDC.0 no los apaga (es la prioridad maestra); en
     * compatibilidad DMG sí (fondo y ventana en blanco). */
    if (cgb || (lcdc & 1)) {
        uint32_t map, tx, ty;
        if ((lcdc & 0x20) && P.wy_hit && x + 7 >= P.wx) {
            map = (lcdc & 0x40) ? 0x1C00 : 0x1800;
            tx = (uint32_t)(x + 7 - P.wx);
            ty = P.win_line;
            P.win_drawn = 1;
        } else {
            map = (lcdc & 0x08) ? 0x1C00 : 0x1800;
            tx = (uint32_t)(x + P.scx) & 255;
            ty = (uint32_t)(line + P.scy) & 255;
        }
        uint32_t moff = map + (ty >> 3) * 32 + ((tx >> 3) & 31);
        uint8_t tile = gb.vram[0][moff];
        if (cgb) battr = gb.vram[1][moff];
        uint32_t row = ty & 7, col = tx & 7;
        if (battr & 0x40) row = 7 - row;
        if (battr & 0x20) col = 7 - col;
        uint32_t ta = (lcdc & 0x10) ? (uint32_t)tile * 16 : (uint32_t)(0x1000 + (int8_t)tile * 16);
        ta += row * 2;
        const uint8_t *v = gb.vram[(battr >> 3) & 1];
        uint32_t sh = 7 - col;
        bgc = (uint8_t)(((v[ta] >> sh) & 1) | ((v[ta + 1] >> sh) & 1) << 1);
    }

    /* Sprites: el primero de la lista (ya ordenada por prioridad) con color ≠ 0. */
    uint8_t sc = 0, sattr = 0;
    if (lcdc & 0x02) {
        int h = (lcdc & 0x04) ? 16 : 8;
        for (int i = 0; i < P.nspr; i++) {
            int sx = P.spr_x[i] - 8;
            if (x < sx || x >= sx + 8) continue;
            const uint8_t *o = &gb.oam[P.spr[i] * 4];
            uint8_t at = o[3];
            uint32_t row = (uint32_t)(line + 16 - P.spr_y[i]) & (uint32_t)(h - 1);
            if (at & 0x40) row = (uint32_t)(h - 1) - row;
            uint8_t tile = o[2];
            if (h == 16) tile &= 0xFE;
            uint32_t col = (uint32_t)(x - sx);
            if (at & 0x20) col = 7 - col;
            const uint8_t *v = gb.vram[cgb ? (at >> 3) & 1 : 0];
            uint32_t ta = (uint32_t)tile * 16 + row * 2, sh = 7 - col;
            uint8_t c = (uint8_t)(((v[ta] >> sh) & 1) | ((v[ta + 1] >> sh) & 1) << 1);
            if (c) { sc = c; sattr = at; break; }
        }
    }

    uint16_t rgb;
    if (cgb) {
        /* Gana el sprite si LCDC.0 = 0, si el fondo es color 0, o si ni el atributo del
         * mapa ni el del sprite piden prioridad del fondo (docs §7.4). */
        if (sc && (!(lcdc & 1) || bgc == 0 || !((battr | sattr) & 0x80)))
            rgb = pal_color(64 + (sattr & 7) * 8, sc);
        else
            rgb = pal_color((battr & 7) * 8, bgc);
    } else {
        /* Compatibilidad DMG: BGP/OBPn eligen el tono, que indexa BG0/OBJ0/OBJ1. Con el
         * fondo apagado se ve el tono 0 sin pasar por BGP [VERIFICAR V1]. */
        uint8_t shade = (lcdc & 1) ? (uint8_t)((P.bgp >> (bgc * 2)) & 3) : 0;
        if (sc && (bgc == 0 || !(sattr & 0x80))) {
            uint8_t obp = (sattr & 0x10) ? P.obp1 : P.obp0;
            rgb = pal_color(64 + ((sattr & 0x10) ? 8 : 0), (obp >> (sc * 2)) & 3);
        } else {
            rgb = pal_color(0, shade);
        }
    }
    fbuf[P.back][line * GB_FB_WIDTH + x] = lut[rgb];
}

/* Emite los píxeles que corresponden hasta el punto `dot` del modo 3. */
static inline void render_to(uint32_t dot)
{
    int upto = (int)dot - 80 - ((int)P.m3len - 160);
    if (upto > 160) upto = 160;
    while (P.px < upto) render_pixel(P.px++);
}

/* ------------------------------------------------------------------------------------
 * Fronteras
 * ---------------------------------------------------------------------------------- */

static inline uint32_t next_boundary(void)
{
    if (P.line < 144) {
        if (P.dot < 80) return 80;
        if (P.mode == 3) return 80u + P.m3len;
        return 456;
    }
    if (P.line == 153 && P.dot < 4) return 4;
    return 456;
}

static void new_line(void)
{
    P.dot = 0;
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
        P.mode = 2;
    } else if (P.line == 144) {
        P.mode = 1;
        gb.ifr |= IRQ_VBLANK;
        if (P.skip_frame) P.skip_frame = 0;
        else P.back ^= 1;
    }
    stat_update();
}

static void at_boundary(void)
{
    if (P.dot == 456) { new_line(); return; }
    if (P.line < 144) {
        if (P.dot == 80) {
            oam_scan();
            P.m3len = mode3_length();
            P.px = 0;
            P.win_drawn = 0;
            P.mode = 3;
            stat_update();
        } else {
            /* Fin del modo 3 */
            if (P.win_drawn) P.win_line++;
            P.mode = 0;
            P.hblank = 1;
            stat_update();
        }
    } else {
        stat_update();   /* línea 153, punto 4: LY pasa a 0 */
    }
}

/* ------------------------------------------------------------------------------------
 * Interfaz machine.h
 * ---------------------------------------------------------------------------------- */

void ppu_catch_up(void)
{
    if (!(P.lcdc & 0x80)) { P.time = gb.now; return; }
    while (P.time < gb.now) {
        uint32_t next = next_boundary();
        uint64_t left = gb.now - P.time;
        uint32_t target = (left < next - P.dot) ? P.dot + (uint32_t)left : next;
        if (P.mode == 3) render_to(target);
        P.time += target - P.dot;
        P.dot = (uint16_t)target;
        if (target == next) at_boundary();
    }
}

uint64_t ppu_next_event(void)
{
    if (!(P.lcdc & 0x80)) return GB_NEVER;
    return P.time + (next_boundary() - P.dot);
}

void ppu_reset(int boot)
{
    gb_memset(&P, 0, sizeof P);
    if (lut_cc != cc_on) build_lut();
    P.time = gb.now;
    if (boot) {
        /* Encendido: LCD apagado; la boot ROM lo configura todo. */
        fill_white(fbuf[0]);
        fill_white(fbuf[1]);
        return;
    }
    /* Estado que deja la boot ROM en 0100h (docs §11): LCD encendido y recién entrado
     * en VBlank (IF.0 = 1). Con esta fase el VBlank coincide con el fin de cada frame
     * de gb_run_frame [VERIFICAR V1: línea y punto exactos con mooneye boot_hwio-C]. */
    P.lcdc = 0x91;
    P.bgp = 0xFC;
    P.obp0 = 0xFF;
    P.obp1 = 0xFF;
    P.line = 144;
    P.mode = 1;
    P.stat_line = 1;   /* ya en VBlank: sin flanco al arrancar */
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
    /* Al encender, la línea 0 empieza sin modo 2 (lee modo 0) y su frame no se ve
     * (docs §7.2) [VERIFICAR V1: duración exacta de la primera línea]. */
    P.time = gb.now;
    P.line = 0;
    P.dot = 0;
    P.mode = 0;
    P.skip_frame = 1;
    P.win_line = 0;
    P.wy_hit = P.wy == 0;
    P.px = 0;
    P.nspr = 0;
    P.stat_line = 0;
    stat_update();
}

static void lcd_off(void)
{
    /* Apagado: LY = 0, modo 0, VRAM/OAM libres; la pantalla queda en blanco. */
    P.line = 0;
    P.dot = 0;
    P.mode = 0;
    P.stat_line = 0;
    P.hblank = 0;
    fill_white(fbuf[P.back ^ 1]);
}

static inline int pal_blocked(void) { return (P.lcdc & 0x80) && P.mode == 3; }

uint8_t ppu_read(uint16_t addr)
{
    ppu_catch_up();
    switch (addr) {
    case 0xFF40: return P.lcdc;
    case 0xFF41: {
        uint8_t v = (uint8_t)(0x80 | P.stat);
        if (P.lcdc & 0x80) v |= (uint8_t)(P.mode | (ly_reg() == P.lyc ? 4 : 0));
        return v;
    }
    case 0xFF42: return P.scy;
    case 0xFF43: return P.scx;
    case 0xFF44: return (P.lcdc & 0x80) ? ly_reg() : 0;
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

void ppu_write(uint16_t addr, uint8_t v)
{
    ppu_catch_up();
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
    case 0xFF41: P.stat = v & 0x78; stat_update(); return;
    case 0xFF42: P.scy = v; return;
    case 0xFF43: P.scx = v; return;
    case 0xFF44: return;   /* sólo lectura */
    case 0xFF45: P.lyc = v; stat_update(); return;
    case 0xFF47: P.bgp = v; return;
    case 0xFF48: P.obp0 = v; return;
    case 0xFF49: P.obp1 = v; return;
    case 0xFF4A: P.wy = v; return;
    case 0xFF4B: P.wx = v; return;
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

int ppu_vram_blocked(void) { return (P.lcdc & 0x80) && P.mode == 3; }
int ppu_oam_blocked(void) { return (P.lcdc & 0x80) && (P.mode == 2 || P.mode == 3); }
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
    return (uint32_t)ly_reg() | (uint32_t)P.dot << 8 | (uint32_t)P.mode << 20;
}

void *ppu_state(uint32_t *len) { *len = sizeof P; return &P; }
