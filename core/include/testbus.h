/*
 * testbus.h — ABI de core-test.wasm: CPU SM83 sobre 64 KB planos, sin periféricos.
 * CONGELADO; sólo lo modifica el coordinador. Lo usan los tests CPU-* (SingleStepTests).
 *
 * El bus plano: toda lectura/escritura va a gbt_mem()[addr] (FF0F = IF y FFFF = IE son
 * memoria normal; bus_irq() = mem[FFFF] & mem[FF0F] & 1F). bus_stop() no hace nada y
 * devuelve 0. Cada ciclo M se registra en el log, con el formato de SingleStepTests:
 * lectura (kind 0), escritura (kind 1) o ciclo interno (kind 2, addr = 0, value = 0).
 */
#ifndef TESTBUS_H
#define TESTBUS_H

#include "gb.h"

typedef struct {
    uint32_t cycle;     /* índice del ciclo M desde el último gbt_reset/gbt_log_clear */
    uint16_t addr;
    uint8_t  kind;      /* 0 = lectura, 1 = escritura, 2 = interno */
    uint8_t  value;
} GbtBusEvent;          /* 8 bytes */
_Static_assert(sizeof(GbtBusEvent) == 8, "GbtBusEvent layout");

#define GBT_LOG_MAX 4096

GB_EXPORT(gbt_reset)     void         gbt_reset(void);     /* memoria, registros y log a 0 */
GB_EXPORT(gbt_mem)       uint8_t     *gbt_mem(void);       /* 65 536 bytes */
GB_EXPORT(gbt_regs)      GbRegs      *gbt_regs(void);
GB_EXPORT(gbt_step)      uint32_t     gbt_step(void);      /* sm83_step(); devuelve ciclos M consumidos */
GB_EXPORT(gbt_log)       GbtBusEvent *gbt_log(void);
GB_EXPORT(gbt_log_len)   uint32_t     gbt_log_len(void);
GB_EXPORT(gbt_log_clear) void         gbt_log_clear(void);

#endif /* TESTBUS_H */
