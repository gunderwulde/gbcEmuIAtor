// Banco de pruebas de las rutinas en ensamblador de la librería sin pasar por el
// compilador: un crt0 mínimo escrito a mano que cumple lo que docs/c-abi.md §5-6 promete
// (OAM sombra en C000h, rutina de OAM DMA en HRAM, __cur_bank, vector de VBlank a
// _gbc_vbl_isr, variables de gbc.c / stdlib.c) + el cuerpo del test, que llama a las
// funciones con la convención de pila (1.er argumento en A/HL, resto apilado de derecha
// a izquierda). Al acabar, LD B,B.
import { build } from "../../web/src/ui/run";
import { CLIB_FILES } from "../../web/src/clib";
import { DOTS_PER_SECOND, loadRom, now, runUntilLdBB, type Probe } from "../util/runners";

export type Arg = number | string;

/** Llamada con la convención de pila. `wide[i]` = el argumento i es de 16 bits (sólo
 *  importa para el primero: A o HL). */
export function call(fn: string, args: Arg[] = [], firstWide = false): string {
  const out: string[] = [];
  for (let i = args.length - 1; i >= 1; i--) out.push(`    ld hl, ${args[i]}`, "    push hl");
  if (args.length > 0) out.push(firstWide ? `    ld hl, ${args[0]}` : `    ld a, ${args[0]}`);
  out.push(`    call _${fn}`);
  if (args.length > 1) out.push(`    add sp, ${2 * (args.length - 1)}`);
  return out.join("\n");
}

const CRT0 = `
DEF HARNESS_RES EQU $DF00          ; resultados del test (WRAMX banco 1, fuera de la pila)

SECTION "h vec40", ROM0[$40]
    jp _gbc_vbl_isr
SECTION "h vec48", ROM0[$48]
    reti
SECTION "h vec50", ROM0[$50]
    reti
SECTION "h vec58", ROM0[$58]
    reti
SECTION "h vec60", ROM0[$60]
    reti

SECTION "h entry", ROM0[$100]
    nop
    jp HStart
    ds $150 - @, 0

SECTION "h shadow", WRAM0[$C000]
_shadow_oam:: ds 160
SECTION "h vars", WRAM0
HVars:
_vbl_count:: ds 2
_gbc_pad_prev:: ds 1
_gbc_tx:: ds 1
_gbc_ty:: ds 1
_gbc_tmap:: ds 1
_gbc_tattr:: ds 1
_gbc_tfont:: ds 1
_gbc_seed:: ds 2
_gbc_ime:: ds 1
HVarsEnd:
SECTION "h hram", HRAM
__cur_bank:: ds 1
__oam_dma_hram:: ds 8

SECTION "h start", ROM0
HDma:                       ; A = byte alto del origen; 160 ciclos M de espera
    ldh [$FF46], a
    ld a, 40
.w: dec a
    jr nz, .w
    ret
HDmaEnd:

HStart:
    di
    ld sp, $D000
    ld hl, _shadow_oam
    ld b, 160
    xor a
.z1: ld [hl+], a
    dec b
    jr nz, .z1
    ld hl, HVars
    ld b, HVarsEnd - HVars
.z2: ld [hl+], a
    dec b
    jr nz, .z2
    ld a, $E1
    ld [_gbc_seed], a
    ld a, $AC
    ld [_gbc_seed+1], a
    ld hl, __oam_dma_hram
    ld de, HDma
    ld b, HDmaEnd - HDma
.cp: ld a, [de]
    ld [hl+], a
    inc de
    dec b
    jr nz, .cp
    ld a, 1
    ldh [__cur_bank], a
    call HBody
    ld b, b
.end:                       ; sin DI: los tests de ei()/di() miran IME tras el LD B,B
    jr .end
`;

/** Guarda A en el resultado i. */
export const resA = (i: number): string => `    ld [$${(0xdf00 + i).toString(16)}], a`;
/** Guarda HL en los resultados i, i+1. */
export const resHL = (i: number): string =>
  `    ld a, l\n    ld [$${(0xdf00 + i).toString(16)}], a\n    ld a, h\n    ld [$${(0xdf01 + i).toString(16)}], a`;
/** db con los bytes dados. */
export const db = (bytes: number[]): string => `    db ${bytes.map((b) => `$${b.toString(16)}`).join(", ")}`;

export interface Harness {
  x: Probe;
  rom: Uint8Array;
  symbols: Map<string, { bank: number; addr: number }>;
  /** Byte en una dirección (sin efectos). */
  peek(addr: number): number;
  /** Resultado i (bytes desde DF00h). */
  res(i: number): number;
  res16(i: number): number;
  vram(bank: number, addr: number, len: number): number[];
  io(addr: number): number;
  /** Paletas: 64 BG + 64 OBJ, RGB555 LE. */
  pal(obj: boolean, n: number, idx: number): number;
  oam(): Uint8Array;
  ldbbAt: number;
}

/** Ensambla el cuerpo `body` (código que termina en RET, etiqueta HBody incluida) con la
 *  librería y lo ejecuta hasta el LD B,B. `extra` = secciones adicionales (datos). */
export async function runAsm(
  body: string,
  opts: { extra?: string; maxSeconds?: number; input?: (dots: number) => number } = {},
): Promise<Harness> {
  const lib = ["gbc.asm", "gbc_font.asm", "string.asm", "stdlib.asm"].map((f) => CLIB_FILES.get(f)!).join("\n");
  const src = `${CRT0}\nSECTION "h body", ROM0\nHBody:\n${body}\n    ret\n${opts.extra ?? ""}\n${lib}\n`;
  const b = build(src, { file: "harness.asm" });
  if (!b.ok) {
    const errs = b.result.errors.map((e) => `${e.file}:${e.line}: ${e.msg}`).concat(b.headerErrors);
    throw new Error(`no ensambla:\n${errs.slice(0, 20).join("\n")}`);
  }
  const rom = b.rom!;
  const x = await loadRom(rom);
  if (!runUntilLdBB(x, opts.maxSeconds ?? 5, opts.input)) throw new Error("sin LD B,B");
  const ldbbAt = now(x);
  const mem = () => new Uint8Array(x.memory.buffer);
  const h: Harness = {
    x,
    rom,
    symbols: b.result.symbols,
    ldbbAt,
    peek: (a) => x.gb_peek(a) & 0xff,
    res: (i) => x.gb_peek(0xdf00 + i) & 0xff,
    res16: (i) => (x.gb_peek(0xdf00 + i) & 0xff) | ((x.gb_peek(0xdf01 + i) & 0xff) << 8),
    vram: (bank, addr, len) => Array.from(mem().subarray(x.gb_vram() + bank * 0x2000 + (addr - 0x8000), x.gb_vram() + bank * 0x2000 + (addr - 0x8000) + len)),
    io: (a) => mem()[x.gb_io() + (a === 0xffff ? 0x80 : a - 0xff00)]!,
    pal: (obj, n, idx) => {
      const p = x.gb_palettes() + (obj ? 64 : 0) + n * 8 + idx * 2;
      return mem()[p]! | (mem()[p + 1]! << 8);
    },
    oam: () => mem().slice(x.gb_oam(), x.gb_oam() + 160),
  };
  return h;
}

export { DOTS_PER_SECOND };
