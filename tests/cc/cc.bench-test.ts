// Medidas del compilador C (K1):
//  - tiempo de compilación: 2000 líneas de C variado en < 200 ms (mediana de 9, tras calentar);
//  - ciclos M del código generado en cuatro programas típicos (fib, criba, burbuja, blit de
//    sprites). Los ciclos son deterministas; se imprimen para web/src/cc/README.md y se
//    comprueba el resultado de cada programa con valores calculados a mano.
import { describe, expect, it } from "vitest";
import { compile } from "../../web/src/cc";
import { cyclesOfMain } from "./harness";

/** ~`lines` líneas en total: cabecera, main.c y un fichero por banco (unos 50 KB de código). */
function program(lines: number): Map<string, string> {
  const FUNCS_PER_BANK = 22;
  const header = [
    "typedef unsigned char u8;",
    "typedef unsigned int u16;",
    "struct obj { u8 x, y, tile, attr; int vx; };",
    "enum { LEFT = 1, RIGHT = 2, UP = 4, DOWN = 8 };",
    "extern struct obj objs[8];",
    "extern u8 buf[64];",
    "extern const u8 table[16];",
    "extern int acc;",
  ];
  const fn = (i: number) => [
    `int __banked f${i}(int a, u8 b, struct obj *o) {`,
    `  int i, s = ${i};`,
    `  u8 *p = buf;`,
    `  for (i = 0; i < 8; i++) {`,
    `    s += table[(a + i) & 15] * b;`,
    `    if (s > 1000 && (b & UP)) s -= a / 3;`,
    `    else if (s < -500 || o->x == 0) s ^= a << 2;`,
    `    p[i] = (u8)(s >> 1);`,
    `  }`,
    `  switch (b & 3) {`,
    `  case 0: o->x++; break;`,
    `  case 1: o->y += (u8)a; break;`,
    `  case 2: o->vx = -o->vx; /* fallthrough */`,
    `  default: o->tile = table[b & 15];`,
    `  }`,
    `  while (a > 10) { a = a - (a >> 2) - 1; s += a % 7; }`,
    `  acc += s;`,
    i > 0 ? `  return s + f${i - 1}(a - 1, b + 1, &objs[${i} & 7]);` : `  return s;`,
    `}`,
    ``,
  ];
  const banks: string[][] = [];
  let total = 0, i = 0;
  while (total < lines - header.length - 20) {
    const k = Math.floor(i / FUNCS_PER_BANK);
    if (!banks[k]) { banks[k] = [`#pragma bank ${k + 1}`, '#include "p.h"']; total += 2; }
    const f = fn(i++);
    banks[k]!.push(...f);
    total += f.length;
  }
  const n = i;
  for (let j = 0; j < n; j++) header.push(`int __banked f${j}(int a, u8 b, struct obj *o);`);
  const main = [
    '#include "p.h"',
    ...banks.map((_, k) => `#pragma link "b${k + 1}.c"`),
    "struct obj objs[8];",
    "u8 buf[64];",
    "const u8 table[16] = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 };",
    "int acc;",
    "void main(void) {",
    `  acc = f${n - 1}(100, 3, &objs[0]);`,
    "}",
  ];
  const files = new Map([["main.c", main.join("\n")], ["p.h", header.join("\n")]]);
  banks.forEach((b, k) => files.set(`b${k + 1}.c`, b.join("\n")));
  return files;
}

describe("cc: rendimiento", () => {
  it("compila 2000 líneas de C en menos de 200 ms", () => {
    const files = program(2000);
    const nLines = [...files.values()].reduce((s, t) => s + t.split("\n").length, 0);
    expect(nLines).toBeGreaterThanOrEqual(2000);
    const first = compile(files, { main: "main.c" });
    expect(first.errors.filter((e) => e.severity === "error")).toEqual([]);
    expect(first.removed).toEqual([]);
    for (let k = 0; k < 3; k++) compile(files, { main: "main.c" });
    const times: number[] = [];
    for (let k = 0; k < 9; k++) {
      const t0 = performance.now();
      compile(files, { main: "main.c" });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[4]!;
    console.log(`cc: ${nLines} líneas en ${files.size} ficheros, ${first.emitted.length} funciones, ${first.asm.split("\n").length} líneas de asm; mediana ${median.toFixed(1)} ms (mín ${times[0]!.toFixed(1)}, máx ${times[8]!.toFixed(1)})`);
    expect(median).toBeLessThan(200);
  });
});

const FIB = `
int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
int r;
void main(void) { r = fib(15); }
`;

const SIEVE = `
unsigned char flags[1024];
int count;
void main(void) {
  int i, j;
  for (i = 2; i < 1024; i++) flags[i] = 1;
  for (i = 2; i < 32; i++)
    if (flags[i])
      for (j = i * i; j < 1024; j += i) flags[j] = 0;
  count = 0;
  for (i = 2; i < 1024; i++) if (flags[i]) count++;
}
`;

const BUBBLE = `
int v[64];
void main(void) {
  unsigned char i, j;
  int t;
  for (i = 0; i < 64; i++) v[i] = (int)((i * 37u + 11u) & 63u) - 20;
  for (i = 0; i < 63; i++)
    for (j = 0; j < 63 - i; j++)
      if (v[j] > v[j + 1]) { t = v[j]; v[j] = v[j + 1]; v[j + 1] = t; }
}
`;

const BLIT = `
struct spr { unsigned char y, x, tile, attr; };
struct spr oam[40];
unsigned char px[40], py[40];
signed char dx[40], dy[40];
void main(void) {
  unsigned char i, f;
  for (i = 0; i < 40; i++) { px[i] = i * 4; py[i] = i * 3 + 16; dx[i] = (i & 1) ? 1 : -1; dy[i] = (i & 2) ? 2 : -2; }
  for (f = 0; f < 10; f++)
    for (i = 0; i < 40; i++) {
      struct spr *s = &oam[i];
      px[i] += dx[i];
      py[i] += dy[i];
      s->y = py[i] + 16;
      s->x = px[i] + 8;
      s->tile = i & 7;
      s->attr = (dx[i] < 0) ? 0x20 : 0;
    }
}
`;

describe("cc: ciclos M del código generado", () => {
  const report: string[] = [];
  it("fib(15) recursivo", async () => {
    const { m, run } = await cyclesOfMain(FIB);
    expect(run.u16("r")).toBe(610);
    report.push(`fib(15): ${m} ciclos M`);
  });
  it("criba de Eratóstenes hasta 1024", async () => {
    const { m, run } = await cyclesOfMain(SIEVE);
    expect(run.u16("count")).toBe(172); // π(1023) = 172
    report.push(`criba 1024: ${m} ciclos M`);
  });
  it("burbuja de 64 int", async () => {
    const { m, run } = await cyclesOfMain(BUBBLE);
    // (i·37 + 11) mod 64 recorre 0..63 (37 es impar): ordenado queda −20..43.
    for (let i = 0; i < 64; i++) expect(run.s16("v", i)).toBe(i - 20);
    report.push(`burbuja 64: ${m} ciclos M`);
  });
  it("blit de 40 sprites × 10 frames", async () => {
    const { m, run } = await cyclesOfMain(BLIT);
    // Sprite 5: x = 20 + 10·1 = 30 → 38; y = 31 + 10·(−2) = 11 → 27; attr 0 (dx > 0).
    expect([run.u8("oam", 5 * 4), run.u8("oam", 5 * 4 + 1), run.u8("oam", 5 * 4 + 2), run.u8("oam", 5 * 4 + 3)]).toEqual([27, 38, 5, 0]);
    report.push(`blit 40×10: ${m} ciclos M`);
    console.log(report.join("\n"));
  });
});
