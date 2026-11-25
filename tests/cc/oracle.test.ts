// Oráculo independiente: el mismo oracle.c compilado con clang (wasm32, int16_t = short)
// y con el compilador de K1 sobre core-probe.wasm debe dar los mismos 1196 resultados.
// El valor esperado sale de clang, no del código bajo prueba (AGENTS.md §4.3).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runC } from "./harness";

const SRC = join(__dirname, "oracle.c");
const LLVM = process.env.LLVM_BIN ?? "C:\\Program Files\\LLVM\\bin";
const CLANG = join(LLVM, process.platform === "win32" ? "clang.exe" : "clang");
const N = 26, K = 46;

/** Resultados según clang: compila a wasm32 y ejecuta run() en Node. */
async function clangResults(): Promise<number[]> {
  const dir = mkdtempSync(join(tmpdir(), "k1-oracle-"));
  try {
    const out = join(dir, "oracle.wasm");
    execFileSync(CLANG, ["--target=wasm32", "-nostdlib", "-O1", "-std=c99", "-Wall", "-Werror", "-Wl,--no-entry", "-o", out, SRC]);
    const { instance } = await WebAssembly.instantiate(readFileSync(out));
    const e = instance.exports as { run(): void; out_ptr(): number; memory: WebAssembly.Memory };
    e.run();
    return Array.from(new Int16Array(e.memory.buffer, e.out_ptr(), N * K));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(CLANG))("cc: oráculo clang (aritmética de 16 bits)", () => {
  it("26 pares de operandos × 46 operaciones coinciden con clang", async () => {
    const want = await clangResults();
    // Cordura del oráculo, a mano: 32767 + (−1); 12345 / 99; −12345 % −100; 0x7F80 << 15.
    expect([want[3 * K + 0], want[10 * K + 3], want[11 * K + 4], want[16 * K + 7]]).toEqual([32766, 124, -45, 0]);
    const r = await runC(readFileSync(SRC, "utf8"), {}, 10);
    const bad: string[] = [];
    for (let i = 0; i < N * K; i++) {
      const got = r.s16("out", i);
      if (got !== want[i]) bad.push(`par ${Math.floor(i / K)} op ${i % K}: K1 ${got}, clang ${want[i]}`);
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });
});
