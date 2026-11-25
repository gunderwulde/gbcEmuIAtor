// Programas C ejecutados en core-probe.wasm. Los valores esperados están calculados a
// mano con las reglas de C99 para int de 16 bits (en los comentarios, la cuenta).
import { describe, expect, it } from "vitest";
import { runC } from "./harness";

describe("cc: aritmética", () => {
  it("8 y 16 bits, con y sin signo", async () => {
    const r = await runC(`
int r[12]; unsigned char b[6]; signed char sc;
void main(void) {
  int a = 1000, c = -7;
  unsigned u = 60000u;
  unsigned char x = 200, y = 100;
  r[0] = a + c;
  r[1] = a - c * 3;
  r[2] = a * c;
  r[3] = a / c;
  r[4] = a % c;
  r[5] = -a / 7;
  r[6] = -a % 7;
  r[7] = u / 7;
  r[8] = u % 7;
  b[0] = x + y;
  b[1] = x - y;
  b[2] = y - x;
  b[3] = x * 3;
  b[4] = x / 3;
  b[5] = x % 7;
  sc = -5;
  r[9] = sc * 3;
  r[10] = x + y;
  r[11] = u > 50000u;
}`);
    const R = (i: number) => r.s16("r", i);
    expect(R(0)).toBe(993); // 1000 - 7
    expect(R(1)).toBe(1021); // 1000 + 21
    expect(R(2)).toBe(-7000);
    expect(R(3)).toBe(-142); // 142,86 trunca hacia cero
    expect(R(4)).toBe(6); // 1000 - (-142)(-7) = 6: signo del dividendo
    expect(R(5)).toBe(-142);
    expect(R(6)).toBe(-6);
    expect(R(7)).toBe(8571); // 60000 = 8571·7 + 3
    expect(R(8)).toBe(3);
    expect([0, 1, 2, 3, 4, 5].map((i) => r.u8("b", i))).toEqual([44, 100, 156, 88, 66, 4]); // 300&255, 100, -100&255, 600&255, 66, 200-196
    expect(R(9)).toBe(-15);
    expect(R(10)).toBe(300); // los char se promocionan a int
    expect(R(11)).toBe(1);
  });

  it("comparaciones con y sin signo", async () => {
    const r = await runC(`
int c[12];
void main(void) {
  int a = -1, b = 1, m = 0x8000; unsigned ua = 0xFFFF, ub = 1;
  signed char s = -3; unsigned char uc = 250, ud = 5;
  c[0] = a < b; c[1] = ua < ub; c[2] = a > b; c[3] = ua > ub;
  c[4] = s < 0; c[5] = uc > 200; c[6] = a <= -1; c[7] = a >= 0;
  c[8] = m < 32767; c[9] = s < uc; c[10] = ud < uc; c[11] = m > a;
}`);
    expect(Array.from({ length: 12 }, (_, i) => r.s16("c", i))).toEqual([1, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0]);
  });

  it("mul, div, mod y desplazamientos (constantes y variables)", async () => {
    const r = await runC(`
int r[16]; unsigned u[6];
void main(void) {
  int a = -100; unsigned b = 0xF00F; int n = 3; unsigned char c = 0x81;
  r[0] = a * 10; r[1] = a / 8; r[2] = a % 8; r[3] = a >> 2; r[4] = a << n; r[5] = a >> n;
  u[0] = b >> 4; u[1] = b << 4; u[2] = b >> n; u[3] = b / 16; u[4] = b % 16; u[5] = b * 3;
  r[6] = c >> 1; r[7] = c << 1; r[8] = (unsigned char)(c << 1); r[9] = a * a;
  r[10] = 7 / n; r[11] = -7 / n; r[12] = -7 % n; r[13] = a * -3; r[14] = 1000 / a; r[15] = b / n;
}`);
    expect(Array.from({ length: 16 }, (_, i) => r.s16("r", i))).toEqual([
      -1000, -12, -4, -25, -800, -13, // -100/8 trunca a -12 (no es un desplazamiento); -100>>3 = floor(-12,5)
      64, 258, 2, 10000, 2, -2, -1, 300, -10, 20485, // 0x81<<1 = 0x102 en int; 61455/3
    ]);
    expect(Array.from({ length: 6 }, (_, i) => r.u16("u", i))).toEqual([
      0x0f00, 0x00f0, 0x1e01, 0x0f00, 15, 0xd02d, // 0xF00F<<4 = 0xF00F0; 0xF00F·3 = 0x2D02D
    ]);
  });

  it("desplazamientos de 16 o más bits y división por cero", async () => {
    const r = await runC(`
int r[6]; unsigned u[4];
void main(void) {
  int n = 16, m = 20, z = 0, a = -5, p = 1234; unsigned b = 0x8001;
  r[0] = a >> n; r[1] = p >> m; r[2] = p << n; r[3] = a / z; r[4] = a % z; r[5] = p / z;
  u[0] = b / z; u[1] = b % z; u[2] = b >> n; u[3] = b << 15;
}`);
    // docs/c-abi.md §1: << da 0, >> da 0 o -1; /0: 0xFFFF y resto = dividendo; con signo, signos aplicados.
    expect([0, 1, 2].map((i) => r.s16("r", i))).toEqual([-1, 0, 0]);
    expect(r.s16("r", 3)).toBe(1); // |-5| / 0 = 0xFFFF, negado por signo distinto = 1
    expect(r.s16("r", 4)).toBe(-5);
    expect(r.s16("r", 5)).toBe(-1);
    expect([0, 1, 2, 3].map((i) => r.u16("u", i))).toEqual([0xffff, 0x8001, 0, 0x8000]);
  });

  // Revisión de K1: los helpers del runtime no deben pisar los registros que el
  // generador cree vivos (BC con un operando o una dirección).
  it("helpers de desplazamiento variable con un valor vivo en BC", async () => {
    const a = await runC("int g(int x){return x;} int n=9; int r; void main(void){ r = g(1000) + (-100 >> n); }");
    expect(a.s16("r")).toBe(999);
    const b = await runC("int a[4]; int i=1; int n=9; void main(void){ a[i] = -100 >> n; }");
    expect(b.s16("a", 1)).toBe(-1);
    const c = await runC("int g2(void);\nint a[4]; int i=2; int n=9; unsigned m=3; void main(void){ a[i] = (int)(0x8000u >> n) + (int)(5u << m); a[i+1] = g2(); }\nint g2(void){ return 7; }");
    expect([c.s16("a", 2), c.s16("a", 3)]).toEqual([64 + 40, 7]);
  });

  it("switch sobre (unsigned) de un signed char: despacho de 16 bits", async () => {
    const r = await runC("signed char sc=-5; int r; void main(void){ switch((unsigned)sc){ case 65531u: r=1; break; default: r=2; } }");
    expect(r.s16("r")).toBe(1);
  });
});

describe("cc: datos", () => {
  it("punteros, arrays, structs y enums", async () => {
    const r = await runC(`
struct pt { unsigned char x; int y; struct pt *next; };
enum col { RED, GREEN = 5, BLUE };
struct pt pts[3];
int out[9];
int arr[5] = {1, 2, 3, 4, 5};
int sum(int *p, int n) { int s = 0; while (n--) s += *p++; return s; }
void swap(int *a, int *b) { int t = *a; *a = *b; *b = t; }
void main(void) {
  struct pt *q;
  int i;
  for (i = 0; i < 3; i++) { pts[i].x = i * 10; pts[i].y = i * 1000; pts[i].next = i < 2 ? &pts[i + 1] : 0; }
  q = &pts[0];
  out[0] = 0;
  while (q) { out[0] += q->y + q->x; q = q->next; }
  out[1] = sum(arr, 5);
  out[2] = BLUE;
  out[3] = sizeof(struct pt);
  out[4] = &arr[4] - &arr[1];
  out[5] = *(arr + 2);
  { char *s = "hola"; out[6] = s[1]; }
  out[7] = pts[2].next == 0;
  swap(&arr[0], &arr[4]);
  out[8] = arr[0] * 10 + arr[4];
}`);
    expect(Array.from({ length: 9 }, (_, i) => r.s16("out", i))).toEqual([
      3030, // (0+0) + (1000+10) + (2000+20)
      15, 6, 5, 3, 3, 111, 1, 51,
    ]);
    expect(r.u8("pts", 5 + 0)).toBe(10); // pts[1].x: structs sin relleno, 5 bytes
  });

  it("globales inicializadas, const y BSS", async () => {
    const r = await runC(`
int g1 = 1234; unsigned char g2 = 0xAB; int g3[4] = {1, -2, 3}; const int k[3] = {10, 20, 30};
char msg[] = "hey"; const char *p = "abc"; int z; int zz[3];
struct s { unsigned char a; int b; } st = { 9, -300 };
int *pg = &g3[2];
int out[9];
void main(void) {
  out[0] = g1; out[1] = g2; out[2] = g3[1] + g3[3];
  out[3] = k[2]; out[4] = msg[2]; out[5] = p[1];
  out[6] = z + zz[2]; out[7] = st.b + st.a; out[8] = *pg;
  g1++;
}`);
    expect(Array.from({ length: 9 }, (_, i) => r.s16("out", i))).toEqual([1234, 0xab, -2, 30, 121, 98, 0, -291, 3]);
    expect(r.s16("g1")).toBe(1235);
    expect(r.u8("msg", 3)).toBe(0);
  });

  it("struct de una cabecera compartida por dos unidades (C99 6.2.7)", async () => {
    const r = await runC(new Map([
      ["p.h", "struct v { int x; unsigned char y; struct v *next; };\nextern struct v g;\nint sum(struct v *p);\n"],
      ["main.c", '#include "p.h"\n#pragma link "b.c"\nstruct v g = { 7, 3, 0 };\nint out;\nvoid main(void) { struct v l; l = g; l.next = &g; out = sum(&l); }\n'],
      ["b.c", '#include "p.h"\nint sum(struct v *p) { int s = 0; for (; p; p = p->next) s += p->x * p->y; return s; }\n'],
    ]));
    expect(r.s16("out")).toBe(42); // 7·3 + 7·3
  });
});

describe("cc: funciones y control", () => {
  it("recursión: fib, factorial y recursión mutua", async () => {
    const r = await runC(`
int fib(int n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
unsigned fact(unsigned n) { return n <= 1 ? 1 : n * fact(n - 1); }
int even(int n);
int odd(int n) { return n == 0 ? 0 : even(n - 1); }
int even(int n) { return n == 0 ? 1 : odd(n - 1); }
int ack(int m, int n) { if (m == 0) return n + 1; if (n == 0) return ack(m - 1, 1); return ack(m - 1, ack(m, n - 1)); }
int r[5];
void main(void) { r[0] = fib(15); r[1] = fact(8); r[2] = even(10); r[3] = odd(7); r[4] = ack(2, 3); }`);
    expect(r.s16("r", 0)).toBe(610);
    expect(r.u16("r", 1)).toBe(40320);
    expect(r.s16("r", 2)).toBe(1);
    expect(r.s16("r", 3)).toBe(1);
    expect(r.s16("r", 4)).toBe(9); // A(2,n) = 2n+3
  });

  it("muchos argumentos, char y marcos estáticos anidados", async () => {
    const r = await runC(`
int r[4];
unsigned char mix(unsigned char a, int b, unsigned char c, int d) { return a + b * c - d; }
int inner(int x, int y) { int t = x * y; return t - 1; }
int outer(int x, int y) { int keep = x + y; return inner(keep, inner(x, y)) + keep; }
void main(void) {
  r[0] = mix(10, 20, 3, 5);
  r[1] = outer(3, 4);
  r[2] = inner(outer(1, 2), 2);
}`);
    expect(r.s16("r", 0)).toBe(65); // 10 + 60 - 5
    expect(r.s16("r", 1)).toBe(83); // keep 7, inner(3,4)=11, inner(7,11)=76, +7
    // outer(1,2): keep 3, inner(1,2)=1, inner(3,1)=2, +3 = 5; inner(5,2)=9
    expect(r.s16("r", 2)).toBe(9);
  });

  it("control de flujo y cortocircuito", async () => {
    const r = await runC(`
int r[10]; int calls;
int f(int v) { calls++; return v; }
void main(void) {
  int i, s = 0;
  r[0] = f(0) && f(1);
  r[1] = f(1) || f(0);
  r[2] = f(1) && f(2);
  r[3] = calls;
  for (i = 0; i < 10; i++) { if (i == 3) continue; if (i == 8) break; s += i; }
  r[4] = s;
  i = 0; do { i += 3; } while (i < 10); r[5] = i;
  switch (i) { case 1: r[6] = 1; break; case 12: r[6] = 2; case 13: r[7] = 3; break; default: r[6] = 9; }
  s = 0; i = 5; while (i) { s += i--; } r[8] = s;
  r[9] = !s + (s ? 7 : 8);
  goto end;
  r[9] = 99;
end:
  ;
}`);
    expect(Array.from({ length: 10 }, (_, i) => r.s16("r", i))).toEqual([0, 1, 1, 4, 25, 12, 2, 3, 15, 7]);
  });
});

describe("cc: extensiones", () => {
  it("__at, interrupción de VBlank, #pragma bank con __banked y __asm", async () => {
    const files = new Map([
      ["main.c", `
__at(0xFF40) volatile unsigned char LCDC;
__at(0xFFFF) volatile unsigned char IE;
__at(0xFF0F) volatile unsigned char IF;
__at(0xD000) unsigned char big[16];
volatile unsigned char vbl;
int r[6];
void isr(void) __interrupt(vblank) { vbl++; }
int __banked helper(int x);
int __banked twice(int x, int y);
void main(void) {
  unsigned char i;
  for (i = 0; i < 16; i++) big[i] = i * 2;
  r[0] = big[15];
  r[1] = LCDC;
  IF = 0; IE = 1;
  __asm
    ei
  __endasm;
  while (vbl < 3) {}
  __asm
    di
  __endasm;
  r[2] = vbl;
  r[3] = helper(20);
  __asm
    ld a, 77
    ld [_r+8], a
    xor a
    ld [_r+9], a
  __endasm;
  r[5] = twice(100, 7);
}`],
      ["bank.c", `
#pragma bank 2
const int tbl[3] = {5, 6, 7};
int __banked helper(int x) { return x * 2 + tbl[1] - 5; }
int __banked twice(int x, int y) { return helper(x) + y; }
`],
    ]);
    const r = await runC(files);
    expect(r.s16("r", 0)).toBe(30);
    expect(r.s16("r", 1)).toBe(0x91); // LCDC tras el arranque (docs/gbc-hardware.md)
    expect(r.s16("r", 2)).toBe(3);
    expect(r.s16("r", 3)).toBe(41); // 40 + 6 - 5
    expect(r.s16("r", 4)).toBe(77);
    expect(r.s16("r", 5)).toBe(208); // helper(100) = 201, + 7
    expect(r.b.symbols.get("_helper")!.bank).toBe(2);
    expect(r.x.gb_peek(r.b.symbols.get("__cur_bank")!.addr) & 0xff).toBe(1);
  });

  it("función en ensamblador llamada desde C y función C llamada desde ensamblador", async () => {
    const r = await runC(`
unsigned char add3(unsigned char a, unsigned char b, unsigned char c);
int sub2(int x, int y) { return x - y; }
int r[3];
__asm
_add3::
    ld hl, sp+2
    add a, [hl]
    ld hl, sp+4
    add a, [hl]
    ret
_call_sub::
    ld hl, 5
    push hl
    ld hl, 50
    call _sub2
    add sp, 2
    ret
__endasm;
int call_sub(void);
void main(void) { r[0] = add3(1, 2, 3); r[1] = call_sub(); r[2] = add3(100, 100, 100); }`);
    expect(r.s16("r", 0)).toBe(6);
    expect(r.s16("r", 1)).toBe(45);
    expect(r.s16("r", 2)).toBe(44); // 300 & 255
  });

  it("main y una interrupción comparten función: convención de pila", async () => {
    const files = new Map([["main.c", `
int shared(int v) { int t = v + 1; return t * 2; }
void tim(void) __interrupt(timer) { shared(3); }
int r;
void main(void) { r = shared(10); }`]]);
    const r = await runC(files);
    expect(r.s16("r")).toBe(22);
    const { compile } = await import("../../web/src/cc");
    const c = compile(files, { main: "main.c" });
    expect(c.frames.get("shared")!.conv).toBe("stack");
    expect(c.frames.get("main")!.conv).toBe("static");
  });
});
