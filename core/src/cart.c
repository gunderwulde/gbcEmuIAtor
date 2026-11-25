/*
 * cart.c — cartuchos (M3): cabecera, ROM sola, MBC1, MBC2, MBC3 (+RTC), MBC5; RAM
 * externa y .sav. Referencia: docs/gbc-hardware.md §10 (Pan Docs "MBCs").
 *
 * Las lecturas de ROM no pasan por aquí: gbc.c usa gb.rom0_off / gb.romx_off, que este
 * módulo recalcula en cada cambio de banco (map_rom).
 */
#include "machine.h"

enum { MBC_NONE, MBC1, MBC2, MBC3, MBC5 };

/* RTC del MBC3: segundos, minutos, horas, días (8 bits bajos), DH (bit 0: día 8,
 * bit 6: parado, bit 7: acarreo de días). Avanza con los puntos emulados (AGENTS §4.1.6). */
typedef struct {
    uint8_t  reg[5];
    uint8_t  latched[5];
    uint8_t  latch_prev;
    uint8_t  _pad;
    uint32_t sub;            /* puntos acumulados dentro del segundo actual */
    uint64_t last;           /* gb.now de la última puesta al día */
} Rtc;

static struct {
    uint8_t  mbc;
    uint8_t  has_ram, has_battery, has_rtc;
    uint8_t  ram_enabled;
    uint8_t  mode;           /* MBC1: 0 = ROM, 1 = RAM/banco 0 avanzado */
    uint8_t  bank_lo;        /* MBC1: 5 bits; MBC2/3: banco; MBC5: 8 bits bajos */
    uint8_t  bank_hi;        /* MBC1: 2 bits; MBC5: bit 8 */
    uint8_t  ram_bank;       /* MBC3: 0-3 o 08h-0Ch (RTC); MBC5: 0-15 */
    uint8_t  dirty;
    uint8_t  rumble;
    uint8_t  _pad;
    uint32_t rom_banks;      /* nº de bancos de 16 KB (potencia de 2) */
    uint32_t ram_size;
    Rtc      rtc;
    uint8_t  ram[GB_SRAM_MAX];
} C;

/* ------------------------------------------------------------------------------------ */

static void map_rom(void)
{
    uint32_t mask = C.rom_banks - 1;
    uint32_t lo = 0, hi = 1;
    switch (C.mbc) {
    case MBC1:
        hi = (uint32_t)(C.bank_hi << 5) | (C.bank_lo ? C.bank_lo : 1);
        lo = C.mode ? (uint32_t)(C.bank_hi << 5) : 0;
        break;
    case MBC2: hi = C.bank_lo ? C.bank_lo : 1; break;
    case MBC3: hi = C.bank_lo ? C.bank_lo : 1; break;
    case MBC5: hi = (uint32_t)(C.bank_hi << 8) | C.bank_lo; break;
    default: break;
    }
    gb.rom0_off = (lo & mask) * 0x4000;
    gb.romx_off = (hi & mask) * 0x4000;
}

static void rtc_add_days(uint32_t n)
{
    Rtc *r = &C.rtc;
    uint32_t day = (uint32_t)(r->reg[3] | (r->reg[4] & 1) << 8) + n;
    if (day > 511) r->reg[4] |= 0x80;   /* acarreo de días: queda fijo hasta que se borre */
    day &= 511;
    r->reg[3] = (uint8_t)day;
    r->reg[4] = (uint8_t)((r->reg[4] & 0xFE) | (day >> 8));
}

/* Un segundo. Un campo fuera de rango (escrito así por el juego) sigue contando hasta
 * su máscara sin acarreo; el acarreo sólo se produce al pasar de 59/23. [VERIFICAR M3] */
static void rtc_tick1(void)
{
    uint8_t *g = C.rtc.reg;
    g[0] = (g[0] + 1) & 0x3F; if (g[0] != 60) return; g[0] = 0;
    g[1] = (g[1] + 1) & 0x3F; if (g[1] != 60) return; g[1] = 0;
    g[2] = (g[2] + 1) & 0x1F; if (g[2] != 24) return; g[2] = 0;
    rtc_add_days(1);
}

static void rtc_add_seconds(uint32_t s)
{
    uint8_t *g = C.rtc.reg;
    /* Con valores fuera de rango, segundo a segundo hasta que vuelvan a estarlo. */
    while (s && (g[0] >= 60 || g[1] >= 60 || g[2] >= 24)) { rtc_tick1(); s--; }
    if (!s) return;
    uint32_t t = g[0] + 60u * g[1] + 3600u * g[2] + s;
    g[0] = (uint8_t)(t % 60); t /= 60;
    g[1] = (uint8_t)(t % 60); t /= 60;
    g[2] = (uint8_t)(t % 24); t /= 24;
    if (t) rtc_add_days(t);
}

static void rtc_catch_up(void)
{
    Rtc *r = &C.rtc;
    uint64_t d = gb.now - r->last;
    r->last = gb.now;
    if (!C.has_rtc || (r->reg[4] & 0x40)) return;
    uint64_t total = d + r->sub;
    uint32_t secs = (uint32_t)(total / GB_DOT_HZ);
    r->sub = (uint32_t)(total % GB_DOT_HZ);
    if (secs) rtc_add_seconds(secs);
}

/* ------------------------------------------------------------------------------------ */

int cart_insert(uint32_t len)
{
    if (len < 0x8000 || len > GB_ROM_MAX) return GB_ERR_SIZE;
    uint8_t type = gb_rom_data[0x147];
    uint8_t mbc, ram = 0, bat = 0, rtc = 0, rumble = 0;
    switch (type) {
    case 0x00: mbc = MBC_NONE; break;
    case 0x08: mbc = MBC_NONE; ram = 1; break;
    case 0x09: mbc = MBC_NONE; ram = 1; bat = 1; break;
    case 0x01: mbc = MBC1; break;
    case 0x02: mbc = MBC1; ram = 1; break;
    case 0x03: mbc = MBC1; ram = 1; bat = 1; break;
    case 0x05: mbc = MBC2; ram = 1; break;
    case 0x06: mbc = MBC2; ram = 1; bat = 1; break;
    case 0x0F: mbc = MBC3; rtc = 1; bat = 1; break;
    case 0x10: mbc = MBC3; rtc = 1; ram = 1; bat = 1; break;
    case 0x11: mbc = MBC3; break;
    case 0x12: mbc = MBC3; ram = 1; break;
    case 0x13: mbc = MBC3; ram = 1; bat = 1; break;
    case 0x19: mbc = MBC5; break;
    case 0x1A: mbc = MBC5; ram = 1; break;
    case 0x1B: mbc = MBC5; ram = 1; bat = 1; break;
    case 0x1C: mbc = MBC5; rumble = 1; break;
    case 0x1D: mbc = MBC5; rumble = 1; ram = 1; break;
    case 0x1E: mbc = MBC5; rumble = 1; ram = 1; bat = 1; break;
    default: return GB_ERR_MBC;
    }

    /* Tamaño: el mayor entre lo que dice la cabecera y el fichero, en potencia de 2. */
    uint32_t size = 0x8000;
    while (size < len) size <<= 1;
    if (size > GB_ROM_MAX) return GB_ERR_SIZE;
    /* Bytes que faltan hasta la potencia de 2 (volcado recortado): bus abierto. */
    for (uint32_t i = len; i < size; i++) gb_rom_data[i] = 0xFF;
    gb_rom_size = size;

    static const uint32_t ram_sizes[6] = { 0, 2048, 8192, 32768, 131072, 65536 };
    uint8_t rcode = gb_rom_data[0x149];
    uint32_t ram_size = rcode < 6 ? ram_sizes[rcode] : 0;
    if (mbc == MBC2) ram_size = 512;
    if (!ram) ram_size = 0;

    gb_memset(&C, 0, sizeof C);
    C.mbc = mbc;
    C.has_ram = ram;
    C.has_battery = bat;
    C.has_rtc = rtc;
    C.rumble = rumble;
    C.rom_banks = size / 0x4000;
    C.ram_size = ram_size;
    /* RAM sin pila arranca indeterminada en el hardware; aquí a FFh (determinista). */
    gb_memset(C.ram, 0xFF, sizeof C.ram);
    return GB_OK;
}

void cart_reset(void)
{
    C.ram_enabled = 0;
    C.mode = 0;
    C.bank_lo = (C.mbc == MBC5) ? 1 : 0;
    C.bank_hi = 0;
    C.ram_bank = 0;
    C.rtc.last = 0;
    C.rtc.sub = 0;
    map_rom();
}

uint8_t cart_read(uint16_t a)
{
    if (!C.ram_enabled) return 0xFF;
    switch (C.mbc) {
    case MBC2:
        return (uint8_t)(C.ram[a & 0x1FF] | 0xF0);
    case MBC3:
        if (C.ram_bank >= 0x08 && C.ram_bank <= 0x0C) {
            if (!C.has_rtc) return 0xFF;
            static const uint8_t mask[5] = { 0x3F, 0x3F, 0x1F, 0xFF, 0xC1 };
            return C.rtc.latched[C.ram_bank - 8] & mask[C.ram_bank - 8];
        }
        if (!C.ram_size) return 0xFF;
        return C.ram[((uint32_t)(C.ram_bank & 3) * 0x2000 + (a & 0x1FFF)) & (C.ram_size - 1)];
    case MBC1: {
        if (!C.ram_size) return 0xFF;
        uint32_t bank = C.mode ? C.bank_hi : 0;
        return C.ram[(bank * 0x2000 + (a & 0x1FFF)) & (C.ram_size - 1)];
    }
    case MBC5:
        if (!C.ram_size) return 0xFF;
        return C.ram[((uint32_t)C.ram_bank * 0x2000 + (a & 0x1FFF)) & (C.ram_size - 1)];
    default:
        if (!C.ram_size) return 0xFF;
        return C.ram[(a & 0x1FFF) & (C.ram_size - 1)];
    }
}

static void ram_write(uint32_t off, uint8_t v)
{
    if (!C.ram_size) return;
    off &= C.ram_size - 1;
    if (C.ram[off] != v) { C.ram[off] = v; C.dirty = 1; }
}

void cart_write(uint16_t a, uint8_t v)
{
    if (a >= 0xA000) {
        if (!C.ram_enabled) return;
        switch (C.mbc) {
        case MBC2: ram_write(a & 0x1FF, v & 0x0F); return;
        case MBC3:
            if (C.ram_bank >= 0x08 && C.ram_bank <= 0x0C) {
                if (!C.has_rtc) return;
                rtc_catch_up();
                static const uint8_t mask[5] = { 0x3F, 0x3F, 0x1F, 0xFF, 0xC1 };
                uint8_t i = (uint8_t)(C.ram_bank - 8);
                C.rtc.reg[i] = v & mask[i];
                if (i == 0) C.rtc.sub = 0;   /* escribir los segundos reinicia el divisor */
                C.rtc.latched[i] = C.rtc.reg[i];
                C.dirty = 1;
                return;
            }
            ram_write((uint32_t)(C.ram_bank & 3) * 0x2000 + (a & 0x1FFF), v);
            return;
        case MBC1: ram_write((uint32_t)(C.mode ? C.bank_hi : 0) * 0x2000 + (a & 0x1FFF), v); return;
        case MBC5: ram_write((uint32_t)C.ram_bank * 0x2000 + (a & 0x1FFF), v); return;
        default: ram_write(a & 0x1FFF, v); return;
        }
    }

    switch (C.mbc) {
    case MBC1:
        if (a < 0x2000) C.ram_enabled = (v & 0x0F) == 0x0A;
        else if (a < 0x4000) C.bank_lo = v & 0x1F;
        else if (a < 0x6000) C.bank_hi = v & 3;
        else C.mode = v & 1;
        break;
    case MBC2:
        if (a < 0x4000) {
            if (a & 0x100) C.bank_lo = v & 0x0F;
            else C.ram_enabled = (v & 0x0F) == 0x0A;
        }
        break;
    case MBC3:
        if (a < 0x2000) C.ram_enabled = (v & 0x0F) == 0x0A;
        else if (a < 0x4000) C.bank_lo = v & 0x7F;
        else if (a < 0x6000) C.ram_bank = v & 0x0F;
        else {
            if (C.rtc.latch_prev == 0 && v == 1 && C.has_rtc) {
                rtc_catch_up();
                gb_memcpy(C.rtc.latched, C.rtc.reg, 5);
            }
            C.rtc.latch_prev = v;
        }
        break;
    case MBC5:
        if (a < 0x2000) C.ram_enabled = (v & 0x0F) == 0x0A;
        else if (a < 0x3000) C.bank_lo = v;
        else if (a < 0x4000) C.bank_hi = v & 1;
        else if (a < 0x6000) C.ram_bank = v & (C.rumble ? 0x07 : 0x0F);
        break;
    default:
        break;
    }
    map_rom();
}

uint8_t *cart_sram(void) { return C.ram; }
uint32_t cart_sram_size(void) { return C.ram_size; }
uint32_t cart_sram_dirty(void) { uint32_t d = C.dirty; C.dirty = 0; return d; }

uint32_t cart_rom_bank(void) { return gb.romx_off / 0x4000; }

/* .sav: la RAM tal cual y, con RTC, 48 bytes al final en el formato de BGB/VBA:
 * 5 × u32 registros actuales, 5 × u32 latcheados, u64 marca de tiempo Unix (docs §10.4).
 * La marca de tiempo la gestiona el frontend (gb_rtc_advance); aquí se escribe 0. */
static void put32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24); }

int cart_load_sav(uint32_t len)
{
    if (!C.has_battery) return GB_ERR_FORMAT;
    if (len < C.ram_size) return GB_ERR_SIZE;
    gb_memcpy(C.ram, gb_io_buf, C.ram_size);
    uint32_t extra = len - C.ram_size;
    if (C.has_rtc && (extra == 48 || extra == 44)) {
        const uint8_t *p = gb_io_buf + C.ram_size;
        for (int i = 0; i < 5; i++) {
            C.rtc.reg[i] = p[i * 4];
            C.rtc.latched[i] = p[20 + i * 4];
        }
    }
    return GB_OK;
}

uint32_t cart_save_sav(void)
{
    if (!C.has_battery) return 0;
    gb_memcpy(gb_io_buf, C.ram, C.ram_size);
    uint32_t n = C.ram_size;
    if (C.has_rtc) {
        rtc_catch_up();
        uint8_t *p = gb_io_buf + n;
        for (int i = 0; i < 5; i++) {
            put32(p + i * 4, C.rtc.reg[i]);
            put32(p + 20 + i * 4, C.rtc.latched[i]);
        }
        put32(p + 40, 0);
        put32(p + 44, 0);
        n += 48;
    }
    return n;
}

void cart_rtc_advance(uint32_t seconds)
{
    if (!C.has_rtc || (C.rtc.reg[4] & 0x40)) return;
    rtc_add_seconds(seconds);
}

void *cart_state(uint32_t *len) { *len = sizeof C; return &C; }
