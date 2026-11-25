/*
 * testbus.c — máquina plana de 64 KB sin periféricos para probar la CPU (core-test.wasm).
 * ABI: core/include/testbus.h. Cada ciclo M queda en el log (formato de SingleStepTests).
 */
#include "../include/testbus.h"
#include "bus.h"

static uint8_t     mem[65536];
static GbRegs      regs;
static GbtBusEvent log_[GBT_LOG_MAX];
static uint32_t    log_len;
static uint32_t    cycles;

static inline void log_cycle(uint16_t addr, uint8_t kind, uint8_t value)
{
    if (log_len < GBT_LOG_MAX) {
        GbtBusEvent *e = &log_[log_len++];
        e->cycle = cycles;
        e->addr = addr;
        e->kind = kind;
        e->value = value;
    }
    cycles++;
}

static inline uint8_t bus_read(uint16_t a)
{
    uint8_t v = mem[a];
    log_cycle(a, 0, v);
    return v;
}

static inline void bus_write(uint16_t a, uint8_t v)
{
    mem[a] = v;
    log_cycle(a, 1, v);
}

static inline void bus_tick(void) { log_cycle(0, 2, 0); }
static inline uint8_t bus_irq(void) { return mem[0xFFFF] & mem[0xFF0F] & 0x1F; }
static inline void bus_irq_ack(int bit) { mem[0xFF0F] &= (uint8_t)~(1u << bit); }
static inline int bus_stop(void) { return 0; }

#include "sm83.c"

void gbt_reset(void)
{
    gb_memset(mem, 0, sizeof mem);
    gb_memset(&regs, 0, sizeof regs);
    log_len = 0;
    cycles = 0;
}

uint8_t *gbt_mem(void) { return mem; }
GbRegs *gbt_regs(void) { return &regs; }

uint32_t gbt_step(void)
{
    uint32_t c0 = cycles;
    sm83_step(&regs);
    return cycles - c0;
}

GbtBusEvent *gbt_log(void) { return log_; }
uint32_t gbt_log_len(void) { return log_len; }
void gbt_log_clear(void) { log_len = 0; cycles = 0; }
