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
// Una suite verificada deja un sello (.fetched) con su hash; con él no se vuelve a bajar.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
