/*
 * debug.c — breakpoints por banco:dirección (D1 lo completará en la fase 2).
 *
 * Mapa de bits por dirección para el filtro rápido y, para 4000-7FFF, el banco exigido
 * (−1 = cualquiera). Con debug_bp_count == 0, gbc.c no llama aquí: coste nulo.
 */
#include "machine.h"

uint32_t debug_bp_count;
static uint8_t  bp_map[65536 / 8];
static int16_t  bp_bank[65536];        /* sólo significativo si el bit está puesto */

int debug_is_bp(uint16_t pc)
{
    if (!(bp_map[pc >> 3] >> (pc & 7) & 1)) return 0;
    int16_t b = bp_bank[pc];
    if (b < 0) return 1;
    if (pc >= 0x4000 && pc < 0x8000) return (uint32_t)b == cart_rom_bank();
    return 1;
}

void debug_bp_set(int32_t bank, uint16_t addr, int on)
{
    int was = bp_map[addr >> 3] >> (addr & 7) & 1;
    if (on) {
        bp_map[addr >> 3] |= (uint8_t)(1u << (addr & 7));
        bp_bank[addr] = (int16_t)(bank < 0 ? -1 : bank);
        if (!was) debug_bp_count++;
    } else if (was) {
        bp_map[addr >> 3] &= (uint8_t)~(1u << (addr & 7));
        debug_bp_count--;
    }
}

void debug_bp_clear_all(void)
{
    gb_memset(bp_map, 0, sizeof bp_map);
    debug_bp_count = 0;
}
