// PPU-03/05 (parte DOC): imagen a partir de tiles, mapas, atributos, sprites y paletas
// montados a mano. El color esperado se calcula aquí a mano desde los datos de entrada
// (RGB555 → RGB888 con c << 3 | c >> 2, docs §7.6) y la paleta de compatibilidad de
// docs §7.5; nunca se lee del núcleo.
import { describe, expect, it } from "vitest";
import {
  boot, makeRom, pixel, pokeVram, probe, rgb, setColor, setRegs, type Probe,
} from "./probe";

// Tile con columnas de color 0,1,2,3,0,1,2,3 en todas las filas:
// bit bajo 01010101, bit alto 00110011.
const TILE_0123 = Array.from({ length: 8 }, () => [0x55, 0x33]).flat();
// Tile macizo de color 1 (bit bajo 1, alto 0) y de color 3.
const TILE_C1 = Array.from({ length: 8 }, () => [0xff, 0x00]).flat();
const TILE_C3 = Array.from({ length: 8 }, () => [0xff, 0xff]).flat();

// Paleta de compatibilidad (docs §7.5), en RGB888 escrito a mano.
const WHITE: [number, number, number] = [255, 255, 255];
const C_GREEN: [number, number, number] = [123, 255, 49];  // 1BEFh
const C_BLUE: [number, number, number] = [0, 99, 198];     // 6180h
const BLACK: [number, number, number] = [0, 0, 0];
const C_PINK: [number, number, number] = [255, 132, 132];  // 421Fh
const C_MAROON: [number, number, number] = [148, 57, 57];  // 1CF2h

async function setup(cgb: boolean): Promise<Probe> {
  const x = await probe();
  boot(x, makeRom(cgb));
  return x;
}

/** Dos frames completos con el estado ya montado (el primero puede estar a medias). */
function frames(x: Probe, n = 2): void {
  for (let i = 0; i < n; i++) x.gb_run_frame();
}

describe("compatibilidad DMG (cartucho sin bandera CGB)", () => {
  it("fondo: BGP elige el tono y la paleta de compatibilidad el color", async () => {
    const x = await setup(false);
    expect(x.gb_cgb_mode()).toBe(0);
    pokeVram(x, 0, 0x8010, TILE_0123);   // tile 1 (LCDC.4 = 1: 8000h sin signo)
    x.gb_poke(0x9800, 1);                // mapa 9800h, celda (0,0)
    setRegs(x, { bgp: 0xe4 });           // identidad 0,1,2,3
    frames(x);
    const row0 = Array.from({ length: 8 }, (_, i) => pixel(x, i, 0));
    expect(row0).toEqual([WHITE, C_GREEN, C_BLUE, BLACK, WHITE, C_GREEN, C_BLUE, BLACK]);
    expect(pixel(x, 3, 7)).toEqual(BLACK);
    expect(pixel(x, 3, 8)).toEqual(WHITE);  // la celda (0,1) es el tile 0 (vacío)
    expect(pixel(x, 8, 0)).toEqual(WHITE);
  });

  it("BGP del arranque (FCh): colores 1-3 → tono 3", async () => {
    const x = await setup(false);
    pokeVram(x, 0, 0x8010, TILE_0123);
    x.gb_poke(0x9800, 1);
    frames(x);
    expect([0, 1, 2, 3].map((i) => pixel(x, i, 0))).toEqual([WHITE, BLACK, BLACK, BLACK]);
  });

  it("SCX/SCY desplazan el fondo", async () => {
    const x = await setup(false);
    pokeVram(x, 0, 0x8010, TILE_0123);
    x.gb_poke(0x9800 + 32 + 1, 1);        // celda (1,1) → píxeles 8-15, líneas 8-15
    setRegs(x, { bgp: 0xe4, scx: 9, scy: 3 });
    frames(x);
    // Píxel de pantalla (0,5) = fondo (9,8): columna 1 del tile → color 1.
    expect(pixel(x, 0, 5)).toEqual(C_GREEN);
    expect(pixel(x, 2, 5)).toEqual(BLACK);   // fondo x=11 → columna 3
    expect(pixel(x, 0, 4)).toEqual(WHITE);   // fondo y=7 → celda (1,0) vacía
  });

  it("sprites: OBP0/OBP1, transparencia, prioridad BG y prioridad por X", async () => {
    const x = await setup(false);
    pokeVram(x, 0, 0x8010, TILE_C3);     // tile 1: fondo macizo color 3
    pokeVram(x, 0, 0x8020, TILE_C1);     // tile 2: sprite macizo color 1
    pokeVram(x, 0, 0x8030, TILE_0123);   // tile 3: sprite con columnas 0..3
    x.gb_poke(0x9800 + 2, 1);            // fondo color 3 en x = 16..23, líneas 0-7
    // OAM: Y, X, tile, atributos
    const oam = [
      [16, 8, 2, 0x00],        // 0: x 0..7, OBP0 color 1
      [16, 16 + 8, 2, 0x80],   // 1: sobre el fondo color 3 con prioridad BG → no se ve
      [24, 8, 3, 0x10],        // 2: línea 8, OBP1, columnas 0..3 (0 transparente)
      [32, 44, 2, 0x10],       // 3: línea 16, x 36..43, OBP1
      [32, 40, 3, 0x00],       // 4: línea 16, x 32..39, OBP0; X menor → gana en 36..39
    ];
    oam.forEach((o, i) => o.forEach((b, j) => x.gb_poke(0xfe00 + i * 4 + j, b)));
    setRegs(x, { lcdc: 0x93, bgp: 0xe4, obp0: 0xe4, obp1: 0x1b /* invierte: 3,2,1,0 */ });
    frames(x);
    expect(pixel(x, 0, 0)).toEqual(C_PINK);       // OBJ0 color 1
    expect(pixel(x, 16, 0)).toEqual(BLACK);       // el fondo (color 3) tapa al sprite 1
    // Sprite 2 con OBP1 = 1Bh: color 1 → tono 2, color 2 → tono 1, color 3 → tono 0.
    expect([0, 1, 2, 3].map((i) => pixel(x, i, 8))).toEqual([WHITE, C_MAROON, C_PINK, WHITE]);
    // Solape en 36..39: sprite 4 (X = 40, OBP0, columnas 4..7 = colores 0,1,2,3) tiene
    // prioridad sobre el 3 (X = 44, color 1 con OBP1 → tono 2) por tener X menor.
    // Donde el 4 es transparente se ve el 3.
    expect([36, 37, 38, 39, 40].map((i) => pixel(x, i, 16)))
      .toEqual([C_MAROON, C_PINK, C_MAROON, BLACK, C_MAROON]);
  });

  it("LCDC.0 = 0 en compatibilidad: fondo en blanco, sprites visibles", async () => {
    const x = await setup(false);
    pokeVram(x, 0, 0x8010, TILE_C3);
    pokeVram(x, 0, 0x8020, TILE_C1);
    x.gb_poke(0x9800, 1);
    [16, 16, 2, 0x80].forEach((b, j) => x.gb_poke(0xfe00 + j, b)); // x 8..15, prioridad BG
    setRegs(x, { lcdc: 0x92, bgp: 0xe4, obp0: 0xe4 });
    frames(x);
    expect(pixel(x, 0, 0)).toEqual(WHITE);
    expect(pixel(x, 8, 0)).toEqual(C_PINK);  // fondo "color 0" → el sprite gana
  });
});

describe("modo CGB", () => {
  // Colores RGB555 arbitrarios para las paletas.
  const P0 = [0x7fff, 0x03e0, 0x7c00, 0x001f];
  const P2 = [0x1234, 0x2345, 0x3456, 0x4567];
  const O0 = [0x0000, 0x0421, 0x0842, 0x0c63];
  const O1 = [0x0000, 0x5294, 0x56b5, 0x5ad6];

  async function cgbSetup(): Promise<Probe> {
    const x = await setup(true);
    expect(x.gb_cgb_mode()).toBe(1);
    P0.forEach((c, i) => setColor(x, 0, i, c));
    P2.forEach((c, i) => setColor(x, 2, i, c));
    O0.forEach((c, i) => setColor(x, 8, i, c));
    O1.forEach((c, i) => setColor(x, 9, i, c));
    return x;
  }

  it("paletas tras el arranque: todo blanco (docs §7.5)", async () => {
    const x = await setup(true);
    const pal = new Uint8Array(x.memory.buffer, x.gb_palettes(), 128);
    for (let i = 0; i < 128; i += 2) expect(pal[i]! | (pal[i + 1]! << 8)).toBe(0x7fff);
    frames(x);
    expect(pixel(x, 80, 72)).toEqual(WHITE);
  });

  it("atributos del mapa: paleta, volteo X/Y y banco de tile", async () => {
    const x = await cgbSetup();
    pokeVram(x, 0, 0x8010, TILE_0123);
    // Tile 1 del banco 1: fila 0 color 3 y el resto color 0 (para ver el volteo Y).
    pokeVram(x, 1, 0x8010, [0xff, 0xff, ...new Array(14).fill(0)]);
    x.gb_poke(0x9800, 1); pokeVram(x, 1, 0x9800, [0x00]);            // paleta 0
    x.gb_poke(0x9801, 1); pokeVram(x, 1, 0x9801, [0x22]);            // paleta 2, volteo X
    x.gb_poke(0x9802, 1); pokeVram(x, 1, 0x9802, [0x08]);            // banco 1
    x.gb_poke(0x9803, 1); pokeVram(x, 1, 0x9803, [0x48]);            // banco 1, volteo Y
    frames(x);
    expect([0, 1, 2, 3].map((i) => pixel(x, i, 0))).toEqual(P0.map(rgb));
    // Volteo X: columnas 8..15 = 3,2,1,0,3,2,1,0 con la paleta 2.
    expect([8, 9, 10, 11].map((i) => pixel(x, i, 0))).toEqual([3, 2, 1, 0].map((c) => rgb(P2[c]!)));
    expect(pixel(x, 16, 0)).toEqual(rgb(P0[3]!));
    expect(pixel(x, 16, 1)).toEqual(rgb(P0[0]!));
    expect(pixel(x, 24, 0)).toEqual(rgb(P0[0]!));
    expect(pixel(x, 24, 7)).toEqual(rgb(P0[3]!));
  });

  it("sprites: prioridad por índice de OAM, OPRI = 1 por X, paleta y banco CGB", async () => {
    const x = await cgbSetup();
    pokeVram(x, 0, 0x8020, TILE_C1);
    pokeVram(x, 1, 0x8030, TILE_0123);
    const oam = [
      [16, 12, 2, 0x01],   // 0: x 4..11, paleta OBJ 1, color 1
      [16, 8, 3, 0x08],    // 1: x 0..7, banco 1, paleta OBJ 0
    ];
    oam.forEach((o, i) => o.forEach((b, j) => x.gb_poke(0xfe00 + i * 4 + j, b)));
    setRegs(x, { lcdc: 0x93 });
    frames(x);
    // x 0..3: sólo el sprite 1 (colores 0..3; 0 → fondo, paleta BG 0 color 0)
    expect([0, 1, 2, 3].map((i) => pixel(x, i, 0)))
      .toEqual([rgb(P0[0]!), rgb(O0[1]!), rgb(O0[2]!), rgb(O0[3]!)]);
    // x 5: solape; gana el índice 0 (paleta OBJ 1 color 1)
    expect(pixel(x, 5, 0)).toEqual(rgb(O1[1]!));
    // Con OPRI = 1 gana la X menor (sprite 1, columna 5 → color 1, paleta OBJ 0)
    setRegs(x, { opri: 1 });
    frames(x);
    expect(pixel(x, 5, 0)).toEqual(rgb(O0[1]!));
    expect(pixel(x, 4, 0)).toEqual(rgb(O1[1]!)); // columna 4 del sprite 1 es color 0
  });

  it("prioridad: atributo BG.7, OBJ.7 y LCDC.0 como prioridad maestra", async () => {
    const x = await cgbSetup();
    pokeVram(x, 0, 0x8010, TILE_C3);
    pokeVram(x, 0, 0x8020, TILE_C1);
    x.gb_poke(0x9800, 1); pokeVram(x, 1, 0x9800, [0x80]); // fondo color 3, prioridad BG
    x.gb_poke(0x9801, 1);                                  // fondo color 3, sin prioridad
    x.gb_poke(0x9802, 0);                                  // fondo color 0
    const oam = [
      [16, 8, 2, 0x00],    // sobre celda 0 (BG.7 = 1) → gana el fondo
      [16, 16, 2, 0x80],   // sobre celda 1 con OBJ.7 → gana el fondo
      [16, 24, 2, 0x80],   // sobre celda 2 (color 0) → gana el sprite
      [24, 16, 2, 0x00],   // línea 8, celda (1,1) = tile 0 → sprite
    ];
    oam.forEach((o, i) => o.forEach((b, j) => x.gb_poke(0xfe00 + i * 4 + j, b)));
    setRegs(x, { lcdc: 0x93 });
    frames(x);
    expect(pixel(x, 0, 0)).toEqual(rgb(P0[3]!));
    expect(pixel(x, 8, 0)).toEqual(rgb(P0[3]!));
    expect(pixel(x, 16, 0)).toEqual(rgb(O0[1]!));
    // LCDC.0 = 0: los sprites siempre encima; el fondo se sigue dibujando.
    setRegs(x, { lcdc: 0x92 });
    frames(x);
    expect(pixel(x, 0, 0)).toEqual(rgb(O0[1]!));
    expect(pixel(x, 8, 0)).toEqual(rgb(O0[1]!));
    expect(pixel(x, 0, 1 + 8)).toEqual(rgb(P0[0]!));
    expect(pixel(x, 30, 0)).toEqual(rgb(P0[0]!));
  });

  it("ventana: WX/WY, mapa propio y contador de líneas interno", async () => {
    const x = await cgbSetup();
    pokeVram(x, 0, 0x8010, TILE_C3);
    // Mapa de la ventana en 9C00h: fila 0 tile 0, fila 1 tile 1.
    for (let i = 0; i < 32; i++) x.gb_poke(0x9c00 + 32 + i, 1);
    setRegs(x, { lcdc: 0xf1, wy: 20, wx: 7 + 40 });
    frames(x);
    expect(pixel(x, 39, 30)).toEqual(rgb(P0[0]!));  // a la izquierda de la ventana: fondo
    expect(pixel(x, 40, 27)).toEqual(rgb(P0[0]!));  // línea 7 de la ventana: fila 0 (tile 0)
    expect(pixel(x, 40, 28)).toEqual(rgb(P0[3]!));  // línea 8 de la ventana: fila 1 (tile 1)
    expect(pixel(x, 40, 19)).toEqual(rgb(P0[0]!));  // encima de WY
  });

  it("corrección de color (byuu/Near, docs §7.6): blanco → 240", async () => {
    const x = await setup(true);
    x.gb_set_color_correction(1);
    frames(x);
    expect(pixel(x, 0, 0)).toEqual([240, 240, 240]);
    x.gb_set_color_correction(0);
    frames(x);
    expect(pixel(x, 0, 0)).toEqual(WHITE);
  });
});
