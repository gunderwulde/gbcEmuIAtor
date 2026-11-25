// Descarga las suites de tests externas a tests/fixtures/ (en .gitignore) y verifica su
// SHA-256. Todo apunta a un commit fijo: si el contenido cambia, la verificación falla.
//
// Uso: node tools/fetch-tests.mjs [suite ...] [--force] [--print-hashes]
//   Sin nombres descarga todas. --force vuelve a descargar aunque ya estén.
//   --print-hashes descarga sin verificar e imprime los hashes para fijarlos aquí
//   (sólo al añadir una suite o mover su commit).
//
// Verificación:
//   - Ficheros sueltos: SHA-256 de cada uno.
//   - Suites de muchos ficheros (SingleStepTests): un único SHA-256 "de conjunto", el
//     SHA-256 del texto formado por las líneas "<nombre> <sha256 del fichero>\n" en orden
//     de nombre. Si no coincide se imprime el hash de cada fichero para localizar el fallo.
//   - Suites que salen de un .zip (c-sp/game-boy-test-roms): SHA-256 del .zip completo;
//     se extraen sólo los prefijos pedidos (o el mapa origen → destino).
// Una suite verificada deja un sello (.fetched) con su hash; con él no se vuelve a bajar.
// Lo descargado son datos: sólo se leen y se escriben a disco, nunca se ejecuta nada.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, normalize, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "tests", "fixtures");
const args = process.argv.slice(2);
const force = args.includes("--force");
const printHashes = args.includes("--print-hashes");
const only = args.filter((a) => !a.startsWith("--"));

const hex2 = (n) => n.toString(16).padStart(2, "0");

// SingleStepTests/sm83 v1: un JSON por opcode legal (base sin CB ni los 11 ilegales, y CB).
const SM83_ILLEGAL = [0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd];
const sm83Files = [];
for (let op = 0; op < 256; op++) {
  if (op !== 0xcb && !SM83_ILLEGAL.includes(op)) sm83Files.push(`${hex2(op)}.json`);
}
for (let op = 0; op < 256; op++) sm83Files.push(`cb ${hex2(op)}.json`);

const GBTR_ZIP = "https://github.com/c-sp/game-boy-test-roms/releases/download/v7.0/game-boy-test-roms-v7.0.zip";
const GBTR_SHA256 = "b9a9d7a1075aa35a3d07c07c34974048672d8520dca9e07a50178f5860c3832c";

const SUITES = [
  {
    name: "sm83",
    dir: "sm83/v1",
    base: "https://raw.githubusercontent.com/SingleStepTests/sm83/f9c30210245dd691661db39f5ace022c465ecc2f/v1/",
    files: sm83Files,
    setHash: "6ec4729f62a058b08ddcf068c1458a762d0779d275301d38f026fbeae368bca0",
  },
  {
    // Blargg (copia de retrio/gb-test-roms). Los runners están en tests/core (T1/C1).
    name: "blargg",
    dir: "blargg",
    base: "https://raw.githubusercontent.com/retrio/gb-test-roms/c240dd7d700e5c0b00a7bbba52b53e4ee67b5f15/",
    files: [
      "cpu_instrs/cpu_instrs.gb",
      "instr_timing/instr_timing.gb",
      "mem_timing/mem_timing.gb",
      "mem_timing-2/mem_timing.gb",
      "interrupt_time/interrupt_time.gb",
      "halt_bug.gb",
    ],
    hashes: {
      "cpu_instrs/cpu_instrs.gb": "8c5e12f41e0ba5bbca796944f92ffe6de28809198682c4332e38d1b3cf56fcf2",
      "instr_timing/instr_timing.gb": "646067b3d6c79fda810e9c3f1cb7c0efd5abb0a7ac06437c54e65720c15d9925",
      "mem_timing/mem_timing.gb": "791cb418fd054b482a6ada5017e2405b96c2373a0f3914c6b23afeee76fa98ce",
      "mem_timing-2/mem_timing.gb": "ab9daf4c51f417c468ad0a61dab66872cf8b5a50e6eb08d989b581d15f3cf461",
      "interrupt_time/interrupt_time.gb": "1a8f8f3bc609a92a5838214c00906c81e7cc77b3b9a63be5a1ec6d513f234929",
      "halt_bug.gb": "ddebfb81f992132954a5580e16cfb97346a4e061c762634d7701328e23fea7c6",
    },
  },
  // Compilación de ROMs ya ensambladas de c-sp/game-boy-test-roms v7.0 (mooneye, SameSuite,
  // Mealybug Tearoom con sus capturas de referencia, AGE, rtc3test, acid2, Blargg
  // cgb_sound). Las suites originales sólo publican fuente (salvo mooneye y acid2): esta
  // release las trae compiladas, con las imágenes esperadas al lado de cada ROM.
  {
    name: "gbtr",
    dir: "gbtr",
    zip: GBTR_ZIP,
    zipHash: GBTR_SHA256,
    prefixes: [
      "mooneye-test-suite/",
      "same-suite/",
      "mealybug-tearoom-tests/",
      "age-test-roms/",
      "rtc3test/",
      "blargg/cgb_sound/",
      // halt_bug e interrupt_time sólo dan el resultado en pantalla: capturas de referencia.
      "blargg/halt_bug-dmg-cgb.png",
      "blargg/interrupt_time/interrupt_time-cgb.png",
    ],
  },
  // acid2: en las rutas que espera tests/core/ppu/acid2.test.ts.
  {
    name: "cgb-acid2",
    dir: "cgb-acid2",
    zip: GBTR_ZIP,
    zipHash: GBTR_SHA256,
    map: { "cgb-acid2/cgb-acid2.gbc": "cgb-acid2.gbc", "cgb-acid2/cgb-acid2.png": "reference.png" },
  },
  {
    name: "dmg-acid2",
    dir: "dmg-acid2",
    zip: GBTR_ZIP,
    zipHash: GBTR_SHA256,
    map: { "dmg-acid2/dmg-acid2.gb": "dmg-acid2.gb", "dmg-acid2/dmg-acid2-cgb.png": "reference-cgb.png" },
  },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 3) throw new Error(`${url}: ${e.message}`);
    }
  }
}

// Lector mínimo de .zip (sin zip64 ni cifrado): directorio central → cabecera local →
// datos "stored" (0) o "deflate" (8). Devuelve Map<nombre, Uint8Array> de los ficheros
// (no directorios) cuyo nombre acepta `want`.
function readZip(buf, want) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 22 - 65535); p--) {
    if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd < 0) throw new Error("zip: no se encuentra el directorio central");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("zip: entrada central corrupta");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/") || !want(name)) continue;
    if (flags & 1) throw new Error(`zip: ${name} cifrado`);
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(`zip: cabecera local de ${name}`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? new Uint8Array(inflateRawSync(raw)) : null;
    if (!data) throw new Error(`zip: ${name} usa el método ${method}`);
    if (data.length !== usize) throw new Error(`zip: ${name} mide ${data.length}, se esperaba ${usize}`);
    out.set(name, data);
  }
  return out;
}

// Ruta de destino segura (relativa, sin "..") para un nombre sacado de un .zip.
function safeRel(name) {
  const n = normalize(name);
  if (isAbsolute(n) || n.startsWith("..") || n.includes(":")) throw new Error(`zip: ruta no válida ${name}`);
  return n;
}

const zipCache = new Map();
async function zipFiles(s) {
  if (!zipCache.has(s.zip)) {
    const data = await download(s.zip);
    const h = sha256(data);
    if (printHashes) console.log(`${s.name}: SHA-256 del zip ${h}`);
    else if (h !== s.zipHash) throw new Error(`SHA-256 del zip ${h}, se esperaba ${s.zipHash}`);
    zipCache.set(s.zip, data);
  }
  const buf = zipCache.get(s.zip);
  if (s.map) {
    const got = readZip(buf, (n) => n in s.map);
    for (const k of Object.keys(s.map)) if (!got.has(k)) throw new Error(`zip: falta ${k}`);
    return [...got].map(([k, v]) => [s.map[k], v]);
  }
  return [...readZip(buf, (n) => s.prefixes.some((pre) => n.startsWith(pre)))];
}

async function fetchSuite(s) {
  const dst = join(fixtures, s.dir);
  const stamp = join(dst, ".fetched");
  if (!force && existsSync(stamp)) {
    console.log(`${s.name}: ya descargada (${s.dir})`);
    return true;
  }
  const tmp = `${dst}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  if (s.zip) {
    const files = await zipFiles(s);
    for (const [name, data] of files) {
      const p = join(tmp, safeRel(name));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data);
    }
    writeFileSync(join(tmp, ".fetched"), `${s.zipHash}\n`);
    rmSync(dst, { recursive: true, force: true });
    renameSync(tmp, dst);
    console.log(`${s.name}: ${files.length} ficheros extraídos en ${s.dir}`);
    return true;
  }

  const sums = new Map();
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < s.files.length) {
      const f = s.files[next++];
      const data = await download(s.base + f.split("/").map(encodeURIComponent).join("/"));
      const p = join(tmp, f);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data);
      sums.set(f, sha256(data));
      if (++done % 50 === 0) console.log(`${s.name}: ${done}/${s.files.length}`);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));

  const names = [...sums.keys()].sort();
  const setHash = sha256(names.map((n) => `${n} ${sums.get(n)}\n`).join(""));
  let ok = true;
  if (printHashes) {
    console.log(`${s.name}: hash de conjunto ${setHash}`);
    for (const n of names) console.log(`  ${n} ${sums.get(n)}`);
  } else if (s.setHash) {
    if (setHash !== s.setHash) {
      ok = false;
      console.error(`${s.name}: SHA-256 de conjunto ${setHash}, se esperaba ${s.setHash}`);
      for (const n of names) console.error(`  ${n} ${sums.get(n)}`);
    }
  } else {
    for (const n of names) {
      if (sums.get(n) !== s.hashes[n]) {
        ok = false;
        console.error(`${s.name}: ${n} SHA-256 ${sums.get(n)}, se esperaba ${s.hashes[n]}`);
      }
    }
  }
  if (!ok) {
    rmSync(tmp, { recursive: true, force: true });
    return false;
  }
  writeFileSync(join(tmp, ".fetched"), `${setHash}\n`);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dirname(dst), { recursive: true });
  renameSync(tmp, dst);
  console.log(`${s.name}: ${s.files.length} ficheros verificados en ${s.dir}`);
  return true;
}

let failed = false;
for (const s of SUITES) {
  if (only.length && !only.includes(s.name)) continue;
  try {
    if (!(await fetchSuite(s))) failed = true;
  } catch (e) {
    console.error(`${s.name}: ${e.message}`);
    failed = true;
  }
}
if (only.some((n) => !SUITES.find((s) => s.name === n))) {
  console.error(`Suites conocidas: ${SUITES.map((s) => s.name).join(", ")}`);
  failed = true;
}
process.exit(failed ? 1 : 0);
