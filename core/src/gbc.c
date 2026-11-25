/*
 * gbc.c — máquina CGB (M1): mapa de memoria, bancos de WRAM/VRAM, E/S, IRQ,
 * temporizador, serie, joypad, OAM DMA, HDMA/GDMA, doble velocidad, bucle de frame.
 * Referencia: docs/gbc-hardware.md. Contratos: bus.h (CPU), machine.h (periféricos).
 *
 * Convención de tiempo dentro de un ciclo M: primero avanza la máquina (m_cycle) y
 * después se hace el acceso. Así una lectura de TIMA en el ciclo en que desborda ve 00h
 * y la recarga con TMA ocurre en el ciclo siguiente (docs §5).
 */
#include "machine.h"

Gb gb;
uint8_t gb_rom_data[GB_ROM_MAX];
uint32_t gb_rom_size;
uint8_t gb_io_buf[GB_IO_BUFFER_SIZE];

static uint8_t  boot_rom[GB_BOOT_MAX];
static uint32_t boot_len;
static uint8_t  io_view[0x81];
static uint8_t  hdma_pending;        /* la PPU entró en HBlank con HDMA activa: copiar un bloque */
static uint8_t  bp_skip;             /* reanudar tras un breakpoint sin volver a parar en él */

#ifdef GB_TEST_HOOKS
static GbBusEvent buslog[GB_BUSLOG_MAX];
static uint32_t   buslog_len;
static uint8_t    buslog_on;
static uint8_t    serial_log[GB_SERIAL_LOG_MAX];
static uint32_t   serial_len;
static uint32_t   ld_b_b_count;
static uint8_t    sched_disabled;
#define BUSLOG(a, k, v) do { if (buslog_on && buslog_len < GB_BUSLOG_MAX) { \
        GbBusEvent *e_ = &buslog[buslog_len++]; e_->cycle = (uint32_t)gb.now; \
        e_->addr = (a); e_->kind = (k); e_->value = (v); } } while (0)
#else
#define BUSLOG(a, k, v) ((void)0)
#endif

/* ------------------------------------------------------------------------------------
 * Planificador
 * ---------------------------------------------------------------------------------- */

void machine_reschedule(void)
{
    gb.next_event = ppu_next_event();
#ifdef GB_TEST_HOOKS
    if (sched_disabled) gb.next_event = 0;
#endif
}

static void machine_events(void)
{
    ppu_catch_up();
    if (ppu_hblank() && gb.hdma_active) hdma_pending = 1;
    machine_reschedule();
}

/* ------------------------------------------------------------------------------------
 * Temporizador (docs §5). El contador interno avanza con el reloj de la CPU: 4 por
 * ciclo M en ambas velocidades, de modo que en doble velocidad DIV va al doble.
 * ---------------------------------------------------------------------------------- */

static const uint16_t tac_mask[4] = { 1u << 9, 1u << 3, 1u << 5, 1u << 7 };

static inline int timer_bit(uint16_t div, uint8_t tac)
{
    return (tac & 4) && (div & tac_mask[tac & 3]);
}

static inline void tima_inc(void)
{
    if (gb.tima == 0xFF) { gb.tima = 0; gb.tima_state = 1; }
    else gb.tima++;
}

/* Secuenciador de frame de la APU: flanco descendente del bit 12 del contador (DIV bit 4),
 * bit 13 en doble velocidad (docs §8). */
static inline void apu_edge(uint16_t old, uint16_t now)
{
    uint16_t m = gb.double_speed ? (1u << 13) : (1u << 12);
    if ((old & m) && !(now & m)) apu_div_event();
}

static inline __attribute__((always_inline)) void timer_mcycle(void)
{
    /* La recarga ocurre un ciclo M después del desbordamiento; el estado 2 marca el ciclo
     * de la recarga (escribir TIMA se ignora; escribir TMA también carga TIMA). */
    if (gb.tima_state == 1) { gb.tima = gb.tma; gb.ifr |= IRQ_TIMER; gb.tima_state = 2; }
    else gb.tima_state = 0;
    uint16_t old = gb.div;
    gb.div = (uint16_t)(old + 4);
    if (timer_bit(old, gb.tac) && !timer_bit(gb.div, gb.tac)) tima_inc();
    apu_edge(old, gb.div);
}

/* ------------------------------------------------------------------------------------
 * Serie: sin nadie al otro lado entra FFh. Reloj interno: 8 192 Hz (128 ciclos M por bit
 * en velocidad normal), 262 144 Hz con SC.1 en CGB (4 ciclos M por bit).
 * ---------------------------------------------------------------------------------- */

static inline void serial_mcycle(void)
{
    if (--gb.serial_div) return;
    gb.sb = (uint8_t)(gb.sb << 1 | 1);
    if (--gb.serial_bits == 0) {
        gb.sc &= 0x7F;
        gb.ifr |= IRQ_SERIAL;
    } else {
        gb.serial_div = (gb.cgb && (gb.sc & 2)) ? 4 : 128;
    }
}

/* ------------------------------------------------------------------------------------
 * OAM DMA (docs §6): un ciclo M de preparación tras la escritura y 160 de copia. Un
 * reinicio deja la anterior en marcha durante la preparación (mooneye oam_dma_restart).
 * ---------------------------------------------------------------------------------- */

static uint8_t dma_source_read(uint16_t a);

static inline void dma_mcycle(void)
{
    if (gb.dma_delay && --gb.dma_delay == 0) {
        gb.oam_dma_active = 1;
        gb.dma_index = 0;
        gb.dma_src = (uint16_t)(gb.dma_reg << 8);
    }
    if (gb.oam_dma_active) {
        if (gb.dma_index == 160) { gb.oam_dma_active = 0; return; }
        ppu_catch_up();
        gb.oam[gb.dma_index] = dma_source_read((uint16_t)(gb.dma_src + gb.dma_index));
        gb.dma_index++;
    }
}

/* ------------------------------------------------------------------------------------
 * Un ciclo M
 * ---------------------------------------------------------------------------------- */

static inline __attribute__((always_inline)) void m_cycle(void)
{
    gb.now += gb.double_speed ? 2 : 4;
    timer_mcycle();
    if (gb.serial_bits) serial_mcycle();
    if (gb.dma_delay | gb.oam_dma_active) dma_mcycle();
    if (gb.now >= gb.next_event) machine_events();
}

/* ------------------------------------------------------------------------------------
 * Mapa de memoria
 * ---------------------------------------------------------------------------------- */

static inline uint8_t wram_bank(void) { uint8_t b = gb.cgb ? (gb.svbk & 7) : 1; return b ? b : 1; }

static inline int boot_covers(uint16_t a)
{
    return gb.boot_mapped && (a < 0x100 || (a >= 0x200 && a < 0x900));
}

static uint8_t dma_source_read(uint16_t a)
{
    switch (a >> 13) {
    case 0: case 1: return gb_rom_data[gb.rom0_off + a];
    case 2: case 3: return gb_rom_data[gb.romx_off + (a - 0x4000)];
    case 4: return gb.vram[gb.vbk][a & 0x1FFF];
    case 5: return cart_read(a);
    default:
        /* E000-FFFF se lee como C000-DFFF [VERIFICAR M1] */
        return (a & 0x1000) ? gb.wram[wram_bank()][a & 0xFFF] : gb.wram[0][a & 0xFFF];
    }
}

static uint8_t joyp_read(void)
{
    uint8_t v = 0x0F;
    if (!(gb.p1_sel & 0x10)) v &= (uint8_t)~(gb.pad & 0x0F);
    if (!(gb.p1_sel & 0x20)) v &= (uint8_t)~(gb.pad >> 4);
    return (uint8_t)(0xC0 | gb.p1_sel | v);
}

static uint8_t io_read(uint16_t a)
{
    switch (a) {
    case 0xFF00: return joyp_read();
    case 0xFF01: return gb.sb;
    case 0xFF02: return (uint8_t)(gb.sc | (gb.cgb ? 0x7C : 0x7E));
    case 0xFF04: return (uint8_t)(gb.div >> 8);
    case 0xFF05: return gb.tima;
    case 0xFF06: return gb.tma;
    case 0xFF07: return (uint8_t)(gb.tac | 0xF8);
    case 0xFF0F: return (uint8_t)(gb.ifr | 0xE0);
    case 0xFF46: return gb.dma_reg;
    case 0xFF4D: return gb.cgb ? (uint8_t)(0x7E | gb.double_speed << 7 | gb.key1_armed) : 0xFF;
    /* También en compatibilidad DMG se lee FEh | banco (mooneye misc/boot_hwio-C). */
    case 0xFF4F: return (uint8_t)(0xFE | gb.vbk);
    case 0xFF55: return gb.cgb ? (uint8_t)(gb.hdma_active ? gb.hdma_len : (0x80 | gb.hdma_len)) : 0xFF;
    case 0xFF70: return gb.cgb ? (uint8_t)(0xF8 | gb.svbk) : 0xFF;
    case 0xFF72: return gb.undoc[0];
    case 0xFF73: return gb.undoc[1];
    case 0xFF74: return gb.cgb ? gb.undoc[2] : 0xFF;
    case 0xFF75: return (uint8_t)(gb.undoc[3] | 0x8F);
    case 0xFF76: case 0xFF77: return apu_read(a);
    default: break;
    }
    if (a >= 0xFF10 && a <= 0xFF3F) return apu_read(a);
    if ((a >= 0xFF40 && a <= 0xFF4B) || (a >= 0xFF68 && a <= 0xFF6C)) return ppu_read(a);
    return 0xFF;
}

static void hdma_copy_block(void)
{
    for (int i = 0; i < 16; i++) {
        /* La HDMA/GDMA no ve VRAM ni E000-FFFF como origen: lee FFh (SameSuite
         * dma/gdma_addr_mask). La OAM DMA sí los ve (dma_source_read). */
        uint16_t s = gb.hdma_src;
        uint8_t v = ((s >> 13) == 4 || (s >> 13) == 7) ? 0xFF : dma_source_read(s);
        gb.vram[gb.vbk][gb.hdma_dst & 0x1FFF] = v;
        gb.hdma_src++;
        gb.hdma_dst = (uint16_t)(0x8000 | ((gb.hdma_dst + 1) & 0x1FFF));
    }
    /* 16 bytes = 32 puntos: 8 ciclos M en velocidad normal, 16 en doble (docs §6). */
    for (int i = 0, n = gb.double_speed ? 16 : 8; i < n; i++) m_cycle();
}

static void io_write(uint16_t a, uint8_t v)
{
    switch (a) {
    case 0xFF00: {
        uint8_t before = joyp_read() & 0x0F;
        gb.p1_sel = v & 0x30;
        if (before & ~joyp_read() & 0x0F) gb.ifr |= IRQ_JOYPAD;
        return;
    }
    case 0xFF01: gb.sb = v; return;
    case 0xFF02:
        gb.sc = (uint8_t)(v & (gb.cgb ? 0x83 : 0x81));
        if ((gb.sc & 0x81) == 0x81) {
#ifdef GB_TEST_HOOKS
            if (serial_len < GB_SERIAL_LOG_MAX) serial_log[serial_len++] = gb.sb;
#endif
            gb.serial_bits = 8;
            gb.serial_div = (gb.cgb && (gb.sc & 2)) ? 4 : 128;
        } else {
            gb.serial_bits = 0;
        }
        return;
    case 0xFF04: {
        uint16_t old = gb.div;
        if (timer_bit(old, gb.tac)) tima_inc();
        gb.div = 0;
        apu_edge(old, 0);
        return;
    }
    case 0xFF05:
        if (gb.tima_state == 2) return;          /* ciclo de recarga: gana TMA */
        gb.tima = v;
        gb.tima_state = 0;                       /* escribir en el ciclo del desbordamiento cancela la recarga */
        return;
    case 0xFF06:
        gb.tma = v;
        if (gb.tima_state == 2) gb.tima = v;
        return;
    case 0xFF07: {
        /* El multiplexor de TAC cambia antes del paso del contador de este ciclo M: se
         * rehace ese paso con el TAC nuevo. Así aparecen los dos efectos del «glitch» de
         * TAC: el flanco 1→0 al cambiar de bit o apagar (Pan Docs «Timer obscure
         * behaviour») y el incremento perdido/ganado si el bit cae justo en este ciclo
         * (mooneye acceptance/timer/rapid_toggle). [VERIFICAR] el orden interno exacto. */
        uint8_t old = gb.tac, nw = v & 7;
        uint16_t prev = (uint16_t)(gb.div - 4);
        int done = timer_bit(prev, old) && !timer_bit(gb.div, old);
        int want = (timer_bit(prev, old) && !timer_bit(prev, nw))
                 + (timer_bit(prev, nw) && !timer_bit(gb.div, nw));
        gb.tac = nw;
        if (want > done) tima_inc();
        else if (want < done) {
            if (gb.tima_state == 1) { gb.tima = 0xFF; gb.tima_state = 0; } else gb.tima--;
        }
        return;
    }
    case 0xFF0F: gb.ifr = v & 0x1F; return;
    case 0xFF46: gb.dma_reg = v; gb.dma_delay = 2; return;
    case 0xFF4C:
        /* KEY0: la boot ROM elige el modo de compatibilidad DMG escribiendo 04h. */
        if (gb.boot_mapped && (v & 0x04)) gb.cgb = 0;
        return;
    case 0xFF4D: if (gb.cgb) gb.key1_armed = v & 1; return;
    case 0xFF4F: if (gb.cgb) { ppu_catch_up(); gb.vbk = v & 1; } return;
    case 0xFF50: if (v) gb.boot_mapped = 0; return;
    case 0xFF51: if (gb.cgb) gb.hdma_src = (uint16_t)((gb.hdma_src & 0x00F0) | v << 8); return;
    case 0xFF52: if (gb.cgb) gb.hdma_src = (uint16_t)((gb.hdma_src & 0xFF00) | (v & 0xF0)); return;
    case 0xFF53: if (gb.cgb) gb.hdma_dst = (uint16_t)(0x8000 | (gb.hdma_dst & 0x00F0) | (v & 0x1F) << 8); return;
    case 0xFF54: if (gb.cgb) gb.hdma_dst = (uint16_t)((gb.hdma_dst & 0xFF00) | (v & 0xF0)); return;
    case 0xFF55:
        if (!gb.cgb) return;
        if (gb.hdma_active && !(v & 0x80)) {     /* cancela la HDMA en curso */
            gb.hdma_active = 0;
            gb.hdma_len = v & 0x7F;
            return;
        }
        gb.hdma_len = v & 0x7F;
        if (v & 0x80) {
            /* Arrancada en modo 0 (o con el LCD apagado, que lee modo 0) copia un bloque
             * al instante; el HBlank ya empezado no vuelve a contar (docs §6). */
            gb.hdma_active = 1;
            if ((ppu_read(0xFF41) & 3) == 0) hdma_pending = 1;
            (void)ppu_hblank();
            machine_reschedule();   /* la PPU sólo despierta en HBlank si hay HDMA */
            return;
        }
        /* GDMA: todo de una vez con la CPU parada */
        ppu_catch_up();
        for (;;) {
            hdma_copy_block();
            if (gb.hdma_len-- == 0) break;
        }
        gb.hdma_len = 0x7F;
        return;
    case 0xFF70: if (gb.cgb) gb.svbk = v & 7; return;
    case 0xFF72: gb.undoc[0] = v; return;
    case 0xFF73: gb.undoc[1] = v; return;
    case 0xFF74: if (gb.cgb) gb.undoc[2] = v; return;
    case 0xFF75: gb.undoc[3] = v & 0x70; return;
    default: break;
    }
    if (a >= 0xFF10 && a <= 0xFF3F) { apu_write(a, v); return; }
    if ((a >= 0xFF40 && a <= 0xFF4B) || (a >= 0xFF68 && a <= 0xFF6C)) { ppu_write(a, v); return; }
}

static inline uint8_t mem_read(uint16_t a)
{
    switch (a >> 12) {
    case 0x0: case 0x1: case 0x2: case 0x3:
        if (boot_covers(a)) return boot_rom[a];
        return gb_rom_data[gb.rom0_off + a];
    case 0x4: case 0x5: case 0x6: case 0x7:
        return gb_rom_data[gb.romx_off + (a - 0x4000)];
    case 0x8: case 0x9:
        ppu_catch_up();
        if (ppu_vram_blocked()) return 0xFF;
        return gb.vram[gb.vbk][a & 0x1FFF];
    case 0xA: case 0xB:
        return cart_read(a);
    case 0xC: case 0xE:
        return gb.wram[0][a & 0xFFF];
    case 0xD:
        return gb.wram[wram_bank()][a & 0xFFF];
    default:
        if (a < 0xFE00) return gb.wram[wram_bank()][a & 0xFFF];
        if (a < 0xFEA0) {
            if (gb.oam_dma_active) return 0xFF;
            ppu_catch_up();
            if (ppu_oam_blocked()) return 0xFF;
            return gb.oam[a - 0xFE00];
        }
        if (a < 0xFF00) {
            /* CGB-E: nibble alto del byte bajo repetido [VERIFICAR M1] */
            if (gb.oam_dma_active) return 0xFF;
            return (uint8_t)((a & 0xF0) | ((a & 0xF0) >> 4));
        }
        if (a < 0xFF80) return io_read(a);
        if (a < 0xFFFF) return gb.hram[a - 0xFF80];
        return gb.ie;
    }
}

static inline void mem_write(uint16_t a, uint8_t v)
{
    switch (a >> 12) {
    case 0x0: case 0x1: case 0x2: case 0x3: case 0x4: case 0x5: case 0x6: case 0x7:
    case 0xA: case 0xB:
        cart_write(a, v);
        return;
    case 0x8: case 0x9:
        ppu_catch_up();
        if (!ppu_vram_blocked()) gb.vram[gb.vbk][a & 0x1FFF] = v;
        return;
    case 0xC: case 0xE:
        gb.wram[0][a & 0xFFF] = v;
        return;
    case 0xD:
        gb.wram[wram_bank()][a & 0xFFF] = v;
        return;
    default:
        if (a < 0xFE00) { gb.wram[wram_bank()][a & 0xFFF] = v; return; }
        if (a < 0xFEA0) {
            if (gb.oam_dma_active) return;
            ppu_catch_up();
            if (!ppu_oam_write_blocked()) gb.oam[a - 0xFE00] = v;
            return;
        }
        if (a < 0xFF00) return;
        if (a < 0xFF80) { io_write(a, v); return; }
        if (a < 0xFFFF) { gb.hram[a - 0xFF80] = v; return; }
        gb.ie = v;
        return;
    }
}

/* ------------------------------------------------------------------------------------
 * Contrato bus.h
 * ---------------------------------------------------------------------------------- */

static inline __attribute__((always_inline)) uint8_t bus_read(uint16_t a)
{
    m_cycle();
    uint8_t v = mem_read(a);
    BUSLOG(a, 0, v);
    return v;
}

static inline __attribute__((always_inline)) void bus_write(uint16_t a, uint8_t v)
{
    if (debug_wp_count) debug_wp_check(a);
    m_cycle();
    mem_write(a, v);
    BUSLOG(a, 1, v);
}

static inline __attribute__((always_inline)) void bus_tick(void)
{
    m_cycle();
    BUSLOG(0, 2, 0);
}

static inline uint8_t bus_irq(void) { return gb.ie & gb.ifr & 0x1F; }
static inline void bus_irq_ack(int bit) { gb.ifr &= (uint8_t)~(1u << bit); }

/* STOP pone DIV a 0 (con el mismo flanco que una escritura en DIV). Sin cambio de
 * velocidad pendiente la CPU queda parada hasta que se pulse un botón.
 *
 * Con KEY1.0 = 1 cambia la velocidad (docs §9). Lo fijan las ROMs AGE speed-switch:
 * - La pausa dura 32 767 ciclos M en los que el contador de DIV, TIMA y la APU siguen
 *   corriendo (spsw-tima: TIMA a 4 kHz avanza 80h). Como el contador se puso a 0 al
 *   entrar, 32 767 × 4 = 1FFFCh lo deja a FFFCh y DIV se lee 00 justo después; el primer
 *   paso de DIV llega 64 ciclos M después (spsw-div).
 * - Entrando en doble velocidad, los 2 primeros ciclos M aún son de velocidad normal;
 *   saliendo de ella, la pausa añade 1 punto de PPU suelto (la CPU queda desfasada medio
 *   ciclo de 2 MHz respecto a la PPU). Lo fija la alineación LY/STAT de spsw-mode0.
 *   [VERIFICAR]: es el único reparto que encaja con las 5 secciones del test, no una
 *   descripción del circuito.
 * - El byte siguiente a STOP no se salta: es el opcode que la CPU ya ha leído y se ejecuta
 *   tras la pausa (spsw-stop-prefetch). Aquí se retrocede el PC y se vuelve a leer tras la
 *   pausa: el tiempo es el mismo, pero si el byte cambia durante la pausa (E/S) se lee el
 *   valor nuevo y no el ya captado; para eso hace falta que sm83.c guarde el opcode.
 * - En CGB E, el reinicio de DIV de STOP muestrea el bit de 262 kHz un ciclo M más tarde
 *   que los de 4/16/65 kHz (spsw-tima-cgbE; en CGB B, según spsw-tima-cgbBC, también los
 *   de 16/65 kHz se muestrean tarde). */
#define SPSW_MCYCLES 32767
#define SPSW_SS_PREFIX 2     /* ciclos M en velocidad normal al pasar a doble */
#define SPSW_DS_EXTRA_DOTS 1 /* punto suelto al volver a velocidad normal */

static inline int bus_stop(void)
{
    uint16_t old = gb.div;
    if (!gb.key1_armed) {
        if (timer_bit(old, gb.tac)) tima_inc();
        gb.div = 0;
        apu_edge(old, 0);
        return 0;
    }
    /* Con una IRQ pendiente STOP no ha leído su segundo byte (sm83.c): no hay que
     * retroceder. [VERIFICAR] si la IRQ llegó justo en ese ciclo. */
    int prefetched = !bus_irq();
    if (timer_bit((gb.tac & 3) == 1 ? (uint16_t)(old + 4) : old, gb.tac)) tima_inc();
    gb.div = 0;
    apu_edge(old, 0);
    gb.key1_armed = 0;
    int n_old = gb.double_speed ? 0 : SPSW_SS_PREFIX;
    for (int i = 0; i < n_old; i++) m_cycle();
    gb.double_speed ^= 1;
    if (!gb.double_speed) gb.now += SPSW_DS_EXTRA_DOTS;
    for (int i = n_old; i < SPSW_MCYCLES; i++) m_cycle();
    if (prefetched) gb.cpu.pc.w--;
    return 1;
}

#include "sm83.c"

/* ------------------------------------------------------------------------------------
 * Arranque
 * ---------------------------------------------------------------------------------- */

static void post_boot_state(void)
{
    /* Estado que deja la boot ROM del CGB al saltar a 0100h (docs §11, Pan Docs
     * "Power Up Sequence"). [VERIFICAR M1] con mooneye boot_regs-cgb / boot_hwio-C. */
    GbRegs *r = &gb.cpu;
    r->af.w = 0x1180;
    r->sp.w = 0xFFFE;
    r->pc.w = 0x0100;
    if (gb.cgb) {
        r->bc.w = 0x0000; r->de.w = 0xFF56; r->hl.w = 0x000D;
    } else {
        r->bc.w = 0x0000; r->de.w = 0x0008; r->hl.w = 0x007C;
    }
    gb.ifr = IRQ_VBLANK;
    /* Fase del contador de DIV en el primer ciclo M de 0100h. La boot ROM tarda más con
     * un cartucho DMG (elige la paleta de compatibilidad): 2674h la fija mooneye
     * misc/boot_div-cgbABCDE (docs §11). Con cartucho CGB no hay test: [VERIFICAR]. */
    gb.div = gb.cgb ? 0x1EA0 : 0x2674;
    gb.p1_sel = 0x30;
    gb.dma_reg = 0x00;
    gb.hdma_len = 0x7F;
}

void gb_reset(void)
{
    uint8_t cgb_flag = gb_rom_size >= 0x150 ? gb_rom_data[0x143] : 0;
    uint32_t rom0 = gb.rom0_off, romx = gb.romx_off;
    gb_memset(&gb, 0, sizeof gb);
    gb.rom0_off = rom0; gb.romx_off = romx;
    gb.boot_mapped = boot_len != 0;
    /* Con boot ROM empieza en modo CGB y ella elige (KEY0); sin ella decide la cabecera. */
    gb.cgb = gb.boot_mapped ? 1 : (cgb_flag & 0x80) != 0;
    gb.frame_end = GB_DOTS_PER_FRAME;
    gb.hdma_len = 0x7F;
    gb.p1_sel = 0x30;
    hdma_pending = 0;
    bp_skip = 0;
    if (!gb.boot_mapped) post_boot_state();
    cart_reset();
    ppu_reset(gb.boot_mapped);
    apu_reset(gb.boot_mapped);
    machine_reschedule();
}

void gb_init(void)
{
    gb_memset(&gb, 0, sizeof gb);
    gb_rom_size = 0;
    boot_len = 0;
}

int gb_insert(uint32_t rom_len)
{
    int err = cart_insert(rom_len);
    if (err != GB_OK) return err;
    gb_reset();
    return GB_OK;
}

int gb_boot_rom(uint32_t len)
{
    if (len == 0) { boot_len = 0; return GB_OK; }
    if (len != GB_BOOT_MAX) return GB_ERR_SIZE;
    gb_memcpy(boot_rom, gb_io_buf, len);
    boot_len = len;
    return GB_OK;
}

/* ------------------------------------------------------------------------------------
 * Ejecución
 * ---------------------------------------------------------------------------------- */

static inline void step_once(void)
{
    if (hdma_pending) {
        hdma_pending = 0;
        if (gb.hdma_active && !gb.cpu.halted) {
            hdma_copy_block();
            if (gb.hdma_len-- == 0) { gb.hdma_active = 0; gb.hdma_len = 0x7F; }
        }
    }
#ifdef GB_TEST_HOOKS
    if (!gb.cpu.halted && !gb.cpu.locked && gb_peek(gb.cpu.pc.w) == 0x40) ld_b_b_count++;
#endif
    sm83_step(&gb.cpu);
}

static int run_until(uint64_t end)
{
    while (gb.now < end) {
        if (debug_bp_count) {
            if (!bp_skip && debug_is_bp(gb.cpu.pc.w)) { bp_skip = 1; return GB_STOP_BREAKPOINT; }
            bp_skip = 0;
        }
        step_once();
        if (debug_bp_count && debug_wp_hit) { debug_wp_hit = 0; return GB_STOP_WATCHPOINT; }
    }
    return GB_STOP_FRAME;
}

int gb_run_frame(void)
{
    if (gb_rom_size == 0) return GB_STOP_FRAME;
    int r = run_until(gb.frame_end);
    if (r != GB_STOP_FRAME) return r;
    gb.frame_end += GB_DOTS_PER_FRAME;
    gb.frame++;
    ppu_catch_up();
    apu_catch_up();
    machine_reschedule();
    return GB_STOP_FRAME;
}

int gb_step(void)
{
    if (gb_rom_size == 0) return GB_STOP_STEP;
    bp_skip = 0;
    step_once();
    debug_wp_hit = 0;   /* un paso ya se detiene: el aviso no debe disparar el próximo run */
    if (gb.now >= gb.frame_end) { gb.frame_end += GB_DOTS_PER_FRAME; gb.frame++; }
    ppu_catch_up();
    return GB_STOP_STEP;
}

uint32_t gb_cycles_lo(void) { return (uint32_t)gb.now; }
uint32_t gb_cycles_hi(void) { return (uint32_t)(gb.now >> 32); }
uint32_t gb_frame(void) { return gb.frame; }

/* ------------------------------------------------------------------------------------
 * Regiones y vistas
 * ---------------------------------------------------------------------------------- */

uint8_t *gb_framebuffer(void) { return ppu_framebuffer(); }
void gb_set_color_correction(uint32_t on) { ppu_set_color_correction(on != 0); }
uint8_t *gb_rom(void) { return gb_rom_data; }
uint8_t *gb_sram(void) { return cart_sram(); }
uint32_t gb_sram_size(void) { return cart_sram_size(); }
uint32_t gb_sram_dirty(void) { return cart_sram_dirty(); }
GbRegs *gb_regs(void) { return &gb.cpu; }
uint8_t *gb_io_buffer(void) { return gb_io_buf; }
uint32_t gb_cgb_mode(void) { return gb.cgb; }

uint32_t gb_audio(uint32_t rate) { apu_catch_up(); return apu_audio(rate); }
float *gb_audio_buffer(void) { return apu_audio_buffer(); }

uint8_t *gb_vram(void) { return &gb.vram[0][0]; }
uint8_t *gb_wram(void) { return &gb.wram[0][0]; }
uint8_t *gb_oam(void) { return gb.oam; }
uint8_t *gb_hram(void) { return gb.hram; }
uint8_t *gb_palettes(void) { return ppu_palettes(); }
uint32_t gb_rom_bank(void) { return cart_rom_bank(); }

uint8_t *gb_io(void)
{
    for (uint32_t i = 0; i < 0x80; i++) io_view[i] = io_read((uint16_t)(0xFF00 + i));
    io_view[0x80] = gb.ie;
    return io_view;
}

uint32_t gb_peek(uint32_t addr)
{
    uint16_t a = (uint16_t)addr;
    switch (a >> 12) {
    case 0x0: case 0x1: case 0x2: case 0x3:
        return boot_covers(a) ? boot_rom[a] : gb_rom_data[gb.rom0_off + a];
    case 0x4: case 0x5: case 0x6: case 0x7: return gb_rom_data[gb.romx_off + (a - 0x4000)];
    case 0x8: case 0x9: return gb.vram[gb.vbk][a & 0x1FFF];
    case 0xA: case 0xB: return cart_read(a);
    case 0xC: case 0xE: return gb.wram[0][a & 0xFFF];
    case 0xD: return gb.wram[wram_bank()][a & 0xFFF];
    default:
        if (a < 0xFE00) return gb.wram[wram_bank()][a & 0xFFF];
        if (a < 0xFEA0) return gb.oam[a - 0xFE00];
        if (a < 0xFF00) return 0xFF;
        if (a < 0xFF80) return io_read(a);
        if (a < 0xFFFF) return gb.hram[a - 0xFF80];
        return gb.ie;
    }
}

void gb_poke(uint32_t addr, uint32_t value)
{
    uint16_t a = (uint16_t)addr;
    uint8_t v = (uint8_t)value;
    switch (a >> 12) {
    case 0x8: case 0x9: gb.vram[gb.vbk][a & 0x1FFF] = v; return;
    case 0xC: case 0xE: gb.wram[0][a & 0xFFF] = v; return;
    case 0xD: gb.wram[wram_bank()][a & 0xFFF] = v; return;
    case 0xF:
        if (a < 0xFE00) gb.wram[wram_bank()][a & 0xFFF] = v;
        else if (a < 0xFEA0) gb.oam[a - 0xFE00] = v;
        else if (a >= 0xFF80 && a < 0xFFFF) gb.hram[a - 0xFF80] = v;
        else if (a == 0xFFFF) gb.ie = v;
        return;
    default: return;   /* ROM, RAM externa y E/S: sin efectos */
    }
}

void gb_set_pc(uint32_t addr)
{
    gb.cpu.pc.w = (uint16_t)addr;
    gb.cpu.halted = 0;
    gb.cpu.stopped = 0;
    gb.cpu.halt_bug = 0;
    bp_skip = 0;
}

/* ------------------------------------------------------------------------------------
 * Entrada
 * ---------------------------------------------------------------------------------- */

void gb_joypad(uint32_t mask)
{
    uint8_t before = joyp_read() & 0x0F;
    uint8_t newly = (uint8_t)(mask & ~gb.pad);
    gb.pad = (uint8_t)mask;
    if (before & ~joyp_read() & 0x0F) gb.ifr |= IRQ_JOYPAD;
    if (newly && gb.cpu.stopped) gb.cpu.stopped = 0;
}

/* ------------------------------------------------------------------------------------
 * Ficheros
 * ---------------------------------------------------------------------------------- */

int gb_load_sav(uint32_t len) { return cart_load_sav(len); }
uint32_t gb_save_sav(void) { return cart_save_sav(); }
void gb_rtc_advance(uint32_t seconds) { cart_rtc_advance(seconds); }
uint32_t gb_save_state(void) { ppu_catch_up(); apu_catch_up(); return state_save(); }
int gb_load_state(uint32_t len)
{
    int r = state_load(len);
    if (r == GB_OK) { hdma_pending = 0; bp_skip = 0; machine_reschedule(); }
    return r;
}

void gb_bp_set(int32_t bank, uint32_t addr, uint32_t on) { debug_bp_set(bank, (uint16_t)addr, on != 0); }
void gb_bp_clear_all(void) { debug_bp_clear_all(); }
int gb_wp_set(uint32_t lo, uint32_t hi, uint32_t on) { return debug_wp_set((uint16_t)lo, (uint16_t)hi, on != 0); }
void gb_wp_clear_all(void) { debug_wp_clear_all(); }
uint32_t gb_wp_addr(void) { return debug_wp_addr; }

/* ------------------------------------------------------------------------------------
 * Hooks de test
 * ---------------------------------------------------------------------------------- */

#ifdef GB_TEST_HOOKS
int gb_t_run_until(uint32_t dots_lo)
{
    while ((uint32_t)gb.now < dots_lo) step_once();
    return GB_STOP_STEP;
}
void gb_t_buslog_enable(uint32_t on) { buslog_on = on != 0; buslog_len = 0; }
GbBusEvent *gb_t_buslog(void) { return buslog; }
uint32_t gb_t_buslog_len(void) { return buslog_len; }
uint8_t *gb_t_serial_log(void) { return serial_log; }
uint32_t gb_t_serial_len(void) { return serial_len; }
uint32_t gb_t_ld_b_b(void) { return ld_b_b_count; }
uint32_t gb_t_ppu_state(void) { ppu_catch_up(); return ppu_debug_state(); }
void gb_t_sched_disable(uint32_t on) { sched_disabled = on != 0; machine_reschedule(); }
#endif
