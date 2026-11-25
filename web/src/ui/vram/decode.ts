// Decodificación pura (sin DOM) de VRAM, OAM y paletas del CGB para los visores.
// Fuentes: docs/gbc-hardware.md §7 (PPU) y Pan Docs ("Tile Data", "BG Map Attributes",
// "OAM", "LCDC", "Palettes"). Sólo lee vistas de depuración: no tiene efectos.

export const BANK_SIZE = 0x2000;
export const TILE_BYTES = 16;
export const TILES_PER_BANK = 384;   // 8000-97FF
export const MAP_SIZE = 256;         // un mapa de 32×32 tiles son 256×256 píxeles
export const OAM_ENTRIES = 40;

/** Fila de un tile 2bpp: el byte bajo da el bit 0 del índice y el alto el bit 1; el bit
 *  7 es el píxel de la izquierda. Escribe 8 índices (0-3) en out[off..off+7]. */
export function decodeTileRow(lo: number, hi: number, out: Uint8Array, off = 0): void {
  for (let x = 0; x < 8; x++) {
    const sh = 7 - x;
    out[off + x] = ((lo >> sh) & 1) | (((hi >> sh) & 1) << 1);
  }
}

/** Tile `index` (0-383) del banco `bank` → 64 índices de color, fila a fila. */
export function decodeTile(vram: Uint8Array, bank: number, index: number): Uint8Array {
  const out = new Uint8Array(64);
  const base = bank * BANK_SIZE + index * TILE_BYTES;
  for (let y = 0; y < 8; y++) decodeTileRow(vram[base + y * 2]!, vram[base + y * 2 + 1]!, out, y * 8);
  return out;
}

/** Dirección (dentro del banco, 0000-17FF) del tile al que apunta una entrada de mapa.
 *  LCDC.4 = 1: 8000 + n·16 (sin signo); LCDC.4 = 0: 9000 + (int8)n·16. */
export function mapTileAddr(tileNum: number, lcdc: number): number {
  return lcdc & 0x10 ? tileNum * 16 : 0x1000 + ((tileNum << 24) >> 24) * 16;
}

/** Atributos de mapa del CGB (VRAM banco 1, misma posición que el nº de tile). */
export interface MapAttr {
  palette: number;   // bits 0-2: paleta BG 0-7
  bank: number;      // bit 3: banco de VRAM del tile
  xflip: boolean;    // bit 5
  yflip: boolean;    // bit 6
  priority: boolean; // bit 7: el fondo tapa a los sprites (si LCDC.0 = 1)
}

export function decodeAttr(b: number): MapAttr {
  return {
    palette: b & 7,
    bank: (b >> 3) & 1,
    xflip: (b & 0x20) !== 0,
    yflip: (b & 0x40) !== 0,
    priority: (b & 0x80) !== 0,
  };
}

/** Color RGB555 de una paleta: `pals` son los 128 bytes de gb_palettes (64 BG + 64 OBJ,
 *  little endian), `obj` elige el grupo, `pal` 0-7, `idx` 0-3. El bit 15 no existe. */
export function paletteColor(pals: Uint8Array, obj: boolean, pal: number, idx: number): number {
  const o = (obj ? 64 : 0) + pal * 8 + idx * 2;
  return (pals[o]! | (pals[o + 1]! << 8)) & 0x7fff;
}

/** RGB555 → RGBA empaquetado para un Uint32Array sobre ImageData (little endian: R en el
 *  byte bajo, A = FF). Sin corrección de color: cada canal c de 5 bits pasa a c<<3 | c>>2. */
export function rgb555ToRgba(c: number): number {
  const r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;
  const e = (v: number) => (v << 3) | (v >> 2);
  return (e(r) | (e(g) << 8) | (e(b) << 16) | 0xff000000) >>> 0;
}

export function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

/** Lo que hace falta para convertir un índice de color en RGB555. */
export interface ColorCtx {
  cgb: boolean;      // gb_cgb_mode: false = compatibilidad DMG
  pals: Uint8Array;  // gb_palettes (128 bytes)
  bgp: number;       // FF47
  obp0: number;      // FF48
  obp1: number;      // FF49
}

/** Color de fondo. En compatibilidad DMG el atributo no existe: BGP elige el tono, que
 *  indexa la paleta BG0 (docs §7.5). */
export function bgColor(ctx: ColorCtx, pal: number, idx: number): number {
  if (ctx.cgb) return paletteColor(ctx.pals, false, pal, idx);
  return paletteColor(ctx.pals, false, 0, (ctx.bgp >> (idx * 2)) & 3);
}

/** Color de sprite. CGB: paleta OBJ 0-7 del atributo. Compatibilidad: OBP0/OBP1 (bit 4
 *  del atributo) eligen el tono, que indexa OBJ0/OBJ1. */
export function objColor(ctx: ColorCtx, pal: number, idx: number): number {
  if (ctx.cgb) return paletteColor(ctx.pals, true, pal, idx);
  const obp = pal & 1 ? ctx.obp1 : ctx.obp0;
  return paletteColor(ctx.pals, true, pal & 1, (obp >> (idx * 2)) & 3);
}

/** Paleta para pintar la hoja de tiles: de fondo, de sprites o grises fijos. */
export type PalSel = { kind: "bg" | "obj"; index: number } | { kind: "gray" };

const GRAY = [0x7fff, 0x5294, 0x294a, 0x0000];

export function selColor(ctx: ColorCtx, sel: PalSel, idx: number): number {
  if (sel.kind === "gray") return GRAY[idx]!;
  return sel.kind === "bg" ? bgColor(ctx, sel.index, idx) : objColor(ctx, sel.index, idx);
}

/** Hoja de tiles de un banco: 16 tiles por fila × 24 filas = 128×192 píxeles RGBA. */
export const SHEET_W = 128;
export const SHEET_H = 192;

export function renderTileSheet(vram: Uint8Array, bank: number, ctx: ColorCtx, sel: PalSel, out: Uint32Array): void {
  const lut = [0, 1, 2, 3].map((i) => rgb555ToRgba(selColor(ctx, sel, i)));
  const row = new Uint8Array(8);
  for (let t = 0; t < TILES_PER_BANK; t++) {
    const base = bank * BANK_SIZE + t * TILE_BYTES;
    const ox = (t & 15) * 8, oy = (t >> 4) * 8;
    for (let y = 0; y < 8; y++) {
      decodeTileRow(vram[base + y * 2]!, vram[base + y * 2 + 1]!, row);
      const o = (oy + y) * SHEET_W + ox;
      for (let x = 0; x < 8; x++) out[o + x] = lut[row[x]!]!;
    }
  }
}

/** Entrada de mapa (nº de tile + atributo) en la celda (cx, cy) del mapa 0 (9800) o 1 (9C00). */
export function mapEntry(vram: Uint8Array, map: number, cx: number, cy: number): { offset: number; tile: number; attr: number } {
  const offset = (map ? 0x1c00 : 0x1800) + cy * 32 + cx;
  return { offset, tile: vram[offset]!, attr: vram[BANK_SIZE + offset]! };
}

/** Mapa completo (256×256 RGBA) con el direccionamiento de tiles de `lcdc` (bit 4) y, en
 *  modo CGB, los atributos (paleta, banco, volteos). En compatibilidad DMG se ignora el
 *  banco 1, como hace la PPU. Igual que render_pixel de la PPU, pero para todo el mapa. */
export function renderMap(vram: Uint8Array, map: number, lcdc: number, ctx: ColorCtx, out: Uint32Array): void {
  const row = new Uint8Array(8);
  const lut = new Uint32Array(32);
  for (let p = 0; p < 8; p++) for (let i = 0; i < 4; i++) lut[p * 4 + i] = rgb555ToRgba(bgColor(ctx, p, i));
  for (let cy = 0; cy < 32; cy++) {
    for (let cx = 0; cx < 32; cx++) {
      const { tile, attr: a } = mapEntry(vram, map, cx, cy);
      const attr = ctx.cgb ? a : 0;
      const base = ((attr >> 3) & 1) * BANK_SIZE + mapTileAddr(tile, lcdc);
      const pal = (attr & 7) * 4;
      for (let y = 0; y < 8; y++) {
        const ty = attr & 0x40 ? 7 - y : y;
        decodeTileRow(vram[base + ty * 2]!, vram[base + ty * 2 + 1]!, row);
        const o = (cy * 8 + y) * MAP_SIZE + cx * 8;
        for (let x = 0; x < 8; x++) out[o + x] = lut[pal + row[attr & 0x20 ? 7 - x : x]!]!;
      }
    }
  }
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Zona visible del fondo en el mapa: 160×144 desde (SCX, SCY), que se envuelve al pasar
 *  de 255. Devuelve de 1 a 4 rectángulos dentro de 256×256. */
export function viewportRects(scx: number, scy: number, w = 160, h = 144): Rect[] {
  const xs: Array<[number, number]> = scx + w > MAP_SIZE ? [[scx, MAP_SIZE - scx], [0, scx + w - MAP_SIZE]] : [[scx, w]];
  const ys: Array<[number, number]> = scy + h > MAP_SIZE ? [[scy, MAP_SIZE - scy], [0, scy + h - MAP_SIZE]] : [[scy, h]];
  const out: Rect[] = [];
  for (const [y, hh] of ys) for (const [x, ww] of xs) out.push({ x, y, w: ww, h: hh });
  return out;
}

/** Parte visible de la ventana en su mapa: empieza en (0,0) del mapa y se dibuja en
 *  pantalla desde (WX−7, WY). null si LCDC.5 = 0 o queda fuera de la pantalla. */
export function windowRect(lcdc: number, wx: number, wy: number): Rect | null {
  if (!(lcdc & 0x20) || wx > 166 || wy > 143) return null;
  const sx = Math.max(0, wx - 7);
  return { x: 0, y: 0, w: 160 - sx, h: 144 - wy };
}

/** Entrada de OAM decodificada. x/y son coordenadas de pantalla (Y−16, X−8). */
export interface OamEntry {
  index: number;
  y: number;
  x: number;
  tile: number;       // tal cual en OAM
  tiles: number[];    // tiles que se dibujan: 1 en 8×8; en 8×16, n&FE (arriba) y n|1
  height: 8 | 16;
  attr: number;
  palette: number;    // CGB: bits 0-2; compatibilidad DMG: bit 4 (OBP0/OBP1)
  bank: number;       // bit 3 (sólo CGB)
  xflip: boolean;     // bit 5
  yflip: boolean;     // bit 6
  behindBg: boolean;  // bit 7: detrás de los colores 1-3 del fondo
  visible: boolean;   // dentro de la pantalla (no garantiza que la PPU lo elija: 10/línea)
}

/** 40 entradas de 4 bytes (Y, X, tile, atributos). LCDC.2 elige 8×16. */
export function decodeOam(oam: Uint8Array, lcdc: number, cgb: boolean): OamEntry[] {
  const tall = (lcdc & 0x04) !== 0;
  const out: OamEntry[] = [];
  for (let i = 0; i < OAM_ENTRIES; i++) {
    const ry = oam[i * 4]!, rx = oam[i * 4 + 1]!, tile = oam[i * 4 + 2]!, attr = oam[i * 4 + 3]!;
    const height = tall ? 16 : 8;
    const y = ry - 16, x = rx - 8;
    out.push({
      index: i, y, x, tile,
      tiles: tall ? [tile & 0xfe, tile | 1] : [tile],
      height, attr,
      palette: cgb ? attr & 7 : (attr >> 4) & 1,
      bank: cgb ? (attr >> 3) & 1 : 0,
      xflip: (attr & 0x20) !== 0,
      yflip: (attr & 0x40) !== 0,
      behindBg: (attr & 0x80) !== 0,
      visible: x > -8 && x < 160 && y > -height && y < 144,
    });
  }
  return out;
}

/** Pinta un sprite (8×8 u 8×16) en out (ancho `stride`) en (ox, oy), con su paleta y
 *  volteos; el color 0 es transparente y se deja `bg`. */
export function renderSprite(vram: Uint8Array, e: OamEntry, ctx: ColorCtx, out: Uint32Array, stride: number, ox: number, oy: number, bg: number): void {
  const row = new Uint8Array(8);
  const lut = [0, 1, 2, 3].map((i) => rgb555ToRgba(objColor(ctx, e.palette, i)));
  const tile = e.height === 16 ? e.tile & 0xfe : e.tile;
  const base = e.bank * BANK_SIZE + tile * TILE_BYTES;
  for (let y = 0; y < e.height; y++) {
    const ty = e.yflip ? e.height - 1 - y : y;
    decodeTileRow(vram[base + ty * 2]!, vram[base + ty * 2 + 1]!, row);
    const o = (oy + y) * stride + ox;
    for (let x = 0; x < 8; x++) {
      const c = row[e.xflip ? 7 - x : x]!;
      out[o + x] = c ? lut[c]! : bg;
    }
  }
}
