// Ejecuta un catálogo de casos como tests de vitest: uno por ROM. Los fallos conocidos
// (known-failures.ts) van con it.fails; los que no aplican se registran como skip con el
// motivo, para que el informe de vitest muestre el inventario completo.
import { describe, expect, it } from "vitest";
import { fixture } from "../util/wasm";
import { presses, runBlargg, runMooneye, runScreenshot, type Result } from "../util/runners";
import type { Case, NotApplicable } from "./catalog";
import { KNOWN_FAILURES } from "./known-failures";

export async function runCase(c: Case): Promise<Result> {
  const rom = fixture(c.rom)!;
  if (c.kind === "blargg") return runBlargg(rom, c.maxSeconds);
  if (c.kind === "mooneye") return runMooneye(rom, c.maxSeconds);
  return runScreenshot(rom, fixture(c.ref!)!, c.id, {
    maxSeconds: c.maxSeconds,
    fixedTime: c.fixedTime,
    input: c.input ? presses(c.input) : undefined,
  });
}

export function suite(title: string, load: () => { cases: Case[]; na: NotApplicable[] }, timeout = 120_000): void {
  describe(title, () => {
    const { cases, na } = load();
    if (!cases.length) {
      it.skip(`${title}: faltan los fixtures (npm run fetch)`, () => {});
      return;
    }
    for (const c of cases) {
      const known = KNOWN_FAILURES[c.id];
      const t = known ? it.fails : it;
      t(known ? `${c.id} [fallo conocido: ${known}]` : c.id, async () => {
        const r = await runCase(c);
        expect(r.pass, r.msg).toBe(true);
      }, timeout);
    }
    for (const n of na) it.skip(`${n.id} — no aplica: ${n.reason}`, () => {});
  });
}
