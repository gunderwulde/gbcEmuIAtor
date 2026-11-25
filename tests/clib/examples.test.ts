// Los 10 ejemplos en C: compilan sin errores ni avisos, ensamblan y hacen lo que dicen,
// comprobado en lo que se ve (framebuffer, VRAM, OAM, paletas, registros de la APU,
// SRAM), con el joypad cuando hace falta. Los valores esperados están calculados a mano
// a partir de lo que describe cada ejemplo y de docs/gbc-hardware.md, no del código.
import { describe, expect, it } from "vitest";
import { C_EXAMPLES, cExampleById } from "../../web/src/clib";
import { FRAME, RGB, buildC, hold, rgb, start, type CMachine } from "./c-harness";

const SEC = 4194304;
const J = { RIGHT: 1, LEFT: 2, UP: 4, DOWN: 8, A: 16, B: 32, SELECT: 64, START: 128 };

async function boot(id: string, seconds = 0.5): Promise<CMachine> {
  const ex = cExampleById(id)!;
  const m = await start(buildC(new Map(ex.files), ex.main));
  m.run(seconds);
  return m;
}
/** Pulsa `mask` durante `frames` frames y suelta; luego deja pasar `after` frames. */
function press(m: CMachine, mask: number, frames = 3, after = 3): void {
  const t0 = m.now();
  m.run((frames * FRAME) / SEC, hold(mask, t0, t0 + frames * FRAME));
  m.run((after * FRAME) / SEC);
}
const frames = (m: CMachine, n: number, input?: (t: number) => number) => m.run((n * FRAME) / SEC, input);

describe("lista de ejemplos", () => {
  it("10 ejemplos con id único, título y main entre sus ficheros", () => {
    expect(C_EXAMPLES.length).toBe(10);
    expect(new Set(C_EXAMPLES.map((e) => e.id)).size).toBe(10);
    for (const e of C_EXAMPLES) {
      expect(e.title).not.toBe("");
      expect(e.files.has(e.main)).toBe(true);
      expect(e.files.get(e.main)).toMatch(/int main\(void\)/);
    }
  });

  it.each(C_EXAMPLES.map((e) => [e.id]))("%s compila sin errores ni avisos y ensambla", (id) => {
    const e = cExampleById(id)!;
    const b = buildC(new Map(e.files), e.main);
    expect(b.rom.length).toBeGreaterThanOrEqual(32768);
  });
});

describe("01 hola", () => {
  it("escribe el texto en el mapa y se ve en tinta azul sobre blanco", async () => {
    const m = await boot("c01-hola");
    expect(m.text(0x9800, 4, 8, 12)).toBe("Hola, mundo!");
    expect(m.text(0x9800, 3, 10, 14)).toBe("Game Boy Color");
    expect(m.pixel(0, 0)).toEqual([255, 255, 255]);
    // '!' (columna 4 + 11 = 15) es una barra en la columna 3 del tile, filas 0-4.
    expect(m.pixel(15 * 8 + 3, 8 * 8)).toEqual(rgb(RGB(0, 0, 16)));
    expect(m.pixel(15 * 8 + 3, 8 * 8 + 5)).toEqual([255, 255, 255]);
  });
});

describe("02 colores", () => {
  it("rejilla de 8 paletas × 4 colores", async () => {
    const m = await boot("c02-colores");
    for (let y = 0; y < 18; y++) {
      for (let x = 0; x < 20; x++) {
        const n = Math.floor((2 * x) / 5);
        const c = Math.min(3, Math.floor(y / 5));
        expect(m.pixel(x * 8 + 4, y * 8 + 4), `celda ${x},${y}`).toEqual(rgb(RGB(n * 4, c * 10, 31 - n * 4)));
      }
    }
  });
});

describe("03 tiles", () => {
  it("tiles de TILE_ROW, casa con set_bg_map y columna en espejo", async () => {
    const m = await boot("c03-tiles");
    // TILE_ROW(0,1,2,3,3,2,1,0): plano bajo 01011010 = 5Ah, alto 00111100 = 3Ch
    expect(m.vram(0, 0x8030, 16)).toEqual(new Array(8).fill([0x5a, 0x3c]).flat());
    expect(m.vram(0, 0x9800 + 9 * 32 + 8, 4)).toEqual([0, 4, 5, 0]);
    expect(m.vram(0, 0x9800 + 10 * 32 + 8, 4)).toEqual([4, 6, 6, 5]);
    expect(m.vram(0, 0x9800 + 11 * 32 + 8, 4)).toEqual([6, 7, 6, 6]);
    expect(m.vram(1, 0x9800 + 8 * 32 + 17, 1)).toEqual([0x21]);
    expect(m.pixel(0, 0)).toEqual(rgb(RGB(20, 26, 31)));            // cielo: color 0, paleta 0
    expect(m.pixel(2 * 8 + 3, 8 * 8)).toEqual(rgb(RGB(6, 2, 0)));    // columna: color 3, paleta 1
    expect(m.pixel(2 * 8 + 1, 8 * 8)).toEqual(rgb(RGB(24, 10, 6)));  // color 1
    expect(m.pixel(17 * 8 + 6, 8 * 8)).toEqual(rgb(RGB(24, 10, 6))); // en espejo: el 1 está en la 6
    expect(m.pixel(3, 13 * 8)).toEqual(rgb(RGB(6, 2, 0)));           // junta del ladrillo
  });
});

describe("04 scroll", () => {
  it("avanza 1 píxel por frame y la cruceta cambia la dirección; A lo para", async () => {
    const m = await boot("c04-scroll", 1);
    expect(m.vram(0, 0x9800, 3)).toEqual([1, 1, 0]);       // diagonal y tablero
    expect(m.vram(0, 0x9800 + 3 * 32 + 3, 1)).toEqual([1]);
    let sx = m.io(0xff43);
    frames(m, 60);
    expect((m.io(0xff43) - sx) & 255).toBe(60);
    press(m, J.LEFT, 5, 5);
    sx = m.io(0xff43);
    frames(m, 60);
    expect((sx - m.io(0xff43)) & 255).toBe(60);
    press(m, J.DOWN, 5, 5);
    const sy = m.io(0xff42);
    sx = m.io(0xff43);
    frames(m, 30);
    expect((m.io(0xff42) - sy) & 255).toBe(30);
    expect(m.io(0xff43)).toBe(sx);
    press(m, J.A, 5, 5);
    const s2 = [m.io(0xff43), m.io(0xff42)];
    frames(m, 30);
    expect([m.io(0xff43), m.io(0xff42)]).toEqual(s2);
  });
});

describe("05 sprite", () => {
  it("el sprite empieza en el centro, se mueve con la cruceta hasta los bordes y cambia con A y B", async () => {
    const m = await boot("c05-sprite");
    expect(Array.from(m.oam().subarray(0, 4))).toEqual([68 + 16, 76 + 8, 1, 0]);
    frames(m, 100, () => J.RIGHT);                          // 76 → 152 en 38 frames
    expect(m.oam()[1]).toBe(152 + 8);
    frames(m, 100, () => J.LEFT | J.DOWN);
    expect(m.oam()[1]).toBe(8);                             // x = 0
    expect(m.oam()[0]).toBe(136 + 16);                      // y = 144 − 8
    // Fila 1 de la nave, columna 3: color 1 = blanco en la paleta 0.
    expect(m.pixel(3, 136 + 1)).toEqual(rgb(RGB(31, 31, 31)));
    press(m, J.A);
    expect(m.oam()[3]).toBe(1);
    expect(m.pixel(3, 136 + 1)).toEqual(rgb(RGB(16, 31, 16)));
    press(m, J.B);
    expect(m.oam()[3]).toBe(0x21);
    expect(m.pixel(4, 136 + 1)).toEqual(rgb(RGB(16, 31, 16)));  // en espejo: la columna 4
    expect(m.pixel(0, 0)).toEqual(rgb(RGB(0, 0, 8)));           // fondo
  });
});

describe("06 sonido", () => {
  it("A dispara el canal 1 con duración, B el 2 mientras se pulsa, SELECT el ruido", async () => {
    const m = await boot("c06-sonido");
    expect(m.io(0xff26) & 0x8f).toBe(0x80);
    expect(m.text(0x9800, 2, 6, 9)).toBe("Nota: Do4");
    expect(m.text(0x9800, 2, 7, 13)).toBe("Periodo: 1547");
    press(m, J.RIGHT);
    expect(m.text(0x9800, 2, 6, 9)).toBe("Nota: Re4");
    expect(m.text(0x9800, 2, 7, 13)).toBe("Periodo: 1602");   // 2048 − 131072 / 293,66
    press(m, J.A, 2, 1);
    expect(m.io(0xff26) & 1).toBe(1);
    expect(m.io(0xff11)).toBe(0xbf);                        // ciclo 50 %, la duración lee 1
    expect(m.io(0xff12)).toBe(0xf0);                        // volumen 15, sin envolvente
    expect(m.io(0xff14) & 0x40).toBe(0x40);                 // duración activa
    frames(m, 12);                                          // 32/256 s = 7,5 frames
    expect(m.io(0xff26) & 1).toBe(0);
    const t0 = m.now();
    frames(m, 10, hold(J.B, t0, t0 + 6 * FRAME));
    expect(m.io(0xff26) & 2).toBe(0);                       // soltado: se apaga
    frames(m, 4, () => J.B);
    expect(m.io(0xff26) & 2).toBe(2);
    expect(m.io(0xff17)).toBe(0xa0);
    frames(m, 4);
    press(m, J.SELECT, 2, 0);
    expect(m.io(0xff26) & 8).toBe(8);
    expect(m.io(0xff22)).toBe(0x34);
  });
});

describe("07 ventana", () => {
  it("marcador fijo en la ventana con el tiempo y el fondo desplazándose", async () => {
    const m = await boot("c07-ventana", 3.2);
    expect(m.io(0xff40) & 0x60).toBe(0x60);
    expect(m.io(0xff4a)).toBe(128);
    expect(m.io(0xff4b)).toBe(7);
    expect(m.text(0x9c00, 0, 0, 19)).toBe("TIEMPO      FRAMES ");
    expect(m.text(0x9800, 0, 0, 15)).toBe("Scroll infinito");
    expect(m.vram(1, 0x9c00, 1)).toEqual([1]);              // ventana con la paleta 1
    // vbl_count cuenta un VBlank por frame: 60 frames más → +60.
    const v0 = m.peek16(m.sym("_vbl_count"));
    frames(m, 60);
    const vbl = m.peek16(m.sym("_vbl_count"));
    expect(vbl - v0).toBe(60);
    const shown = m.text(0x9c00, 0, 1, 17);
    const frameShown = Number(shown.slice(11));
    expect(frameShown).toBeGreaterThanOrEqual(vbl - 1);
    expect(frameShown).toBeLessThanOrEqual(vbl);
    expect(shown).toBe(`${String(Math.floor(frameShown / 60)).padStart(5)} s    ${String(frameShown).padStart(6)}`);
  });
});

describe("08 fundido", () => {
  const pals = [
    RGB(31, 31, 31), RGB(31, 20, 8), RGB(20, 4, 12), RGB(4, 0, 12),
    RGB(31, 31, 31), RGB(8, 24, 31), RGB(4, 8, 24), RGB(0, 4, 8),
  ];
  const scaled = (c: number, k: number) =>
    (((c & 31) * k) >> 3) | (((((c >> 5) & 31) * k) >> 3) << 5) | (((((c >> 10) & 31) * k) >> 3) << 10);
  const bg = (m: CMachine) => Array.from({ length: 8 }, (_, i) => m.pal(false, i >> 2, i & 3));

  it("tiles por HDMA, fundido desde negro, color pleno y fundido a negro", async () => {
    const m = await boot("c08-fundido", 0.05);
    expect(bg(m)).toEqual(new Array(8).fill(0));
    // Durante el fundido, cada color es el original escalado por k/8 con el mismo k.
    let seen = 0;
    for (let i = 0; i < 40; i++) {
      frames(m, 1);
      const p = bg(m);
      const k = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((kk) => p.every((c, j) => c === scaled(pals[j]!, kk)));
      expect(k, `frame ${i}: ${p.map((c) => c.toString(16))}`).toBeDefined();
      seen |= 1 << k!;
    }
    expect(seen).toBe(0x1ff);                               // pasa por k = 0 (negro) … 8
    expect(bg(m)).toEqual(pals);
    // Tiles: la copia de WRAM (D000h) llegó entera a VRAM; tile 0 fila 0 = FFh, FFh.
    const buf = Array.from({ length: 256 }, (_, i) => m.peek(0xd000 + i));
    expect(m.vram(0, 0x8000, 256)).toEqual(buf);
    expect(buf.slice(0, 4)).toEqual([0xff, 0xff, 0x7f, 0x7f]);
    expect(buf.slice(8 * 16, 8 * 16 + 2)).toEqual([0xff >> 8 % 8, 0x00]);   // tile 8: invertido
    expect(m.pixel(0, 0)).toEqual(rgb(pals[3]!));          // tile 0 fila 0: color 3, paleta 0
    frames(m, 120 + 40);
    expect(bg(m)).toEqual(new Array(8).fill(0));
  });
});

describe("09 interrupciones", () => {
  it("raster a mitad de pantalla, 16 ticks/s y 32 en doble velocidad", async () => {
    const m = await boot("c09-interrupciones", 2.2);
    expect(m.pixel(0, 70)).toEqual(rgb(RGB(0, 8, 16)));
    expect(m.pixel(0, 71)).toEqual(rgb(RGB(0, 8, 16)));
    expect(m.pixel(0, 72)).toEqual(rgb(RGB(16, 0, 8)));
    expect(m.pixel(0, 143)).toEqual(rgb(RGB(16, 0, 8)));
    // 60 frames = 4213440 puntos; TIMA desborda cada 256 · 1024 puntos → 16,07 por segundo.
    expect(["  16", "  17"]).toContain(m.text(0x9800, 9, 3, 4));
    expect(m.text(0x9800, 12, 4, 6)).toBe("normal");
    press(m, J.A, 3, 3);
    expect(m.io(0xff4d) & 0x80).toBe(0x80);
    expect(m.text(0x9800, 12, 4, 6)).toBe("doble ");
    m.run(2.1);
    expect(["  32", "  33"]).toContain(m.text(0x9800, 9, 3, 4));
    expect(m.pixel(0, 72)).toEqual(rgb(RGB(16, 0, 8)));
    expect(m.pixel(0, 10)).toEqual(rgb(RGB(0, 8, 16)));
    press(m, J.A, 3, 3);
    expect(m.io(0xff4d) & 0x80).toBe(0);
  });
});

describe("10 estrellas", () => {
  /** Jugador automático: lleva la cesta bajo la estrella visible más baja. */
  const bot = (m: CMachine) => () => {
    const o = m.oam();
    const px = o[1]! - 8;
    let best = -1;
    let bx = 0;
    for (let i = 2; i < 6; i++) {
      const y = o[i * 4]!;
      if (y > 16 && y < 160 && y > best) { best = y; bx = o[i * 4 + 1]! - 8; }
    }
    if (best < 0) return 0;
    const d = bx + 4 - (px + 8);
    return d > 1 ? J.RIGHT : d < -1 ? J.LEFT : 0;
  };

  it("título, partida con puntos, fin, récord en la SRAM y récord al volver a cargar el .sav", async () => {
    const m = await boot("c10-estrellas", 0.5);
    expect(m.text(0x9800, 3, 4, 10)).toBe("LLUVIA  DE");
    expect(m.text(0x9800, 4, 10, 10)).toBe("RECORD   0");
    press(m, J.START, 3, 10);
    expect(m.text(0x9800, 0, 0, 19)).toBe("PUNTOS   0  VIDAS 3");
    expect(m.vram(0, 0x9800 + 17 * 32, 20)).toEqual(new Array(20).fill(96));
    expect(m.oam()[0]).toBe(128 + 16);                      // la cesta
    m.run(20, bot(m));
    const hud = m.text(0x9800, 0, 0, 19);
    const score = Number(hud.slice(7, 10));
    expect(score).toBeGreaterThanOrEqual(5);
    expect(m.peek16(m.sym("_score"))).toBe(score);
    // Sin jugador las estrellas caen: 3 fallos y fin de partida.
    m.run(15);
    expect(m.text(0x9800, 3, 7, 14)).toBe("FIN DE PARTIDA");
    expect(m.text(0x9800, 3, 9, 13)).toBe("NUEVO RECORD!");
    const final = m.peek16(m.sym("_score"));
    expect(final).toBeGreaterThanOrEqual(score);
    const sram = m.sram();
    expect(Array.from(sram.subarray(0, 6))).toEqual([0x53, 0x54, 0x41, 0x52, final & 255, final >> 8]);
    expect(m.io(0xff00) & 0x30).toBe(0x30);
    press(m, J.START, 3, 10);
    expect(m.text(0x9800, 4, 10, 10)).toBe(`RECORD ${String(final).padStart(3)}`);

    // El .sav (la SRAM) en una máquina nueva: el título enseña el récord.
    const len = m.x.gb_save_sav();
    const sav = new Uint8Array(m.x.memory.buffer, m.x.gb_io_buffer(), len).slice();
    const m2 = await start(m.build, sav);
    m2.run(0.5);
    expect(m2.text(0x9800, 4, 10, 10)).toBe(`RECORD ${String(final).padStart(3)}`);
  });
});
