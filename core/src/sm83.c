/*
 * sm83.c — CPU SM83 (C1), exacta al ciclo M.
 *
 * No se compila suelto: lo incluyen gbc.c y testbus.c tras definir las funciones de
 * bus.h (unity build). Cada bus_read/bus_write/bus_tick es UN ciclo M y aparecen en el
 * orden real de la instrucción (gb-ctr, verificado con SingleStepTests/sm83, CPU-01).
 *
 * Referencia: docs/gbc-hardware.md §4.
 */
#include "bus.h"

/* Flags en F (bits 3-0 siempre 0). */
#define FZ 0x80
#define FN 0x40
#define FH 0x20
#define FC 0x10

/* Acceso directo a los registros del struct (sin copia: JS los ve tal cual). */
#define A  r->af.b.h
#define F  r->af.b.l
#define B  r->bc.b.h
#define C  r->bc.b.l
#define D  r->de.b.h
#define E  r->de.b.l
#define H  r->hl.b.h
#define L  r->hl.b.l
#define AF r->af.w
#define BC r->bc.w
#define DE r->de.w
#define HL r->hl.w
#define SP r->sp.w
#define PC r->pc.w

/* ---- ALU de 8 bits (sin acceso a bus: no esconden ciclos) ---- */

static inline void alu_add(GbRegs *r, uint8_t v)
{
    unsigned res = (unsigned)A + v;
    F = (uint8_t)(((res & 0xFF) ? 0 : FZ) | (((A ^ v ^ res) & 0x10) ? FH : 0) | ((res > 0xFF) ? FC : 0));
    A = (uint8_t)res;
}

static inline void alu_adc(GbRegs *r, uint8_t v)
{
    unsigned c = (F & FC) ? 1 : 0;
    unsigned res = (unsigned)A + v + c;
    F = (uint8_t)(((res & 0xFF) ? 0 : FZ) | (((A & 0xF) + (v & 0xF) + c > 0xF) ? FH : 0) | ((res > 0xFF) ? FC : 0));
    A = (uint8_t)res;
}

static inline void alu_sub(GbRegs *r, uint8_t v)
{
    unsigned res = (unsigned)A - v;
    F = (uint8_t)((((res & 0xFF) == 0) ? FZ : 0) | FN | (((A & 0xF) < (v & 0xF)) ? FH : 0) | ((A < v) ? FC : 0));
    A = (uint8_t)res;
}

static inline void alu_sbc(GbRegs *r, uint8_t v)
{
    unsigned c = (F & FC) ? 1 : 0;
    unsigned res = (unsigned)A - v - c;
    F = (uint8_t)((((res & 0xFF) == 0) ? FZ : 0) | FN | (((A & 0xFu) < (v & 0xFu) + c) ? FH : 0) |
                  (((unsigned)A < (unsigned)v + c) ? FC : 0));
    A = (uint8_t)res;
}

static inline void alu_and(GbRegs *r, uint8_t v) { A &= v; F = (uint8_t)((A ? 0 : FZ) | FH); }
static inline void alu_xor(GbRegs *r, uint8_t v) { A ^= v; F = A ? 0 : FZ; }
static inline void alu_or(GbRegs *r, uint8_t v)  { A |= v; F = A ? 0 : FZ; }

static inline void alu_cp(GbRegs *r, uint8_t v)
{
    F = (uint8_t)(((A == v) ? FZ : 0) | FN | (((A & 0xF) < (v & 0xF)) ? FH : 0) | ((A < v) ? FC : 0));
}

/* INC/DEC r: el acarreo no se toca; H por el bit 3 (docs §4, CPU-02). */
static inline uint8_t alu_inc(GbRegs *r, uint8_t v)
{
    v++;
    F = (uint8_t)((F & FC) | (v ? 0 : FZ) | (((v & 0xF) == 0) ? FH : 0));
    return v;
}

static inline uint8_t alu_dec(GbRegs *r, uint8_t v)
{
    v--;
    F = (uint8_t)((F & FC) | FN | (v ? 0 : FZ) | (((v & 0xF) == 0xF) ? FH : 0));
    return v;
}

/* ADD HL,rr: H del bit 11, C del bit 15, Z intacto. */
static inline void alu_add_hl(GbRegs *r, uint16_t v)
{
    uint32_t res = (uint32_t)HL + v;
    F = (uint8_t)((F & FZ) | ((((HL & 0xFFF) + (v & 0xFFF)) > 0xFFF) ? FH : 0) | ((res > 0xFFFF) ? FC : 0));
    HL = (uint16_t)res;
}

/* SP+e (ADD SP,e y LD HL,SP+e): H y C salen de sumar el byte bajo de SP y e SIN signo;
 * Z = N = 0. */
static inline uint16_t alu_sp_e(GbRegs *r, uint8_t e)
{
    F = (uint8_t)(((((SP & 0xF) + (e & 0xF)) > 0xF) ? FH : 0) | ((((SP & 0xFF) + e) > 0xFF) ? FC : 0));
    return (uint16_t)(SP + (int8_t)e);
}

/* Rotaciones/desplazamientos del prefijo CB (y = bits 5-3 del opcode CB). */
static inline uint8_t alu_rot(GbRegs *r, int y, uint8_t v)
{
    unsigned c;
    switch (y) {
    case 0: c = v >> 7; v = (uint8_t)((v << 1) | c); break;                       /* RLC */
    case 1: c = v & 1;  v = (uint8_t)((v >> 1) | (c << 7)); break;                /* RRC */
    case 2: c = v >> 7; v = (uint8_t)((v << 1) | ((F & FC) ? 1 : 0)); break;      /* RL */
    case 3: c = v & 1;  v = (uint8_t)((v >> 1) | ((F & FC) ? 0x80 : 0)); break;   /* RR */
    case 4: c = v >> 7; v = (uint8_t)(v << 1); break;                             /* SLA */
    case 5: c = v & 1;  v = (uint8_t)((v >> 1) | (v & 0x80)); break;              /* SRA */
    case 6: c = 0;      v = (uint8_t)((v >> 4) | (v << 4)); break;                /* SWAP */
    default: c = v & 1; v = (uint8_t)(v >> 1); break;                             /* SRL */
    }
    F = (uint8_t)((v ? 0 : FZ) | (c ? FC : 0));
    return v;
}

/* DAA: ajuste BCD tras una suma (N=0) o resta (N=1) según H y C. N se conserva, H=0. */
static inline void alu_daa(GbRegs *r)
{
    unsigned a = A;
    uint8_t f = F;
    if (!(f & FN)) {
        if ((f & FC) || a > 0x99) { a += 0x60; f |= FC; }
        if ((f & FH) || (a & 0xF) > 0x9) a += 0x06;
    } else {
        if (f & FC) a -= 0x60;
        if (f & FH) a -= 0x06;
    }
    A = (uint8_t)a;
    F = (uint8_t)((f & (FN | FC)) | (A ? 0 : FZ));
}

/* ---- Operandos de varios bytes (cada lectura es un ciclo M) ---- */

static inline uint8_t imm8(GbRegs *r) { return bus_read(PC++); }

static inline uint16_t imm16(GbRegs *r)
{
    uint8_t lo = bus_read(PC++);
    uint8_t hi = bus_read(PC++);
    return (uint16_t)(lo | (hi << 8));
}

/* PUSH: un ciclo interno (SP--) y luego byte alto, byte bajo. */
static inline void push16(GbRegs *r, uint16_t v)
{
    bus_tick();
    bus_write(--SP, (uint8_t)(v >> 8));
    bus_write(--SP, (uint8_t)v);
}

static inline uint16_t pop16(GbRegs *r)
{
    uint8_t lo = bus_read(SP++);
    uint8_t hi = bus_read(SP++);
    return (uint16_t)(lo | (hi << 8));
}

/* ---- Bloques que se repiten por registro (macros que expanden a `case`) ---- */

#define LD_R_R(op, dst, src) case op: dst = src; break;
#define LD_R_HL(op, dst)     case op: dst = bus_read(HL); break;
#define LD_HL_R(op, src)     case op: bus_write(HL, src); break;

#define ALU_ROW(base, fn)                                    \
    case base + 0: fn(r, B); break;                          \
    case base + 1: fn(r, C); break;                          \
    case base + 2: fn(r, D); break;                          \
    case base + 3: fn(r, E); break;                          \
    case base + 4: fn(r, H); break;                          \
    case base + 5: fn(r, L); break;                          \
    case base + 6: fn(r, bus_read(HL)); break;               \
    case base + 7: fn(r, A); break;

/* Condiciones NZ, Z, NC, C. */
#define CC_NZ (!(F & FZ))
#define CC_Z  ((F & FZ) != 0)
#define CC_NC (!(F & FC))
#define CC_C  ((F & FC) != 0)

/* JR cc,e: lee e; si se cumple, un ciclo interno para sumar al PC. */
#define JR_CC(op, cond)                                      \
    case op: {                                               \
        int8_t e = (int8_t)imm8(r);                          \
        if (cond) { bus_tick(); PC = (uint16_t)(PC + e); }   \
        break;                                               \
    }

/* JP cc,nn: lee nn; si se cumple, un ciclo interno para cargar el PC. */
#define JP_CC(op, cond)                                      \
    case op: {                                               \
        uint16_t nn = imm16(r);                              \
        if (cond) { bus_tick(); PC = nn; }                   \
        break;                                               \
    }

/* CALL cc,nn: lee nn; si se cumple, PUSH PC (interno + 2 escrituras) y salta. */
#define CALL_CC(op, cond)                                    \
    case op: {                                               \
        uint16_t nn = imm16(r);                              \
        if (cond) { push16(r, PC); PC = nn; }                \
        break;                                               \
    }

/* RET cc: un ciclo interno para evaluar la condición; si se cumple, POP PC y otro
 * ciclo interno para cargar el PC (5 ciclos M en total frente a 2). */
#define RET_CC(op, cond)                                     \
    case op:                                                 \
        bus_tick();                                          \
        if (cond) { PC = pop16(r); bus_tick(); }             \
        break;

#define RST(op)                                              \
    case op: push16(r, PC); PC = (op) & 0x38; break;

/* Opcodes ilegales: el SM83 se cuelga hasta el reset (docs §4). */
#define ILLEGAL(op) case op: r->locked = 1; PC--; break;

/* ---- Prefijo CB ---- */

static inline uint8_t cb_get(GbRegs *r, int z)
{
    switch (z) {
    case 0: return B;
    case 1: return C;
    case 2: return D;
    case 3: return E;
    case 4: return H;
    case 5: return L;
    case 6: return bus_read(HL);
    default: return A;
    }
}

static inline void cb_set(GbRegs *r, int z, uint8_t v)
{
    switch (z) {
    case 0: B = v; break;
    case 1: C = v; break;
    case 2: D = v; break;
    case 3: E = v; break;
    case 4: H = v; break;
    case 5: L = v; break;
    case 6: bus_write(HL, v); break;
    default: A = v; break;
    }
}

/* CB xx: fetch de CB y de xx (2 ciclos M); con (HL), lectura y (salvo BIT) escritura. */
static inline void exec_cb(GbRegs *r)
{
    uint8_t op = bus_read(PC++);
    int y = (op >> 3) & 7, z = op & 7;
    uint8_t v = cb_get(r, z);
    switch (op >> 6) {
    case 0: cb_set(r, z, alu_rot(r, y, v)); break;
    case 1: F = (uint8_t)((F & FC) | FH | ((v & (1u << y)) ? 0 : FZ)); break;   /* BIT */
    case 2: cb_set(r, z, (uint8_t)(v & ~(1u << y))); break;                      /* RES */
    default: cb_set(r, z, (uint8_t)(v | (1u << y))); break;                      /* SET */
    }
}

/* ---- Despacho de interrupciones (docs §4) ----
 * 5 ciclos M: dos internos (el fetch en curso se descarta y el PC retrocede), escritura
 * del byte alto del PC, escritura del byte bajo, carga del vector. El vector se decide
 * DESPUÉS de escribir el byte alto: si esa escritura cae en IE (FFFF) y anula la IRQ, ya
 * no hay ninguna pendiente y el PC acaba en 0000h (mooneye acceptance/interrupts/ie_push). */
static inline void dispatch_irq(GbRegs *r)
{
    r->ime = 0;
    /* Tras EI;HALT con IRQ pendiente el halt bug deja el PC sin avanzar en el fetch
     * descartado; al retroceder, la dirección de vuelta es el propio HALT (Pan Docs,
     * "halt bug"). */
    if (r->halt_bug) { r->halt_bug = 0; PC--; }
    bus_tick();
    bus_tick();
    bus_write(--SP, (uint8_t)(PC >> 8));
    uint8_t pending = bus_irq();
    uint16_t vec = 0x0000;
    if (pending) {
        int bit = __builtin_ctz(pending);
        bus_irq_ack(bit);
        vec = (uint16_t)(0x40 + 8 * bit);
    }
    bus_write(--SP, (uint8_t)PC);
    bus_tick();
    PC = vec;
}

static void sm83_step(GbRegs *r)
{
    if (r->locked || r->stopped) { bus_tick(); return; }

    /* HALT: un ciclo M por llamada hasta que IE & IF != 0 (con o sin IME). Al salir se
     * continúa en esta misma llamada: el ciclo en que se levantó IF ya fue un tick de
     * HALT. [VERIFICAR C1/M1] ciclo extra de salida en CGB: halt_ime*_timing2. */
    if (r->halted) {
        if (!bus_irq()) { bus_tick(); return; }
        r->halted = 0;
    }

    if (r->ime && bus_irq()) { dispatch_irq(r); return; }

    /* Retardo de EI: IME pasa a 1 al terminar la instrucción que sigue a EI (salvo que
     * sea DI). La instrucción se ejecuta todavía con IME = 0. */
    uint8_t ei = r->ei_delay;
    r->ei_delay = 0;

    /* Fetch. Con el halt bug el PC no avanza: el byte siguiente a HALT se lee dos veces. */
    uint8_t op = bus_read(PC);
    if (r->halt_bug) r->halt_bug = 0;
    else PC++;

    switch (op) {
    /* ---- 00-3F: miscelánea, cargas de 16 bits, INC/DEC, rotaciones de A ---- */
    case 0x00: break;                                                    /* NOP */
    case 0x01: BC = imm16(r); break;                                     /* LD BC,nn */
    case 0x11: DE = imm16(r); break;
    case 0x21: HL = imm16(r); break;
    case 0x31: SP = imm16(r); break;
    case 0x02: bus_write(BC, A); break;                                  /* LD (BC),A */
    case 0x12: bus_write(DE, A); break;
    case 0x22: bus_write(HL++, A); break;                                /* LD (HL+),A */
    case 0x32: bus_write(HL--, A); break;
    case 0x0A: A = bus_read(BC); break;                                  /* LD A,(BC) */
    case 0x1A: A = bus_read(DE); break;
    case 0x2A: A = bus_read(HL++); break;                                /* LD A,(HL+) */
    case 0x3A: A = bus_read(HL--); break;
    /* INC/DEC rr: un ciclo interno (la unidad de 16 bits ocupa el bus de direcciones). */
    case 0x03: bus_tick(); BC++; break;
    case 0x13: bus_tick(); DE++; break;
    case 0x23: bus_tick(); HL++; break;
    case 0x33: bus_tick(); SP++; break;
    case 0x0B: bus_tick(); BC--; break;
    case 0x1B: bus_tick(); DE--; break;
    case 0x2B: bus_tick(); HL--; break;
    case 0x3B: bus_tick(); SP--; break;
    case 0x04: B = alu_inc(r, B); break;
    case 0x0C: C = alu_inc(r, C); break;
    case 0x14: D = alu_inc(r, D); break;
    case 0x1C: E = alu_inc(r, E); break;
    case 0x24: H = alu_inc(r, H); break;
    case 0x2C: L = alu_inc(r, L); break;
    case 0x34: bus_write(HL, alu_inc(r, bus_read(HL))); break;            /* INC (HL) */
    case 0x3C: A = alu_inc(r, A); break;
    case 0x05: B = alu_dec(r, B); break;
    case 0x0D: C = alu_dec(r, C); break;
    case 0x15: D = alu_dec(r, D); break;
    case 0x1D: E = alu_dec(r, E); break;
    case 0x25: H = alu_dec(r, H); break;
    case 0x2D: L = alu_dec(r, L); break;
    case 0x35: bus_write(HL, alu_dec(r, bus_read(HL))); break;            /* DEC (HL) */
    case 0x3D: A = alu_dec(r, A); break;
    case 0x06: B = imm8(r); break;                                       /* LD r,n */
    case 0x0E: C = imm8(r); break;
    case 0x16: D = imm8(r); break;
    case 0x1E: E = imm8(r); break;
    case 0x26: H = imm8(r); break;
    case 0x2E: L = imm8(r); break;
    case 0x36: { uint8_t n = imm8(r); bus_write(HL, n); break; }         /* LD (HL),n */
    case 0x3E: A = imm8(r); break;
    /* Rotaciones de A: como las CB pero Z siempre 0. */
    case 0x07: { uint8_t c = A >> 7; A = (uint8_t)((A << 1) | c); F = c ? FC : 0; break; }        /* RLCA */
    case 0x0F: { uint8_t c = A & 1; A = (uint8_t)((A >> 1) | (c << 7)); F = c ? FC : 0; break; }  /* RRCA */
    case 0x17: { uint8_t c = A >> 7; A = (uint8_t)((A << 1) | ((F & FC) ? 1 : 0)); F = c ? FC : 0; break; }    /* RLA */
    case 0x1F: { uint8_t c = A & 1; A = (uint8_t)((A >> 1) | ((F & FC) ? 0x80 : 0)); F = c ? FC : 0; break; } /* RRA */
    case 0x08: {                                                         /* LD (nn),SP */
        uint16_t nn = imm16(r);
        bus_write(nn, (uint8_t)SP);
        bus_write((uint16_t)(nn + 1), (uint8_t)(SP >> 8));
        break;
    }
    case 0x09: bus_tick(); alu_add_hl(r, BC); break;                     /* ADD HL,rr */
    case 0x19: bus_tick(); alu_add_hl(r, DE); break;
    case 0x29: bus_tick(); alu_add_hl(r, HL); break;
    case 0x39: bus_tick(); alu_add_hl(r, SP); break;
    case 0x10: {                                                         /* STOP */
        /* Con una IRQ pendiente STOP ocupa 1 byte; si no, 2 (el segundo se lee y se
         * descarta). Pan Docs "Using the STOP instruction"; SameBoy. La máquina decide
         * el resto (cambio de velocidad o parada) en bus_stop(). */
        if (!bus_irq()) (void)bus_read(PC++);
        if (!bus_stop()) r->stopped = 1;
        break;
    }
    JR_CC(0x20, CC_NZ)
    JR_CC(0x28, CC_Z)
    JR_CC(0x30, CC_NC)
    JR_CC(0x38, CC_C)
    case 0x18: { int8_t e = (int8_t)imm8(r); bus_tick(); PC = (uint16_t)(PC + e); break; }   /* JR e */
    case 0x27: alu_daa(r); break;                                        /* DAA */
    case 0x2F: A = (uint8_t)~A; F |= FN | FH; break;                     /* CPL */
    case 0x37: F = (uint8_t)((F & FZ) | FC); break;                      /* SCF */
    case 0x3F: F = (uint8_t)((F & FZ) | ((F & FC) ^ FC)); break;         /* CCF */

    /* ---- 40-7F: LD r,r' (76 = HALT) ---- */
    LD_R_R(0x40, B, B) LD_R_R(0x41, B, C) LD_R_R(0x42, B, D) LD_R_R(0x43, B, E)
    LD_R_R(0x44, B, H) LD_R_R(0x45, B, L) LD_R_HL(0x46, B) LD_R_R(0x47, B, A)
    LD_R_R(0x48, C, B) LD_R_R(0x49, C, C) LD_R_R(0x4A, C, D) LD_R_R(0x4B, C, E)
    LD_R_R(0x4C, C, H) LD_R_R(0x4D, C, L) LD_R_HL(0x4E, C) LD_R_R(0x4F, C, A)
    LD_R_R(0x50, D, B) LD_R_R(0x51, D, C) LD_R_R(0x52, D, D) LD_R_R(0x53, D, E)
    LD_R_R(0x54, D, H) LD_R_R(0x55, D, L) LD_R_HL(0x56, D) LD_R_R(0x57, D, A)
    LD_R_R(0x58, E, B) LD_R_R(0x59, E, C) LD_R_R(0x5A, E, D) LD_R_R(0x5B, E, E)
    LD_R_R(0x5C, E, H) LD_R_R(0x5D, E, L) LD_R_HL(0x5E, E) LD_R_R(0x5F, E, A)
    LD_R_R(0x60, H, B) LD_R_R(0x61, H, C) LD_R_R(0x62, H, D) LD_R_R(0x63, H, E)
    LD_R_R(0x64, H, H) LD_R_R(0x65, H, L) LD_R_HL(0x66, H) LD_R_R(0x67, H, A)
    LD_R_R(0x68, L, B) LD_R_R(0x69, L, C) LD_R_R(0x6A, L, D) LD_R_R(0x6B, L, E)
    LD_R_R(0x6C, L, H) LD_R_R(0x6D, L, L) LD_R_HL(0x6E, L) LD_R_R(0x6F, L, A)
    LD_HL_R(0x70, B) LD_HL_R(0x71, C) LD_HL_R(0x72, D) LD_HL_R(0x73, E)
    LD_HL_R(0x74, H) LD_HL_R(0x75, L) LD_HL_R(0x77, A)
    LD_R_R(0x78, A, B) LD_R_R(0x79, A, C) LD_R_R(0x7A, A, D) LD_R_R(0x7B, A, E)
    LD_R_R(0x7C, A, H) LD_R_R(0x7D, A, L) LD_R_HL(0x7E, A) LD_R_R(0x7F, A, A)
    case 0x76:                                                           /* HALT */
        /* Con IE & IF != 0 no se entra en HALT. Si IME = 0 se produce el halt bug: el
         * siguiente fetch no incrementa el PC (Pan Docs "halt bug"). Con IME = 1 la IRQ
         * se despacha en la siguiente llamada. */
        if (bus_irq()) { if (!r->ime) r->halt_bug = 1; }
        else r->halted = 1;
        break;

    /* ---- 80-BF: ALU A,r ---- */
    ALU_ROW(0x80, alu_add)
    ALU_ROW(0x88, alu_adc)
    ALU_ROW(0x90, alu_sub)
    ALU_ROW(0x98, alu_sbc)
    ALU_ROW(0xA0, alu_and)
    ALU_ROW(0xA8, alu_xor)
    ALU_ROW(0xB0, alu_or)
    ALU_ROW(0xB8, alu_cp)

    /* ---- C0-FF: saltos, pila, ALU A,n, E/S alta ---- */
    RET_CC(0xC0, CC_NZ)
    RET_CC(0xC8, CC_Z)
    RET_CC(0xD0, CC_NC)
    RET_CC(0xD8, CC_C)
    JP_CC(0xC2, CC_NZ)
    JP_CC(0xCA, CC_Z)
    JP_CC(0xD2, CC_NC)
    JP_CC(0xDA, CC_C)
    CALL_CC(0xC4, CC_NZ)
    CALL_CC(0xCC, CC_Z)
    CALL_CC(0xD4, CC_NC)
    CALL_CC(0xDC, CC_C)
    RST(0xC7) RST(0xCF) RST(0xD7) RST(0xDF) RST(0xE7) RST(0xEF) RST(0xF7) RST(0xFF)
    case 0xC1: BC = pop16(r); break;                                     /* POP rr */
    case 0xD1: DE = pop16(r); break;
    case 0xE1: HL = pop16(r); break;
    case 0xF1: AF = (uint16_t)(pop16(r) & 0xFFF0); break;
    case 0xC5: push16(r, BC); break;                                     /* PUSH rr */
    case 0xD5: push16(r, DE); break;
    case 0xE5: push16(r, HL); break;
    case 0xF5: push16(r, AF); break;
    case 0xC3: { uint16_t nn = imm16(r); bus_tick(); PC = nn; break; }   /* JP nn */
    case 0xE9: PC = HL; break;                                           /* JP HL */
    case 0xCD: { uint16_t nn = imm16(r); push16(r, PC); PC = nn; break; } /* CALL nn */
    case 0xC9: PC = pop16(r); bus_tick(); break;                         /* RET */
    case 0xD9: PC = pop16(r); bus_tick(); r->ime = 1; break;             /* RETI: IME sin retardo */
    case 0xCB: exec_cb(r); break;
    case 0xC6: alu_add(r, imm8(r)); break;                               /* ALU A,n */
    case 0xCE: alu_adc(r, imm8(r)); break;
    case 0xD6: alu_sub(r, imm8(r)); break;
    case 0xDE: alu_sbc(r, imm8(r)); break;
    case 0xE6: alu_and(r, imm8(r)); break;
    case 0xEE: alu_xor(r, imm8(r)); break;
    case 0xF6: alu_or(r, imm8(r)); break;
    case 0xFE: alu_cp(r, imm8(r)); break;
    case 0xE0: { uint8_t n = imm8(r); bus_write((uint16_t)(0xFF00 | n), A); break; }   /* LDH (n),A */
    case 0xF0: { uint8_t n = imm8(r); A = bus_read((uint16_t)(0xFF00 | n)); break; }   /* LDH A,(n) */
    case 0xE2: bus_write((uint16_t)(0xFF00 | C), A); break;              /* LD (C),A */
    case 0xF2: A = bus_read((uint16_t)(0xFF00 | C)); break;              /* LD A,(C) */
    case 0xEA: { uint16_t nn = imm16(r); bus_write(nn, A); break; }      /* LD (nn),A */
    case 0xFA: { uint16_t nn = imm16(r); A = bus_read(nn); break; }      /* LD A,(nn) */
    /* ADD SP,e: dos ciclos internos (byte bajo y byte alto por la ALU de 8 bits). */
    case 0xE8: { uint8_t e = imm8(r); uint16_t v = alu_sp_e(r, e); bus_tick(); bus_tick(); SP = v; break; }
    case 0xF8: { uint8_t e = imm8(r); uint16_t v = alu_sp_e(r, e); bus_tick(); HL = v; break; } /* LD HL,SP+e */
    case 0xF9: bus_tick(); SP = HL; break;                               /* LD SP,HL */
    case 0xF3: r->ime = 0; ei = 0; break;                                /* DI: inmediato y anula un EI previo */
    case 0xFB: r->ei_delay = 1; break;                                   /* EI */
    ILLEGAL(0xD3) ILLEGAL(0xDB) ILLEGAL(0xDD) ILLEGAL(0xE3) ILLEGAL(0xE4) ILLEGAL(0xEB)
    ILLEGAL(0xEC) ILLEGAL(0xED) ILLEGAL(0xF4) ILLEGAL(0xFC) ILLEGAL(0xFD)
    }

    if (ei) r->ime = 1;
}

#undef FZ
#undef FN
#undef FH
#undef FC
#undef A
#undef F
#undef B
#undef C
#undef D
#undef E
#undef H
#undef L
#undef AF
#undef BC
#undef DE
#undef HL
#undef SP
#undef PC
#undef LD_R_R
#undef LD_R_HL
#undef LD_HL_R
#undef ALU_ROW
#undef CC_NZ
#undef CC_Z
#undef CC_NC
#undef CC_C
#undef JR_CC
#undef JP_CC
#undef CALL_CC
#undef RET_CC
#undef RST
#undef ILLEGAL
