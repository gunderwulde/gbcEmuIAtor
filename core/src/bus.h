/*
 * bus.h — contrato CPU <-> máquina. CONGELADO; sólo lo modifica el coordinador.
 *
 * La CPU (sm83.c) no conoce la Game Boy: todo acceso a memoria y todo paso del tiempo
 * pasa por estas funciones. No hay punteros a función: cada máquina (gbc.c, testbus.c)
 * define estas funciones como `static inline` y DESPUÉS hace `#include "sm83.c"` (unity
 * build), así el compilador las integra en el bucle de la CPU.
 *
 * Unidad de tiempo: el CICLO M. Cada función que lo dice consume exactamente uno. La CPU
 * escribe los ciclos de cada instrucción en su orden real (AGENTS.md §4.1.4), p. ej.
 * PUSH BC = fetch, interno, escribe (SP-1)=B, escribe (SP-2)=C:
 *
 *     op = bus_read(pc++);           // ciclo M 1: fetch
 *     bus_tick();                    // ciclo M 2: interno (SP--)
 *     bus_write(--sp, b);            // ciclo M 3
 *     bus_write(--sp, c);            // ciclo M 4
 *
 * Funciones que cada máquina DEBE definir antes de incluir sm83.c:
 *
 *   static inline uint8_t bus_read(uint16_t addr);           un ciclo M de lectura
 *   static inline void    bus_write(uint16_t addr, uint8_t v); un ciclo M de escritura
 *   static inline void    bus_tick(void);                    un ciclo M interno
 *   static inline uint8_t bus_irq(void);
 *       IE & IF & 0x1F en este instante, SIN avanzar el tiempo.
 *   static inline void    bus_irq_ack(int bit);
 *       La CPU atiende la interrupción `bit` (0-4): la máquina borra IF.bit. Sin tiempo.
 *   static inline int     bus_stop(void);
 *       La CPU ejecutó STOP (ya ha leído los 2 bytes). La máquina decide: si hay cambio de
 *       velocidad pendiente (KEY1.0) lo hace, incluida la pausa, y devuelve 1 (la CPU
 *       sigue); si no, devuelve 0 y la CPU queda con r->stopped = 1.
 *
 * Lo que sm83.c ofrece a la máquina (definido en sm83.c, static):
 *
 *   static void sm83_step(GbRegs *r);
 *       Hace UNA de estas cosas y vuelve:
 *        - r->locked:  un bus_tick() (CPU bloqueada por opcode ilegal).
 *        - r->stopped: un bus_tick() (la máquina pone stopped = 0 al despertar).
 *        - r->halted:  si bus_irq() != 0 sale de HALT (y, si IME, despacha en esta misma
 *                      llamada o en la siguiente según el hardware); si no, un bus_tick().
 *        - si IME y bus_irq() != 0: despacho de la IRQ (5 ciclos M, docs §4).
 *        - si no: fetch + ejecución de una instrucción completa (CB incluido).
 *       El retardo de EI (r->ei_delay) y el halt bug (r->halt_bug) los lleva sm83.c.
 */
#ifndef BUS_H
#define BUS_H

#include "base.h"

#endif /* BUS_H */
