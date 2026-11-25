// Rutinas en ensamblador de la librería (gbc.asm, string.asm, stdlib.asm) en el núcleo
// real, llamadas con la convención de pila desde un crt0 escrito a mano
// (asm-harness.ts). Los valores esperados salen de docs/gbc-hardware.md, de docs/c-abi.md
// o están escritos a mano; nunca del código bajo prueba.
//
// Tiempos (docs §1 y §7): sin boot ROM el programa empieza en LY = 144, punto 0; una
// línea son 456 puntos y un frame 154 líneas = 70224 puntos. El primer VBlank tras el
// arranque empieza, pues, en el punto 70224, y el k-ésimo en k·70224.
import { describe, expect, it } from "vitest";
import { call, db, resA, resHL, runAsm, type Harness } from "./asm-harness";

const LINE = 456;
const FRAME = 154 * LINE;

/** Espera activa a LY = n (sin interrupciones). */
const waitLy = (n: number, tag: string) => `.${tag}:\n    ldh a, [$FF44]\n    cp ${n}\n    jr nz, .${tag}`;
const sym = (h: Harness, name: string) => {
  const s = h.symbols.get(name);
  if (!s) throw new Error(`falta ${name}`);
  return s.addr;
};
/** Patrón de datos escrito a mano: (7·i + 3) mod 256. */
const pattern = (n: number) => Array.from({ length: n }, (_, i) => (7 * i + 3) & 255);
const PATTERN_SECTION = `SECTION "pattern", ROM0, ALIGN[4]\nPattern:\n${db(pattern(64))}\n`;

describe("LCD, VBlank y registros de vídeo", () => {
  it("lcd_off espera a VBlank (LY 144) y apaga LCDC.7", async () => {
    const h = await runAsm(`${waitLy(10, "w")}\n${call("lcd_off")}`);
    expect(h.io(0xff40) & 0x80).toBe(0);
    // LY = 10 llega en 20·456; LY = 144 del mismo frame en 154·456.
    expect(h.ldbbAt).toBeGreaterThanOrEqual(154 * LINE);
    expect(h.ldbbAt).toBeLessThan(156 * LINE);
  });

  it("lcd_off con el LCD apagado vuelve enseguida; lcd_on lo enciende", async () => {
    // El crt0 del banco de pruebas tarda ~11 líneas: al llegar aquí el VBlank del arranque
    // ya ha acabado y el primer lcd_off espera al siguiente (LY 144 en el punto 70224).
    const h = await runAsm(`${call("lcd_off")}\n${call("lcd_off")}\n${call("lcd_on")}`);
    expect(h.io(0xff40) & 0x80).toBe(0x80);
    // ldbbAt se mide en trozos de una línea (runUntilLdBB): margen de dos líneas.
    expect(h.ldbbAt).toBeGreaterThanOrEqual(FRAME);
    expect(h.ldbbAt).toBeLessThan(FRAME + 2 * LINE);
  });

  it("wait_vbl vuelve al empezar el VBlank y cuenta frames; delay(n) espera n", async () => {
    const h = await runAsm(`${waitLy(10, "w")}\n${call("wait_vbl")}\n${call("delay", [3], true)}`);
    expect(h.peek(sym(h, "_vbl_count"))).toBe(4);
    expect(h.ldbbAt).toBeGreaterThanOrEqual(4 * FRAME);
    expect(h.ldbbAt).toBeLessThan(4 * FRAME + 2 * LINE);
  });

  it("wait_vbl ignora el IF.0 que deja el arranque (docs §1)", async () => {
    // Sin el borrado volvería en el punto ~0; debe esperar al VBlank del punto 70224.
    const h = await runAsm(call("wait_vbl"));
    expect(h.ldbbAt).toBeGreaterThanOrEqual(FRAME);
    expect(h.peek(sym(h, "_vbl_count"))).toBe(1);
  });

  it("wait_vbl con el LCD apagado no se cuelga", async () => {
    const h = await runAsm(`${call("lcd_off")}\n${call("wait_vbl")}\n${call("delay", [5], true)}`);
    expect(h.ldbbAt).toBeLessThan(FRAME + 4 * LINE); // lo que tarda lcd_off y poco más
  });

  it("scroll, window y bits de LCDC", async () => {
    const h = await runAsm([
      call("scroll", [5, 7]),
      call("window", [10, 20]),
      call("window_on"),
      call("sprites_on"),
      call("sprites_8x16", [1]),
      call("bg_priority", [0]),
      "    ldh a, [$FF40]", resA(0),
      call("window_off"),
      call("sprites_off"),
      call("sprites_8x16", [0]),
      call("bg_priority", [1]),
      "    ldh a, [$FF40]", resA(1),
    ].join("\n"));
    expect(h.io(0xff43)).toBe(5);
    expect(h.io(0xff42)).toBe(7);
    expect(h.io(0xff4b)).toBe(17); // WX = x + 7
    expect(h.io(0xff4a)).toBe(20);
    // 91h del arranque | 60h (ventana + mapa 9C00) | 02h | 04h, sin el bit 0 → F6h
    expect(h.res(0)).toBe(0xf6);
    // F6h & ~20h & ~02h & ~04h | 01h → D1h (window_off conserva LCDC.6)
    expect(h.res(1)).toBe(0xd1);
  });
});

describe("bancos, CPU e interrupciones", () => {
  it("vram_bank y wram_bank", async () => {
    const h = await runAsm(`${call("vram_bank", [1])}\n${call("wram_bank", [3])}`);
    expect(h.io(0xff4f) & 1).toBe(1);
    expect(h.io(0xff70) & 7).toBe(3);
  });

  it("rom_bank cambia el banco de 4000h y actualiza __cur_bank", async () => {
    const h = await runAsm(
      [
        call("rom_bank", [3]), "    ld a, [$4000]", resA(0), "    ldh a, [__cur_bank]", resA(1),
        call("rom_bank", [2]), "    ld a, [$4000]", resA(2), "    ldh a, [__cur_bank]", resA(3),
      ].join("\n"),
      { extra: `SECTION "b2", ROMX, BANK[2]\n    db $42\nSECTION "b3", ROMX, BANK[3]\n    db $43\n` },
    );
    expect([h.res(0), h.res(1), h.res(2), h.res(3)]).toEqual([0x43, 3, 0x42, 2]);
  });

  it("sram_on / sram_bank / sram_off", async () => {
    const h = await runAsm(
      [
        call("sram_on"),
        call("sram_bank", [1]), "    ld a, $11", "    ld [$A000], a",
        call("sram_bank", [0]), "    ld a, $22", "    ld [$A000], a",
        call("sram_bank", [1]), "    ld a, [$A000]", resA(0),
        call("sram_off"), "    ld a, [$A000]", resA(1),
      ].join("\n"),
      { extra: `SECTION "sav0", SRAM[$A000], BANK[0]\n    ds 16\nSECTION "sav1", SRAM[$A000], BANK[1]\n    ds 16\n` },
    );
    expect(h.res(0)).toBe(0x11);
    expect(h.res(1)).toBe(0xff); // RAM deshabilitada: lee FFh
    const sram = new Uint8Array(h.x.memory.buffer, h.x.gb_sram(), h.x.gb_sram_size());
    expect(sram[0]).toBe(0x22);
    expect(sram[0x2000]).toBe(0x11);
  });

  it("cpu_fast / cpu_slow / cpu_is_fast (KEY1.7)", async () => {
    const h = await runAsm([
      call("cpu_is_fast"), resA(0),
      call("cpu_fast"), call("cpu_is_fast"), resA(1), "    ldh a, [$FF4D]", resA(2),
      call("cpu_fast"), call("cpu_is_fast"), resA(3),
      call("cpu_slow"), call("cpu_is_fast"), resA(4),
    ].join("\n"));
    expect(h.res(0)).toBe(0);
    expect(h.res(1)).toBe(1);
    expect(h.res(2) & 0x81).toBe(0x80); // doble velocidad, sin cambio pendiente
    expect(h.res(3)).toBe(1);
    expect(h.res(4)).toBe(0);
  });

  it("irq_enable / irq_disable", async () => {
    const h = await runAsm([
      call("irq_enable", [0x05]), "    ldh a, [$FFFF]", resA(0),
      call("irq_disable", [0x01]), "    ldh a, [$FFFF]", resA(1),
    ].join("\n"));
    expect(h.res(0) & 0x1f).toBe(0x05);
    expect(h.res(1) & 0x1f).toBe(0x04);
  });

  it("ei / di cambian IME", async () => {
    const ime = (h: Harness) => new Uint8Array(h.x.memory.buffer, h.x.gb_regs(), 20)[12];
    expect(ime(await runAsm(call("ei")))).toBe(1);
    expect(ime(await runAsm(`${call("ei")}\n${call("di")}`))).toBe(0);
  });
});

describe("VRAM", () => {
  it("vram_set / vram_get con el LCD encendido (esperan al modo 0/1)", async () => {
    // 200 escrituras repartidas por el frame: muchas caen en modo 3 si no se espera.
    const h = await runAsm([
      "    ld c, 0",
      ".loop:",
      "    push bc",
      "    ld a, c", "    add a", "    add c", "    inc a", "    ld l, a", "    ld h, 0", "    push hl", // v = 3c + 1
      "    ld l, c", "    ld h, $80", "    call _vram_set", "    add sp, 2",
      "    pop bc", "    push bc",
      "    ld l, c", "    ld h, $80", "    call _vram_get",
      "    pop bc", "    ld l, c", "    ld h, $DF", "    ld [hl], a",
      "    inc c", "    ld a, c", "    cp 200", "    jr nz, .loop",
    ].join("\n"));
    const want = Array.from({ length: 200 }, (_, i) => (3 * i + 1) & 255);
    expect(h.vram(0, 0x8000, 200)).toEqual(want);
    expect(Array.from({ length: 200 }, (_, i) => h.res(i))).toEqual(want);
  });

  it("vram_copy: LCD encendido, LCD apagado sin alinear, GDMA y origen en VRAM", async () => {
    const h = await runAsm(
      [
        call("vram_copy", ["$8100", "Pattern", 64], true),             // LCD encendido
        call("lcd_off"),
        call("vram_copy", ["$8203", "Pattern", 50], true),             // bucle rápido
        call("vram_copy", ["$8400", "Pattern", 64], true),             // GDMA
        call("vram_copy", ["$8600", "$8400", 64], true),               // VRAM → VRAM: sin DMA
        call("vram_copy", ["$8800", "Pattern", 0], true),              // nada
      ].join("\n"),
      { extra: PATTERN_SECTION },
    );
    expect(h.vram(0, 0x8100, 64)).toEqual(pattern(64));
    expect(h.vram(0, 0x8203, 50)).toEqual(pattern(50));
    expect(h.vram(0, 0x8235, 1)).toEqual([0]);
    expect(h.vram(0, 0x8400, 64)).toEqual(pattern(64));
    expect(h.vram(0, 0x8600, 64)).toEqual(pattern(64));
    expect(h.vram(0, 0x8800, 16)).toEqual(new Array(16).fill(0));
  });

  it("vram_copy grande con el LCD apagado: GDMA en trozos de 2048 bytes", async () => {
    const h = await runAsm([
      call("lcd_off"),
      call("vram_copy", ["$8000", "$0000", 4096], true),
      call("vram_copy", ["$9000", "$1000", 2096], true),
    ].join("\n"));
    expect(h.vram(0, 0x8000, 4096)).toEqual(Array.from(h.rom.subarray(0, 4096)));
    expect(h.vram(0, 0x9000, 2096)).toEqual(Array.from(h.rom.subarray(0x1000, 0x1000 + 2096)));
  });

  it("vram_fill con el LCD encendido", async () => {
    const h = await runAsm(call("vram_fill", ["$9800", 0x77, 300], true));
    expect(h.vram(0, 0x9800, 300)).toEqual(new Array(300).fill(0x77));
    expect(h.vram(0, 0x9800 + 300, 1)).toEqual([0]);
  });

  it("set_sprite_tiles y set_bg_tiles (LCDC.4 = 1 y = 0, cruce del tile 128)", async () => {
    const h = await runAsm(
      [
        call("set_sprite_tiles", [2, 2, "Pattern"]),                   // 8020h
        call("set_bg_tiles", [5, 1, "Pattern"]),                       // LCDC.4 = 1: 8050h
        "    ldh a, [$FF40]", "    res 4, a", "    ldh [$FF40], a",
        call("set_bg_tiles", [126, 4, "Pattern"]),                     // 97E0h y 8800h
        call("set_bg_tiles", [130, 1, "Pattern"]),                     // 8820h
        call("set_bg_tiles", [3, 0, "Pattern"]),                       // nada
      ].join("\n"),
      { extra: PATTERN_SECTION },
    );
    const p = pattern(64);
    expect(h.vram(0, 0x8020, 32)).toEqual(p.slice(0, 32));
    expect(h.vram(0, 0x8050, 16)).toEqual(p.slice(0, 16));
    expect(h.vram(0, 0x97e0, 32)).toEqual(p.slice(0, 32));
    expect(h.vram(0, 0x8800, 32)).toEqual(p.slice(32, 64));
    expect(h.vram(0, 0x8820, 16)).toEqual(p.slice(0, 16));
    expect(h.vram(0, 0x9030, 16)).toEqual(new Array(16).fill(0));
  });

  it("gdma_copy, hdma_copy y hdma_busy", async () => {
    const h = await runAsm(
      [
        call("hdma_copy", ["$8100", "Pattern", 64], true), call("hdma_busy"), resA(0),
        // La HDMA no avanza con la CPU en HALT (core/src/gbc.c): se espera sin wait_vbl.
        ".busy:", call("hdma_busy"), "    or a", "    jr nz, .busy", resA(1),
        call("lcd_off"),
        call("gdma_copy", ["$8200", "Pattern", 32], true), call("hdma_busy"), resA(2),
        call("hdma_copy", ["$8300", "Pattern", 48], true), call("hdma_busy"), resA(3),  // LCD apagado: GDMA
      ].join("\n"),
      { extra: PATTERN_SECTION },
    );
    expect(h.res(0)).toBe(1); // 4 bloques: no caben en un HBlank
    expect(h.res(1)).toBe(0);
    expect(h.vram(0, 0x8100, 64)).toEqual(pattern(64));
    expect(h.vram(0, 0x8200, 32)).toEqual(pattern(32));
    expect(h.res(2)).toBe(0);
    expect(h.vram(0, 0x8300, 48)).toEqual(pattern(48));
    expect(h.res(3)).toBe(0);
  });
});

describe("mapas", () => {
  it("set_bg_map, set_bg_attr, fill_bg, fill_bg_attr, ventana; VBK se conserva", async () => {
    const h = await runAsm(
      [
        call("vram_bank", [1]),
        call("set_bg_map", [2, 3, 4, 2, "MapData"]),
        call("set_bg_attr", [2, 3, 4, 2, "AttrData"]),
        call("fill_bg", [0, 0, 3, 1, 0xaa]),
        call("fill_bg_attr", [1, 1, 1, 1, 7]),
        call("fill_bg", [5, 5, 0, 3, 0xee]),                           // w = 0: nada
        call("set_win_map", [0, 0, 2, 1, "MapData"]),
        call("set_win_attr", [30, 31, 2, 1, "AttrData"]),
        call("fill_win", [1, 1, 2, 2, 0x55]),
        call("fill_win_attr", [0, 2, 1, 1, 0x21]),
        call("set_bg_tile", [31, 31, 0x99]),
        call("get_bg_tile", [31, 31]), resA(0),
        call("get_bg_tile", [2, 4]), resA(1),
      ].join("\n"),
      { extra: `SECTION "maps", ROM0\nMapData:\n${db([1, 2, 3, 4, 5, 6, 7, 8])}\nAttrData:\n${db([0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88])}\n` },
    );
    // 9800h + 32·3 + 2 = 9862h; la fila siguiente, 9882h
    expect(h.vram(0, 0x9862, 4)).toEqual([1, 2, 3, 4]);
    expect(h.vram(0, 0x9882, 4)).toEqual([5, 6, 7, 8]);
    expect(h.vram(0, 0x9866, 1)).toEqual([0]);
    expect(h.vram(1, 0x9862, 4)).toEqual([0x81, 0x82, 0x83, 0x84]);
    expect(h.vram(1, 0x9882, 4)).toEqual([0x85, 0x86, 0x87, 0x88]);
    expect(h.vram(0, 0x9800, 4)).toEqual([0xaa, 0xaa, 0xaa, 0]);
    expect(h.vram(1, 0x9821, 1)).toEqual([7]);
    expect(h.vram(0, 0x98a5, 1)).toEqual([0]);
    expect(h.vram(0, 0x9c00, 3)).toEqual([1, 2, 0]);
    expect(h.vram(1, 0x9c00 + 31 * 32 + 30, 2)).toEqual([0x81, 0x82]);
    expect(h.vram(0, 0x9c21, 2)).toEqual([0x55, 0x55]);
    expect(h.vram(0, 0x9c41, 2)).toEqual([0x55, 0x55]);
    expect(h.vram(1, 0x9c40, 1)).toEqual([0x21]);
    expect(h.vram(0, 0x9bff, 1)).toEqual([0x99]);
    expect(h.res(0)).toBe(0x99);
    expect(h.res(1)).toBe(5);
    expect(h.io(0xff4f) & 1).toBe(1);
  });
});

describe("paletas", () => {
  it("set_bg_palette, set_sprite_palette, set_bg_color, set_sprite_color con el LCD encendido", async () => {
    const h = await runAsm(
      [
        call("set_bg_palette", [2, "Cols"]),
        call("set_sprite_palette", [7, "Cols"]),
        call("set_bg_color", [1, 3, 0x5555]),
        call("set_sprite_color", [0, 2, 0x2aaa]),
      ].join("\n"),
      { extra: `SECTION "cols", ROM0\nCols:\n    dw $7FFF, $1234, $0421, $0000\n` },
    );
    expect([0, 1, 2, 3].map((i) => h.pal(false, 2, i))).toEqual([0x7fff, 0x1234, 0x0421, 0x0000]);
    expect([0, 1, 2, 3].map((i) => h.pal(true, 7, i))).toEqual([0x7fff, 0x1234, 0x0421, 0x0000]);
    expect(h.pal(false, 1, 3)).toBe(0x5555);
    expect(h.pal(false, 1, 2)).toBe(0x7fff); // sin tocar (blanco del arranque CGB)
    expect(h.pal(true, 0, 2)).toBe(0x2aaa);
  });
});

describe("sprites", () => {
  it("sprite_set/move/tile/attr/hide y la OAM sombra (Y+16, X+8)", async () => {
    const h = await runAsm([
      call("sprite_set", [0, 10, 20, 5, 0x21]),
      call("sprite_set", [39, 1, 2, 3, 4]),
      call("sprite_set", [1, 100, 50, 6, 0]),
      "    ld hl, $C0A0", "    ld a, [hl+]", resA(0x10), "    ld a, [hl+]", resA(0x11), "    ld a, [hl+]", resA(0x12), "    ld a, [hl]", resA(0x13),
      call("sprite_set", [40, 0xee, 0xee, 0xee, 0xee]),                // fuera de rango: nada
      "    ld hl, $C0A0", "    ld a, [hl+]", resA(0x14), "    ld a, [hl+]", resA(0x15), "    ld a, [hl+]", resA(0x16), "    ld a, [hl]", resA(0x17),
      "    ld hl, $C09C", "    ld a, [hl+]", resA(0), "    ld a, [hl+]", resA(1), "    ld a, [hl+]", resA(2), "    ld a, [hl]", resA(3),
      call("sprite_move", [0, 50, 60]),
      call("sprite_tile", [0, 9]),
      call("sprite_attr", [0, 0x40]),
      call("sprite_hide", [39]),
    ].join("\n"));
    expect([h.peek(0xc000), h.peek(0xc001), h.peek(0xc002), h.peek(0xc003)]).toEqual([76, 58, 9, 0x40]);
    expect([h.res(0), h.res(1), h.res(2), h.res(3)]).toEqual([18, 9, 3, 4]);
    expect([h.peek(0xc004), h.peek(0xc005), h.peek(0xc006), h.peek(0xc007)]).toEqual([66, 108, 6, 0]);
    expect(h.peek(0xc09c)).toBe(0);
    expect([h.res(0x14), h.res(0x15), h.res(0x16), h.res(0x17)]).toEqual([h.res(0x10), h.res(0x11), h.res(0x12), h.res(0x13)]);
  });

  it("sprites_hide_all pone Y = 0 y conserva el resto", async () => {
    const h = await runAsm(`${call("sprite_set", [0, 10, 20, 5, 0x21])}\n${call("sprite_set", [20, 10, 20, 5, 0x21])}\n${call("sprites_hide_all")}`);
    expect([h.peek(0xc000), h.peek(0xc001), h.peek(0xc002), h.peek(0xc003)]).toEqual([0, 18, 5, 0x21]);
    expect(h.peek(0xc050)).toBe(0);
    expect(h.peek(0xc051)).toBe(18);
  });

  it("oam_flush copia la sombra a la OAM con la DMA y respeta IE", async () => {
    const h = await runAsm([
      call("sprite_set", [0, 10, 20, 5, 0x21]),
      call("sprite_set", [39, 1, 2, 3, 4]),
      call("wait_vbl"),
      call("oam_flush"),
      "    ldh a, [$FFFF]", resA(0),
    ].join("\n"));
    const oam = h.oam();
    expect(Array.from(oam.subarray(0, 4))).toEqual([36, 18, 5, 0x21]);
    expect(Array.from(oam.subarray(156, 160))).toEqual([18, 9, 3, 4]);
    expect(h.res(0) & 1).toBe(1); // wait_vbl puso IE.0 y oam_flush lo restaura
  });
});

describe("texto", () => {
  // 'A' de la fuente, fila a fila (color 3 = los dos planos): 00030000 → 10h, 10h…
  const glyphA = [0x10, 0x28, 0x44, 0x44, 0x7c, 0x44, 0x44, 0x00].flatMap((b) => [b, b]);
  const codes = (s: string, base = 0) => Array.from(s, (c) => c.charCodeAt(0) - 32 + base);

  it("text_init carga la fuente: ' ' vacío, 'A' y el bloque 127 macizo", async () => {
    const h = await runAsm(`${call("lcd_off")}\n${call("text_init", [0])}`);
    expect(h.vram(0, 0x8000, 16)).toEqual(new Array(16).fill(0));
    expect(h.vram(0, 0x8000 + 16 * 33, 16)).toEqual(glyphA);
    expect(h.vram(0, 0x8000 + 16 * 95, 16)).toEqual(new Array(16).fill(0xff));
  });

  it("text_init con LCDC.4 = 0 y primer tile 128 → 8800h", async () => {
    const h = await runAsm(`${call("lcd_off")}\n    ldh a, [$FF40]\n    res 4, a\n    ldh [$FF40], a\n${call("text_init", [128])}`);
    expect(h.vram(0, 0x8800 + 16 * 33, 16)).toEqual(glyphA);
  });

  it("putchar / print / at / text_attr: tile en el banco 0 y atributo en el 1", async () => {
    const h = await runAsm(
      [
        call("lcd_off"), call("text_init", [0]), call("lcd_on"),
        call("text_attr", [3]),
        call("at", [1, 2]), call("print", ["SHi"], true),
        call("at", [5, 0]), call("print", ["SAB"], true),
        call("at", [19, 17]), call("print", ["SXY"], true),
        call("putchar", [0x2a], true), "    ld a, l", resA(0),
      ].join("\n"),
      { extra: `SECTION "s", ROM0\nSHi: db "Hi", 0\nSAB: db "A\\nB", 0\nSXY: db "XY", 0\n` },
    );
    expect(h.vram(0, 0x9841, 2)).toEqual(codes("Hi"));
    expect(h.vram(1, 0x9841, 2)).toEqual([3, 3]);
    expect(h.vram(0, 0x9805, 1)).toEqual(codes("A"));
    expect(h.vram(0, 0x9820, 1)).toEqual(codes("B")); // '\n': columna 0 de la fila 1
    expect(h.vram(0, 0x9800 + 17 * 32 + 19, 1)).toEqual(codes("X"));
    expect(h.vram(0, 0x9800, 2)).toEqual(codes("Y*")); // tras la fila 17 vuelve a la 0
    expect(h.res(0)).toBe(0x2a); // putchar devuelve c
    expect(h.peek(sym(h, "_gbc_tx"))).toBe(2);
    expect(h.peek(sym(h, "_gbc_ty"))).toBe(0);
  });

  it("printf: %d %u %x %X %c %s %% y anchura con espacios o ceros", async () => {
    const fmt = "%d,%u,%x,%X,%c,%s,%%,%5d,%05d,%3u,%i";
    const h = await runAsm(
      [
        call("lcd_off"), call("text_init", [0]),
        call("printf", ["SFmt", -123 & 0xffff, 65535, 0xbeef, 0xbeef, 90, "SOk", 42, -42 & 0xffff, 12345, 0], true),
      ].join("\n"),
      { extra: `SECTION "s", ROM0\nSFmt: db "${fmt}", 0\nSOk: db "ok", 0\n` },
    );
    const want = "-123,65535,beef,BEEF,Z,ok,%,   42,-0042,12345,0";
    const got = [...h.vram(0, 0x9800, 20), ...h.vram(0, 0x9820, 20), ...h.vram(0, 0x9840, want.length - 40)];
    expect(got).toEqual(codes(want));
  });

  it("cls llena el mapa de texto con espacios y el atributo; text_layer elige 9C00h", async () => {
    const h = await runAsm([
      call("lcd_off"), call("text_init", [1]),
      call("text_attr", [2]), call("at", [4, 4]), call("cls"),
      call("print", ["SZ"], true),                                     // tras cls: (0, 0)
      call("text_layer", [1]), call("text_attr", [5]), call("at", [0, 0]), call("print", ["SZ"], true),
    ].join("\n"), { extra: `SECTION "s", ROM0\nSZ: db "Z", 0\n` });
    const bank0 = h.vram(0, 0x9800, 1024);
    expect(bank0.slice(1)).toEqual(new Array(1023).fill(1)); // ' ' = tile 1
    expect(h.vram(1, 0x9800, 1024)).toEqual(new Array(1024).fill(2));
    expect(bank0[0]).toBe(codes("Z", 1)[0]);
    expect(h.vram(0, 0x9c00, 1)).toEqual(codes("Z", 1));
    expect(h.vram(1, 0x9c00, 1)).toEqual([5]);
  });
});

describe("joypad", () => {
  // La entrada cambia a mitad de frame para que cada lectura (justo tras el VBlank k)
  // vea la máscara del frame k.
  const frameInput = (masks: number[]) => (t: number) => masks[Math.min(masks.length - 1, Math.floor((t + FRAME / 2) / FRAME))]!;

  it("joypad y joypad_pressed (flancos)", async () => {
    const body: string[] = [];
    for (let k = 0; k < 6; k++) body.push(call("wait_vbl"), call("joypad"), resA(k), call("joypad_pressed"), resA(0x10 + k));
    const h = await runAsm(body.join("\n"), { input: frameInput([0, 0, 0x11, 0x11, 0x91, 0x80, 0]) });
    expect([0, 1, 2, 3, 4, 5].map((k) => h.res(k))).toEqual([0, 0x11, 0x11, 0x91, 0x80, 0]);
    expect([0, 1, 2, 3, 4, 5].map((k) => h.res(0x10 + k))).toEqual([0, 0x11, 0, 0x80, 0, 0]);
    expect(h.io(0xff00) & 0x30).toBe(0x30); // deja el joypad deseleccionado
  });

  it("wait_key espera a soltar y a pulsar; joypad_pressed no repite la tecla", async () => {
    const h = await runAsm(
      [call("wait_key"), resA(0), call("joypad_pressed"), resA(1)].join("\n"),
      { input: frameInput([0x10, 0x10, 0, 0, 0x20, 0x20]) },
    );
    expect(h.res(0)).toBe(0x20);
    expect(h.res(1)).toBe(0);
    expect(h.peek(sym(h, "_vbl_count"))).toBe(4);
  });
});

describe("string.asm", () => {
  it("memcpy, memset (con n = 256 y 300), memcmp", async () => {
    const h = await runAsm(
      [
        call("memcpy", ["$D100", "S5", 5], true), resHL(0),
        call("memset", ["$D200", 0xab, 300], true), resHL(2),
        call("memset", ["$D400", 0xcd, 256], true),
        call("memset", ["$D600", 0xef, 0], true),
        call("memcmp", ["SAbc", "SAbd", 3], true), resHL(4),
        call("memcmp", ["SAbc", "SAbd", 2], true), resHL(6),
        call("memcmp", ["SAbd", "SAbc", 3], true), resHL(8),
        call("memcmp", ["S00", "SFF", 1], true), resHL(10),
        call("memcmp", ["SAbc", "SAbd", 0], true), resHL(12),
      ].join("\n"),
      { extra: `SECTION "s", ROM0\nS5: db 1, 2, 3, 4, 5\nSAbc: db "abc", 0\nSAbd: db "abd", 0\nS00: db 0\nSFF: db $FF\n` },
    );
    expect([0, 1, 2, 3, 4, 5].map((i) => h.peek(0xd100 + i))).toEqual([1, 2, 3, 4, 5, 0]);
    expect(h.res16(0)).toBe(0xd100);
    expect(h.res16(2)).toBe(0xd200);
    expect(h.peek(0xd200)).toBe(0xab);
    expect(h.peek(0xd200 + 299)).toBe(0xab);
    expect(h.peek(0xd200 + 300)).toBe(0);
    expect(h.peek(0xd400 + 255)).toBe(0xcd);
    expect(h.peek(0xd400 + 256)).toBe(0);
    expect(h.peek(0xd600)).toBe(0);
    expect(h.res16(4)).toBe(0xffff); // 'c' - 'd' = -1
    expect(h.res16(6)).toBe(0);
    expect(h.res16(8)).toBe(1);
    expect(h.res16(10)).toBe(0xff01); // 0 - 255 = -255
    expect(h.res16(12)).toBe(0);
  });

  it("strlen, strcpy, strcat, strcmp", async () => {
    const h = await runAsm(
      [
        call("strlen", ["SHello"], true), resHL(0),
        call("strlen", ["SEmpty"], true), resHL(2),
        call("strcpy", ["$D100", "SHey"], true), resHL(4),
        call("strcat", ["$D100", "SBang"], true), resHL(6),
        call("strcmp", ["SAbc", "SAbc"], true), resHL(8),
        call("strcmp", ["SAbc", "SAbd"], true), resHL(10),
        call("strcmp", ["SB", "SA"], true), resHL(12),
        call("strcmp", ["SAb", "SAbc"], true), resHL(14),
      ].join("\n"),
      { extra: `SECTION "s", ROM0\nSHello: db "hello", 0\nSEmpty: db 0\nSHey: db "hey", 0\nSBang: db "!!", 0\nSAbc: db "abc", 0\nSAbd: db "abd", 0\nSB: db "b", 0\nSA: db "a", 0\nSAb: db "ab", 0\n` },
    );
    expect(h.res16(0)).toBe(5);
    expect(h.res16(2)).toBe(0);
    expect(h.res16(4)).toBe(0xd100);
    expect(h.res16(6)).toBe(0xd100);
    expect(Array.from({ length: 6 }, (_, i) => h.peek(0xd100 + i))).toEqual([...Buffer.from("hey!!"), 0]);
    expect(h.res16(8)).toBe(0);
    expect(h.res16(10)).toBe(0xffff);
    expect(h.res16(12)).toBe(1);
    expect(h.res16(14)).toBe((0 - 0x63) & 0xffff); // '\0' - 'c'
  });
});

describe("stdlib.asm", () => {
  // Modelo de referencia independiente: la definición del xorshift (7, 9, 8).
  const xorshift = (x: number) => {
    x ^= (x << 7) & 0xffff;
    x ^= x >> 9;
    x ^= (x << 8) & 0xffff;
    return x;
  };
  const seq = (seed: number, n: number) => {
    const out: number[] = [];
    let x = seed;
    for (let i = 0; i < n; i++) out.push((x = xorshift(x)) & 0x7fff);
    return out;
  };

  it("rand sigue el xorshift (7, 9, 8) desde ACE1h; srand(0) usa 1", async () => {
    const body: string[] = [];
    for (let i = 0; i < 5; i++) body.push(call("rand"), resHL(2 * i));
    body.push(call("srand", [0], true), call("rand"), resHL(10), call("rand"), resHL(12));
    body.push(call("srand", [1234], true), call("rand"), resHL(14));
    const h = await runAsm(body.join("\n"));
    expect([0, 1, 2, 3, 4].map((i) => h.res16(2 * i))).toEqual(seq(0xace1, 5));
    expect([h.res16(10), h.res16(12)]).toEqual(seq(1, 2));
    expect(h.res16(14)).toBe(seq(1234, 1)[0]);
  });

  it("abs", async () => {
    const h = await runAsm([
      call("abs", [-5 & 0xffff], true), resHL(0),
      call("abs", [7], true), resHL(2),
      call("abs", [0x8000], true), resHL(4),
      call("abs", [0], true), resHL(6),
    ].join("\n"));
    expect([h.res16(0), h.res16(2), h.res16(4), h.res16(6)]).toEqual([5, 7, 0x8000, 0]);
  });
});
