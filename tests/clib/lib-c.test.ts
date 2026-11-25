// La librería usada desde C (lo que está escrito en C en gbc.c/stdlib.c y la
// interacción C ↔ asm: varargs de printf, punteros a const, variables de la librería).
// Los valores esperados salen de docs/gbc-hardware.md (registros de la APU y sus
// máscaras de lectura) o están calculados a mano en el comentario de cada test.
import { describe, expect, it } from "vitest";
import { FRAME, RGB, startC, type CMachine } from "./c-harness";

async function exit(src: string, seconds = 2): Promise<CMachine> {
  const m = await startC(src);
  m.runToExit(seconds);
  return m;
}
const bytes = (m: CMachine, name: string, n: number) =>
  Array.from({ length: n }, (_, i) => m.peek(m.sym(name) + i));
const words = (m: CMachine, name: string, n: number) =>
  Array.from({ length: n }, (_, i) => m.peek16(m.sym(name) + 2 * i));

describe("escrituras protegidas contra interrupciones", () => {
  // Una IRQ entre «STAT dice modo 0/1» y la escritura retrasa ésta hasta el modo 3, y la
  // PPU la ignora (docs §7.8). Con la IRQ de temporizador a 16 kHz (TAC = 05h: 262144 Hz,
  // TMA = C0h: cada 64 cuentas) y una ISR que tarda, sin protección se pierden bytes.
  it("vram_fill, vram_copy, fill_bg_attr, paletas y lcd_off con IRQ de timer frecuentes", async () => {
    const m = await exit(`
#include <gbc.h>
volatile unsigned char spin;
void t_isr(void) __interrupt(timer)
{
    unsigned char i;
    for (i = 0; i < 6; i++) spin++;
}
const unsigned int pal[4] = { RGB(1, 2, 3), RGB(4, 5, 6), RGB(7, 8, 9), RGB(10, 11, 12) };
unsigned char src[256];
int main(void)
{
    unsigned int i;
    for (i = 0; i < 256; i++) src[i] = i;
    rTMA = 0xC0;
    rTIMA = 0xC0;
    rTAC = 0x05;
    irq_enable(IRQ_TIMER);
    ei();
    vram_fill(0x9800, 0x5A, 2048);
    vram_copy(0x8000, src, 256);
    fill_bg_attr(0, 0, 20, 18, 3);
    for (i = 0; i < 8; i++) set_bg_palette(i, pal);
    set_sprite_color(7, 3, RGB(31, 0, 17));
    lcd_off();
    di();
    return 0;
}`, 4);
    expect(m.io(0xff40) & 0x80).toBe(0);
    expect(m.peek(m.sym("_spin"))).toBeGreaterThan(0);
    const bad = m.vram(0, 0x9800, 2048).filter((v) => v !== 0x5a).length;
    expect(bad, "bytes de vram_fill perdidos").toBe(0);
    expect(m.vram(0, 0x8000, 256)).toEqual(Array.from({ length: 256 }, (_, i) => i));
    for (let y = 0; y < 18; y++) expect(m.vram(1, 0x9800 + 32 * y, 20), `fila ${y}`).toEqual(new Array(20).fill(3));
    for (let i = 0; i < 32; i++) expect(m.pal(false, i >> 2, i & 3)).toBe([RGB(1, 2, 3), RGB(4, 5, 6), RGB(7, 8, 9), RGB(10, 11, 12)][i & 3]);
    expect(m.pal(true, 7, 3)).toBe(RGB(31, 0, 17));
  });
});

describe("sonido", () => {
  it("snd_on, snd_tone, snd_noise, snd_stop y las duraciones", async () => {
    const m = await exit(`
#include <gbc.h>
unsigned char r[16];
unsigned char s[4];
int main(void)
{
    snd_on();
    snd_tone(1, NOTE_A4, 0, 12);
    snd_tone(2, NOTE_C4, 32, 9);
    snd_noise(0x34, 16, 7);
    s[0] = rNR52;
    r[0] = rNR10; r[1] = rNR11; r[2] = rNR12; r[3] = rNR14;
    r[4] = rNR21; r[5] = rNR22; r[6] = rNR24;
    r[7] = rNR42; r[8] = rNR43; r[9] = rNR44;
    r[10] = rNR50; r[11] = rNR51;
    delay(12);
    s[1] = rNR52;
    snd_stop(1);
    s[2] = rNR52;
    snd_off();
    s[3] = rNR52;
    return 0;
}`);
    // Lectura (docs §8): NR10 | 80h, NRx1 | 3Fh, NRx4 | BFh; NR52 | 70h.
    // NR12 = 12 << 4 = C0h; NR22 = 9 << 4 = 90h; NR42 = 7 << 4 = 70h.
    expect(bytes(m, "_r", 12)).toEqual([0x80, 0xbf, 0xc0, 0xbf, 0xbf, 0x90, 0xff, 0x70, 0x34, 0xff, 0x77, 0xff]);
    // Los 4 bits bajos de NR52: canales 1, 2 y 4 activos. 12 frames = 0,2 s: el 2 (32/256 s)
    // y el ruido (16/256 s) han terminado; el 1 sin duración sigue hasta snd_stop.
    expect(bytes(m, "_s", 4)).toEqual([0xfb, 0xf1, 0xf0, 0x70]);
  });

  it("sfx_jump y sfx_hit disparan los canales 1 y 4", async () => {
    const m = await exit(`
#include <gbc.h>
unsigned char r[4];
int main(void)
{
    snd_on();
    sfx_jump();
    sfx_hit();
    r[0] = rNR52; r[1] = rNR10; r[2] = rNR12; r[3] = rNR42;
    return 0;
}`);
    expect(bytes(m, "_r", 4)).toEqual([0xf9, 0x80 | 0x15, 0xf2, 0xf1]);
  });
});

describe("fundidos", () => {
  it("fade_bg escala cada canal por (8 − nivel)/8 y fade_sprites a nivel 8 da negro", async () => {
    const m = await exit(`
#include <gbc.h>
const unsigned int p[8] = {
    RGB(31, 16, 8), RGB(4, 1, 2), RGB(3, 24, 31), RGB(0, 0, 0),
    RGB(8, 8, 8), RGB(31, 31, 31), RGB(1, 2, 3), RGB(16, 4, 24),
};
int main(void)
{
    lcd_off();
    fade_bg(p, 2, 2);
    fade_sprites(p, 2, 0);
    fade_sprites(p, 1, 8);
    return 0;
}`);
    // k = 6: (c · 6) >> 3 → 31→23, 16→12, 8→6, 4→3, 1→0, 2→1, 3→2, 24→18, 0→0.
    const exp = [
      RGB(23, 12, 6), RGB(3, 0, 1), RGB(2, 18, 23), 0,
      RGB(6, 6, 6), RGB(23, 23, 23), RGB(0, 1, 2), RGB(12, 3, 18),
    ];
    for (let i = 0; i < 8; i++) expect(m.pal(false, i >> 2, i & 3), `bg ${i}`).toBe(exp[i]);
    for (let i = 0; i < 4; i++) expect(m.pal(true, 0, i)).toBe(0);
    // La paleta de sprites 1 quedó con los originales (nivel 0).
    expect([4, 5, 6, 7].map((i) => m.pal(true, 1, i & 3))).toEqual([RGB(8, 8, 8), RGB(31, 31, 31), RGB(1, 2, 3), RGB(16, 4, 24)]);
  });
});

describe("tiempo", () => {
  it("delay(n) espera n VBlank y vbl_count los cuenta", async () => {
    const m = await exit(`
#include <gbc.h>
unsigned int a;
unsigned int b;
int main(void)
{
    wait_vbl();
    a = vbl_count;
    delay(10);
    b = vbl_count;
    return 0;
}`);
    expect(m.peek16(m.sym("_b")) - m.peek16(m.sym("_a"))).toBe(10);
    // Del primer VBlank (≈ 1 frame tras el arranque) + 10 frames más.
    expect(m.now()).toBeGreaterThan(10 * FRAME);
    expect(m.now()).toBeLessThan(12 * FRAME);
  });

  it("GBC_NO_VBL_ISR: el programa pone su propia rutina de VBlank", async () => {
    const m = await exit(`
#define GBC_NO_VBL_ISR
#include <gbc.h>
volatile unsigned char mine;
void my_vbl(void) __interrupt(vblank)
{
    mine++;
    vbl_count++;
}
int main(void)
{
    delay(5);
    return 0;
}`);
    expect(m.peek(m.sym("_mine"))).toBe(5);
    expect(m.peek16(m.sym("_vbl_count"))).toBe(5);
  });
});

describe("texto desde C", () => {
  it("printf con varargs de C: %u %d %s %c %x y anchura", async () => {
    const m = await exit(`
#include <gbc.h>
int main(void)
{
    lcd_off();
    text_init(0);
    cls();
    printf("%u-%d-%s-%c-%x", 1234, -5, "ab", 'Q', 0xABC);
    at(0, 1);
    printf("[%5u][%05d][%X]", 42, -42, 0xbeef);
    return 0;
}`);
    expect(m.text(0x9800, 0, 0, 16)).toBe("1234--5-ab-Q-abc");
    expect(m.text(0x9800, 0, 1, 20)).toBe("[   42][-0042][BEEF]");
  });
});

describe("azar y cadenas desde C", () => {
  it("rand sigue el xorshift de 16 bits (7, 9, 8) y srand fija la semilla", async () => {
    const m = await exit(`
#include <gbc.h>
unsigned int v[6];
int main(void)
{
    unsigned char i;
    srand(1);
    for (i = 0; i < 6; i++) v[i] = rand();
    return 0;
}`);
    // Modelo independiente: x ^= x << 7; x ^= x >> 9; x ^= x << 8 (16 bits); rand = x & 7FFFh.
    let x = 1;
    const exp: number[] = [];
    for (let i = 0; i < 6; i++) {
      x ^= (x << 7) & 0xffff;
      x ^= x >> 9;
      x ^= (x << 8) & 0xffff;
      exp.push(x & 0x7fff);
    }
    expect(words(m, "_v", 6)).toEqual(exp);
  });

  it("strlen, strcpy, strcmp, memset, memcpy y abs desde C", async () => {
    const m = await exit(`
#include <gbc.h>
char buf[16];
unsigned char z[8];
int r[4];
int main(void)
{
    strcpy(buf, "hola");
    r[0] = strlen(buf);
    r[1] = strcmp(buf, "hola");
    r[2] = strcmp("abc", "abd") < 0;
    r[3] = abs(-300);
    memset(z, 0x5A, 8);
    memcpy(z + 2, "xy", 2);
    return 0;
}`);
    expect(bytes(m, "_buf", 5)).toEqual([0x68, 0x6f, 0x6c, 0x61, 0]);
    expect(words(m, "_r", 4)).toEqual([4, 0, 1, 300]);
    expect(bytes(m, "_z", 8)).toEqual([0x5a, 0x5a, 0x78, 0x79, 0x5a, 0x5a, 0x5a, 0x5a]);
  });
});

describe("sprites desde C", () => {
  it("sprite_set + oam_flush en VBlank llevan la sombra a la OAM", async () => {
    const m = await exit(`
#include <gbc.h>
int main(void)
{
    sprite_set(0, 10, 20, 7, ATTR_PAL(3));
    sprite_set(39, 152, 136, 255, ATTR_FLIPX | ATTR_FLIPY);
    sprite_move(0, 11, 21);
    wait_vbl();
    oam_flush();
    return 0;
}`);
    const o = m.oam();
    expect(Array.from(o.subarray(0, 4))).toEqual([21 + 16, 11 + 8, 7, 3]);
    expect(Array.from(o.subarray(156, 160))).toEqual([136 + 16, 152 + 8, 255, 0x60]);
  });
});

describe("SRAM y bancos desde C", () => {
  it("sram_on / variable __at en A000h / sram_off; la escritura con la RAM apagada se pierde", async () => {
    const m = await startC(
      new Map([
        ["main.c", `
#include <gbc.h>
#pragma link "save.asm"
__at(0xA000) unsigned char sv[4];
int main(void)
{
    sram_on();
    sv[0] = 0x12;
    sv[1] = 0x34;
    sv[2] = 0;
    sram_off();
    sv[2] = 0x99;            /* ignorada: RAM deshabilitada */
    wram_bank(3);
    *(unsigned char *)0xD000 = 0x33;
    wram_bank(1);
    *(unsigned char *)0xD000 = 0x11;
    return 0;
}`],
        ["save.asm", `SECTION "save", SRAM[$A000]\n    ds 4\n`],
      ]),
      "main.c",
    );
    m.runToExit(1);
    expect(Array.from(m.sram().subarray(0, 3))).toEqual([0x12, 0x34, 0]);
    // gb_wram(): 8 bancos de 4 KB; D000h del banco n está en n · 1000h.
    const w = new Uint8Array(m.x.memory.buffer, m.x.gb_wram(), 0x8000);
    expect([w[0x3000], w[0x1000]]).toEqual([0x33, 0x11]);
  });
});
