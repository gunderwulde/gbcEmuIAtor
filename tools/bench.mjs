// Bench del núcleo (P1): ms/frame, MHz emulados y × tiempo real por escenario.
//
//   node tools/bench.mjs [opciones]
//     --frames N         frames por repetición (def. 128, múltiplo de 16: ciclo del "driver")
//     --repeats R        repeticiones cronometradas (def. 15); se informa la mediana
//     --warmup W         frames de calentamiento sin medir (def. 240)
//     --scenario S       heavy | idle (repetible; def. todos)
//     --wasm PATH        core.wasm a medir (repetible: A/B intercalado; def. $GB_BUILD_DIR
//                        o build/wasm). Con varios, se compara cada uno contra el primero.
//     --save-baseline    guarda el resultado del primer wasm en bench/baseline.json
//     --no-baseline      no compara con bench/baseline.json
//     --strict           sale con código 1 si algún escenario empeora > 2 %
//     --write-roms       escribe build/bench/<escenario>.gbc (para tools/run-rom.mjs)
//
// Además del tiempo imprime un hash del framebuffer y del audio al final: dos builds que
// den hashes distintos NO son equivalentes (una optimización no puede cambiarlos).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import { buildRom } from "../bench/rom.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(root, "bench", "baseline.json");
const DOT_HZ = 4194304;
const DOTS_PER_FRAME = 70224;
const FRAME_MS = 1000 * DOTS_PER_FRAME / DOT_HZ;   // 16,742 ms
const ALL = ["heavy", "idle"];

// ---- argumentos ----
const argv = process.argv.slice(2);
const opt = { frames: 128, repeats: 15, warmup: 240, scenarios: [], wasm: [], save: false, base: true, strict: false, writeRoms: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case "--frames": opt.frames = +argv[++i]; break;
    case "--repeats": opt.repeats = +argv[++i]; break;
    case "--warmup": opt.warmup = +argv[++i]; break;
    case "--scenario": opt.scenarios.push(argv[++i]); break;
    case "--wasm": opt.wasm.push(argv[++i]); break;
    case "--save-baseline": opt.save = true; break;
    case "--no-baseline": opt.base = false; break;
    case "--strict": opt.strict = true; break;
    case "--write-roms": opt.writeRoms = true; break;
    default: console.error(`opción desconocida: ${a}`); process.exit(2);
  }
}
if (!opt.scenarios.length) opt.scenarios = ALL;
for (const s of opt.scenarios) if (!ALL.includes(s)) { console.error(`escenario desconocido: ${s}`); process.exit(2); }
if (!opt.wasm.length) opt.wasm.push(join(process.env.GB_BUILD_DIR ?? join("build", "wasm"), "core.wasm"));
const wasmPaths = opt.wasm.map((p) => resolve(root, p));

const roms = Object.fromEntries(opt.scenarios.map((s) => [s, buildRom(s)]));
if (opt.writeRoms) {
  const out = join(root, "build", "bench");
  mkdirSync(out, { recursive: true });
  for (const [s, r] of Object.entries(roms)) writeFileSync(join(out, `${s}.gbc`), r);
  console.log(`ROMs en ${out}`);
}

// ---- utilidades ----
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2; };
function fnv(bytes, h = 0x811C9DC5) {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  return h;
}
const hex = (n) => n.toString(16).padStart(8, "0");

// Una máquina por (wasm, escenario): instancia propia, ROM cargada, calentada.
async function machine(path, scenario) {
  const { instance } = await WebAssembly.instantiate(readFileSync(path), {});
  const x = instance.exports;
  x.gb_init();
  const rom = roms[scenario];
  new Uint8Array(x.memory.buffer, x.gb_rom(), rom.length).set(rom);
  if (x.gb_insert(rom.length) !== 0) throw new Error("gb_insert falló");
  let audioHash = 0x811C9DC5, frames = 0;
  // Como el frontend: un gb_run_frame y un gb_audio(48000) por frame.
  const run = (n) => {
    for (let f = 0; f < n; f++) {
      if (x.gb_run_frame() !== 0) throw new Error("parada inesperada");
      const k = x.gb_audio(48000);
      audioHash = fnv(new Uint8Array(x.memory.buffer, x.gb_audio_buffer(), k * 8), audioHash);
    }
    frames += n;
  };
  const runTimed = (n) => {
    const t0 = performance.now();
    for (let f = 0; f < n; f++) { x.gb_run_frame(); x.gb_audio(48000); }
    frames += n;
    return performance.now() - t0;
  };
  return {
    x, run, runTimed,
    get frames() { return frames; },
    audioHash: () => audioHash,
  };
}

function check(m, scenario) {
  // Comprobaciones de que la ROM hace lo que dice (si no, el número no significa nada).
  const io = new Uint8Array(m.x.memory.buffer, m.x.gb_io(), 0x81);
  const errs = [];
  if (io[0x40] !== 0xF7) errs.push(`LCDC=${io[0x40].toString(16)}`);
  if ((io[0x26] & 0x8F) !== 0x8F) errs.push(`NR52=${io[0x26].toString(16)} (no suenan los 4 canales)`);
  if (!m.x.gb_cgb_mode()) errs.push("no está en modo CGB");
  const regs = new DataView(m.x.memory.buffer, m.x.gb_regs(), 20);
  if (regs.getUint8(17)) errs.push("CPU bloqueada (opcode ilegal)");
  if (errs.length) throw new Error(`${scenario}: ${errs.join(", ")}`);
}

// ---- medición ----
const results = {};   // results[wasm][scenario] = { msFrame: [...], fbHash, audioHash }
for (const p of wasmPaths) {
  if (!existsSync(p)) { console.error(`${p} no existe: npm run build:core`); process.exit(1); }
  results[p] = {};
}

console.log(`P1 bench — ${opt.frames} frames × ${opt.repeats} repeticiones (+${opt.warmup} de calentamiento), ` +
  `node ${process.version}, ${cpus()[0]?.model.trim() ?? "?"}`);

for (const s of opt.scenarios) {
  const ms = {};
  for (const p of wasmPaths) {
    ms[p] = await machine(p, s);
    // Primero unos frames con comprobación de audio (hash) y luego el calentamiento.
    ms[p].run(opt.warmup);
    check(ms[p], s);
    results[p][s] = { msFrame: [] };
  }
  // Intercalado: repetición r de cada wasm seguidas, para que la deriva térmica/del SO
  // afecte a todos por igual.
  for (let r = 0; r < opt.repeats; r++) {
    for (const p of wasmPaths) results[p][s].msFrame.push(ms[p].runTimed(opt.frames) / opt.frames);
  }
  for (const p of wasmPaths) {
    const m = ms[p];
    m.run(16);   // frames finales con hash de audio
    const fb = new Uint8Array(m.x.memory.buffer, m.x.gb_framebuffer(), 160 * 144 * 4);
    results[p][s].fbHash = hex(fnv(fb));
    results[p][s].audioHash = hex(m.audioHash());
    results[p][s].frames = m.frames;
  }
}

// ---- informe ----
const summary = (r) => {
  const med = median(r.msFrame);
  return { msFrame: +med.toFixed(4), minMs: +Math.min(...r.msFrame).toFixed(4),
    spread: +((Math.max(...r.msFrame) - Math.min(...r.msFrame)) / med * 100).toFixed(1),
    realtime: +(FRAME_MS / med).toFixed(2), mhz: +(DOT_HZ / 1e6 * FRAME_MS / med).toFixed(1),
    fbHash: r.fbHash, audioHash: r.audioHash };
};

let baseline = null;
if (opt.base && !opt.save && existsSync(BASELINE)) baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
// Los hashes se toman tras warmup + repeats×frames frames: sólo son comparables con la
// línea base si se midió con los mismos parámetros.
const sameParams = baseline?.params && baseline.params.frames === opt.frames &&
  baseline.params.repeats === opt.repeats && baseline.params.warmup === opt.warmup;

let regress = false;
const first = wasmPaths[0];
for (const p of wasmPaths) {
  console.log(`\n${relative(root, p)}`);
  console.log("  escenario   ms/frame   (mín)    disp.   × t.real   MHz(punto)   fb        audio     vs. " +
    (p === first ? (baseline ? "baseline" : "—") : relative(root, first)));
  for (const s of opt.scenarios) {
    const c = summary(results[p][s]);
    let ref = null;
    if (p !== first) ref = summary(results[first][s]);
    else if (baseline?.scenarios?.[s]) ref = baseline.scenarios[s];
    let delta = "";
    if (ref) {
      const d = (c.msFrame - ref.msFrame) / ref.msFrame * 100;
      delta = `${d >= 0 ? "+" : ""}${d.toFixed(1)} %`;
      if (d > 2) { delta += "  ← REGRESIÓN > 2 %"; regress = true; }
      else if (d < -2) delta += "  (mejora)";
      if (ref.fbHash && (p !== first || sameParams) && (ref.fbHash !== c.fbHash || ref.audioHash !== c.audioHash)) delta += "  ¡SALIDA DISTINTA!";
    }
    console.log(`  ${s.padEnd(10)}  ${c.msFrame.toFixed(4).padStart(8)}  ${c.minMs.toFixed(4).padStart(8)}  ` +
      `${(c.spread + "%").padStart(6)}  ${(c.realtime + "×").padStart(8)}  ${String(c.mhz).padStart(10)}   ` +
      `${c.fbHash}  ${c.audioHash}  ${delta}`);
  }
}
console.log(`\nObjetivo PLAN P1: ≥ 10× tiempo real (< ${(FRAME_MS / 10).toFixed(2)} ms/frame). ` +
  "disp. = (máx − mín)/mediana de las repeticiones.");

if (opt.save) {
  const out = {
    note: "Línea base de npm run bench. Regenerar con: node tools/bench.mjs --save-baseline",
    date: new Date().toISOString().slice(0, 10),
    machine: { cpu: cpus()[0]?.model.trim() ?? "?", node: process.version, platform: process.platform },
    params: { frames: opt.frames, repeats: opt.repeats, warmup: opt.warmup },
    wasm: relative(root, first).replaceAll("\\", "/"),
    scenarios: Object.fromEntries(opt.scenarios.map((s) => [s, summary(results[first][s])])),
  };
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + "\n");
  console.log(`línea base guardada en ${relative(root, BASELINE)}`);
}
if (opt.strict && regress) process.exit(1);
