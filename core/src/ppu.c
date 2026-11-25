/*
 * ppu.c — PPU (V1). STUB DE FASE 0: registros como memoria, framebuffer con ruido.
 */
#include "machine.h"

static struct {
    uint8_t  regs[0x40];
    uint8_t  pal[128];
    uint8_t  hblank;
    uint8_t  cc;
    uint8_t  _pad[2];
} P;

static uint8_t fb[GB_FB_WIDTH * GB_FB_HEIGHT * 4];

void ppu_reset(int boot) { (void)boot; gb_memset(&P, 0, sizeof P); }
void ppu_catch_up(void) {}
uint64_t ppu_next_event(void) { return GB_NEVER; }
uint8_t ppu_read(uint16_t addr) { return P.regs[addr & 0x3F]; }
void ppu_write(uint16_t addr, uint8_t v) { P.regs[addr & 0x3F] = v; }
int ppu_vram_blocked(void) { return 0; }
int ppu_oam_blocked(void) { return 0; }
int ppu_hblank(void) { int h = P.hblank; P.hblank = 0; return h; }
uint8_t *ppu_framebuffer(void) { return fb; }
uint8_t *ppu_palettes(void) { return P.pal; }
void ppu_set_color_correction(int on) { P.cc = (uint8_t)on; }
uint32_t ppu_debug_state(void) { return 0; }
void *ppu_state(uint32_t *len) { *len = sizeof P; return &P; }
