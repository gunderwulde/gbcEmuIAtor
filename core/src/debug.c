/*
 * debug.c — breakpoints por banco:dirección y watchpoints de escritura (D1).
 *
 * Breakpoints: mapa de bits por dirección para el filtro rápido y, para 4000-7FFF, el
 * banco exigido (−1 = cualquiera). Un solo banco por dirección: si el depurador quiere
 * la misma dirección en dos bancos, pone −1 y filtra él al parar (web/src/ui/debugger).
 *
 * Watchpoints de escritura: hasta DEBUG_WP_MAX rangos [lo, hi]. La CPU llama a
 * debug_wp_check() en cada escritura de bus sólo si debug_wp_count != 0; el aviso se
 * consulta en la frontera de instrucción (la parada ocurre tras la instrucción que
 * escribió, como en cualquier depurador con watchpoints por software).
 *
 * debug_bp_count es el número de breakpoints MÁS el de watchpoints: con 0, gbc.c no
 * llama aquí (coste nulo); con watchpoints activos, la comprobación de fin de
 * instrucción va en la misma rama que la de breakpoints.
 */
#include "machine.h"

#define DEBUG_WP_MAX 8

uint32_t debug_bp_count;
uint32_t debug_wp_count;
uint32_t debug_wp_hit;                 /* 1 = una escritura cayó en un watchpoint */
uint32_t debug_wp_addr;                /* dirección de esa escritura */

static uint32_t bp_n;
static uint8_t  bp_map[65536 / 8];
static int16_t  bp_bank[65536];        /* sólo significativo si el bit está puesto */
static struct { uint16_t lo, hi; } wp[DEBUG_WP_MAX];

/* Declaradas aquí hasta que machine.h las incluya (las llama gbc.c / gb.h). */
void debug_wp_check(uint16_t addr);
int  debug_wp_set(uint16_t lo, uint16_t hi, int on);
void debug_wp_clear_all(void);

static void recount(void) { debug_bp_count = bp_n + debug_wp_count; }

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
        if (!was) bp_n++;
    } else if (was) {
        bp_map[addr >> 3] &= (uint8_t)~(1u << (addr & 7));
        bp_n--;
    }
    recount();
}

void debug_bp_clear_all(void)
{
    gb_memset(bp_map, 0, sizeof bp_map);
    bp_n = 0;
    recount();
}

void debug_wp_check(uint16_t addr)
{
    for (uint32_t i = 0; i < debug_wp_count; i++) {
        if (addr >= wp[i].lo && addr <= wp[i].hi) { debug_wp_hit = 1; debug_wp_addr = addr; return; }
    }
}

/* Devuelve 0, o −1 si no caben más rangos. Quitar busca el rango exacto. */
int debug_wp_set(uint16_t lo, uint16_t hi, int on)
{
    if (lo > hi) { uint16_t t = lo; lo = hi; hi = t; }
    for (uint32_t i = 0; i < debug_wp_count; i++) {
        if (wp[i].lo != lo || wp[i].hi != hi) continue;
        if (!on) { wp[i] = wp[--debug_wp_count]; recount(); }
        return 0;
    }
    if (!on) return 0;
    if (debug_wp_count == DEBUG_WP_MAX) return -1;
    wp[debug_wp_count].lo = lo;
    wp[debug_wp_count].hi = hi;
    debug_wp_count++;
    recount();
    return 0;
}

void debug_wp_clear_all(void)
{
    debug_wp_count = 0;
    debug_wp_hit = 0;
    recount();
}
