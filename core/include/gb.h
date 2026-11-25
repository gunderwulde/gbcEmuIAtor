/*
 * gb.h — ABI pública del núcleo Game Boy Color (lo único que ve JavaScript).
 *
 * CONTRATO CONGELADO (fin de la fase 0). Sólo el coordinador lo modifica.
 *
 * Reglas del ABI:
 *  - Sólo enteros, floats y punteros a regiones estáticas. Nada se reserva en tiempo
 *    de ejecución: cada puntero devuelto es válido durante toda la vida del módulo.
 *  - Para pasar ficheros: JS escribe en gb_io_buffer() y llama a gb_load_*(len).
 *    La ROM del cartucho va directamente a gb_rom() y luego gb_insert(len).
 *  - Direcciones y valores se pasan como uint32_t/int32_t y se truncan dentro.
 */
#ifndef GB_H
#define GB_H

#include <stddef.h>
#include <stdint.h>

#define GB_EXPORT(name) __attribute__((export_name(#name)))

/* ---- Geometría y tiempos (docs/gbc-hardware.md §1) ---- */
#define GB_DOT_HZ          4194304      /* reloj de la PPU (punto); no cambia en doble velocidad */
#define GB_DOTS_PER_LINE   456
#define GB_LINES           154
#define GB_DOTS_PER_FRAME  70224
#define GB_FB_WIDTH        160
#define GB_FB_HEIGHT       144
#define GB_ROM_MAX         (8 * 1024 * 1024)
#define GB_SRAM_MAX        (128 * 1024)
#define GB_BOOT_MAX        2304         /* 0000-00FF + 0200-08FF */
#define GB_IO_BUFFER_SIZE  (1024 * 1024)
#define GB_AUDIO_MAX_FRAMES 4096        /* muestras estéreo por frame; sobra para 192 kHz */

/* ---- Estado de la CPU ----
 * El núcleo trabaja DIRECTAMENTE sobre este struct (no hay copia): JS puede leerlo y
 * modificarlo entre frames. Little-endian (wasm): en un par, .b.l es el byte bajo
 * (F, C, E, L) y .b.h el alto (A, B, D, H). Espejo TS: web/src/emu/regs.ts.
 */
typedef union {
    uint16_t w;
    struct { uint8_t l, h; } b;
} GbPair;

typedef struct {
    GbPair  af, bc, de, hl;   /*  0  2  4  6  (F: bits 3-0 siempre 0) */
    GbPair  sp, pc;           /*  8 10 */
    uint8_t ime;              /* 12  IME */
    uint8_t ei_delay;         /* 13  1 = la última instrucción fue EI: IME pasa a 1 tras la siguiente */
    uint8_t halted;           /* 14  1 = en HALT */
    uint8_t halt_bug;         /* 15  1 = el próximo fetch no incrementa PC */
    uint8_t stopped;          /* 16  1 = en STOP (la máquina lo saca al pulsar un botón) */
    uint8_t locked;           /* 17  1 = ejecutó un opcode ilegal: CPU bloqueada hasta reset */
    uint8_t _pad[2];          /* 18 19 */
} GbRegs;                     /* 20 bytes */

_Static_assert(offsetof(GbRegs, sp) == 8, "GbRegs layout");
_Static_assert(offsetof(GbRegs, pc) == 10, "GbRegs layout");
_Static_assert(offsetof(GbRegs, ime) == 12, "GbRegs layout");
_Static_assert(offsetof(GbRegs, locked) == 17, "GbRegs layout");
_Static_assert(sizeof(GbRegs) == 20, "GbRegs layout");

/* ---- Motivos de parada de gb_run_frame / gb_step ---- */
enum {
    GB_STOP_FRAME      = 0,   /* frame completo (70 224 puntos) */
    GB_STOP_BREAKPOINT = 1,   /* PC alcanzó un breakpoint (la instrucción NO se ha ejecutado) */
    GB_STOP_STEP       = 2,   /* gb_step terminó */
    GB_STOP_WATCHPOINT = 3,   /* una escritura cayó en un watchpoint (la instrucción SÍ se ha ejecutado) */
};

/* ---- Errores de carga ---- */
enum {
    GB_OK            = 0,
    GB_ERR_SIZE      = -1,    /* longitud imposible para el formato */
    GB_ERR_FORMAT    = -2,    /* contenido malformado */
    GB_ERR_MBC       = -3,    /* tipo de cartucho no soportado */
    GB_ERR_VERSION   = -4,    /* estado de otra versión */
};

/* ---- Joypad: bit a 1 = pulsado ---- */
enum {
    GB_PAD_RIGHT = 1 << 0, GB_PAD_LEFT = 1 << 1, GB_PAD_UP    = 1 << 2, GB_PAD_DOWN  = 1 << 3,
    GB_PAD_A     = 1 << 4, GB_PAD_B    = 1 << 5, GB_PAD_SELECT = 1 << 6, GB_PAD_START = 1 << 7,
};

/* ---- Ciclo de vida ---- */
GB_EXPORT(gb_init)      void     gb_init(void);              /* todo a cero, sin cartucho */
GB_EXPORT(gb_insert)    int      gb_insert(uint32_t rom_len);/* ROM ya en gb_rom(); valida cabecera y hace gb_reset. GB_OK o GB_ERR_* */
GB_EXPORT(gb_boot_rom)  int      gb_boot_rom(uint32_t len);  /* boot ROM en gb_io_buffer(); 0 = quitarla. Efecto en el próximo reset */
GB_EXPORT(gb_reset)     void     gb_reset(void);             /* encendido (con boot ROM) o estado post-arranque (sin ella) */

/* ---- Ejecución ---- */
GB_EXPORT(gb_run_frame) int      gb_run_frame(void);         /* hasta completar 70 224 puntos, o breakpoint */
GB_EXPORT(gb_step)      int      gb_step(void);              /* una instrucción (o despacho de IRQ, o un ciclo M en HALT/STOP) */
GB_EXPORT(gb_cycles_lo) uint32_t gb_cycles_lo(void);         /* puntos desde el reset (64 bits) */
GB_EXPORT(gb_cycles_hi) uint32_t gb_cycles_hi(void);
GB_EXPORT(gb_frame)     uint32_t gb_frame(void);             /* frames completados desde el reset */

/* ---- Regiones ---- */
GB_EXPORT(gb_framebuffer)          uint8_t *gb_framebuffer(void);   /* RGBA 160×144, último frame completo */
GB_EXPORT(gb_set_color_correction) void     gb_set_color_correction(uint32_t on);
GB_EXPORT(gb_rom)          uint8_t  *gb_rom(void);           /* GB_ROM_MAX bytes */
GB_EXPORT(gb_sram)         uint8_t  *gb_sram(void);          /* RAM externa del cartucho */
GB_EXPORT(gb_sram_size)    uint32_t  gb_sram_size(void);     /* tamaño según cabecera (0 si no hay) */
GB_EXPORT(gb_sram_dirty)   uint32_t  gb_sram_dirty(void);    /* 1 si se escribió desde la última llamada (y lo pone a 0) */
GB_EXPORT(gb_regs)         GbRegs   *gb_regs(void);
GB_EXPORT(gb_io_buffer)    uint8_t  *gb_io_buffer(void);     /* GB_IO_BUFFER_SIZE bytes */
GB_EXPORT(gb_cgb_mode)     uint32_t  gb_cgb_mode(void);      /* 1 = modo CGB, 0 = compatibilidad DMG */

/* ---- Audio ----
 * Convierte el audio emulado desde la última llamada en muestras estéreo float [-1,1]
 * intercaladas L/R a `rate` Hz. Devuelve el nº de muestras ESTÉREO (pares). El resto
 * fraccional se arrastra (no se pierde ni duplica nada). */
GB_EXPORT(gb_audio)        uint32_t  gb_audio(uint32_t rate);
GB_EXPORT(gb_audio_buffer) float    *gb_audio_buffer(void);

/* ---- Vistas de depuración (sin efectos laterales) ---- */
GB_EXPORT(gb_vram)     uint8_t *gb_vram(void);      /* 2 × 8 KB */
GB_EXPORT(gb_wram)     uint8_t *gb_wram(void);      /* 8 × 4 KB */
GB_EXPORT(gb_oam)      uint8_t *gb_oam(void);       /* 160 bytes */
GB_EXPORT(gb_hram)     uint8_t *gb_hram(void);      /* 127 bytes (FF80-FFFE) */
GB_EXPORT(gb_palettes) uint8_t *gb_palettes(void);  /* 64 BG + 64 OBJ, RGB555 little-endian */
GB_EXPORT(gb_io)       uint8_t *gb_io(void);        /* FF00-FF7F + FFFF en [0x80], tal como se leerían (se refresca al llamar) */
GB_EXPORT(gb_peek)     uint32_t gb_peek(uint32_t addr);  /* lectura sin efectos ni avance de tiempo */
GB_EXPORT(gb_rom_bank) uint32_t gb_rom_bank(void);  /* banco mapeado en 4000-7FFF */

/* ---- Entrada ---- */
GB_EXPORT(gb_joypad) void gb_joypad(uint32_t mask);  /* GB_PAD_* pulsados */

/* ---- Ficheros (en gb_io_buffer) ---- */
GB_EXPORT(gb_load_sav)    int      gb_load_sav(uint32_t len);       /* RAM (+48 bytes de RTC) */
GB_EXPORT(gb_save_sav)    uint32_t gb_save_sav(void);               /* devuelve longitud */
GB_EXPORT(gb_rtc_advance) void     gb_rtc_advance(uint32_t seconds);/* tiempo real transcurrido (al cargar .sav) */
GB_EXPORT(gb_save_state)  uint32_t gb_save_state(void);
GB_EXPORT(gb_load_state)  int      gb_load_state(uint32_t len);

/* ---- Depuración ---- */
GB_EXPORT(gb_bp_set)       void gb_bp_set(int32_t bank, uint32_t addr, uint32_t on); /* bank −1 = cualquiera */
GB_EXPORT(gb_bp_clear_all) void gb_bp_clear_all(void);
GB_EXPORT(gb_wp_set)       int  gb_wp_set(uint32_t lo, uint32_t hi, uint32_t on);   /* watchpoint de escritura [lo,hi]; −1 si no caben más */
GB_EXPORT(gb_wp_clear_all) void gb_wp_clear_all(void);
GB_EXPORT(gb_wp_addr)      uint32_t gb_wp_addr(void);    /* dirección de la última escritura que paró */
GB_EXPORT(gb_poke)         void gb_poke(uint32_t addr, uint32_t value);  /* escritura sin efectos de E/S ni tiempo; ROM ignorada */
GB_EXPORT(gb_set_pc)       void gb_set_pc(uint32_t addr);                /* también sale de HALT/STOP */

/* ---- Hooks de test (sólo core-probe.wasm, docs/TEST-PLAN.md §1) ---- */
#ifdef GB_TEST_HOOKS

typedef struct {
    uint32_t cycle;     /* puntos (32 bits bajos) al final del ciclo M */
    uint16_t addr;
    uint8_t  kind;      /* 0 = lectura, 1 = escritura, 2 = interno */
    uint8_t  value;
} GbBusEvent;           /* 8 bytes */
_Static_assert(sizeof(GbBusEvent) == 8, "GbBusEvent layout");
#define GB_BUSLOG_MAX 65536
#define GB_SERIAL_LOG_MAX 65536

GB_EXPORT(gb_t_run_until)     int         gb_t_run_until(uint32_t dots_lo); /* instrucciones hasta alcanzar o superar */
GB_EXPORT(gb_t_buslog_enable) void        gb_t_buslog_enable(uint32_t on);  /* también vacía el log */
GB_EXPORT(gb_t_buslog)        GbBusEvent *gb_t_buslog(void);
GB_EXPORT(gb_t_buslog_len)    uint32_t    gb_t_buslog_len(void);
GB_EXPORT(gb_t_serial_log)    uint8_t    *gb_t_serial_log(void);   /* bytes enviados por SB con reloj interno */
GB_EXPORT(gb_t_serial_len)    uint32_t    gb_t_serial_len(void);
GB_EXPORT(gb_t_ld_b_b)        uint32_t    gb_t_ld_b_b(void);       /* nº de LD B,B ejecutados (mooneye) */
GB_EXPORT(gb_t_ppu_state)     uint32_t    gb_t_ppu_state(void);    /* LY | punto<<8 | modo<<20 */
GB_EXPORT(gb_t_sched_disable) void        gb_t_sched_disable(uint32_t on);

#endif /* GB_TEST_HOOKS */

#endif /* GB_H */
