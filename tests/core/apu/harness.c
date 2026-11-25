/*
 * harness.c — banco de pruebas de la APU aislada (sólo tests). Compila apu.c con un `gb`
 * propio: el tiempo y el flanco de DIV los pone el test, sin CPU ni gbc.c, para fijar la
 * APU registro a registro aunque la CPU aún no exista. Lo compila apu-harness.ts.
 */
#include "../../../core/src/machine.h"

Gb gb;

GB_EXPORT(h_reset) void h_reset(uint32_t boot)
{
    gb_memset(&gb, 0, sizeof gb);
    apu_reset((int)boot);
}

GB_EXPORT(h_write) void h_write(uint32_t a, uint32_t v) { apu_write((uint16_t)a, (uint8_t)v); }
GB_EXPORT(h_read) uint32_t h_read(uint32_t a) { return apu_read((uint16_t)a); }

/* Avanza `dots` puntos en velocidad normal: el bit 12 del contador de DIV cae cada 8 192
 * puntos (docs §8), y en ese instante se llama a apu_div_event como hace gbc.c. */
GB_EXPORT(h_advance) void h_advance(uint32_t dots)
{
    uint64_t end = gb.now + dots;
    for (;;) {
        uint64_t edge = (gb.now / 8192 + 1) * 8192;
        if (edge > end) break;
        gb.now = edge;
        apu_div_event();
    }
    gb.now = end;
    apu_catch_up();
}

GB_EXPORT(h_audio) uint32_t h_audio(uint32_t rate) { apu_catch_up(); return apu_audio(rate); }
GB_EXPORT(h_audio_buffer) float *h_audio_buffer(void) { return apu_audio_buffer(); }
GB_EXPORT(h_state_len) uint32_t h_state_len(void) { uint32_t n; (void)apu_state(&n); return n; }
GB_EXPORT(h_state) void *h_state(void) { uint32_t n; return apu_state(&n); }
