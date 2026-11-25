// Tiempo de ensamblado: 5000 líneas variadas (instrucciones, etiquetas locales, datos, macros)
// deben ensamblarse en < 50 ms (mediana de varias ejecuciones, tras calentar el JIT).
import { describe, expect, it } from "vitest";
import { assemble } from "../../web/src/asm";

function program(lines: number): string {
  const out: string[] = [
    `DEF rLCDC EQU $FF40`,
    `MACRO addw`,
    `  ld a, l`,
    `  add \\1`,
    `  ld l, a`,
    `ENDM`,
    `SECTION "Code", ROM0[$150]`,
  ];
  const body = [
    (i: number) => `Func${i}:`,
    () => `  ld hl, $C000`,
    () => `  ld a, [hl+]`,
    (i: number) => `.loop${i}: dec b`,
    (i: number) => `  jr nz, .loop${i}`,
    () => `  ldh [rLCDC], a`,
    () => `  addw 4`,
    (i: number) => `  call Func${i & ~7}`,
    () => `  bit 3, [hl]`,
    (i: number) => `  db ${i & 0xff}, "ab", LOW(Func${i & ~7})`,
    () => `  ret`,
  ];
  let i = 0;
  let sec = 0;
  while (out.length < lines) {
    for (const f of body) out.push(f(i));
    i++;
    if (i % 400 === 0) out.push(`SECTION "X${++sec}", ROMX`);
  }
  return out.join("\n");
}

describe("assembler performance", () => {
  it("assembles 5000 lines in under 50 ms", () => {
    const src = program(5000);
    expect(src.split("\n").length).toBeGreaterThanOrEqual(5000);
    const first = assemble(src);
    expect(first.errors).toEqual([]);
    for (let k = 0; k < 3; k++) assemble(src);
    const times: number[] = [];
    for (let k = 0; k < 9; k++) {
      const t0 = performance.now();
      assemble(src);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[4]!;
    console.log(`asm: 5000 lines, median ${median.toFixed(2)} ms (min ${times[0]!.toFixed(2)}, max ${times[8]!.toFixed(2)})`);
    expect(median).toBeLessThan(50);
  });
});
