// Cabecera de cartucho (0100-014F) y checksums. TS puro, sin DOM, determinista.
// Referencia: docs/gbc-hardware.md §10.1 y Pan Docs "The Cartridge Header".

/**
 * Logo de la cabecera (0104-0133). Lo exige el hardware: la boot ROM lo compara byte a
 * byte y, si no coincide, se cuelga y el cartucho no arranca. Es una clave funcional de
 * interoperabilidad, no material decorativo, así que se guarda sólo aquí, como los 48
 * bytes que hay que escribir (igual que hacen rgbfix de RGBDS y el resto de toolchains
 * homebrew), y sólo lo usa el exportador: nunca se muestra en la UI ni se copia en los
 * tests (éstos lo comparan con el de ROMs de la comunidad descargadas con npm run fetch,
 * ver tests/export/header.test.ts). Formato: 48×8 píxeles a 1 bpp en bloques de 4×4
 * (cada nibble es una fila de 4 píxeles); el CGB sólo comprueba los 24 primeros bytes.
 */
export const LOGO: Uint8Array = hex(
  "CEED6666CC0D000B03730083000C000D0008111F8889000EDCCC6EE6DDDDD999BBBB67636E0EECCCDDDC999FBBB9333E",
);

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export type CgbMode = "dmg" | "cgb" | "cgbOnly";

/** Bandera CGB (0143): 80h = funciona también en DMG, C0h = sólo CGB. */
export const CGB_FLAG: Record<CgbMode, number> = { dmg: 0x00, cgb: 0x80, cgbOnly: 0xc0 };

export interface SectionInfo {
  kind: string;
  bank: number;
  addr: number;
  size: number;
}

export interface HeaderOptions {
  /** Título en ASCII (se pasa a mayúsculas). 15 caracteres, u 11 si hay `manufacturer`. */
  title: string;
  cgb: CgbMode;
  /** Tipo de cartucho (0147). Por defecto: 00h si cabe en 32 KB sin RAM; si no, MBC5. */
  cartType?: number;
  /** Código de tamaño de ROM (0148): 32 KB << n. Por defecto, el de la imagen. */
  romSize?: number;
  /** Código de tamaño de RAM (0149). Por defecto, deducido de las secciones SRAM. */
  ramSize?: number;
  /** Licencia nueva (0144-0145), 2 caracteres ASCII. Por defecto "00" (ninguna). */
  licensee?: string;
  /** Versión de la máscara (014C). */
  version?: number;
  /** Código de fabricante (013F-0142), 4 caracteres; reduce el título a 11. */
  manufacturer?: string;
  /** Destino (014A): 0 = Japón, 1 = resto. Por defecto 1. */
  destination?: 0 | 1;
  /** Secciones del ensamblador: las SRAM fijan el tamaño de RAM si no se da `ramSize`. */
  sections?: readonly SectionInfo[];
}

export interface HeaderIssue {
  level: "error" | "warning";
  msg: string;
}

export class HeaderError extends Error {
  constructor(public readonly issues: HeaderIssue[]) {
    super(issues.filter((i) => i.level === "error").map((i) => i.msg).join("; "));
  }
}

/** Lo que admite el núcleo (core/src/cart.c, cart_insert) y los límites de cada MBC
 *  (Pan Docs "MBC1/2/3/5"): código máximo de ROM y de RAM, y si lleva RAM. */
interface CartKind { name: string; maxRom: number; maxRam: number; ram: boolean; mbc2?: boolean }
const NONE = { maxRom: 0, maxRam: 2 };
const MBC1 = { maxRom: 6, maxRam: 3 };   // 2 MB, 32 KB (MBC1M fuera de alcance)
const MBC2 = { maxRom: 3, maxRam: 0 };   // 256 KB, RAM interna de 512×4 bits
const MBC3 = { maxRom: 6, maxRam: 3 };   // 2 MB, 32 KB (MBC30 fuera de alcance)
const MBC5 = { maxRom: 8, maxRam: 4 };   // 8 MB, 128 KB
export const CART_TYPES: ReadonlyMap<number, CartKind> = new Map<number, CartKind>([
  [0x00, { name: "ROM", ...NONE, ram: false }],
  [0x08, { name: "ROM+RAM", ...NONE, ram: true }],
  [0x09, { name: "ROM+RAM+BATTERY", ...NONE, ram: true }],
  [0x01, { name: "MBC1", ...MBC1, ram: false }],
  [0x02, { name: "MBC1+RAM", ...MBC1, ram: true }],
  [0x03, { name: "MBC1+RAM+BATTERY", ...MBC1, ram: true }],
  [0x05, { name: "MBC2", ...MBC2, ram: false, mbc2: true }],
  [0x06, { name: "MBC2+BATTERY", ...MBC2, ram: false, mbc2: true }],
  [0x0f, { name: "MBC3+TIMER+BATTERY", ...MBC3, ram: false }],
  [0x10, { name: "MBC3+TIMER+RAM+BATTERY", ...MBC3, ram: true }],
  [0x11, { name: "MBC3", ...MBC3, ram: false }],
  [0x12, { name: "MBC3+RAM", ...MBC3, ram: true }],
  [0x13, { name: "MBC3+RAM+BATTERY", ...MBC3, ram: true }],
  [0x19, { name: "MBC5", ...MBC5, ram: false }],
  [0x1a, { name: "MBC5+RAM", ...MBC5, ram: true }],
  [0x1b, { name: "MBC5+RAM+BATTERY", ...MBC5, ram: true }],
  [0x1c, { name: "MBC5+RUMBLE", ...MBC5, ram: false }],
  [0x1d, { name: "MBC5+RUMBLE+RAM", ...MBC5, ram: true }],
  [0x1e, { name: "MBC5+RUMBLE+RAM+BATTERY", ...MBC5, ram: true }],
]);

/** 0149: tamaño de RAM en bytes por código (01h no se usa). */
export const RAM_BYTES: readonly number[] = [0, 2048, 8192, 32768, 131072, 65536];
const RAM_KB = (code: number) => `${(RAM_BYTES[code] ?? 0) / 1024} KB`;

/** Bancos de 8 KB que usan las secciones SRAM → código de 0149 (0 si no hay). */
export function ramSizeForSections(sections: readonly SectionInfo[]): number {
  let banks = 0;
  for (const s of sections) if (s.kind === "SRAM" && s.size > 0) banks = Math.max(banks, s.bank + 1);
  if (banks === 0) return 0;
  if (banks === 1) return 2;
  if (banks <= 4) return 3;
  if (banks <= 8) return 5;
  return 4; // hasta 16 bancos = 128 KB (más: lo detecta la validación)
}

/** Código de 0148 para una imagen de `len` bytes: potencia de 2, mínimo 32 KB. */
export function romSizeCode(len: number): number {
  let code = 0;
  while ((0x8000 << code) < len) code++;
  return code;
}

/** Checksum de cabecera (014D): x = 0; para 0134..014C: x = x − rom[a] − 1. */
export function headerChecksum(rom: Uint8Array): number {
  let x = 0;
  for (let a = 0x134; a <= 0x14c; a++) x = (x - (rom[a] ?? 0) - 1) & 0xff;
  return x;
}

/** Checksum global (014E-014F): suma de 16 bits de todos los bytes salvo esos dos. */
export function globalChecksum(rom: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < rom.length; i++) s += rom[i]!;
  return (s - (rom[0x14e] ?? 0) - (rom[0x14f] ?? 0)) & 0xffff;
}

function asciiField(s: string, what: string, issues: HeaderIssue[]): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c > 0x7e) {
      issues.push({ level: "error", msg: `${what}: carácter no ASCII ${JSON.stringify(ch)}` });
      return [];
    }
    out.push(c);
  }
  return out;
}

/**
 * Valida opciones e imagen sin modificar nada. `fillHeader` lanza si hay errores; la UI
 * puede llamar a ésta antes para mostrar también los avisos.
 */
export function checkHeader(rom: Uint8Array, opts: HeaderOptions): HeaderIssue[] {
  return plan(rom, opts).issues;
}

interface Plan {
  issues: HeaderIssue[];
  title: number[];
  manufacturer: number[];
  licensee: number[];
  cartType: number;
  romCode: number;
  ramCode: number;
}

function plan(rom: Uint8Array, opts: HeaderOptions): Plan {
  const issues: HeaderIssue[] = [];
  const err = (msg: string) => issues.push({ level: "error", msg });
  const warn = (msg: string) => issues.push({ level: "warning", msg });

  if (rom.length > 8 << 20) err(`la imagen ocupa ${rom.length} bytes; el máximo es 8 MB`);
  if (!(opts.cgb in CGB_FLAG)) err(`modo CGB desconocido: ${String(opts.cgb)}`);

  // Título: 15 caracteres (0134-0142; 0143 es la bandera CGB) u 11 con código de fabricante.
  const manufacturer = asciiField((opts.manufacturer ?? "").toUpperCase(), "fabricante", issues);
  if (opts.manufacturer !== undefined && manufacturer.length !== 4)
    err(`el código de fabricante debe tener 4 caracteres (tiene ${manufacturer.length})`);
  const maxTitle = opts.manufacturer !== undefined ? 11 : 15;
  let title = asciiField(opts.title.toUpperCase(), "título", issues);
  if (title.length > maxTitle) {
    warn(`título recortado a ${maxTitle} caracteres`);
    title = title.slice(0, maxTitle);
  }

  const licensee = asciiField(opts.licensee ?? "00", "licencia", issues);
  if (licensee.length !== 2) err(`la licencia debe tener 2 caracteres (tiene ${licensee.length})`);
  const version = opts.version ?? 0;
  if (!Number.isInteger(version) || version < 0 || version > 255) err(`versión fuera de rango: ${version}`);

  const imageCode = romSizeCode(Math.max(rom.length, 1));
  let romCode = imageCode;
  if (opts.romSize !== undefined) {
    if (!Number.isInteger(opts.romSize) || opts.romSize < 0 || opts.romSize > 8) {
      err(`código de tamaño de ROM no válido: ${opts.romSize} (0-8)`);
    } else if (opts.romSize < imageCode) {
      err(`la imagen ocupa ${0x8000 << imageCode >> 10} KB pero el tamaño fijado es ${0x8000 << opts.romSize >> 10} KB`);
    } else romCode = opts.romSize;
  }

  let ramCode = opts.ramSize ?? ramSizeForSections(opts.sections ?? []);
  if (opts.sections && opts.ramSize !== undefined) {
    const need = ramSizeForSections(opts.sections);
    if ((RAM_BYTES[ramCode] ?? 0) < (RAM_BYTES[need] ?? 0))
      err(`las secciones SRAM necesitan ${RAM_KB(need)} pero el tamaño de RAM fijado es ${RAM_KB(ramCode)}`);
  }
  if (!Number.isInteger(ramCode) || ramCode < 0 || ramCode > 5 || ramCode === 1) {
    err(`código de tamaño de RAM no válido: ${ramCode} (0, 2-5)`);
    ramCode = 0;
  }

  // Tipo por defecto: sin MBC si cabe; si no, MBC5 (el único garantizado en doble velocidad).
  const cartType = opts.cartType ?? (romCode === 0 && ramCode === 0 ? 0x00 : ramCode ? 0x1b : 0x19);
  const kind = CART_TYPES.get(cartType);
  if (!kind) {
    err(`tipo de cartucho ${hex2(cartType)} no soportado por el emulador`);
  } else {
    if (romCode > kind.maxRom)
      err(`${kind.name} admite hasta ${0x8000 << kind.maxRom >> 10} KB de ROM; la imagen necesita ${0x8000 << romCode >> 10} KB`);
    if (kind.mbc2) {
      if (ramCode !== 0) err(`${kind.name} lleva RAM interna: el tamaño de RAM debe ser 0`);
    } else if (!kind.ram) {
      if (ramCode !== 0) err(`${kind.name} no tiene RAM pero se piden ${RAM_KB(ramCode)}`);
    } else if (ramCode === 0) {
      warn(`${kind.name} con tamaño de RAM 0: la RAM no se podrá usar`);
    } else if ((RAM_BYTES[ramCode] ?? 0) > (RAM_BYTES[kind.maxRam] ?? 0)) {
      err(`${kind.name} admite hasta ${RAM_KB(kind.maxRam)} de RAM; se piden ${RAM_KB(ramCode)}`);
    }
  }

  // Bytes del programa en 0104-014F: el exportador los sobrescribe.
  for (let a = 0x104; a < 0x150 && a < rom.length; a++) {
    const b = rom[a]!;
    if (b !== 0x00 && b !== 0xff) {
      warn(`hay datos en la zona de la cabecera (${hex4(a)}); se sobrescriben`);
      break;
    }
  }

  return { issues, title, manufacturer, licensee, cartType, romCode, ramCode };
}

const hex2 = (v: number) => `$${v.toString(16).toUpperCase().padStart(2, "0")}`;
const hex4 = (v: number) => `$${v.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Devuelve una copia de `rom` rellenada con FFh hasta la potencia de 2 (mínimo 32 KB, o
 * el tamaño fijado) y con la cabecera y los checksums completos. Lanza `HeaderError` si
 * la validación da errores (los avisos se obtienen con `checkHeader`).
 */
export function fillHeader(rom: Uint8Array, opts: HeaderOptions): Uint8Array {
  const p = plan(rom, opts);
  if (p.issues.some((i) => i.level === "error")) throw new HeaderError(p.issues);

  const out = new Uint8Array(0x8000 << p.romCode).fill(0xff);
  out.set(rom);

  // Entrada: se respeta la del programa salvo que esté vacía (NOP; JP $0150).
  const entry = out.subarray(0x100, 0x104);
  if (entry.every((b) => b === 0x00) || entry.every((b) => b === 0xff)) entry.set([0x00, 0xc3, 0x50, 0x01]);

  out.set(LOGO, 0x104);
  out.fill(0x00, 0x134, 0x143);
  out.set(p.title, 0x134);
  if (p.manufacturer.length) out.set(p.manufacturer, 0x13f);
  out[0x143] = CGB_FLAG[opts.cgb];
  out.set(p.licensee, 0x144);
  out[0x146] = 0x00; // SGB: no
  out[0x147] = p.cartType;
  out[0x148] = p.romCode;
  out[0x149] = p.ramCode;
  out[0x14a] = opts.destination ?? 1;
  out[0x14b] = 0x33; // licencia antigua: "usar la nueva" (0144-0145)
  out[0x14c] = opts.version ?? 0;
  out[0x14d] = headerChecksum(out);
  const g = globalChecksum(out);
  out[0x14e] = g >> 8;
  out[0x14f] = g & 0xff;
  return out;
}

/**
 * Comprueba una ROM ya hecha (importada o exportada): logo, checksums, tamaño y tipo.
 * La boot ROM sólo exige logo y checksum de cabecera (errores); el resto son avisos.
 */
export function validateCartridge(rom: Uint8Array): HeaderIssue[] {
  const issues: HeaderIssue[] = [];
  if (rom.length < 0x150) return [{ level: "error", msg: "fichero demasiado corto para tener cabecera" }];
  for (let i = 0; i < LOGO.length; i++) {
    if (rom[0x104 + i] !== LOGO[i]) {
      issues.push({ level: "error", msg: `logo de la cabecera incorrecto (${hex4(0x104 + i)})` });
      break;
    }
  }
  const hc = headerChecksum(rom);
  if (rom[0x14d] !== hc)
    issues.push({ level: "error", msg: `checksum de cabecera ${hex2(rom[0x14d]!)}, debería ser ${hex2(hc)}` });
  const gc = globalChecksum(rom);
  const stored = (rom[0x14e]! << 8) | rom[0x14f]!;
  if (stored !== gc)
    issues.push({ level: "warning", msg: `checksum global ${hex4(stored)}, debería ser ${hex4(gc)}` });
  const code = rom[0x148]!;
  if (code > 8) issues.push({ level: "warning", msg: `código de tamaño de ROM desconocido ${hex2(code)}` });
  else if (0x8000 << code !== rom.length)
    issues.push({ level: "warning", msg: `la cabecera indica ${0x8000 << code >> 10} KB y el fichero tiene ${rom.length} bytes` });
  if (!CART_TYPES.has(rom[0x147]!))
    issues.push({ level: "error", msg: `tipo de cartucho ${hex2(rom[0x147]!)} no soportado` });
  return issues;
}
