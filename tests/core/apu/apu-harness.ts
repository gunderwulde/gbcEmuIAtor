// Compila harness.c (que incluye core/src/apu.c) a un wasm propio (en GB_BUILD_DIR) y lo instancia.
// Mismas flags que tools/build-core.mjs (incluido -Werror) con -DGB_DEBUG.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, WASM_DIR } from "../../util/wasm";

function findClang(): string {
  const exe = process.platform === "win32" ? "clang.exe" : "clang";
  const dirs = [process.env.LLVM_BIN, process.platform === "win32" ? "C:\\Program Files\\LLVM\\bin" : undefined];
  for (const d of dirs) if (d && existsSync(join(d, exe))) return join(d, exe);
  return exe;
}

export interface ApuHarness {
  memory: WebAssembly.Memory;
  reset(boot?: number): void;
  write(addr: number, v: number): void;
  read(addr: number): number;
  advance(dots: number): void;
  /** Muestras estéreo intercaladas producidas desde la última llamada (copia). */
  audio(rate: number): Float32Array;
  state(): Uint8Array;
  /** Tramos de run() desde la última llamada (coste de la puesta al día). */
  runs(): number;
}

export async function loadApuHarness(): Promise<ApuHarness> {
  mkdirSync(WASM_DIR, { recursive: true });
  const dst = join(WASM_DIR, "apu-harness.wasm");
  execFileSync(findClang(), [
    "--target=wasm32", "-std=c99", "-ffreestanding", "-nostdlib", "-mbulk-memory",
    "-Wall", "-Wextra", "-Werror", "-Wno-unused-function", "-O2", "-DGB_DEBUG",
    "-Wl,--no-entry", "-Wl,--stack-first", "-Wl,-z,stack-size=65536",
    join(ROOT, "tests", "core", "apu", "harness.c"), "-o", dst,
  ], { stdio: "inherit" });
  const { instance } = await WebAssembly.instantiate(readFileSync(dst), {});
  const x = instance.exports as Record<string, any>;
  const memory = x.memory as WebAssembly.Memory;
  return {
    memory,
    reset: (boot = 1) => x.h_reset(boot),
    write: (a, v) => x.h_write(a, v),
    read: (a) => x.h_read(a) as number,
    advance: (d) => x.h_advance(d),
    audio: (rate) => {
      const n = x.h_audio(rate) as number;
      return new Float32Array(memory.buffer, x.h_audio_buffer(), n * 2).slice();
    },
    state: () => new Uint8Array(memory.buffer, x.h_state(), x.h_state_len()).slice(),
    runs: () => x.h_runs() as number,
  };
}

/** Canal izquierdo de un buffer intercalado. */
export function left(s: Float32Array): Float32Array {
  const o = new Float32Array(s.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = s[2 * i]!;
  return o;
}

/** Frecuencia fundamental por cruces ascendentes por cero (interpolados) de una señal
 *  sin continua; `rate` en Hz. */
export function zeroCrossFreq(x: Float32Array, rate: number): number {
  let first = -1, last = -1, count = 0;
  for (let i = 1; i < x.length; i++) {
    const a = x[i - 1]!, b = x[i]!;
    if (a < 0 && b >= 0) {
      const t = i - 1 + a / (a - b);
      if (first < 0) first = t; else count++;
      last = t;
    }
  }
  return count > 0 ? (count * rate) / (last - first) : 0;
}
