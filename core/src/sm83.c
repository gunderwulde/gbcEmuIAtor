/*
 * sm83.c — CPU SM83 (C1). STUB DE FASE 0: ejecuta todo como NOP.
 * No se compila suelto: lo incluyen gbc.c y testbus.c tras definir las funciones de bus.h.
 */
#include "bus.h"

static void sm83_step(GbRegs *r)
{
    if (r->locked || r->stopped || r->halted) { bus_tick(); return; }
    (void)bus_read(r->pc.w++);
}
