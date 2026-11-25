// G1 · Decodificación de VRAM/OAM/paletas contra valores escritos a mano (Pan Docs:
// "Tile Data", "BG Map Attributes", "Object Attribute Memory", "LCDC", "Palettes").
import { describe, expect, it } from "vitest";
import {
  BANK_SIZE, MAP_SIZE, SHEET_W, bgColor, decodeAttr, decodeOam, decodeTile, decodeTileRow,
  mapTileAddr, objColor, paletteColor, renderMap, renderSprite, renderTileSheet, rgb555ToRgba,
  viewportRects, windowRect, type ColorCtx,
} from "../../../web/src/ui/vram/decode";

// Ejemplo de Pan Docs ("Tile Data"): 3C 7E 42 42 42 42 42 42 7E 5E 7E 0A 7C 56 38 7C
const PANDOCS_TILE = [0x3c, 0x7e, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x7e, 0x5e, 0x7e, 0x0a, 0x7c, 0x56, 0x38, 0x7c];
const PANDOCS_PIXELS = [
  "02333320",
  "03000030",
  "03000030",
  "03000030",
  "03133330",
  "01113130",
  "03131320",
  "02333200",
];

function ctxWith(pals: Uint8Array, cgb = true, bgp = 0xe4, obp0 = 0xe4, obp1 = 0xe4): ColorCtx {
  return { cgb, pals, bgp, obp0, obp1 };
}

function setColor(pals: Uint8Array, obj: boolean, pal: number, idx: number, c: number): void {
  const o = (obj ? 64 : 0) + pal * 8 + idx * 2;
  pals[o] = c & 0xff;
  pals[o + 1] = c >> 8;
}

describe("tiles 2bpp", () => {
  it("fila: bit bajo del byte 0, bit alto del byte 1, bit 7 a la izquierda", () => {
    const out = new Uint8Array(8);
    decodeTileRow(0b10100000, 0b11000001, out);
    expect([...out]).toEqual([3, 2, 1, 0, 0, 0, 0, 2]);
  });

  it("ejemplo de Pan Docs", () => {
    const vram = new Uint8Array(2 * BANK_SIZE);
    vram.set(PANDOCS_TILE, BANK_SIZE + 5 * 16); // banco 1, tile 5
    const px = decodeTile(vram, 1, 5);
    const rows = [];
    for (let y = 0; y < 8; y++) rows.push([...px.subarray(y * 8, y * 8 + 8)].join(""));
    expect(rows).toEqual(PANDOCS_PIXELS);
  });

  it("direccionamiento 8000 (LCDC.4=1) y 8800 con signo (LCDC.4=0)", () => {
    expect(mapTileAddr(0x00, 0x10)).toBe(0x0000);
    expect(mapTileAddr(0x80, 0x10)).toBe(0x0800);
    expect(mapTileAddr(0xff, 0x10)).toBe(0x0ff0);
    expect(mapTileAddr(0x00, 0x00)).toBe(0x1000);
    expect(mapTileAddr(0x7f, 0x00)).toBe(0x17f0);
    expect(mapTileAddr(0x80, 0x00)).toBe(0x0800);
    expect(mapTileAddr(0xff, 0x00)).toBe(0x0ff0);
  });
});

describe("atributos de mapa CGB", () => {
  it("bits 0-2 paleta, 3 banco, 5 X, 6 Y, 7 prioridad", () => {
    expect(decodeAttr(0x00)).toEqual({ palette: 0, bank: 0, xflip: false, yflip: false, priority: false });
    expect(decodeAttr(0x0d)).toEqual({ palette: 5, bank: 1, xflip: false, yflip: false, priority: false });
    expect(decodeAttr(0x27)).toEqual({ palette: 7, bank: 0, xflip: true, yflip: false, priority: false });
    expect(decodeAttr(0xc2)).toEqual({ palette: 2, bank: 0, xflip: false, yflip: true, priority: true });
    // El bit 4 no se usa en el CGB.
    expect(decodeAttr(0x10)).toEqual(decodeAttr(0x00));
  });
});

describe("color", () => {
  it("RGB555 → RGBA (c<<3 | c>>2, R en el byte bajo)", () => {
    expect(rgb555ToRgba(0x0000)).toBe(0xff000000);
    expect(rgb555ToRgba(0x7fff)).toBe(0xffffffff);
    expect(rgb555ToRgba(0x001f)).toBe(0xff0000ff);       // rojo puro
    expect(rgb555ToRgba(0x03e0)).toBe(0xff00ff00);       // verde puro
    expect(rgb555ToRgba(0x7c00)).toBe(0xffff0000);       // azul puro
    expect(rgb555ToRgba(0x0010)).toBe(0xff000084);       // r=16 → 128|4 = 0x84
    expect(rgb555ToRgba(0x0421)).toBe(0xff080808);       // 1,1,1 → 8
  });

  it("paletas: 64 BG + 64 OBJ little endian; el bit 15 se ignora", () => {
    const pals = new Uint8Array(128);
    pals[3 * 8 + 2 * 2] = 0x34; pals[3 * 8 + 2 * 2 + 1] = 0x92;   // BG3 color 2 = 9234
    pals[64 + 7 * 8 + 3 * 2] = 0xff; pals[64 + 7 * 8 + 3 * 2 + 1] = 0x7f; // OBJ7 color 3
    expect(paletteColor(pals, false, 3, 2)).toBe(0x1234);
    expect(paletteColor(pals, true, 7, 3)).toBe(0x7fff);
    expect(paletteColor(pals, true, 3, 2)).toBe(0);
  });

  it("modo CGB: el atributo elige la paleta", () => {
    const pals = new Uint8Array(128);
    setColor(pals, false, 4, 1, 0x1111);
    setColor(pals, true, 6, 3, 0x2222);
    const ctx = ctxWith(pals, true, 0x00, 0x00, 0x00);
    expect(bgColor(ctx, 4, 1)).toBe(0x1111);
    expect(objColor(ctx, 6, 3)).toBe(0x2222);
  });

  it("compatibilidad DMG: BGP/OBP0/OBP1 eligen el tono de BG0/OBJ0/OBJ1", () => {
    const pals = new Uint8Array(128);
    for (let i = 0; i < 4; i++) {
      setColor(pals, false, 0, i, 0x100 + i);
      setColor(pals, true, 0, i, 0x200 + i);
      setColor(pals, true, 1, i, 0x300 + i);
      setColor(pals, false, 5, i, 0x7777); // no debe usarse
    }
    // BGP = 1B (00 01 10 11): índice 0 → tono 3, 1 → 2, 2 → 1, 3 → 0.
    // OBP0 = E4 (identidad), OBP1 = 00 (todo tono 0).
    const ctx = ctxWith(pals, false, 0x1b, 0xe4, 0x00);
    expect([0, 1, 2, 3].map((i) => bgColor(ctx, 5, i))).toEqual([0x103, 0x102, 0x101, 0x100]);
    expect([0, 1, 2, 3].map((i) => objColor(ctx, 0, i))).toEqual([0x200, 0x201, 0x202, 0x203]);
    expect([0, 1, 2, 3].map((i) => objColor(ctx, 1, i))).toEqual([0x300, 0x300, 0x300, 0x300]);
  });
});

describe("mapas", () => {
  it("atributos: paleta, banco y volteos al pintar el mapa", () => {
    const vram = new Uint8Array(2 * BANK_SIZE);
    const pals = new Uint8Array(128);
    for (let i = 0; i < 4; i++) setColor(pals, false, 2, i, [0x0000, 0x001f, 0x03e0, 0x7c00][i]!);
    // Tile 1 del banco 1: fila 0 = 3 0 0 0 0 0 0 1, resto 0.
    vram[BANK_SIZE + 16] = 0b10000001;
    vram[BANK_SIZE + 17] = 0b10000000;
    // Mapa 1 (9C00), celda (2, 3): tile 1, atributo paleta 2 + banco 1 + volteo X e Y.
    const off = 0x1c00 + 3 * 32 + 2;
    vram[off] = 1;
    vram[BANK_SIZE + off] = 0x08 | 0x20 | 0x40 | 2;
    const out = new Uint32Array(MAP_SIZE * MAP_SIZE);
    renderMap(vram, 1, 0x10, ctxWith(pals), out);
    const at = (x: number, y: number) => out[(3 * 8 + y) * MAP_SIZE + 2 * 8 + x];
    // Volteo Y: la fila 0 del tile aparece en la fila 7; volteo X: el 3 pasa a la derecha.
    expect(at(7, 7)).toBe(rgb555ToRgba(0x7c00));
    expect(at(0, 7)).toBe(rgb555ToRgba(0x001f));
    expect(at(3, 7)).toBe(rgb555ToRgba(0x0000));
    expect(at(7, 0)).toBe(rgb555ToRgba(0x0000));
  });

  it("compatibilidad DMG: se ignoran los atributos del banco 1", () => {
    const vram = new Uint8Array(2 * BANK_SIZE);
    const pals = new Uint8Array(128);
    setColor(pals, false, 0, 0, 0x0001);
    setColor(pals, false, 0, 3, 0x0003);
    vram[0x1000] = 0x80; vram[0x1001] = 0x80;     // tile 0 (modo 8800): píxel (0,0) = 3
    vram[BANK_SIZE + 0x1800] = 0x7f;               // atributo que en CGB voltearía y cambiaría todo
    const out = new Uint32Array(MAP_SIZE * MAP_SIZE);
    renderMap(vram, 0, 0x00, ctxWith(pals, false, 0xe4), out);
    expect(out[0]).toBe(rgb555ToRgba(0x0003));
    expect(out[1]).toBe(rgb555ToRgba(0x0001));
  });

  it("zona visible: se envuelve en 256", () => {
    expect(viewportRects(0, 0)).toEqual([{ x: 0, y: 0, w: 160, h: 144 }]);
    expect(viewportRects(200, 0)).toEqual([{ x: 200, y: 0, w: 56, h: 144 }, { x: 0, y: 0, w: 104, h: 144 }]);
    expect(viewportRects(96, 112)).toEqual([{ x: 96, y: 112, w: 160, h: 144 }]);
    expect(viewportRects(100, 200)).toEqual([
      { x: 100, y: 200, w: 156, h: 56 }, { x: 0, y: 200, w: 4, h: 56 },
      { x: 100, y: 0, w: 156, h: 88 }, { x: 0, y: 0, w: 4, h: 88 },
    ]);
  });

  it("ventana: (WX−7, WY) en pantalla, desde (0,0) de su mapa", () => {
    expect(windowRect(0x00, 7, 0)).toBeNull();               // LCDC.5 = 0
    expect(windowRect(0x20, 7, 0)).toEqual({ x: 0, y: 0, w: 160, h: 144 });
    expect(windowRect(0x20, 95, 40)).toEqual({ x: 0, y: 0, w: 72, h: 104 });
    expect(windowRect(0x20, 3, 100)).toEqual({ x: 0, y: 0, w: 160, h: 44 });
    expect(windowRect(0x20, 167, 0)).toBeNull();
    expect(windowRect(0x20, 7, 144)).toBeNull();
  });
});

describe("OAM", () => {
  const oam = new Uint8Array(160);
  oam.set([16, 8, 0x42, 0x00], 0);          // esquina superior izquierda
  oam.set([0, 0, 0x01, 0xff], 4);           // fuera de pantalla, todos los bits
  oam.set([100, 50, 0x43, 0x1a], 8);        // CGB: paleta 2, banco 1; DMG: OBP1

  it("8×8: Y−16, X−8 y atributos", () => {
    const e = decodeOam(oam, 0x00, true);
    expect(e).toHaveLength(40);
    expect(e[0]).toMatchObject({ index: 0, y: 0, x: 0, tile: 0x42, tiles: [0x42], height: 8, visible: true });
    expect(e[1]).toMatchObject({ y: -16, x: -8, palette: 7, bank: 1, xflip: true, yflip: true, behindBg: true, visible: false });
    expect(e[2]).toMatchObject({ y: 84, x: 42, palette: 2, bank: 1, xflip: false, behindBg: false });
  });

  it("8×16 (LCDC.2): tiles n&FE y n|1", () => {
    const e = decodeOam(oam, 0x04, true);
    expect(e[0]).toMatchObject({ height: 16, tiles: [0x42, 0x43] });
    expect(e[2]).toMatchObject({ height: 16, tiles: [0x42, 0x43] });
  });

  it("compatibilidad DMG: bit 4 = OBP1, sin banco", () => {
    const e = decodeOam(oam, 0x00, false);
    expect(e[2]).toMatchObject({ palette: 1, bank: 0 });
    expect(e[0]).toMatchObject({ palette: 0 });
  });

  it("visibilidad en los bordes", () => {
    const o = new Uint8Array(160);
    o.set([9, 1, 0, 0], 0);       // y = −7, x = −7: asoma una fila y una columna
    o.set([8, 8, 0, 0], 4);       // y = −8: oculto en 8×8, visible en 8×16
    o.set([160, 168, 0, 0], 8);   // y = 144: oculto
    const s = decodeOam(o, 0x00, true), t = decodeOam(o, 0x04, true);
    expect([s[0]!.visible, s[1]!.visible, s[2]!.visible]).toEqual([true, false, false]);
    expect(t[1]!.visible).toBe(true);
  });

  it("sprite 8×16 con volteo Y y color 0 transparente", () => {
    const vram = new Uint8Array(2 * BANK_SIZE);
    const pals = new Uint8Array(128);
    setColor(pals, true, 3, 1, 0x001f);
    vram[BANK_SIZE + 0x11 * 16 + 7 * 2] = 0x80;   // tile 11h (mitad baja), fila 7, píxel 0 = 1
    const o = new Uint8Array(160);
    o.set([16, 8, 0x11, 0x48 | 3], 0);            // banco 1, volteo Y, paleta 3; 8×16 → tile 10h
    const [e] = decodeOam(o, 0x04, true);
    const out = new Uint32Array(8 * 16).fill(0x12345678);
    renderSprite(vram, e!, ctxWith(pals), out, 8, 0, 0, 0x12345678);
    // Fila 15 del sprite (tile 11h, fila 7) pasa a la fila 0 con el volteo.
    expect(out[0]).toBe(rgb555ToRgba(0x001f));
    expect(out[1]).toBe(0x12345678);
    expect(out.filter((v) => v !== 0x12345678)).toHaveLength(1);
  });
});

describe("hoja de tiles", () => {
  it("16 tiles por fila; tile 17 en (8, 8); paleta elegida", () => {
    const vram = new Uint8Array(2 * BANK_SIZE);
    const pals = new Uint8Array(128);
    setColor(pals, true, 5, 2, 0x03e0);
    vram[17 * 16] = 0x00; vram[17 * 16 + 1] = 0x80;   // tile 17, píxel (0,0) = 2
    const out = new Uint32Array(SHEET_W * 192);
    renderTileSheet(vram, 0, ctxWith(pals), { kind: "obj", index: 5 }, out);
    expect(out[8 * SHEET_W + 8]).toBe(rgb555ToRgba(0x03e0));
    expect(out[8 * SHEET_W + 9]).toBe(rgb555ToRgba(0x0000));
    renderTileSheet(vram, 0, ctxWith(pals), { kind: "gray" }, out);
    expect(out[8 * SHEET_W + 8]).toBe(rgb555ToRgba(0x294a));
  });
});
