/*
 * machine.h — contrato interno entre los módulos de la máquina CGB.
 * CONGELADO; sólo lo modifica el coordinador. Permite que M1 (gbc.c), V1 (ppu.c),
 * M2 (apu.c), M3 (cart.c, state.c) y D1 (debug.c) trabajen en paralelo.
 *
 * Estado: lo compartido vive en el struct estático `gb` (lo posee gbc.c). Cada módulo
 * guarda lo suyo en UN struct `static` de su .c y lo expone como bloque opaco con
 * xxx_state() para los estados guardados: así todo el estado es plano y serializable
 * (AGENTS.md §4.1.5) sin que machine.h conozca los detalles de cada periférico.
 * Un bloque de estado NO puede contener punteros (sólo índices/offsets).
 *
 * Tiempo: `gb.now` cuenta PUNTOS (4 194 304 Hz) desde el reset y es monótono. Un ciclo
 * M avanza gb.now en 4 (velocidad normal) o 2 (doble velocidad). Los periféricos se
 * ponen al día de forma perezosa (AGENTS.md §4.1.8): cada uno avanza HASTA gb.now
 * cuando alguien lo observa (registros, VRAM, OAM, paletas) y cuando llega el instante
 * que él mismo anunció con xxx_next_event() (para pedir IRQs a su hora). gbc.c llama a
 * machine_events() en cuanto gb.now >= gb.next_event.
 */
#ifndef MACHINE_H
#define MACHINE_H

#include "base.h"

#define GB_NEVER 0xFFFFFFFFFFFFFFFFull

/* Bits de IF / IE */
enum { IRQ_VBLANK = 1, IRQ_STAT = 2, IRQ_TIMER = 4, IRQ_SERIAL = 8, IRQ_JOYPAD = 16 };

typedef struct {
    GbRegs   cpu;
    uint64_t now;            /* puntos desde el reset */
    uint64_t frame_end;      /* gb.now en que termina el frame de gb_run_frame en curso */
    uint64_t next_event;     /* mínimo de los xxx_next_event(); lo mantiene gbc.c */
    uint32_t frame;          /* frames completados */

    uint8_t  cgb;            /* 1 = modo CGB; 0 = compatibilidad DMG (cartucho sin bandera CGB) */
    uint8_t  double_speed;   /* KEY1.7 */
    uint8_t  key1_armed;     /* KEY1.0 */
    uint8_t  ie;             /* FFFF (8 bits tal cual) */
    uint8_t  ifr;            /* FF0F bits 0-4; los periféricos piden IRQs con gb.ifr |= IRQ_* */
    uint8_t  vbk;            /* FF4F bit 0 */
    uint8_t  svbk;           /* FF70 bits 0-2 tal cual se escribieron (0 → banco 1 al mapear) */
    uint8_t  boot_mapped;    /* 1 = la boot ROM tapa 0000-00FF y 0200-08FF */
    uint8_t  pad;            /* botones pulsados (GB_PAD_*) */
    uint8_t  p1_sel;         /* FF00 bits 4-5 escritos */
    uint8_t  oam_dma_active; /* 1 mientras la OAM DMA copia: la PPU no ve OAM (lee FFh) */
    uint8_t  _pad0;

    /* Temporizador (docs §5) y serie */
    uint16_t div;            /* contador interno de 16 bits (DIV = bits 15-8) */
    uint8_t  tima, tma, tac;
    uint8_t  tima_state;     /* 0 normal; 1 = desbordó en este ciclo M (lee 0, recarga en el siguiente) */
    uint8_t  sb, sc;
    uint8_t  serial_bits;    /* bits que faltan por desplazar */
    uint8_t  _pad1[3];
    uint32_t serial_div;     /* ciclos M hasta el siguiente bit */

    /* OAM DMA (docs §6) */
    uint8_t  dma_reg;        /* último valor escrito en FF46 */
    uint8_t  dma_index;      /* siguiente byte (0-159) */
    uint8_t  dma_delay;      /* ciclos M hasta que empiece a copiar */
    uint8_t  dma_pending;    /* reinicio solicitado mientras otra estaba en marcha */
    uint16_t dma_src;

    /* HDMA/GDMA (FF51-FF55) */
    uint16_t hdma_src, hdma_dst;
    uint8_t  hdma_len;       /* bloques de 16 bytes que faltan − 1 (formato de FF55) */
    uint8_t  hdma_active;    /* 1 = HDMA por HBlank en curso */
    uint8_t  _pad2[2];

    /* ROM mapeada: offsets dentro de gb_rom_data (los mantiene cart.c en cada cambio de banco) */
    uint32_t rom0_off;       /* 0000-3FFF */
    uint32_t romx_off;       /* 4000-7FFF: dirección = romx_off + (a - 0x4000) */

    uint8_t  vram[2][0x2000];
    uint8_t  wram[8][0x1000];
    uint8_t  oam[0xA0];
    uint8_t  hram[0x7F];
    uint8_t  undoc[8];       /* FF72-FF75 y similares del CGB: registros sin función, legibles */
} Gb;

extern Gb gb;
extern uint8_t gb_rom_data[GB_ROM_MAX];   /* la ROM del cartucho (gb_rom()) */
extern uint32_t gb_rom_size;              /* bytes válidos (potencia de 2, ≥ 32 KB tras cart_insert) */
extern uint8_t gb_io_buf[GB_IO_BUFFER_SIZE];

/* ---- gbc.c (M1): servicios para los periféricos ---- */
void machine_reschedule(void);   /* un periférico cambió su próximo evento: recalcular gb.next_event */

/* ---- ppu.c (V1) ----
 * ppu_reset(boot): boot = 1 → estado de encendido (la boot ROM hará el resto);
 *   boot = 0 → estado que deja la boot ROM al saltar a 0100h (LCD encendido, LY/modo
 *   documentados en docs §11, paletas: en modo CGB todo blanco; en compatibilidad DMG,
 *   la paleta fija de docs §7.5 cargada en BG0/OBJ0/OBJ1).
 * ppu_catch_up(): ejecuta la PPU hasta gb.now (al punto). Pide IRQs (VBlank, STAT) en
 *   gb.ifr en el punto exacto en que ocurren aunque se ejecute más tarde.
 * ppu_next_event(): próximo gb.now en que algo de la PPU es observable sin que nadie
 *   lea sus registros (cambio de modo, de LY, fin de frame). GB_NEVER con el LCD apagado.
 * ppu_read/ppu_write: FF40-FF45, FF47-FF4B, FF68-FF6C (llaman ellas a ppu_catch_up).
 *   FF46 (DMA), FF4F (VBK) y FF51-55 (HDMA) son de gbc.c.
 * ppu_vram_blocked/ppu_oam_blocked: gbc.c llama antes a ppu_catch_up(). 1 si la CPU no
 *   puede acceder ahora (VRAM en modo 3; OAM en modos 2 y 3).
 * ppu_hblank(): 1 si la PPU entró en modo 0 de una línea visible desde la última
 *   llamada (lo pone a 0). gbc.c lo usa para la HDMA tras cada ppu_catch_up del evento.
 * ppu_framebuffer(): RGBA 160×144 del último frame COMPLETO (doble buffer interno).
 * ppu_palettes(): 128 bytes (64 BG + 64 OBJ).
 */
void      ppu_reset(int boot);
void      ppu_catch_up(void);
uint64_t  ppu_next_event(void);
uint8_t   ppu_read(uint16_t addr);
void      ppu_write(uint16_t addr, uint8_t v);
int       ppu_vram_blocked(void);
int       ppu_oam_blocked(void);
int       ppu_hblank(void);
uint8_t  *ppu_framebuffer(void);
uint8_t  *ppu_palettes(void);
void      ppu_set_color_correction(int on);
uint32_t  ppu_debug_state(void);          /* LY | punto<<8 | modo<<20 */
void     *ppu_state(uint32_t *len);

/* ---- apu.c (M2) ----
 * El reloj de la APU es el punto (no le afecta la doble velocidad).
 * apu_catch_up(): genera el audio hasta gb.now.
 * apu_read/apu_write: FF10-FF3F, FF76, FF77 (llaman ellas a apu_catch_up).
 * apu_div_event(): gbc.c la llama en el flanco descendente del bit de DIV que mueve el
 *   secuenciador de frame (bit 12 del contador interno, 13 en doble velocidad), con
 *   gb.now ya en ese instante.
 * apu_audio(rate): convierte lo generado desde la llamada anterior en muestras estéreo
 *   intercaladas (ver gb_audio); apu_audio_buffer() las contiene.
 */
void      apu_reset(int boot);
void      apu_catch_up(void);
uint8_t   apu_read(uint16_t addr);
void      apu_write(uint16_t addr, uint8_t v);
void      apu_div_event(void);
uint32_t  apu_audio(uint32_t rate);
float    *apu_audio_buffer(void);
void     *apu_state(uint32_t *len);

/* ---- cart.c (M3) ----
 * cart_insert(len): analiza la cabecera de gb_rom_data; GB_OK o GB_ERR_*.
 * cart_reset(): bancos iniciales, fija gb.rom0_off / gb.romx_off.
 * Las lecturas de 0000-7FFF NO pasan por cart.c (gbc.c usa los offsets); sí las de
 * A000-BFFF (cart_read). Todas las escrituras 0000-7FFF y A000-BFFF van a cart_write.
 */
int       cart_insert(uint32_t len);
void      cart_reset(void);
uint8_t   cart_read(uint16_t addr);
void      cart_write(uint16_t addr, uint8_t v);
uint8_t  *cart_sram(void);
uint32_t  cart_sram_size(void);
uint32_t  cart_sram_dirty(void);           /* 1 si se escribió desde la última llamada (y lo pone a 0) */
uint32_t  cart_rom_bank(void);
int       cart_load_sav(uint32_t len);     /* desde gb_io_buf */
uint32_t  cart_save_sav(void);             /* a gb_io_buf */
void      cart_rtc_advance(uint32_t seconds);
void     *cart_state(uint32_t *len);

/* ---- state.c (M3) ---- */
uint32_t  state_save(void);                /* a gb_io_buf */
int       state_load(uint32_t len);

/* ---- debug.c (D1) ----
 * debug_bp_count == 0 → gbc.c no consulta nada más (coste mínimo). */
extern uint32_t debug_bp_count;
int       debug_is_bp(uint16_t pc);         /* tiene en cuenta el banco mapeado */
void      debug_bp_set(int32_t bank, uint16_t addr, int on);
void      debug_bp_clear_all(void);

#endif /* MACHINE_H */
