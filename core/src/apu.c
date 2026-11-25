/*
 * apu.c — APU del CGB (M2). Referencia: docs/gbc-hardware.md §8.
 *
 * Reloj: el punto (4 194 304 Hz); la doble velocidad sólo cambia qué bit de DIV mueve el
 * secuenciador de frame, y eso lo decide gbc.c al llamar a apu_div_event().
 *
 * Puesta al día perezosa (AGENTS.md §4.1.8): apu_catch_up() avanza de evento en evento
 * (paso de algún generador o fin de "bin") hasta gb.now. La salida mezclada es una función
 * escalonada; se integra exactamente en bins de BIN_DOTS puntos (área = nivel × puntos,
 * entera). apu_audio(rate) pasa cada bin por el filtro paso alto (el condensador de salida)
 * y promedia los bins en ventanas de 4 194 304 / rate puntos (filtro de caja).
 * Todo el estado, bins pendientes incluidos, está en el struct A (estados guardados).
 */
#include "machine.h"

#define BIN_DOTS  32          /* 131 072 bins/s: sobra para salidas de hasta 96 kHz */
#define APU_BINS  16384       /* ≈ 7,5 frames sin que nadie llame a apu_audio */
#define LVL_MAX   480         /* |nivel| máximo: 4 canales × 15 × volumen maestro 8 */

/* Condensador de salida: carga 0,999958 por punto (Pan Docs, "Audio details", DMG)
 * elevado a BIN_DOTS. El valor de CGB es [VERIFICAR M2] (docs §8.4). */
#define HP_CHARGE 0.99865687457663577

typedef struct {
    uint32_t timer;     /* puntos hasta el siguiente paso del generador; 0 = parado */
    uint16_t freq;      /* 11 bits (canales 1-3) */
    uint16_t len;       /* contador de longitud (cuenta hacia 0) */
    uint8_t  on;        /* bit de NR52 */
    uint8_t  dac;
    uint8_t  len_en;
    uint8_t  vol;       /* volumen actual de la envolvente */
    uint8_t  env_timer;
    uint8_t  pos;       /* paso del ciclo de trabajo (0-7) o muestra de onda (0-31) */
    uint8_t  out;       /* salida digital actual 0-15 (PCM12/PCM34) */
    uint8_t  _pad;
} Ch;

static struct {
    uint64_t last;            /* gb.now hasta el que se ha generado */
    double   hp_l, hp_r;      /* carga del condensador */
    double   rs_l, rs_r, rs_t;/* muestra de salida a medio integrar (rs_t en bins) */
    Ch       ch[4];
    int32_t  acc_l, acc_r;    /* área del bin en curso */
    int32_t  lvl_l, lvl_r;    /* nivel mezclado actual */
    uint32_t bin_pos;         /* puntos ya integrados en el bin en curso */
    uint32_t nbins;           /* bins completos pendientes de apu_audio */
    uint16_t lfsr;
    uint16_t shadow;          /* frecuencia sombra del barrido */
    uint8_t  regs[0x30];      /* FF10-FF3F tal cual se escribieron (FF30-3F = RAM de onda) */
    uint8_t  power;
    uint8_t  seq;             /* PRÓXIMO paso del secuenciador de frame (0-7) */
    uint8_t  sweep_timer;
    uint8_t  sweep_en;
    uint8_t  sweep_neg;       /* se calculó en modo resta desde el último disparo */
    uint8_t  wave_buf;        /* último byte leído de la RAM de onda por el canal 3 */
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

/* Ciclos de trabajo 12,5 %, 25 %, 50 %, 75 % (Pan Docs, NRx1). */
static const uint8_t duty_tab[4] = { 0x01, 0x81, 0x87, 0x7E };

enum { R_NR10 = 0x00, R_NR11, R_NR12, R_NR13, R_NR14,
       R_NR21 = 0x06, R_NR22, R_NR23, R_NR24,
       R_NR30 = 0x0A, R_NR31, R_NR32, R_NR33, R_NR34,
       R_NR41 = 0x10, R_NR42, R_NR43, R_NR44,
       R_NR50 = 0x14, R_NR51, R_NR52, R_WAVE = 0x20 };

static inline uint32_t noise_period(void)
{
    /* 262 144 / (r × 2^s) Hz con r = 0 → 0,5: en puntos, (r ? 16r : 8) << s. s ≥ 14 no
     * avanza el LFSR (Pan Docs, NR43). */
    uint8_t nr43 = A.regs[R_NR43];
    uint32_t s = nr43 >> 4, r = nr43 & 7;
    if (s >= 14) return 0;
    return (r ? r * 16 : 8) << s;
}

static inline uint8_t square_out(const Ch *c, uint8_t nrx1)
{
    return (duty_tab[nrx1 >> 6] >> (7 - c->pos) & 1) ? c->vol : 0;
}

static inline uint8_t wave_out(void)
{
    /* NR32 bits 5-6: 0 = mudo, 1 = 100 %, 2 = 50 %, 3 = 25 %. Nibble alto primero. */
    static const uint8_t shift[4] = { 4, 0, 1, 2 };
    uint8_t s = (A.ch[2].pos & 1) ? (A.wave_buf & 15) : (A.wave_buf >> 4);
    return (uint8_t)(s >> shift[(A.regs[R_NR32] >> 5) & 3]);
}

/* Salidas digitales y nivel mezclado. Un DAC encendido con el canal parado da su nivel de
 * 0 (−15 aquí): ese escalón de continua lo quita el paso alto, como en el hardware. */
static void mix(void)
{
    Ch *c = A.ch;
    c[0].out = c[0].on ? square_out(&c[0], A.regs[R_NR11]) : 0;
    c[1].out = c[1].on ? square_out(&c[1], A.regs[R_NR21]) : 0;
    c[2].out = c[2].on ? wave_out() : 0;
    c[3].out = (c[3].on && !(A.lfsr & 1)) ? c[3].vol : 0;
    uint8_t nr51 = A.regs[R_NR51], nr50 = A.regs[R_NR50];
    int32_t l = 0, r = 0;
    A.any_dac = 0;
    for (int i = 0; i < 4; i++) {
        if (!c[i].dac) continue;
        int32_t a = 2 * (int32_t)c[i].out - 15;
        A.any_dac = 1;
        if (nr51 & (0x10 << i)) l += a;
        if (nr51 & (0x01 << i)) r += a;
    }
    A.lvl_l = l * (((nr50 >> 4) & 7) + 1);
    A.lvl_r = r * ((nr50 & 7) + 1);
    if (A.any_dac) A.cur_dac = 1;
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

static void run(uint32_t n)
{
    Ch *c = A.ch;
    while (n) {
        uint32_t dt = BIN_DOTS - A.bin_pos;
        if (dt > n) dt = n;
        for (int i = 0; i < 4; i++)
            if (c[i].on && c[i].timer && c[i].timer < dt) dt = c[i].timer;

        A.acc_l += A.lvl_l * (int32_t)dt;
        A.acc_r += A.lvl_r * (int32_t)dt;

        int changed = 0;
        /* Pulso: el temporizador cuenta (2048 − f) ciclos de 1 MHz; 8 pasos por periodo. */
        if (c[0].on && c[0].timer && !(c[0].timer -= dt)) {
            c[0].timer = (2048u - c[0].freq) * 4;
            c[0].pos = (c[0].pos + 1) & 7;
            changed = 1;
        }
        if (c[1].on && c[1].timer && !(c[1].timer -= dt)) {
            c[1].timer = (2048u - c[1].freq) * 4;
            c[1].pos = (c[1].pos + 1) & 7;
            changed = 1;
        }
        /* Onda: (2048 − f) ciclos de 2 MHz por muestra; avanza y luego lee el byte. */
        if (c[2].on && c[2].timer && !(c[2].timer -= dt)) {
            c[2].timer = (2048u - c[2].freq) * 2;
            c[2].pos = (c[2].pos + 1) & 31;
            A.wave_buf = A.regs[R_WAVE + (c[2].pos >> 1)];
            changed = 1;
        }
        /* Ruido: LFSR de 15 bits; con NR43.3 el bit nuevo también va al bit 6 (7 bits). */
        if (c[3].on && c[3].timer && !(c[3].timer -= dt)) {
            uint16_t x = (A.lfsr ^ (A.lfsr >> 1)) & 1;
            A.lfsr = (uint16_t)((A.lfsr >> 1) | (x << 14));
            if (A.regs[R_NR43] & 8) A.lfsr = (uint16_t)((A.lfsr & ~0x40u) | (x << 6));
            c[3].timer = noise_period();
            changed = 1;
        }

        A.bin_pos += dt;
        if (A.bin_pos == BIN_DOTS) push_bin();
        if (changed) mix();
        n -= dt;
    }
}

void apu_catch_up(void)
{
    while (gb.now > A.last) {
        uint64_t d = gb.now - A.last;
        uint32_t n = d > 0x40000000u ? 0x40000000u : (uint32_t)d;
        A.last += n;
        run(n);
    }
}

/* ---- Secuenciador de frame ---- */

static uint16_t sweep_calc(void)
{
    uint8_t nr10 = A.regs[R_NR10];
    uint16_t d = A.shadow >> (nr10 & 7);
    uint16_t f;
    if (nr10 & 8) { f = (uint16_t)(A.shadow - d); A.sweep_neg = 1; }
    else f = (uint16_t)(A.shadow + d);
    if (f > 2047) A.ch[0].on = 0;
    return f;
}

static void clock_length(void)
{
    for (int i = 0; i < 4; i++) {
        Ch *c = &A.ch[i];
        if (c->len_en && c->len && --c->len == 0) c->on = 0;
    }
}

static void clock_envelope(Ch *c, uint8_t nrx2)
{
    uint8_t per = nrx2 & 7;
    if (!per) return;
    if (c->env_timer) c->env_timer--;
    if (c->env_timer) return;
    c->env_timer = per;
    if (nrx2 & 8) { if (c->vol < 15) c->vol++; }
    else if (c->vol) c->vol--;
}

static void clock_sweep(void)
{
    if (A.sweep_timer) A.sweep_timer--;
    if (A.sweep_timer) return;
    uint8_t nr10 = A.regs[R_NR10];
    uint8_t per = (nr10 >> 4) & 7;
    A.sweep_timer = per ? per : 8;
    if (!A.sweep_en || !per || !A.ch[0].on) return;
    uint16_t f = sweep_calc();
    if (f <= 2047 && (nr10 & 7)) {
        A.shadow = f;
        A.ch[0].freq = f;
        A.regs[R_NR13] = (uint8_t)f;
        A.regs[R_NR14] = (uint8_t)((A.regs[R_NR14] & ~7u) | (f >> 8));
        (void)sweep_calc();
    }
}

void apu_div_event(void)
{
    apu_catch_up();
    if (!A.power) return;
    /* Pasos 0,2,4,6: longitud (256 Hz); 2,6: barrido (128 Hz); 7: envolvente (64 Hz). */
    uint8_t s = A.seq;
    A.seq = (s + 1) & 7;
    if (!(s & 1)) clock_length();
    if (s == 2 || s == 6) clock_sweep();
    if (s == 7) {
        clock_envelope(&A.ch[0], A.regs[R_NR12]);
        clock_envelope(&A.ch[1], A.regs[R_NR22]);
        clock_envelope(&A.ch[3], A.regs[R_NR42]);
    }
    mix();
}

/* ---- Registros ---- */

/* Escritura en NRx4: habilitar la longitud en la mitad del periodo en que el próximo paso
 * no la cuenta (A.seq impar) le da un pulso extra; el disparo carga la longitud máxima si
 * estaba a 0 (Blargg cgb_sound 03-trigger, Pan Docs "Obscure behavior"). */
static void write_nrx4(int i, uint8_t v, uint16_t max)
{
    Ch *c = &A.ch[i];
    int extra = A.seq & 1;
    uint8_t old_en = c->len_en;
    c->len_en = (v >> 6) & 1;
    if (extra && !old_en && c->len_en && c->len && --c->len == 0 && !(v & 0x80)) c->on = 0;
    if (!(v & 0x80)) return;

    c->on = 1;
    if (c->len == 0) {
        c->len = max;
        if (c->len_en && extra) c->len--;
    }
    switch (i) {
    case 0: case 1: {
        uint8_t nrx2 = A.regs[i ? R_NR22 : R_NR12];
        c->timer = (2048u - c->freq) * 4;
        c->vol = nrx2 >> 4;
        c->env_timer = nrx2 & 7;
        break;
    }
    case 2:
        c->timer = (2048u - c->freq) * 2;
        c->pos = 0;          /* la primera muestra nueva será la 1 (Pan Docs, NR34) */
        break;
    default:
        c->timer = noise_period();
        c->vol = A.regs[R_NR42] >> 4;
        c->env_timer = A.regs[R_NR42] & 7;
        A.lfsr = 0x7FFF;
        break;
    }
    if (i == 0) {
        uint8_t nr10 = A.regs[R_NR10];
        uint8_t per = (nr10 >> 4) & 7;
        A.shadow = c->freq;
        A.sweep_timer = per ? per : 8;
        A.sweep_en = (per || (nr10 & 7)) ? 1 : 0;
        A.sweep_neg = 0;
        if (nr10 & 7) (void)sweep_calc();
    }
    if (!c->dac) c->on = 0;
}

static void power_off(void)
{
    /* CGB: se borran FF10-FF25 y también los contadores de longitud (Blargg cgb_sound
     * 08-len ctr during power). La RAM de onda se conserva. */
    gb_memset(A.regs, 0, R_WAVE);
    gb_memset(A.ch, 0, sizeof A.ch);
    A.power = 0;
    A.sweep_timer = A.sweep_en = A.sweep_neg = 0;
    A.shadow = 0;
    A.lfsr = 0;
    A.wave_buf = 0;
}

void apu_write(uint16_t addr, uint8_t v)
{
    if (addr < 0xFF10 || addr > 0xFF3F) return;   /* PCM12/PCM34 son de sólo lectura */
    apu_catch_up();
    uint32_t r = addr - 0xFF10u;
    if (r >= R_WAVE) {
        /* CGB: con el canal 3 activo, la CPU accede al byte que el canal está leyendo,
         * sin la ventana de acceso del DMG (Pan Docs, "Wave RAM"). */
        if (A.ch[2].on) A.regs[R_WAVE + (A.ch[2].pos >> 1)] = v;
        else A.regs[r] = v;
        return;
    }
    if (r == R_NR52) {
        if (!(v & 0x80)) { if (A.power) power_off(); }
        else if (!A.power) { A.power = 1; A.seq = 0; }   /* el próximo paso será el 0 */
        mix();
        return;
    }
    if (!A.power || r > R_NR52) return;   /* apagada: registros de sólo lectura (CGB) */
    A.regs[r] = v;
    Ch *c = A.ch;
    switch (r) {
    case R_NR10:
        /* Quitar el modo resta tras haberlo usado desde el disparo apaga el canal. */
        if (A.sweep_neg && !(v & 8)) c[0].on = 0;
        break;
    case R_NR11: c[0].len = 64 - (v & 63); break;
    case R_NR21: c[1].len = 64 - (v & 63); break;
    case R_NR31: c[2].len = 256 - v; break;
    case R_NR41: c[3].len = 64 - (v & 63); break;
    case R_NR12: c[0].dac = (v & 0xF8) != 0; if (!c[0].dac) c[0].on = 0; break;
    case R_NR22: c[1].dac = (v & 0xF8) != 0; if (!c[1].dac) c[1].on = 0; break;
    case R_NR42: c[3].dac = (v & 0xF8) != 0; if (!c[3].dac) c[3].on = 0; break;
    case R_NR30: c[2].dac = v >> 7; if (!c[2].dac) c[2].on = 0; break;
    case R_NR13: c[0].freq = (uint16_t)((c[0].freq & 0x700) | v); break;
    case R_NR23: c[1].freq = (uint16_t)((c[1].freq & 0x700) | v); break;
    case R_NR33: c[2].freq = (uint16_t)((c[2].freq & 0x700) | v); break;
    case R_NR14: c[0].freq = (uint16_t)((c[0].freq & 0xFF) | (v & 7) << 8); write_nrx4(0, v, 64); break;
    case R_NR24: c[1].freq = (uint16_t)((c[1].freq & 0xFF) | (v & 7) << 8); write_nrx4(1, v, 64); break;
    case R_NR34: c[2].freq = (uint16_t)((c[2].freq & 0xFF) | (v & 7) << 8); write_nrx4(2, v, 256); break;
    case R_NR44: write_nrx4(3, v, 64); break;
    case R_NR43:
        /* Un LFSR parado (s ≥ 14) vuelve a andar en cuanto el periodo es válido. */
        if (!c[3].timer) c[3].timer = noise_period();
        break;
    default: break;   /* NR32, NR50, NR51: sólo el valor */
    }
    mix();
}

uint8_t apu_read(uint16_t addr)
{
    apu_catch_up();
    const Ch *c = A.ch;
    /* PCM12/PCM34 (CGB): salida digital actual de cada canal, 1 en el nibble bajo. */
    if (addr == 0xFF76) return (uint8_t)(c[0].out | c[1].out << 4);
    if (addr == 0xFF77) return (uint8_t)(c[2].out | c[3].out << 4);
    if (addr < 0xFF10 || addr > 0xFF3F) return 0xFF;
    uint32_t r = addr - 0xFF10u;
    if (r >= R_WAVE) return c[2].on ? A.regs[R_WAVE + (c[2].pos >> 1)] : A.regs[r];
    if (r == R_NR52)
        return (uint8_t)(0x70 | A.power << 7 | c[0].on | c[1].on << 1 | c[2].on << 2 | c[3].on << 3);
    return A.regs[r] | read_mask[r];
}

void apu_reset(int boot)
{
    gb_memset(&A, 0, sizeof A);
    A.last = gb.now;
    /* RAM de onda al encender en CGB: 00 FF 00 FF… (Pan Docs, "Wave RAM"). */
    for (int i = 0; i < 16; i++) A.regs[R_WAVE + i] = (i & 1) ? 0xFF : 0x00;
    if (!boot) {
        /* Estado que deja la boot ROM del CGB (Pan Docs, "Power Up Sequence"): NR52 = F1,
         * NR50 = 77, NR51 = F3, canal 1 con DAC encendido y la envolvente ya en 0. */
        A.power = 1;
        A.regs[R_NR11] = 0x80;
        A.regs[R_NR12] = 0xF3;
        A.regs[R_NR50] = 0x77;
        A.regs[R_NR51] = 0xF3;
        A.ch[0].on = 1;
        A.ch[0].dac = 1;
        A.ch[0].timer = 2048u * 4;
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
    const double spb = (double)(GB_DOT_HZ / BIN_DOTS) / (double)rate;   /* bins por muestra */
    const double norm = 1.0 / (BIN_DOTS * LVL_MAX);
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
