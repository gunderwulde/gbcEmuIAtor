/*
 * state.c — estados guardados (.gbstate).
 *
 * Formato: "GBST", versión (u32), y cuatro bloques {u32 longitud, bytes}: gb, ppu, apu,
 * cart. Cada bloque es el struct plano de su módulo (sin punteros, machine.h), así que
 * guardar es copiar. Un bloque con longitud distinta de la del build actual invalida el
 * estado (GB_ERR_VERSION): los estados no sobreviven a cambios de layout, y STATE_VERSION
 * se sube cuando el formato cambia a propósito.
 */
#include "machine.h"

#define STATE_VERSION 2u   /* 2: línea de tiempo de la PPU y APU de la fase 2 (X-PPU/X-APU) */

typedef void *(*state_fn)(uint32_t *len);

static void *gb_state(uint32_t *len) { *len = sizeof gb; return &gb; }

static const state_fn blocks[4] = { gb_state, ppu_state, apu_state, cart_state };

static void put32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24); }
static uint32_t get32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }

uint32_t state_save(void)
{
    uint8_t *p = gb_io_buf;
    p[0] = 'G'; p[1] = 'B'; p[2] = 'S'; p[3] = 'T';
    put32(p + 4, STATE_VERSION);
    uint32_t n = 8;
    for (int i = 0; i < 4; i++) {
        uint32_t len;
        void *src = blocks[i](&len);
        if (n + 4 + len > GB_IO_BUFFER_SIZE) return 0;
        put32(p + n, len);
        gb_memcpy(p + n + 4, src, len);
        n += 4 + len;
    }
    return n;
}

int state_load(uint32_t len)
{
    const uint8_t *p = gb_io_buf;
    if (len < 8 || p[0] != 'G' || p[1] != 'B' || p[2] != 'S' || p[3] != 'T') return GB_ERR_FORMAT;
    if (get32(p + 4) != STATE_VERSION) return GB_ERR_VERSION;
    /* Validar todo antes de tocar nada. */
    uint32_t n = 8;
    for (int i = 0; i < 4; i++) {
        uint32_t want;
        (void)blocks[i](&want);
        if (n + 4 > len || get32(p + n) != want || n + 4 + want > len) return GB_ERR_VERSION;
        n += 4 + want;
    }
    /* El bloque gb lleva los offsets de ROM; deben caber en la ROM cargada. */
    n = 8;
    for (int i = 0; i < 4; i++) {
        uint32_t want;
        void *dst = blocks[i](&want);
        gb_memcpy(dst, p + n + 4, want);
        n += 4 + want;
    }
    if (gb.rom0_off >= gb_rom_size || gb.romx_off >= gb_rom_size) { gb.rom0_off = 0; gb.romx_off = 0x4000; }
    return GB_OK;
}
