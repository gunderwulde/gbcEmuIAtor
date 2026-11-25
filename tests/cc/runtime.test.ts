import { describe, expect, it } from "vitest";
import { HELPERS } from "../../web/src/cc/runtime";

// La tabla de clobbers de runtime.ts la usa clob() del generador para dejar valores vivos
// en BC o DE alrededor de una llamada a un helper. Si el código de un helper (o de sus
// dependencias) escribe en un par que la tabla no declara, el generador produce código
// erróneo. El valor esperado sale del texto del código, no de la tabla.

const REGS = ["b", "c", "d", "e"] as const;
const PAIR: Record<string, string> = { b: "bc", c: "bc", d: "de", e: "de", bc: "bc", de: "de" };

/** Pares (bc/de) que escribe un fragmento de ensamblador, mirando sólo las instrucciones. */
function writtenPairs(code: string): Set<string> {
  const out = new Set<string>();
  for (const raw of code.split("\n")) {
    const line = raw.replace(/;.*/, "").trim().toLowerCase();
    if (!line || line.endsWith(":")) continue;
    const m = /^(\w+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const op = m[1]!;
    const args = m[2]!.split(",").map((s) => s.trim());
    let dst: string | undefined;
    if (op === "ld" || op === "add" && args.length === 2 || op === "pop" || op === "inc" || op === "dec") dst = args[0];
    else if (["rl", "rr", "rlc", "rrc", "sla", "sra", "srl", "swap"].includes(op)) dst = args[0];
    else if (op === "res" || op === "set") dst = args[1];
    if (dst && PAIR[dst]) out.add(PAIR[dst]!);
  }
  return out;
}

function closure(name: string, seen = new Set<string>()): Set<string> {
  if (seen.has(name)) return seen;
  seen.add(name);
  for (const d of HELPERS[name]!.deps) closure(d, seen);
  return seen;
}

describe("cc: tabla de clobbers del runtime", () => {
  for (const name of Object.keys(HELPERS)) {
    it(`${name} no pisa más pares de los que declara`, () => {
      const written = new Set<string>();
      for (const h of closure(name)) for (const p of writtenPairs(HELPERS[h]!.code)) written.add(p);
      const declared = new Set<string>(HELPERS[name]!.clobbers);
      expect([...written].filter((p) => !declared.has(p))).toEqual([]);
    });
    it(`${name} declara como dependencia todo helper al que llama`, () => {
      const deps = closure(name);
      const targets = [...HELPERS[name]!.code.matchAll(/^\s*(?:call|jp|jr)\s+(?:\w+,)?(__\w+)/gm)].map((m) => m[1]!);
      expect(targets.filter((t) => t in HELPERS && !deps.has(t))).toEqual([]);
    });
  }

  it("el detector reconoce escrituras en B, C, D y E", () => {
    for (const r of REGS) expect(writtenPairs(`        ld ${r},a`)).toEqual(new Set([PAIR[r]]));
    expect(writtenPairs("        ld [de],a\n        add hl,de\n        ldh [c],a")).toEqual(new Set());
    expect(writtenPairs("        pop bc\n        rl d")).toEqual(new Set(["bc", "de"]));
  });
});
