/*
 * apu.c — APU (M2). STUB DE FASE 0: registros como memoria, silencio.
 */
#include "machine.h"

static struct {
    uint8_t regs[0x80];
} A;

static float out[GB_AUDIO_MAX_FRAMES * 2];

void apu_reset(int boot) { (void)boot; gb_memset(&A, 0, sizeof A); }
void apu_catch_up(void) {}
uint8_t apu_read(uint16_t addr) { return A.regs[addr & 0x7F]; }
void apu_write(uint16_t addr, uint8_t v) { A.regs[addr & 0x7F] = v; }
void apu_div_event(void) {}
uint32_t apu_audio(uint32_t rate) { (void)rate; return 0; }
float *apu_audio_buffer(void) { return out; }
void *apu_state(uint32_t *len) { *len = sizeof A; return &A; }
