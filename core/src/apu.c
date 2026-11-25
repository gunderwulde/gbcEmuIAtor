/*
 * apu.c — APU del CGB (CPU CGB-E). Referencia: docs/gbc-hardware.md §8.
 *
 * Reloj: el "tick" de la APU es de 2 MHz (2 puntos en ambas velocidades). Los generadores
 * de pulso cuentan en ticks (periodo (2048 − f) × 2 por paso), el de onda en ticks
 * ((2048 − f) por muestra) y el contador del ruido también. Las máquinas de estados de los
 * canales (retardos de disparo, alineación común, envolvente en dos fases con el "modo
 * zombi" de NRx2, barrido, contador y LFSR del ruido) siguen el modelo de revisión E de
 * SameBoy (docs §8.5), contrastado con SameSuite.
 *
 * Puesta al día perezosa (AGENTS.md §4.1.8): advance_to() avanza de evento en evento
 * (paso de algún generador, flanco del contador del ruido o fin de "bin") hasta el tick
 * pedido. La salida mezclada es una función escalonada; se integra exactamente en bins de
 * BIN_TICKS ticks. apu_audio(rate) pasa cada bin por el filtro paso alto (el condensador de
 * salida) y promedia los bins en ventanas de 4 194 304 / rate puntos (filtro de caja).
 * Todo el estado, bins pendientes incluidos, está en el struct A (estados guardados).
 */
#include "machine.h"

#define BIN_TICKS 16          /* 32 puntos: 131 072 bins/s, sobra para salidas de 96 kHz */
#define APU_BINS  16384       /* ≈ 7,5 frames sin que nadie llame a apu_audio */
#define LVL_MAX   480         /* |nivel| máximo: 4 canales × 15 × volumen maestro 8 */

/* Gancho de tests: tests/core/apu/harness.c lo define para contar los tramos de run(). */
#ifndef APU_RUN_HOOK
#define APU_RUN_HOOK() ((void)0)
#endif

/* Condensador de salida: carga 0,999958 por punto (Pan Docs, "Audio details", DMG)
 * elevado a 32 puntos (un bin). El valor de CGB es [VERIFICAR M2] (docs §8.4). */
#define HP_CHARGE 0.99865687457663577

typedef struct {
    uint16_t cd;        /* cuenta atrás del generador en ticks (pulso/onda) */
    uint16_t freq;      /* 11 bits (canales 1-3) */
    uint16_t length;    /* contador de longitud (cuenta hacia 0) */
    uint8_t  active;    /* bit de NR52 */
    uint8_t  len_en;
    uint8_t  idx;       /* paso del ciclo de trabajo (0-7) o muestra de onda (0-31) */
    uint8_t  delay;     /* ticks del retardo de disparo que aún no han pasado (pulso) */
    uint8_t  vol;       /* volumen de la envolvente */
    uint8_t  vol_cd;    /* cuenta atrás del periodo de la envolvente */
    uint8_t  samp;      /* salida digital 0-15 (se conserva con el DAC apagado) */
    uint8_t  supp;      /* pulso recién disparado: la salida sigue en 0 hasta el primer paso */
    uint8_t  just_rel;  /* el generador se recargó justo en el último tick */
    uint8_t  did_tick;  /* el generador ha dado algún paso desde el disparo */
    uint8_t  env_clk;   /* fase 2 de la envolvente: el próximo evento la mueve */
    uint8_t  env_lock;  /* envolvente bloqueada (llegó a 0 o a 15) */
    uint8_t  env_should;
    uint8_t  _pad;
} Ch;

static struct {
    uint64_t t;               /* tick de 2 MHz hasta el que se ha generado */
    uint64_t t_on;            /* t al encender la APU (paridad de lf_div, alineación) */
    uint64_t pend_t;          /* tick del paso diferido de la envolvente (doble velocidad) */
    double   hp_l, hp_r;      /* carga del condensador */
    double   rs_l, rs_r, rs_t;/* muestra de salida a medio integrar (rs_t en bins) */
    Ch       ch[4];
    int32_t  acc_l, acc_r;    /* área del bin en curso */
    int32_t  lvl_l, lvl_r;    /* nivel mezclado actual */
    uint32_t bin_pos;         /* ticks ya integrados en el bin en curso */
    uint32_t nbins;           /* bins completos pendientes de apu_audio */
    uint32_t noise_edge;      /* caché de noise_time_to_edge() (ticks); 0 = recalcular */
    uint16_t lfsr;
    uint16_t counter;         /* contador de 14 bits del ruido */
    uint16_t shadow;          /* frecuencia sombra del barrido */
    uint16_t addend;          /* sumando del barrido (frecuencia >> n) */
    uint16_t done_addend;     /* sumando del último cálculo terminado */
    uint8_t  regs[0x30];      /* FF10-FF3F tal cual se escribieron (FF30-3F = RAM de onda) */
    uint8_t  power;
    uint8_t  divider;         /* pasos del secuenciador de frame desde el encendido */
    uint8_t  skip_div;        /* 1 = saltar el próximo evento, 2 = recién saltado */
    uint8_t  sec_pending;     /* falta el flanco de subida de DIV (fase 1 de la envolvente) */
    uint8_t  pend_env;
    uint8_t  sweep_cd;        /* periodo del barrido, cuenta hacia 7 */
    uint8_t  calc_cd;         /* ciclos de 1 MHz hasta terminar el cálculo del barrido */
    uint8_t  reload_timer;
    uint8_t  instant_done;
    uint8_t  unshifted;
    uint8_t  restart_hold;    /* ticks tras el disparo en que el barrido no toma la frecuencia */
    uint8_t  wave_byte;       /* último byte leído de la RAM de onda por el canal 3 */
    uint8_t  noise_cd;       /* ticks hasta el próximo paso del contador del ruido */
    uint8_t  noise_cnt;       /* el contador del ruido corre (canal disparado con DAC) */
    uint8_t  noise_bg;        /* el contador sigue en segundo plano */
    uint8_t  noise_dac_off_start;
    uint8_t  did_step;
    uint8_t  cd_reloaded;
    uint8_t  lfsr_b7;
    uint8_t  stepped_narrow;
    uint8_t  noise_bit;
    uint8_t  dirty;
    uint8_t  any_dac;
    uint8_t  cur_dac;         /* algún DAC encendido durante el bin en curso */
    int16_t  bins[APU_BINS][2];
    uint8_t  bin_dac[APU_BINS];
} A;

static float out_buf[GB_AUDIO_MAX_FRAMES * 2];

/* Bits no usados o de sólo escritura se leen a 1 (Pan Docs, "Audio Registers";
 * Blargg cgb_sound 01-registers). Índice = dirección − FF10. FF26 se trata aparte. */
static const uint8_t read_mask[0x20] = {
    0x80, 0x3F, 0x00, 0xFF, 0xBF,   /* NR10-NR14 */
    0xFF, 0x3F, 0x00, 0xFF, 0xBF,   /* FF15, NR21-NR24 */
    0x7F, 0xFF, 0x9F, 0xFF, 0xBF,   /* NR30-NR34 */
    0xFF, 0xFF, 0x00, 0x00, 0xBF,   /* FF1F, NR41-NR44 */
    0x00, 0x00, 0x70,               /* NR50, NR51, NR52 */
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF  /* FF27-FF2F */
};

/* Ciclos de trabajo 12,5 %, 25 %, 50 %, 75 % (Pan Docs, NRx1); bit 7 = paso 0. */
static const uint8_t duty_tab[4] = { 0x01, 0x81, 0x87, 0x7E };

enum { R_NR10 = 0x00, R_NR11, R_NR12, R_NR13, R_NR14,
       R_NR21 = 0x06, R_NR22, R_NR23, R_NR24,
       R_NR30 = 0x0A, R_NR31, R_NR32, R_NR33, R_NR34,
       R_NR41 = 0x10, R_NR42, R_NR43, R_NR44,
       R_NR50 = 0x14, R_NR51, R_NR52, R_WAVE = 0x20 };

static const uint8_t nrx2_reg[4] = { R_NR12, R_NR22, R_NR30, R_NR42 };

/* ---- Salidas ---- */

static inline int dac_on(int i)
{
    return i == 2 ? (A.regs[R_NR30] >> 7) : (A.regs[nrx2_reg[i]] & 0xF8) != 0;
}

/* lf_div: fase del reloj de 1 MHz respecto al de 2 MHz. Empieza a 1 al encender la APU y
 * cambia con cada tick; en velocidad normal la CPU sólo la ve a 1 (los ticks van de 2 en 2). */
static inline uint8_t lf_div(void) { return (uint8_t)(1 ^ ((A.t - A.t_on) & 1)); }

/* Con el DAC apagado la salida conserva el último nivel (no se actualiza). */
static inline void set_samp(int i, uint8_t v)
{
    if (dac_on(i)) A.ch[i].samp = v;
    A.dirty = 1;
}

static inline void deactivate(int i)
{
    A.ch[i].active = 0;
    set_samp(i, 0);
}

static void square_samp(int i)
{
    const Ch *c = &A.ch[i];
    if (c->supp) return;
    uint8_t duty = A.regs[i ? R_NR21 : R_NR11] >> 6;
    set_samp(i, (duty_tab[duty] >> (7 - c->idx) & 1) ? c->vol : 0);
}

static void wave_samp(void)
{
    /* NR32 bits 5-6: 0 = mudo, 1 = 100 %, 2 = 50 %, 3 = 25 %. Nibble alto primero. */
    static const uint8_t shift[4] = { 4, 0, 1, 2 };
    uint8_t s = (A.ch[2].idx & 1) ? (A.wave_byte & 15) : (A.wave_byte >> 4);
    set_samp(2, (uint8_t)(s >> shift[(A.regs[R_NR32] >> 5) & 3]));
}

/* Un DAC encendido con salida 0 da su nivel mínimo (−15 aquí): ese escalón de continua lo
 * quita el paso alto, como en el hardware. */
static void mix(void)
{
    uint8_t nr51 = A.regs[R_NR51], nr50 = A.regs[R_NR50];
    int32_t l = 0, r = 0;
    A.any_dac = 0;
    for (int i = 0; i < 4; i++) {
        if (!dac_on(i)) continue;
        int32_t a = 2 * (int32_t)A.ch[i].samp - 15;
        A.any_dac = 1;
        if (nr51 & (0x10 << i)) l += a;
        if (nr51 & (0x01 << i)) r += a;
    }
    A.lvl_l = l * (((nr50 >> 4) & 7) + 1);
    A.lvl_r = r * ((nr50 & 7) + 1);
    if (A.any_dac) A.cur_dac = 1;
    A.dirty = 0;
}

static inline void push_bin(void)
{
    if (A.nbins == APU_BINS) A.nbins = 0;   /* nadie consume: se descarta lo viejo */
    A.bins[A.nbins][0] = (int16_t)A.acc_l;
    A.bins[A.nbins][1] = (int16_t)A.acc_r;
    A.bin_dac[A.nbins] = A.cur_dac;
    A.nbins++;
    A.acc_l = A.acc_r = 0;
    A.bin_pos = 0;
    A.cur_dac = A.any_dac;
}

/* ---- Ruido ---- */

static void noise_samp(void)
{
    A.noise_bit = A.lfsr & 1;
    if (A.ch[3].active) set_samp(3, A.noise_bit ? A.ch[3].vol : 0);
}

/* LFSR invertido (empieza en 0): el bit nuevo es NOT(b0 XOR b1); con NR43.3 también va al
 * bit 6 (7 bits). Salida = bit 0. */
static void lfsr_shift(int bit)
{
    uint16_t m = (A.regs[R_NR43] & 8) ? 0x4040 : 0x4000;
    A.lfsr_b7 = (A.lfsr & 0x80) != 0;
    A.lfsr >>= 1;
    if (bit) A.lfsr |= m; else A.lfsr &= (uint16_t)~m;
    noise_samp();
    A.stepped_narrow = (A.regs[R_NR43] & 8) != 0;
}

static inline void step_lfsr(void) { lfsr_shift((A.lfsr ^ (A.lfsr >> 1) ^ 1) & 1); }

static inline uint32_t noise_div(void)
{
    uint32_t d = (A.regs[R_NR43] & 7u) << 2;
    return d ? d : 2;
}

/* Ticks hasta el próximo flanco de subida del bit (NR43 >> 4) del contador, que es lo que
 * mueve el LFSR. Con s ≥ 14 el bit no existe y el LFSR no avanza (Pan Docs, NR43). */
static uint32_t noise_time_to_edge(void)
{
    uint32_t s = A.regs[R_NR43] >> 4;
    if (s >= 14) return 0xFFFFFFFFu;
    uint32_t d = noise_div();
    uint32_t cd = A.noise_cd ? A.noise_cd : d;
    uint32_t m = 1u << s;
    uint32_t steps = ((m - A.counter - 1u) & (2 * m - 1)) + 1;
    return cd + (steps - 1) * d;
}

/* Avanza el contador dt ticks. Con el canal activo, dt nunca pasa del próximo flanco. */
static void noise_advance(uint32_t dt)
{
    uint32_t d = noise_div();
    if (!A.noise_cd) A.noise_cd = (uint8_t)d;
    if (dt < A.noise_cd) { A.noise_cd = (uint8_t)(A.noise_cd - dt); A.cd_reloaded = 0; return; }
    /* dt ≤ BIN_TICKS: casi siempre cabe un solo paso (o dos); la división es el resto. */
    uint32_t r = dt - A.noise_cd, k = 1;
    if (r >= d) {
        r -= d; k = 2;
        if (r >= d) { k += r / d; r %= d; }
    }
    A.counter = (uint16_t)((A.counter + k) & 0x3FFF);
    A.did_step = 1;
    uint32_t s = A.regs[R_NR43] >> 4;
    if (A.ch[3].active && r == 0 && s < 14) {
        uint32_t m = 1u << s;
        if ((A.counter & (2 * m - 1)) == m) step_lfsr();
    }
    if (r == 0) { A.noise_cd = (uint8_t)d; A.cd_reloaded = 1; }
    else { A.noise_cd = (uint8_t)(d - r); A.cd_reloaded = 0; }
}

/* ---- Barrido ---- */

/* El barrido comprueba el desbordamiento tras sumar el delta dos veces (SameBoy). */
static void sweep_done(void)
{
    uint8_t nr10 = A.regs[R_NR10];
    if (A.restart_hold == 0) A.shadow = A.ch[0].freq;
    if (nr10 & 8) A.addend ^= 0x7FF;
    if (A.shadow + A.addend > 0x7FF && !(nr10 & 8)) deactivate(0);
    A.done_addend = A.addend;
}

static void trigger_sweep_calc(void)
{
    uint8_t nr10 = A.regs[R_NR10];
    if (!((nr10 & 0x70) && A.sweep_cd == 7)) return;
    if (nr10 & 7)
        A.ch[0].freq = (uint16_t)((A.addend + A.shadow + ((nr10 & 8) ? 1 : 0)) & 0x7FF);
    if (A.restart_hold == 0) A.addend = (uint16_t)(A.ch[0].freq >> (nr10 & 7));
    /* El recálculo y la comprobación de desbordamiento llegan con retardo. */
    A.calc_cd = nr10 & 7;
    A.reload_timer = (uint8_t)(1 + lf_div());
    A.unshifted = !(nr10 & 7);
    A.sweep_cd = ((nr10 >> 4) & 7) ^ 7;
    if (A.calc_cd == 0) A.instant_done = 1;
}

/* Parte del barrido que corre a 1 MHz; lfd = lf_div al final del tramo. */
static void sweep_run(uint32_t n, uint8_t lfd)
{
    uint32_t sc = n / 2;
    if ((n & 1) && !lfd) sc++;
    if (A.reload_timer > sc) {
        A.reload_timer = (uint8_t)(A.reload_timer - sc);
        sc = 0;
    } else {
        if (A.reload_timer && !A.calc_cd && A.instant_done) sweep_done();
        A.instant_done = 0;
        sc -= A.reload_timer;
        A.reload_timer = 0;
    }
    /* El cálculo se para si NR10 bits 0-2 = 0. */
    if (A.calc_cd && ((A.regs[R_NR10] & 7) || A.unshifted)) {
        if (A.calc_cd > sc) A.calc_cd = (uint8_t)(A.calc_cd - sc);
        else { A.calc_cd = 0; sweep_done(); }
    }
    if (A.restart_hold) A.restart_hold = A.restart_hold > n ? (uint8_t)(A.restart_hold - n) : 0;
}

/* El barrido tiene algo que puede cambiar con el tiempo. Un cálculo pendiente con NR10
 * bits 0-2 = 0 (y no iniciado sin desplazamiento) está congelado: sweep_run no lo toca, así
 * que no obliga a avanzar de ciclo M en ciclo M (si no, ~17 000 tramos por frame hasta
 * que se reescriba NR10 o se apague la APU). */
static inline int sweep_busy(void)
{
    return A.reload_timer | A.restart_hold |
           (A.calc_cd && ((A.regs[R_NR10] & 7) || A.unshifted));
}

/* ---- Generadores ---- */

static void run(uint32_t n)
{
    APU_RUN_HOOK();
    if (sweep_busy())
        sweep_run(n, (uint8_t)(1 ^ ((A.t + n - A.t_on) & 1)));
    else
        A.instant_done = 0;

    Ch *c = A.ch;
    while (n) {
        uint32_t dt = BIN_TICKS - A.bin_pos;
        if (dt > n) dt = n;
        if (c[0].active && c[0].cd + 1u < dt) dt = c[0].cd + 1u;
        if (c[1].active && c[1].cd + 1u < dt) dt = c[1].cd + 1u;
        if (c[2].active && c[2].cd + 1u < dt) dt = c[2].cd + 1u;
        int noise = A.noise_cnt | A.noise_bg;
        if (noise && c[3].active) {
            if (!A.noise_edge) A.noise_edge = noise_time_to_edge();
            if (A.noise_edge < dt) dt = A.noise_edge;
        }

        A.acc_l += A.lvl_l * (int32_t)dt;
        A.acc_r += A.lvl_r * (int32_t)dt;

        /* Pulso: paso cada (2048 − f) × 2 ticks; el retardo de disparo va en la cuenta. */
        for (int i = 0; i < 2; i++) {
            Ch *q = &c[i];
            if (!q->active) continue;
            q->delay = q->delay > dt ? (uint8_t)(q->delay - dt) : 0;
            if (dt == q->cd + 1u) {
                q->cd = (uint16_t)((q->freq ^ 0x7FF) * 2 + 1);
                q->idx = (q->idx + 1) & 7;
                q->supp = 0;
                q->did_tick = 1;
                square_samp(i);
                q->just_rel = 1;
            } else {
                q->cd = (uint16_t)(q->cd - dt);
                q->just_rel = 0;
            }
        }
        /* Onda: (2048 − f) ticks por muestra; avanza y luego lee el byte. */
        if (c[2].active) {
            if (dt == c[2].cd + 1u) {
                c[2].cd = c[2].freq ^ 0x7FF;
                c[2].idx = (c[2].idx + 1) & 31;
                A.wave_byte = A.regs[R_WAVE + (c[2].idx >> 1)];
                wave_samp();
            } else {
                c[2].cd = (uint16_t)(c[2].cd - dt);
            }
        }
        if (noise) {
            noise_advance(dt);
            /* El flanco se mueve sólo con el tiempo mientras nadie escriba NR4x (apu_write
             * invalida la caché); llegado o pasado el flanco, se recalcula. */
            A.noise_edge = A.noise_edge > dt ? A.noise_edge - dt : 0;
        }

        A.t += dt;
        A.bin_pos += dt;
        if (A.bin_pos == BIN_TICKS) push_bin();
        if (A.dirty) mix();
        n -= dt;
    }
}

/* ---- Envolvente ---- */

static void env_clock(Ch *c, int value, int dir, uint8_t vol)
{
    value = value != 0;
    if (c->env_clk == value) return;
    if (value) {
        c->env_clk = 1;
        c->env_should = (vol == 15 && dir) || (vol == 0 && !dir);
    } else {
        c->env_clk = 0;
        c->env_lock |= c->env_should;
    }
}

/* "Modo zombi": escribir NRx2 con el canal activo altera el volumen según cómo están
 * cableados los relojes del contador (SameBoy, CGB-E: una sola transición old → new). */
static void nrx2_glitch(Ch *c, uint8_t v, uint8_t old)
{
    if (c->env_clk) c->vol_cd = v & 7;
    int tick = (v & 7) && !(old & 7) && !c->env_lock;
    int invert = (v & 8) ^ (old & 8);
    if ((v & 0xF) == 8 && (old & 0xF) == 8 && !c->env_lock) tick = 1;
    if (invert) {
        if (v & 8) {
            if (!(old & 7) && !c->env_lock) c->vol ^= 0xF;
            else c->vol = (uint8_t)((0xE - c->vol) & 0xF);
            tick = 0;
        } else {
            c->vol = (uint8_t)((0x10 - c->vol) & 0xF);
        }
    }
    if (tick) c->vol = (uint8_t)((v & 8 ? c->vol + 1 : c->vol - 1) & 0xF);
    else if (!(v & 7) && c->env_clk) env_clock(c, 0, 0, 0);
}

static void env_tick(int i)
{
    Ch *c = &A.ch[i];
    env_clock(c, 0, 0, 0);
    if (c->env_lock) return;
    uint8_t nrx2 = A.regs[nrx2_reg[i]];
    if (!(nrx2 & 7)) return;
    c->vol = (uint8_t)((nrx2 & 8 ? c->vol + 1 : c->vol - 1) & 0xF);
    if (!c->active) return;
    if (i == 3) set_samp(3, A.noise_bit ? c->vol : 0);
    else square_samp(i);
}

static void env_ticks(void)
{
    if (A.ch[0].env_clk) env_tick(0);
    if (A.ch[1].env_clk) env_tick(1);
    if (A.ch[3].env_clk) env_tick(3);
}

/* Flanco de subida del bit de DIV: si la cuenta del periodo llegó a 0, se recarga y se
 * arma el reloj de la envolvente para el próximo flanco de bajada. */
static void secondary_event(void)
{
    if (!A.power) return;
    static const int chs[3] = { 0, 1, 3 };
    for (int k = 0; k < 3; k++) {
        Ch *c = &A.ch[chs[k]];
        uint8_t nrx2 = A.regs[nrx2_reg[chs[k]]];
        if (c->active && c->vol_cd == 0) {
            c->vol_cd = nrx2 & 7;
            env_clock(c, c->vol_cd, nrx2 & 8, c->vol);
        }
    }
}

/* ---- Tiempo ---- */

static inline uint32_t mdots(void) { return gb.double_speed ? 2u : 4u; }

static inline uint64_t ticks_at(uint64_t dots)
{
    return dots >> 1;
}

static void advance_to(uint64_t t)
{
    while (t > A.t) {
        uint64_t d = t - A.t;
        uint32_t n = d > 0x10000u ? 0x10000u : (uint32_t)d;
        /* Mientras el barrido tiene algo en marcha se avanza de ciclo M en ciclo M, como
         * los ve la CPU (sus contadores se evalúan una vez por tramo). */
        if (sweep_busy() && n > (gb.double_speed ? 1u : 2u))
            n = gb.double_speed ? 1u : 2u;
        if (A.pend_env && A.pend_t > A.t && A.pend_t - A.t < n) n = (uint32_t)(A.pend_t - A.t);
        run(n);
        if (A.pend_env && A.t >= A.pend_t) {
            A.pend_env = 0;
            if (A.power) env_ticks();
        }
    }
}

/* Fase 1 de la envolvente en el flanco de subida del bit de DIV. gbc.c sólo avisa del de
 * bajada; el de subida se deduce de gb.div al siguiente acceso. */
static void sec_check(void)
{
    if (!A.sec_pending) return;
    uint16_t bit = gb.double_speed ? 0x2000 : 0x1000;
    if (!(gb.div & bit)) return;
    uint64_t back = (uint64_t)((gb.div & (bit - 1u)) >> 2) * mdots() + mdots();
    advance_to(ticks_at(gb.now > back ? gb.now - back : 0));
    A.sec_pending = 0;
    secondary_event();
}

void apu_catch_up(void)
{
    sec_check();
    advance_to(ticks_at(gb.now));
}

/* ---- Secuenciador de frame ---- */

void apu_div_event(void)
{
    uint32_t md = mdots();
    if (A.sec_pending) {
        /* Nadie miró la APU en todo el semiperiodo: el flanco de subida fue hace medio
         * periodo (o antes, si se escribió DIV). */
        uint64_t half = (uint64_t)((gb.double_speed ? 0x2000u : 0x1000u) >> 2) * md + md;
        advance_to(ticks_at(gb.now > half ? gb.now - half : 0));
        A.sec_pending = 0;
        secondary_event();
    }
    /* El evento se procesa ANTES de sumar los ticks del ciclo M en que DIV cambia: ve la
     * APU un ciclo M por detrás de gb.now (docs §8.5). */
    advance_to(ticks_at(gb.now > md ? gb.now - md : 0));
    A.sec_pending = 1;
    if (!A.power) return;
    if (A.skip_div == 1) { A.skip_div = 2; return; }
    if (A.skip_div == 2) A.skip_div = 0;
    else A.divider++;

    /* Divisor 7: la cuenta del periodo de la envolvente baja en los canales sin reloj. */
    if ((A.divider & 7) == 7) {
        if (!A.ch[0].env_clk) A.ch[0].vol_cd = (A.ch[0].vol_cd - 1) & 7;
        if (!A.ch[1].env_clk) A.ch[1].vol_cd = (A.ch[1].vol_cd - 1) & 7;
        if (!A.ch[3].env_clk) A.ch[3].vol_cd = (A.ch[3].vol_cd - 1) & 7;
    }
    /* En doble velocidad (CGB-D/E) el paso de la envolvente llega un tick más tarde. */
    if (gb.double_speed) { A.pend_env = 1; A.pend_t = A.t + 1; }
    else env_ticks();

    if (A.divider & 1) {   /* longitud, 256 Hz */
        for (int i = 0; i < 4; i++) {
            Ch *c = &A.ch[i];
            if (c->len_en && c->length && --c->length == 0) deactivate(i);
        }
    }
    if ((A.divider & 3) == 3) {   /* barrido, 128 Hz */
        A.sweep_cd = (A.sweep_cd + 1) & 7;
        trigger_sweep_calc();
    }
    if (A.dirty) mix();
}

/* ---- Registros ---- */

/* Habilitar la longitud cuando el divisor es impar (el próximo paso no la cuenta) le da
 * un pulso extra; si así llega a 0 sin disparo, el canal se para, y con disparo queda en
 * máximo − 1 (Blargg cgb_sound 03-trigger, Pan Docs "Obscure behavior"). */
static void length_glitch(int i, uint8_t v, uint16_t max)
{
    Ch *c = &A.ch[i];
    if ((v & 0x40) && !c->len_en && (A.divider & 1) && c->length) {
        if (--c->length == 0) {
            if (v & 0x80) c->length = (uint16_t)(max - 1);
            else deactivate(i);
        }
    }
    c->len_en = (v >> 6) & 1;
}

static void write_square_nrx4(int i, uint8_t v, uint8_t old)
{
    Ch *c = &A.ch[i];
    int was_active = c->active;
    /* Bajar los bits altos de la frecuencia desde 7 justo tras un paso deshace ese paso
     * (SameBoy: el cambio de 0x7xx llega antes de la recarga). */
    if (!(v & 0x80) && c->active && (old & 7) == 7 && (v & 7) != 7) {
        if (c->did_tick && (c->cd >> 1) == (c->freq ^ 0x7FF)) {
            c->idx = (c->idx - 1) & 7;
            c->supp = 0;
        }
    }
    uint16_t old_freq = c->freq;
    c->freq = (uint16_t)((c->freq & 0xFF) | (v & 7) << 8);
    if (c->just_rel) c->cd = (uint16_t)((c->freq ^ 0x7FF) * 2 + 1);
    if (v & 0x80) {
        uint8_t nrx2 = A.regs[nrx2_reg[i]];
        /* El paso del ciclo de trabajo no se reinicia al disparar (sólo al apagar la APU). */
        c->env_lock = 0;
        c->env_clk = 0;
        c->did_tick = 0;
        int force_unsupp = 0;
        if (!c->active) {
            if (!(v & 4) && !((((int)c->cd - (int)c->delay) / 2) & 0x400)) {
                c->idx = (c->idx + 1) & 7;
                force_unsupp = 1;
            }
            /* Retardo de disparo: 6 ticks menos la fase de 1 MHz. */
            c->delay = (uint8_t)(6 - lf_div());
        } else {
            uint8_t extra = 0;
            if (!c->just_rel && !(v & 4) && !((((int)c->cd - 1 - (int)c->delay) / 2) & 0x400)) {
                c->idx = (c->idx + 1) & 7;
                c->supp = 0;
            } else if (c->freq == 0x7FF && old_freq != 0x7FF && c->supp) {
                extra = 2;
            }
            /* Ya activo: el sonido arranca 2 ticks antes. */
            c->delay = (uint8_t)(4 - lf_div() + extra);
        }
        c->cd = (uint16_t)((c->freq ^ 0x7FF) * 2 + c->delay);
        c->vol = nrx2 >> 4;
        if (c->active) square_samp(i);
        c->vol_cd = nrx2 & 7;
        if ((nrx2 & 0xF8) && !c->active) {
            c->active = 1;
            set_samp(i, 0);
            c->supp = !force_unsupp;
        }
        if (c->length == 0) { c->length = 64; c->len_en = 0; }

        if (i == 0) {
            uint8_t nr10 = A.regs[R_NR10];
            A.instant_done = 0;
            A.shadow = 0;
            A.done_addend = 0;
            if (nr10 & 7) {
                /* Con desplazamiento ≠ 0 también se comprueba el desbordamiento al disparar. */
                A.calc_cd = nr10 & 7;
                A.reload_timer = (uint8_t)(2 + !was_active);
                A.unshifted = 0;
                A.addend = (uint16_t)(c->freq >> (nr10 & 7));
            } else {
                A.addend = 0;
            }
            A.restart_hold = (uint8_t)(2 - lf_div() + 2);
            A.sweep_cd = ((nr10 >> 4) & 7) ^ 7;
        }
    }
    length_glitch(i, v, 64);
}

/* Disparo del ruido: alinea el contador con el reloj de 512 kHz (SameBoy, CGB-E). */
static void prepare_noise_start(void)
{
    uint32_t align = (uint32_t)(A.t - A.t_on);
    A.noise_cnt = (A.regs[R_NR42] & 0xF8) != 0;
    int was_dac_off = A.noise_dac_off_start;
    A.noise_dac_off_start = !A.noise_cnt;
    unsigned div = A.regs[R_NR43] & 7;
    int was_bg = A.noise_bg;
    A.noise_bg = 1;
    int instant = 0, div1_glitch = 0;
    int act = A.ch[3].active;

    if (div > 1 && A.noise_cd == 1) {
        A.counter = (A.counter + 1) & 0x3FFF;
    } else if (A.noise_cd == 2 && (align & 3) == 0 && act) {
        if (div == 0) {
            div = 8;
        } else if (div == 1) {
            if (!A.did_step) div1_glitch = 1;
            uint16_t m = (uint16_t)(1u << (A.regs[R_NR43] >> 4));
            int ob = (A.counter & m) != 0;
            A.counter = (A.counter + 1) & 0x3FFF;
            if ((A.counter & m) && !ob) instant = 1;
        }
    }
    uint8_t cd = (uint8_t)(div == 0 ? 6 : div * 4 + 6);
    if (align & 1) {
        if (!div) {
            if (was_bg) cd--; else cd++;
        } else if (align & 2) {
            if (div == 1 && !act) cd++; else cd -= 3;
        } else {
            cd--;
            if (div == 1 && act) cd -= 4;
        }
    } else if (div) {
        if (align & 2) cd -= 2;
        else if (div > 1) cd -= 4;
        else if (act && !(A.regs[R_NR43] & 0xF0)) cd -= 4;
    }
    /* Arranques con el contador en segundo plano. */
    if (div > 1) {
        if (!A.noise_cnt && !(align & 3)) cd += 4;
    } else if (was_bg && !act && !(align & 3)) {
        if (div == 0) { if (was_dac_off) cd += 28; }
        else cd -= 4;
    }
    if (div1_glitch) cd -= 4;
    A.noise_cd = cd;
    A.lfsr = (!div && act && (align & 3) == 3) ? 0x0055 : 0;
    if (instant) step_lfsr();
}

/* Escribir NR43 cambia de golpe el bit del contador que mira el LFSR; la transición pasa
 * por un valor intermedio (old & 7F | new & 80) y puede dar pasos espurios (SameBoy,
 * CGB-E; issue 397). */
static void nr43_write(uint8_t v)
{
    int old_narrow = (A.regs[R_NR43] & 8) != 0;
    uint8_t old = A.regs[R_NR43];
    A.regs[R_NR43] = v;
    if ((old & 0xF0) == (v & 0xF0)) return;

    uint16_t ec = A.counter;
    int ob = (ec >> (old >> 4)) & 1;
    uint8_t gv = (uint8_t)((old & 0x7F) | (v & 0x80));
    int gbit = (ec >> (gv >> 4)) & 1;
    int nb = (ec >> (v >> 4)) & 1;
    int narrow = (v & 8) != 0;

    if (ob == nb && nb != gbit) {
        if (nb) {
            if (!(v & 0x80)) {
                step_lfsr();
            } else {
                uint8_t t1 = (old >> 4) & 7, t2 = (v >> 4) & 7;
                if ((t1 ^ 7) + t2 > 7 || ((t1 ^ 7) & t2)) {
                    A.lfsr = (uint16_t)((A.lfsr & ~0x80u) | ((A.lfsr >> 1) & 0x80));
                    if ((t1 == 0 || t1 == 4) && t2 == 3) {
                        A.lfsr &= (uint16_t)((A.lfsr >> 1) | 0x545);
                        noise_samp();
                    } else if (t1 == 2 && t2 == 3) {
                        uint16_t mask = 0x555;
                        if ((A.lfsr & 0xC) == 0xC) mask |= 8;
                        if ((A.lfsr & 0xC00) == 0xC00) mask |= 0x800;
                        A.lfsr &= (uint16_t)((A.lfsr >> 1) | mask);
                        noise_samp();
                    }
                    if (!narrow && old_narrow && A.stepped_narrow) {
                        if (A.lfsr_b7) A.lfsr |= 0x40; else A.lfsr &= (uint16_t)~0x40u;
                    }
                    A.lfsr |= narrow ? 0x4040 : 0x4000;
                    A.stepped_narrow = (uint8_t)narrow;
                }
            }
        } else {
            static const uint8_t gmap[64] = {
                [002] = 4, [003] = 2, [004] = 2, [005] = 2,
                [012] = 2, [013] = 4, [014] = 2, [015] = 2,
                [020] = 1, [021] = 2, [023] = 1, [024] = 5, [025] = 3,
                [034] = 2, [035] = 2,
                [041] = 2, [042] = 2, [043] = 2,
                [050] = 6, [052] = 2, [053] = 2,
            };
            unsigned g = (v & 0x80) ? gmap[((old & 0x70) >> 1) | ((v & 0x70) >> 4)] : 0;
            switch (g) {
            case 1: case 6:
                step_lfsr();
                if (g == 6) {
                    if ((narrow && (A.lfsr & 0x71) == 0x20) || (A.lfsr & 0x71) == 0x61)
                        A.lfsr &= (uint16_t)~0x20u;
                    if ((A.lfsr & 0x7001) == 0x2000 || (A.lfsr & 0x7001) == 0x6001)
                        A.lfsr &= (uint16_t)~0x2000u;
                }
                if ((A.lfsr & 3) == 2) A.lfsr &= (uint16_t)~2u;
                break;
            case 2: {
                uint16_t prev = A.lfsr;
                step_lfsr();
                A.lfsr &= (uint16_t)(prev | 1);
                break;
            }
            case 5:
                if ((A.lfsr & 3) == 2) A.lfsr &= (uint16_t)(narrow ? ~0x4040u : ~0x4000u);
                if ((A.lfsr & 0x19) == 8) A.lfsr &= (uint16_t)~8u;
                /* fallthrough */
            case 3:
                A.lfsr = (uint16_t)((A.lfsr & ~1u) | ((A.lfsr >> 1) & 1));
                noise_samp();
                A.stepped_narrow = (uint8_t)narrow;
                break;
            case 4: {
                uint16_t prev = A.lfsr;
                step_lfsr();
                A.lfsr &= (uint16_t)(prev | (narrow ? ~0x2022u : ~0x2002u));
                break;
            }
            default:
                step_lfsr();
                break;
            }
        }
    } else if (!ob && nb) {
        step_lfsr();
    }
}

static void power_off(void)
{
    /* CGB: se borran FF10-FF25 y también los contadores de longitud (Blargg cgb_sound
     * 08-len ctr during power). La RAM de onda se conserva. */
    for (int i = 0; i < 4; i++) deactivate(i);
    gb_memset(A.regs, 0, R_WAVE);
    gb_memset(A.ch, 0, sizeof A.ch);
    A.power = 0;
    A.divider = A.skip_div = A.pend_env = 0;
    A.sweep_cd = A.calc_cd = A.reload_timer = A.instant_done = A.unshifted = A.restart_hold = 0;
    A.shadow = A.addend = A.done_addend = 0;
    A.lfsr = A.counter = 0;
    A.wave_byte = 0;
    A.noise_cd = A.noise_cnt = A.noise_bg = A.noise_dac_off_start = 0;
    A.noise_edge = 0;
    A.did_step = A.cd_reloaded = A.lfsr_b7 = A.stepped_narrow = A.noise_bit = 0;
}

static void power_on(void)
{
    A.power = 1;
    A.t_on = A.t;
    /* Encender con el bit de DIV a 1 se salta el primer evento del secuenciador. */
    if (gb.div & (gb.double_speed ? 0x2000 : 0x1000)) { A.skip_div = 1; A.divider = 1; }
    A.ch[0].cd = A.ch[1].cd = 0xFFFF;
}

void apu_write(uint16_t addr, uint8_t v)
{
    if (addr < 0xFF10 || addr > 0xFF3F) return;   /* PCM12/PCM34 son de sólo lectura */
    apu_catch_up();
    uint32_t r = addr - 0xFF10u;
    Ch *c = A.ch;
    if (r >= R_WAVE) {
        /* CGB: con el canal 3 activo, la CPU accede al byte que el canal está leyendo,
         * sin la ventana de acceso del DMG (Pan Docs, "Wave RAM"). */
        if (c[2].active) A.regs[R_WAVE + (c[2].idx >> 1)] = v;
        else A.regs[r] = v;
        return;
    }
    if (r == R_NR52) {
        if (!(v & 0x80)) { if (A.power) power_off(); }
        else if (!A.power) power_on();
        A.regs[R_NR52] = v;
        mix();
        return;
    }
    if (!A.power || r > R_NR52) return;   /* apagada: registros de sólo lectura (CGB) */
    uint8_t old = A.regs[r];
    switch (r) {
    case R_NR50: case R_NR51:
        break;
    case R_NR10: {
        if (A.calc_cd || A.reload_timer) {
            if (A.reload_timer == 2) {
                /* La cuenta se acaba de recargar: se recarga otra vez. */
                A.calc_cd = v & 7;
                if (!A.calc_cd) A.reload_timer = 0;
            }
            if ((v & 7) && !(old & 7) && !lf_div() && A.calc_cd > 1) {
                if (!--A.calc_cd) sweep_done();
            }
        }
        A.regs[R_NR10] = v;
        /* Quitar el modo resta tras haberlo usado desde el disparo apaga el canal. */
        if (A.shadow + A.done_addend + ((old & 8) ? 1 : 0) > 0x7FF && !(v & 8)) deactivate(0);
        trigger_sweep_calc();
        break;
    }
    case R_NR11: c[0].length = 64 - (v & 63); break;
    case R_NR21: c[1].length = 64 - (v & 63); break;
    case R_NR31: c[2].length = 256 - v; break;
    case R_NR41: c[3].length = 64 - (v & 63); break;
    case R_NR12: case R_NR22: {
        int i = r == R_NR22;
        if (!(v & 0xF8)) {
            A.regs[r] = v;
            deactivate(i);
        } else if (c[i].active) {
            nrx2_glitch(&c[i], v, old);
            square_samp(i);
        }
        break;
    }
    case R_NR42:
        if (!(v & 0xF8)) {
            if (c[3].active && (A.regs[R_NR43] & 7)) {
                if (A.noise_cd <= 2) A.counter = (A.counter + 1) & 0x3FFF;
                A.noise_bg = 0;
            }
            A.regs[r] = v;
            deactivate(3);
            A.noise_cnt = 0;
        } else if (c[3].active) {
            nrx2_glitch(&c[3], v, old);
            set_samp(3, A.noise_bit ? c[3].vol : 0);
        }
        break;
    case R_NR13: case R_NR23: {
        Ch *q = &c[r == R_NR23];
        q->freq = (uint16_t)((q->freq & 0x700) | v);
        if (q->just_rel) q->cd = (uint16_t)((q->freq ^ 0x7FF) * 2 + 1);
        break;
    }
    case R_NR14: write_square_nrx4(0, v, old); break;
    case R_NR24: write_square_nrx4(1, v, old); break;
    case R_NR30:
        A.regs[r] = v;
        if (!(v & 0x80)) {
            /* Apagar el DAC justo cuando el canal iba a leer: lee el byte que señala el bus
             * de direcciones (en CGB-E coincide con PC & F). */
            if (c[2].active && c[2].cd == 0) A.wave_byte = A.regs[R_WAVE + (gb.cpu.pc.w & 0xF)];
            deactivate(2);
        }
        break;
    case R_NR32:
        A.regs[r] = v;
        if (c[2].active) wave_samp();
        break;
    case R_NR33:
        c[2].freq = (uint16_t)((c[2].freq & 0x700) | v);
        break;
    case R_NR34:
        c[2].freq = (uint16_t)((c[2].freq & 0xFF) | (v & 7) << 8);
        if (v & 0x80) {
            c[2].idx = 0;
            if (c[2].active && c[2].cd == 0) A.wave_byte = A.regs[R_WAVE];
            if (A.regs[R_NR30] & 0x80) {
                /* La primera salida es el nibble alto del byte que quedó en el búfer: el
                 * disparo no relee la RAM de onda (Pan Docs, NR34; SameSuite). */
                static const uint8_t shift[4] = { 4, 0, 1, 2 };
                c[2].active = 1;
                set_samp(2, (uint8_t)((A.wave_byte >> 4) >> shift[(A.regs[R_NR32] >> 5) & 3]));
            }
            /* Retardo de disparo: 3 ticks antes de la primera cuenta. */
            c[2].cd = (uint16_t)((c[2].freq ^ 0x7FF) + 3);
            if (c[2].length == 0) { c[2].length = 256; c[2].len_en = 0; }
        }
        length_glitch(2, v, 256);
        break;
    case R_NR43:
        if (A.cd_reloaded) {
            static const uint8_t adj[4] = { 2, 1, 0, 3 };
            unsigned d = (v & 7u) << 2;
            if (!d) d = 2;
            A.noise_cd = (uint8_t)(d + (d == 2 ? 0 : adj[(A.t - A.t_on) & 3]));
        }
        nr43_write(v);
        break;
    case R_NR44:
        if (v & 0x80) {
            c[3].env_lock = 0;
            c[3].env_clk = 0;
            A.lfsr = 0;
            prepare_noise_start();
            c[3].vol = A.regs[R_NR42] >> 4;
            A.noise_bit = 0;
            c[3].vol_cd = A.regs[R_NR42] & 7;
            A.did_step = ((A.t - A.t_on) & 3) == 2;
            if (A.regs[R_NR42] & 0xF8) {
                c[3].active = 1;
                set_samp(3, 0);
            }
            if (c[3].length == 0) { c[3].length = 64; c[3].len_en = 0; }
        }
        length_glitch(3, v, 64);
        break;
    default: break;
    }
    A.regs[r] = v;
    A.noise_edge = 0;   /* NR42/43/44 mueven el contador, su fase o el bit que mira el LFSR */
    mix();
}

uint8_t apu_read(uint16_t addr)
{
    apu_catch_up();
    const Ch *c = A.ch;
    /* PCM12/PCM34 (CGB): salida digital actual de cada canal activo, 1 en el nibble bajo. */
    if (addr == 0xFF76)
        return (uint8_t)((c[0].active ? c[0].samp : 0) | (c[1].active ? c[1].samp : 0) << 4);
    if (addr == 0xFF77)
        return (uint8_t)((c[2].active ? c[2].samp : 0) | (c[3].active ? c[3].samp : 0) << 4);
    if (addr < 0xFF10 || addr > 0xFF3F) return 0xFF;
    uint32_t r = addr - 0xFF10u;
    if (r >= R_WAVE) return c[2].active ? A.regs[R_WAVE + (c[2].idx >> 1)] : A.regs[r];
    if (r == R_NR52)
        return (uint8_t)(0x70 | A.power << 7 | c[0].active | c[1].active << 1 |
                         c[2].active << 2 | c[3].active << 3);
    return A.regs[r] | read_mask[r];
}

void apu_reset(int boot)
{
    gb_memset(&A, 0, sizeof A);
    A.t = A.t_on = ticks_at(gb.now);
    A.sec_pending = 1;
    /* RAM de onda al encender en CGB: 00 FF 00 FF… (Pan Docs, "Wave RAM"). */
    for (int i = 0; i < 16; i++) A.regs[R_WAVE + i] = (i & 1) ? 0xFF : 0x00;
    A.ch[0].cd = A.ch[1].cd = 0xFFFF;
    if (!boot) {
        /* Estado que deja la boot ROM del CGB (Pan Docs, "Power Up Sequence"): NR52 = F1,
         * NR50 = 77, NR51 = F3, canal 1 con DAC encendido y la envolvente ya en 0.
         * La fase del secuenciador y del generador es [VERIFICAR] (docs §8.5). */
        A.power = 1;
        A.regs[R_NR11] = 0x80;
        A.regs[R_NR12] = 0xF3;
        A.regs[R_NR50] = 0x77;
        A.regs[R_NR51] = 0xF3;
        A.regs[R_NR52] = 0xF1;
        A.ch[0].active = 1;
        A.ch[0].cd = 0x7FF * 2 + 1;
        A.ch[0].length = 64;
    }
    mix();
    A.cur_dac = A.any_dac;
}

/* ---- Salida ---- */

static inline float clampf(double x)
{
    return (float)(x > 1.0 ? 1.0 : x < -1.0 ? -1.0 : x);
}

uint32_t apu_audio(uint32_t rate)
{
    uint32_t n = A.nbins;
    A.nbins = 0;
    if (rate == 0) return 0;
    const double spb = (double)(GB_DOT_HZ / (2 * BIN_TICKS)) / (double)rate;   /* bins por muestra */
    const double norm = 1.0 / (BIN_TICKS * LVL_MAX);
    uint32_t k = 0;
    for (uint32_t i = 0; i < n; i++) {
        double l = 0.0, r = 0.0;
        if (A.bin_dac[i]) {
            /* Condensador de salida: sólo carga con algún DAC encendido (Pan Docs). */
            double il = A.bins[i][0] * norm, ir = A.bins[i][1] * norm;
            l = il - A.hp_l; A.hp_l = il - l * HP_CHARGE;
            r = ir - A.hp_r; A.hp_r = ir - r * HP_CHARGE;
        }
        double rem = 1.0;
        for (;;) {
            double need = spb - A.rs_t;
            if (need > rem) {
                A.rs_l += l * rem; A.rs_r += r * rem; A.rs_t += rem;
                break;
            }
            A.rs_l += l * need; A.rs_r += r * need;
            rem -= need;
            if (k < GB_AUDIO_MAX_FRAMES) {
                out_buf[2 * k] = clampf(A.rs_l / spb);
                out_buf[2 * k + 1] = clampf(A.rs_r / spb);
                k++;
            }
            A.rs_l = A.rs_r = A.rs_t = 0.0;
        }
    }
    return k;
}

float *apu_audio_buffer(void) { return out_buf; }
void *apu_state(uint32_t *len) { *len = sizeof A; return &A; }
