// La aventura (AV) en el núcleo real: se juega con el joypad grabado (pulsaciones con su
// duración en frames) y se mira lo que se ve: el mapa en VRAM, la OAM y el marcador de
// la ventana. Los valores esperados salen del diseño del mapa (los comentarios de
// world.c y la tabla de abajo), calculados a mano:
//
//  - Metatile n de gfx.c → tiles 96 + 4n … 96 + 4n + 3. Hierba = bloque 0 (tile 96),
//    árbol = 1 (100), agua = 2 (104), puerta = 7 (124), llave = 8 (128), losa = 5 (116),
//    corazón del marcador = 144, corazón vacío = 145, llave del marcador = 146.
//  - Metatile (c, f) de la pantalla → tile (2c, 2f) del mapa 9800h.
//  - Caja de los pies del jugador: x+2…x+13, y+6…y+15; centro para recoger: (x+8, y+10).
//  - Se empieza en la pantalla 5 en (64, 80).
import { describe, expect, it } from "vitest";
import { FRAME, buildC, start, type CBuild, type CMachine } from "../c-harness";
import { adventureFiles } from "./files";

const SEC = 4194304;
const J = { RIGHT: 1, LEFT: 2, UP: 4, DOWN: 8, A: 16, B: 32, SELECT: 64, START: 128 };
const GRASS = 96, TREE = 100, WATER = 104, FLOOR = 116, DOOR = 124, KEY = 128;
const HEART = 144, HEART_OFF = 145, HUD_KEY = 146;

let built: CBuild | undefined;
const rom = (): CBuild => (built ??= buildC(adventureFiles(), "main.c"));

const frames = (m: CMachine, n: number, input?: (t: number) => number) => m.run((n * FRAME) / SEC, input);
function press(m: CMachine, mask: number, n = 3, after = 3): void {
  frames(m, n, () => mask);
  frames(m, after);
}
const bgTile = (m: CMachine, x: number, y: number) => m.vram(0, 0x9800 + y * 32 + x, 1)[0];
/** Los 4 tiles de un metatile (c, f) del campo de juego. */
const cell = (m: CMachine, c: number, f: number) => [
  ...m.vram(0, 0x9800 + 2 * f * 32 + 2 * c, 2),
  ...m.vram(0, 0x9800 + (2 * f + 1) * 32 + 2 * c, 2),
];
const block = (t: number) => [t, t + 1, t + 2, t + 3];
const hud = (m: CMachine, row: number) => m.text(0x9c00, 0, row, 20);
/** Posición del jugador según la OAM (sprite 0: Y+16, X+8). */
const oamPos = (m: CMachine) => [m.oam()[1]! - 8, m.oam()[0]! - 16];
const pos = (m: CMachine) => [m.peek(m.sym("_px")), m.peek(m.sym("_py"))];
const screen = (m: CMachine) => m.peek(m.sym("_screen"));

/** Mantiene `mask` hasta que `done()` o hasta `max` frames; devuelve los frames usados. */
function holdUntil(m: CMachine, mask: number, done: () => boolean, max = 400): number {
  for (let i = 0; i < max; i++) {
    if (done()) return i;
    frames(m, 1, () => mask);
  }
  throw new Error(`no se llegó en ${max} frames (pos ${pos(m)}, pantalla ${screen(m)})`);
}

async function newGame(sav?: Uint8Array): Promise<CMachine> {
  const m = await start(rom(), sav);
  frames(m, 10);
  press(m, J.START, 3, 10);
  return m;
}

/** .sav escrito a mano con el formato de save.c. */
function makeSav(scr: number, x: number, y: number, hp: number, keys: number, flags: Record<number, number> = {}): Uint8Array {
  const s = new Uint8Array(8192);
  s.set([0x4d, 0x53, 0x47, 0x4f, 1, scr, x, y, hp, keys]);
  for (const [k, v] of Object.entries(flags)) s[10 + Number(k)] = v;
  return s;
}

describe("aventura: datos", () => {
  it("compila sin errores ni avisos en una ROM de 64 KB (bancos 0-3) con RAM con pila", () => {
    const b = rom();
    expect(b.rom.length).toBe(65536);
    expect(b.rom[0x147]).toBe(0x1b);                        // MBC5 + RAM + pila
    expect(b.rom[0x148]).toBe(1);                           // 64 KB
    expect(b.symbols.get("_world_load")!.bank).toBe(2);
    expect(b.symbols.get("_gfx_load")!.bank).toBe(3);
    // Checksum de cabecera (0134h-014Ch) y global.
    let x = 0;
    for (let i = 0x134; i <= 0x14c; i++) x = (x - b.rom[i]! - 1) & 0xff;
    expect(b.rom[0x14d]).toBe(x);
    let g = 0;
    for (let i = 0; i < b.rom.length; i++) if (i !== 0x14e && i !== 0x14f) g = (g + b.rom[i]!) & 0xffff;
    expect((b.rom[0x14e]! << 8) | b.rom[0x14f]!).toBe(g);
  });

  it("dibujos de 16×16 y mapas de 10×8 sin caracteres de más ni de menos", () => {
    const files = adventureFiles();
    const strings = (src: string, decl: string) => {
      const body = src.slice(src.indexOf(decl), src.indexOf(";", src.indexOf(decl)));
      return [...body.matchAll(/"([^"]*)"/g)].map((r) => r[1]!);
    };
    const art = [...files.get("tiles.asm")!.matchAll(/^ +dw (.*)$/gm)].flatMap((r) => r[1]!.split(/, */));
    for (const row of art) expect(row[0]).toBe("`");
    expect(art.length).toBe(25 * 4 * 8);                     // 25 bloques × 4 tiles × 8 filas
    for (const row of art) expect(row).toMatch(/^`[0123]{8}$/);
    const map = strings(files.get("world.c")!, "const char world_map[]");
    expect(map.length).toBe(24 * 8);
    for (const row of map) expect(row).toMatch(/^[.T~RDKHS,#dkhUsbzvX]{10}$/);
  });
});

describe("aventura: partida", () => {
  it("título, movimiento, muro, cambio de pantalla, llave, puerta, cripta y partida guardada", async () => {
    const m = await start(rom());
    frames(m, 10);                                         // el título sale en ≤ 10 frames
    // Tile 96 (hierba), fila 1 "..1.....": plano bajo 20h, alto 00h.
    expect(m.vram(0, 0x8000 + 96 * 16 + 2, 2)).toEqual([0x20, 0x00]);
    expect(m.text(0x9800, 5, 3, 9)).toBe("M U S G O");
    expect(m.text(0x9800, 0, 5, 20)).toBe("LA CRIPTA DEL LIQUEN");
    expect(m.text(0x9800, 2, 11, 12)).toBe("START  JUGAR");   // SRAM vacía: sin firma
    press(m, J.START, 3, 10);

    // Pantalla 5. Marcador: 5 corazones, 0 llaves.
    expect(screen(m)).toBe(5);
    expect(m.vram(0, 0x9c00 + 1, 5)).toEqual([HEART, HEART, HEART, HEART, HEART]);
    expect(m.vram(0, 0x9c00 + 8, 1)).toEqual([HUD_KEY]);
    expect(hud(m, 0).slice(9, 11)).toBe("x0");
    expect(hud(m, 1)).toBe(" BOSQUE  05         ");
    expect(m.io(0xff40) & 0x60).toBe(0x60);                // ventana encendida, mapa 9C00h
    expect(m.io(0xff4a)).toBe(128);
    // Fila 5 de la pantalla 5: "T.....~~.T".
    expect(cell(m, 0, 5)).toEqual(block(TREE));
    expect(cell(m, 4, 5)).toEqual(block(GRASS));
    expect(cell(m, 6, 5)).toEqual(block(WATER));
    expect(oamPos(m)).toEqual([64, 80]);

    // Derecha: el agua de la columna 6 (x 96…) para los pies en x + 13 = 95 → x = 82.
    frames(m, 5, () => J.RIGHT);
    const x0 = pos(m)[0]!;
    frames(m, 10, () => J.RIGHT);
    expect(pos(m)).toEqual([x0 + 10, 80]);                 // 1 píxel por frame
    frames(m, 40, () => J.RIGHT);
    expect(oamPos(m)).toEqual([82, 80]);
    frames(m, 3);

    // Vuelta a x = 64 y arriba por la columna 4 (libre hasta el borde) → pantalla 1.
    holdUntil(m, J.LEFT, () => pos(m)[0] === 64);
    expect(bgTile(m, 8, 0)).toBe(GRASS);                   // salida de arriba de la 5
    // El cambio de pantalla no puede parar el juego más de 2 frames: vueltas del bucle
    // frente a frames transcurridos (por ciclos; con el LCD apagado no hay VBlank).
    const t0 = m.now(), f0 = m.peek16(m.sym("_frames_run"));
    holdUntil(m, J.UP, () => screen(m) === 1);
    frames(m, 3);
    const elapsed = Math.round((m.now() - t0) / FRAME);
    expect(elapsed - (m.peek16(m.sym("_frames_run")) - f0)).toBeLessThanOrEqual(2);
    expect(pos(m)).toEqual([64, 112]);
    expect(cell(m, 4, 0)).toEqual(block(TREE));            // fila 0 de la 1: todo árboles
    expect(cell(m, 4, 7)).toEqual(block(GRASS));           // su salida de abajo
    expect(cell(m, 4, 1)).toEqual(block(KEY));             // la llave en (4, 1)
    expect(hud(m, 1)).toBe(" BOSQUE  01         ");

    // Arriba hasta el árbol de la fila 0: y + 6 = 16 → y = 10; el centro (y + 10 = 20)
    // pisa la llave de la fila 1 por el camino.
    holdUntil(m, J.UP, () => pos(m)[1] === 10);
    frames(m, 20, () => J.UP);
    expect(pos(m)).toEqual([64, 10]);
    frames(m, 3);
    expect(cell(m, 4, 1)).toEqual(block(GRASS));
    expect(hud(m, 0).slice(9, 11)).toBe("x1");

    // Abajo a la 5, a las filas 3-4 (y = 56) y a la derecha → pantalla 6, x = 0.
    holdUntil(m, J.DOWN, () => screen(m) === 5);
    expect(pos(m)).toEqual([64, 0]);
    holdUntil(m, J.DOWN, () => pos(m)[1] === 56);
    holdUntil(m, J.RIGHT, () => screen(m) === 6);
    frames(m, 3);
    expect(pos(m)).toEqual([0, 56]);
    expect(cell(m, 5, 4)).toEqual(block(DOOR));            // "...RRDRR.."
    // Columna 1, abajo a la fila 5 (y = 76), derecha bajo la puerta (x = 80).
    holdUntil(m, J.RIGHT, () => pos(m)[0] === 16);
    holdUntil(m, J.DOWN, () => pos(m)[1] === 76);
    holdUntil(m, J.RIGHT, () => pos(m)[0] === 80);
    // Arriba: los pies tocan la fila 4 en y + 6 = 79 → para en y = 74 y abre con la llave.
    frames(m, 4, () => J.UP);
    frames(m, 3);
    // (en los frames que quedan con UP pulsado ya entra por la puerta abierta)
    expect(pos(m)[0]).toBe(80);
    expect(pos(m)[1]).toBeGreaterThanOrEqual(71);
    expect(pos(m)[1]).toBeLessThanOrEqual(74);
    expect(cell(m, 5, 4)).toEqual(block(GRASS));
    expect(hud(m, 0).slice(9, 11)).toBe("x0");
    // Sigue arriba por la puerta abierta hasta la escalera (5, 2) → cripta, pantalla 20.
    holdUntil(m, J.UP, () => screen(m) === 20);
    frames(m, 3);
    expect(pos(m)).toEqual([48, 48]);
    expect(cell(m, 3, 2)).toEqual(block(BLOCK_UP));
    expect(cell(m, 1, 1)).toEqual(block(FLOOR));
    expect(hud(m, 1)).toBe(" CRIPTA  20         ");

    // La partida se guardó al entrar: firma, pantalla 20, (48, 48), llaves 0, marcas de
    // la 1 (llave recogida) y la 6 (puerta abierta).
    const sram = m.sram();
    expect(Array.from(sram.subarray(0, 10))).toEqual([0x4d, 0x53, 0x47, 0x4f, 1, 20, 48, 48, sram[8], 0]);
    expect(sram[10 + 1]).toBe(1);
    expect(sram[10 + 6]).toBe(2);
    const hearts = m.vram(0, 0x9c00 + 1, 5);

    // .sav → otra máquina: el título ofrece continuar y se vuelve a la cripta.
    const len = m.x.gb_save_sav();
    const sav = new Uint8Array(m.x.memory.buffer, m.x.gb_io_buffer(), len).slice();
    const m2 = await start(m.build, sav);
    frames(m2, 10);
    expect(m2.text(0x9800, 2, 11, 16)).toBe("START  CONTINUAR");
    press(m2, J.START, 3, 10);
    expect(screen(m2)).toBe(20);
    expect(oamPos(m2)).toEqual([48, 48]);
    expect(m2.vram(0, 0x9c00 + 1, 5)).toEqual(hearts);
    expect(hud(m2, 0).slice(9, 11)).toBe("x0");
    // Subiendo por la escalera, la puerta de la 6 sigue abierta y la llave de la 1 no
    // ha vuelto.
    holdUntil(m2, J.UP, () => screen(m2) === 6);
    frames(m2, 3);
    expect(pos(m2)).toEqual([80, 48]);
    expect(cell(m2, 5, 4)).toEqual(block(GRASS));
    // Fuera del cercado por la puerta: abajo a la fila 5, a la columna 1, arriba a las
    // filas 3-4 (abiertas por la izquierda) y a la 5; allí a la columna 4 y arriba.
    holdUntil(m2, J.DOWN, () => pos(m2)[1] === 80);
    holdUntil(m2, J.LEFT, () => pos(m2)[0] === 16);
    holdUntil(m2, J.UP, () => pos(m2)[1] === 56);
    holdUntil(m2, J.LEFT, () => screen(m2) === 5);
    frames(m2, 3);
    expect(pos(m2)).toEqual([144, 56]);
    holdUntil(m2, J.LEFT, () => pos(m2)[0] === 64);
    holdUntil(m2, J.UP, () => screen(m2) === 1);
    frames(m2, 3);
    expect(cell(m2, 4, 1)).toEqual(block(GRASS));
  });
});

const BLOCK_UP = 96 + 4 * 10;

describe("aventura: 60 fps", () => {
  // En cada vuelta el bucle de juego espera un VBlank (wait_vbl): si una vuelta tardase
  // más de un frame, vbl_count avanzaría más que frames_run.
  const measure = (m: CMachine, n: number, input?: (t: number) => number) => {
    const v0 = m.peek16(m.sym("_vbl_count"));
    const f0 = m.peek16(m.sym("_frames_run"));
    frames(m, n, input);
    return [m.peek16(m.sym("_vbl_count")) - v0, m.peek16(m.sym("_frames_run")) - f0];
  };
  // Pulsa A cada 16 frames y anda de un lado a otro: todo el trabajo a la vez.
  const busy = (t0: number) => (t: number) => {
    const f = Math.floor((t - t0) / FRAME);
    return (f % 16 < 2 ? J.A : 0) | (f % 128 < 64 ? J.RIGHT : J.LEFT);
  };

  it("pantalla 19 con 4 enemigos: ningún VBlank perdido", async () => {
    const m = await newGame(makeSav(19, 32, 48, 5, 0));
    expect(screen(m)).toBe(19);
    // 4 enemigos vivos: 2 murciélagos y 2 limos, en las entradas 4-11 de la OAM.
    const oam = m.oam();
    for (let i = 4; i < 12; i++) expect(oam[i * 4], `sprite ${i}`).toBeGreaterThan(0);
    const [v, f] = measure(m, 120, busy(m.now()));
    expect(f).toBe(v);
    expect(v).toBeGreaterThanOrEqual(119);
  });

  it("sala del jefe (32×32): ningún VBlank perdido", async () => {
    const m = await newGame(makeSav(23, 32, 48, 5, 0, { 22: 2 }));
    expect(screen(m)).toBe(23);
    const [v, f] = measure(m, 60, busy(m.now()));
    expect(f).toBe(v);
  });
});
