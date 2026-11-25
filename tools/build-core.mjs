// Compila el núcleo C a WebAssembly con clang (sin libc, sin Emscripten).
// Salida: build/wasm/{core,core-probe,core-test}.wasm; core.wasm se copia a
//         web/public/wasm/ (se publica con la web).
//
// Uso: node tools/build-core.mjs [--debug] [core|core-probe|core-test ...]
//   Sin nombres compila los tres.
//   LLVM_BIN=<dir>      carpeta de clang/wasm-ld (por defecto C:\Program Files\LLVM\bin en
//                       Windows, o el PATH en el resto).
//   GB_BUILD_DIR=<dir>  salida alternativa (relativa a la raíz). Cada agente usa la suya
//                       para no pisar a los demás; con ella NO se copia nada a web/public.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "core", "src");
const custom = process.env.GB_BUILD_DIR;
const out = custom ? join(root, custom) : join(root, "build", "wasm");
const pub = custom ? null : join(root, "web", "public", "wasm");
const debug = process.argv.includes("--debug");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

function findClang() {
  const exe = process.platform === "win32" ? "clang.exe" : "clang";
  const dirs = [process.env.LLVM_BIN, process.platform === "win32" ? "C:\\Program Files\\LLVM\\bin" : null];
  for (const d of dirs) if (d && existsSync(join(d, exe))) return join(d, exe);
  return exe; // PATH
}

const clang = findClang();

const common = [
  "--target=wasm32",
  "-std=c99",
  "-ffreestanding",
  "-nostdlib",
  "-mbulk-memory",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-Wno-unused-function",
  debug ? "-O1" : "-O2",
  ...(debug ? ["-g", "-DGB_DEBUG"] : []),
  "-Wl,--no-entry",
  "-Wl,--stack-first",
  "-Wl,-z,stack-size=65536",
];

// sm83.c no se compila suelto: lo incluyen gbc.c y testbus.c (unity build, ver bus.h).
const machine = ["gbc.c", "ppu.c", "apu.c", "cart.c", "state.c", "debug.c"];

const targets = [
  { name: "core", files: machine, defs: [] },
  { name: "core-probe", files: machine, defs: ["-DGB_TEST_HOOKS", "-DGB_DEBUG"] },
  { name: "core-test", files: ["testbus.c"], defs: ["-DGB_DEBUG"] },
];

mkdirSync(out, { recursive: true });
if (pub) mkdirSync(pub, { recursive: true });
let failed = false;
for (const t of targets) {
  if (only.length && !only.includes(t.name)) continue;
  const dst = join(out, `${t.name}.wasm`);
  const args = [...common, ...t.defs, ...t.files.map((f) => join(src, f)), "-o", dst];
  const t0 = performance.now();
  try {
    execFileSync(clang, args, { stdio: "inherit" });
    const ms = (performance.now() - t0).toFixed(0);
    console.log(`${t.name}.wasm  ${statSync(dst).size} bytes  (${ms} ms)`);
    if (pub && t.name === "core") copyFileSync(dst, join(pub, "core.wasm"));
  } catch {
    console.error(`FALLO compilando ${t.name}.wasm`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
