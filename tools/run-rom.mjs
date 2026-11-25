// Ejecuta una ROM sin navegador y vuelca capturas PNG (diagnóstico, no es un test).
//
//   node tools/run-rom.mjs <rom> [frames=600] [salida=build/shot] [pulsaciones]
//
// pulsaciones: lista "frame:boton[:duracion]" separada por comas, p. ej.
//   "300:start,400:start,500:a:10"   (botones: right left up down a b select start)
// Se guarda una captura cada 60 frames y la final. Usa core.wasm de $GB_BUILD_DIR o build/wasm.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [romPath, framesArg = "600", outArg = "build/shot", pressArg = ""] = process.argv.slice(2);
if (!romPath) { console.error("uso: node tools/run-rom.mjs <rom> [frames] [salida] [pulsaciones]"); process.exit(1); }

const PAD = { right: 1, left: 2, up: 4, down: 8, a: 16, b: 32, select: 64, start: 128 };
const presses = pressArg ? pressArg.split(",").map((s) => {
  const [f, b, d = "5"] = s.split(":");
  if (!(b in PAD)) throw new Error(`botón desconocido: ${b}`);
  return { from: +f, to: +f + +d, bit: PAD[b] };
}) : [];

const wasmDir = join(root, process.env.GB_BUILD_DIR ?? join("build", "wasm"));
const { instance } = await WebAssembly.instantiate(readFileSync(join(wasmDir, "core.wasm")), {});
const x = instance.exports;
x.gb_init();
const rom = readFileSync(romPath);
new Uint8Array(x.memory.buffer, x.gb_rom(), rom.length).set(rom);
const err = x.gb_insert(rom.length);
if (err !== 0) { console.error(`gb_insert: ${err}`); process.exit(1); }
console.log(`modo ${x.gb_cgb_mode() ? "CGB" : "compatibilidad DMG"}`);

const out = join(root, outArg);
mkdirSync(out, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const shot = (name) => {
  const fb = new Uint8Array(x.memory.buffer, x.gb_framebuffer(), 160 * 144 * 4);
  writeFileSync(join(out, name), png(fb, 160, 144));
};

const frames = +framesArg;
const t0 = performance.now();
for (let f = 0; f < frames; f++) {
  let m = 0;
  for (const p of presses) if (f >= p.from && f < p.to) m |= p.bit;
  x.gb_joypad(m);
  const r = x.gb_run_frame();
  if (r !== 0) { console.log(`parada ${r} en frame ${f}`); break; }
  if ((f + 1) % 60 === 0) shot(`f${String(f + 1).padStart(5, "0")}.png`);
}
shot("final.png");
const ms = performance.now() - t0;
const regs = new DataView(x.memory.buffer, x.gb_regs(), 20);
console.log(`${frames} frames en ${ms.toFixed(0)} ms (${(frames / (ms / 1000)).toFixed(0)} fps, ` +
  `${((frames * 70224 / 4) / (ms / 1000) / 1e6).toFixed(2)} M ciclos M/s)`);
console.log(`PC=${regs.getUint16(10, true).toString(16)} SP=${regs.getUint16(8, true).toString(16)} ` +
  `banco=${x.gb_rom_bank()} halted=${regs.getUint8(14)} locked=${regs.getUint8(17)}`);
console.log(`capturas en ${out}`);
