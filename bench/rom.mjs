// ROMs del bench (P1). Homebrew propio, codificado a mano (todavía no hay ensamblador):
// un emisor mínimo de SM83 con etiquetas y los opcodes que hacen falta, comentados con su
// mnemónico. Determinista: mismos bytes en cada ejecución (datos con un LCG fijo).
//
// Escenarios (ver bench/REPORT.md):
//   heavy — CPU 100 % ocupada (bucle con ROM/WRAM/HRAM, CALL/RET, PUSH/POP, CB, lectura
//           de LY); LCD encendido con fondo + ventana (WY=40, WX=71), SCX%8 ≠ 0 y sprites
//           8×16: 10 por línea en ~138 de 144 líneas (multiplexados con 3 OAM DMA por frame:
//           VBlank y STAT por LYC=62/126); APU con los 4 canales sonando, envolventes, y un
//           "driver" que toca NR23 cada frame y redispara 1 y 4 cada 16 frames.
//   idle  — mismo vídeo, audio e interrupciones, pero el bucle principal espera en HALT a
//           la VBlank y hace ~2 800 ciclos M de "lógica" por frame (~16 %): el caso más
//           común en juegos reales.
//
// Uso: import { buildRom } from "./rom.mjs"; buildRom("heavy" | "idle") → Uint8Array

const ROM_SIZE = 0x8000;

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
}

class Asm {
  constructor() { this.rom = new Uint8Array(ROM_SIZE); this.pc = 0; this.labels = {}; this.fix = []; }
  org(a) { this.pc = a; return this; }
  label(n) { if (n in this.labels) throw new Error(`etiqueta repetida ${n}`); this.labels[n] = this.pc; return this; }
  db(...b) { for (const x of b.flat()) this.rom[this.pc++] = x & 0xFF; return this; }
  // Valor de 16 bits o etiqueta (se resuelve al final).
  w16(v) {
    if (typeof v === "string") { this.fix.push({ at: this.pc, label: v, kind: "abs" }); this.db(0, 0); }
    else this.db(v & 0xFF, v >> 8);
    return this;
  }
  rel(label) { this.fix.push({ at: this.pc, label, kind: "rel" }); return this.db(0); }
  resolve() {
    for (const f of this.fix) {
      const t = this.labels[f.label];
      if (t === undefined) throw new Error(`etiqueta sin definir ${f.label}`);
      if (f.kind === "abs") { this.rom[f.at] = t & 0xFF; this.rom[f.at + 1] = t >> 8; }
      else {
        const d = t - (f.at + 1);
        if (d < -128 || d > 127) throw new Error(`JR fuera de rango a ${f.label}`);
        this.rom[f.at] = d & 0xFF;
      }
    }
    return this.rom;
  }
  // ---- instrucciones (mnemónico RGBDS en el nombre) ----
  nop() { return this.db(0x00); }
  di() { return this.db(0xF3); }
  ei() { return this.db(0xFB); }
  halt() { return this.db(0x76); }
  ret() { return this.db(0xC9); }
  reti() { return this.db(0xD9); }
  jp(l) { return this.db(0xC3).w16(l); }
  call(l) { return this.db(0xCD).w16(l); }
  jr(l) { return this.db(0x18).rel(l); }
  jrnz(l) { return this.db(0x20).rel(l); }
  jrz(l) { return this.db(0x28).rel(l); }
  ld_a(n) { return this.db(0x3E, n); }          // LD A,n
  ld_b(n) { return this.db(0x06, n); }          // LD B,n
  ld_bc(v) { return this.db(0x01).w16(v); }     // LD BC,nn
  ld_de(v) { return this.db(0x11).w16(v); }     // LD DE,nn
  ld_hl(v) { return this.db(0x21).w16(v); }     // LD HL,nn
  ld_sp(v) { return this.db(0x31).w16(v); }     // LD SP,nn
  ldh_w(n) { return this.db(0xE0, n); }         // LDH (FF00+n),A
  ldh_r(n) { return this.db(0xF0, n); }         // LDH A,(FF00+n)
  // Atajo: LD A,v ; LDH (n),A
  out(n, v) { return this.ld_a(v).ldh_w(n); }
}

// Datos fijos (posiciones en ROM0)
const D_TILES = 0x1000;   // 256 tiles × 16 bytes
const D_MAP   = 0x2000;   // 32×32×2 mapas (9800 y 9C00)
const D_ATTR  = 0x2800;   // atributos CGB de ambos mapas
const D_OAM   = 0x3000;   // 3 tablas OAM de 160 bytes (cada una en su página de 256)
const D_PAL   = 0x3300;   // 64 BG + 64 OBJ
const D_WAVE  = 0x3380;   // 16 bytes de RAM de onda
const D_DMA   = 0x3390;   // rutina de OAM DMA que se copia a HRAM
const DMA_LEN = 8;

const HR_FRAME = 0x90;    // FF90 contador de frames
const HR_VBL   = 0x92;    // FF92 bandera "hubo VBlank" (escenario idle)
const HR_LY    = 0x91;    // FF91 último LY leído (escenario heavy)

function data(rom) {
  const r = lcg(0x1234567);
  for (let i = 0; i < 4096; i++) rom[D_TILES + i] = r();
  for (let i = 0; i < 2048; i++) rom[D_MAP + i] = r();
  for (let i = 0; i < 2048; i++) {
    // paleta 0-7, banco de tile (bit 3), volteo X/Y (bits 5/6); prioridad BG (bit 7) 1 de 8
    const v = r();
    rom[D_ATTR + i] = (v & 0x07) | (v & 0x08) | (v & 0x60) | ((v & 0x70) === 0x70 ? 0x80 : 0);
  }
  for (let t = 0; t < 3; t++) {
    for (let g = 0; g < 4; g++) {
      for (let i = 0; i < 10; i++) {
        const s = g * 10 + i, o = D_OAM + t * 0x100 + s * 4;
        rom[o] = (t * 64 + g * 16 + 16) & 0xFF;            // Y (8×16)
        rom[o + 1] = 8 + i * 16 + ((g * 5) & 7);           // X: alineaciones distintas
        rom[o + 2] = (s * 6) & 0xFE;                       // tile (par en 8×16)
        rom[o + 3] = (i & 7) | ((i & 1) << 3) | ((g & 1) << 5); // paleta, banco, volteo X
      }
    }
  }
  for (let i = 0; i < 128; i += 2) { rom[D_PAL + i] = r(); rom[D_PAL + i + 1] = r() & 0x7F; }
  for (let i = 0; i < 16; i++) rom[D_WAVE + i] = (i * 0x11 + 0x08) & 0xFF;
  // ROMX (banco 1): datos que lee el bucle de CPU
  for (let i = 0x4000; i < 0x8000; i++) rom[i] = r();
}

export function buildRom(scenario) {
  if (scenario !== "heavy" && scenario !== "idle") throw new Error(`escenario desconocido: ${scenario}`);
  const a = new Asm();
  data(a.rom);

  // ---- rutina de DMA (se copia a FF80): A = página de origen ----
  a.org(D_DMA)
    .ldh_w(0x46)                  // LDH (FF46),A
    .ld_a(40)                     // LD A,40      ; 40 × 4 ciclos M = 160
    .db(0x3D)                     // .w: DEC A
    .db(0x20, 0xFD)               // JR NZ,.w
    .ret();

  // ---- vectores ----
  a.org(0x40).jp("vblank");
  a.org(0x48).jp("stat");

  // ---- cabecera ----
  a.org(0x100).nop().jp("start");
  const title = "P1BENCH";
  for (let i = 0; i < title.length; i++) a.rom[0x134 + i] = title.charCodeAt(i);
  a.rom[0x143] = 0x80;  // CGB
  a.rom[0x147] = 0x00;  // ROM sola
  a.rom[0x148] = 0x00;  // 32 KB
  a.rom[0x149] = 0x00;

  // ---- arranque ----
  a.org(0x150).label("start")
    .di().ld_sp(0xFFFE)
    .db(0xAF).ldh_w(0x40)                       // XOR A ; LCDC = 0 (arrancamos en VBlank)
    // paletas BG y OBJ con autoincremento
    .out(0x68, 0x80).ld_hl(D_PAL).ld_b(64)
    .label("pal1").db(0x2A).ldh_w(0x69).db(0x05).jrnz("pal1")   // LD A,(HL+) ; LDH (69),A ; DEC B
    .out(0x6A, 0x80).ld_b(64)
    .label("pal2").db(0x2A).ldh_w(0x6B).db(0x05).jrnz("pal2")
    // tiles en los dos bancos de VRAM; mapas en el banco 0, atributos en el 1
    .out(0x4F, 0).ld_hl(0x8000).ld_de(D_TILES).ld_bc(4096).call("memcpy")
    .ld_hl(0x9800).ld_de(D_MAP).ld_bc(2048).call("memcpy")
    .out(0x4F, 1).ld_hl(0x8000).ld_de(D_TILES).ld_bc(4096).call("memcpy")
    .ld_hl(0x9800).ld_de(D_ATTR).ld_bc(2048).call("memcpy")
    .out(0x4F, 0)
    // tablas OAM a C000/C100/C200 y rutina de DMA a FF80
    .ld_hl(0xC000).ld_de(D_OAM).ld_bc(0x300).call("memcpy")
    .ld_hl(0xFF80).ld_de(D_DMA).ld_bc(DMA_LEN).call("memcpy")
    .ld_a(0xC0).call(0xFF80)
    // APU: los 4 canales
    .out(0x26, 0x80).out(0x24, 0x77).out(0x25, 0xFF)
    .out(0x10, 0x00).out(0x11, 0x80).out(0x12, 0xF3).out(0x13, 0x00).out(0x14, 0x87)  // pulso 50 %, envolvente ↓
    .out(0x16, 0x40).out(0x17, 0xA7).out(0x18, 0x80).out(0x19, 0x86)                    // pulso 25 %
    .out(0x1A, 0x00).ld_hl(0xFF30).ld_de(D_WAVE).ld_bc(16).call("memcpy")
    .out(0x1A, 0x80).out(0x1C, 0x20).out(0x1D, 0xC0).out(0x1E, 0x87)                    // onda
    .out(0x21, 0xF2).out(0x22, 0x32).out(0x23, 0x80)                                    // ruido
    // PPU: SCX%8 = 3, ventana en la esquina inferior derecha, IRQ de STAT por LYC
    .out(0x42, 0).out(0x43, 3).out(0x4A, 40).out(0x4B, 71)
    .out(0x45, 62).out(0x41, 0x40)
    .db(0xAF).ldh_w(HR_FRAME).ldh_w(HR_VBL)
    .out(0xFF, 0x03)                            // IE = VBlank | STAT
    .db(0xAF).ldh_w(0x0F)                       // IF = 0
    .out(0x40, 0xF7)                            // LCD on, ventana 9C00, tiles 8000, OBJ 8×16
    .ei()
    .jp("main");

  // memcpy: HL = destino, DE = origen, BC = bytes
  a.label("memcpy")
    .db(0x1A, 0x13, 0x22)          // LD A,(DE) ; INC DE ; LD (HL+),A
    .db(0x0B, 0x78, 0xB1)          // DEC BC ; LD A,B ; OR C
    .jrnz("memcpy").ret();

  // ---- VBlank: OAM DMA de la tabla 0, LYC = 62, "driver" de música ----
  a.label("vblank")
    .db(0xF5, 0xC5, 0xD5, 0xE5)    // PUSH AF/BC/DE/HL
    .ld_a(0xC0).call(0xFF80)
    .out(0x45, 62)
    .ldh_r(HR_FRAME).db(0x3C).ldh_w(HR_FRAME)   // INC A
    .db(0xE6, 0x0F).jrnz("nomus")               // AND 0Fh
    .out(0x14, 0x87).out(0x23, 0x80)            // redispara canales 1 y 4
    .label("nomus")
    .ldh_r(HR_FRAME).ldh_w(0x18)                // NR23 = frame (vibrato)
    .ld_a(1).ldh_w(HR_VBL)
    .db(0xE1, 0xD1, 0xC1, 0xF1)    // POP HL/DE/BC/AF
    .reti();

  // ---- STAT (LYC): segunda y tercera tabla OAM ----
  a.label("stat")
    .db(0xF5)                      // PUSH AF
    .ldh_r(0x45).db(0xFE, 62).jrnz("stat2")     // CP 62
    .ld_a(0xC1).call(0xFF80).out(0x45, 126)
    .db(0xF1).reti()
    .label("stat2")
    .ld_a(0xC2).call(0xFF80).out(0x45, 0xFF)
    .db(0xF1).reti();

  if (scenario === "heavy") {
    a.label("main")
      .ld_hl(0xC300).ld_de(0x4000).ld_bc(256)
      .label("loop")
      .db(0x1A, 0x13)              // LD A,(DE) ; INC DE        (ROMX)
      .db(0x86, 0xA9)              // ADD A,(HL) ; XOR C        (WRAM)
      .db(0x22)                    // LD (HL+),A
      .db(0xC5).call("sub").db(0xC1)   // PUSH BC ; CALL sub ; POP BC (pila en HRAM)
      .db(0x0B, 0x78, 0xB1)        // DEC BC ; LD A,B ; OR C
      .jrnz("loop")
      .ldh_r(0x44).ldh_w(HR_LY)    // LY → FF91 (E/S → puesta al día de la PPU)
      .jr("main");
    a.label("sub")
      .db(0xCB, 0x37, 0x07, 0x47)  // SWAP A ; RLCA ; LD B,A
      .ret();
  } else {
    a.label("main")
      .halt()
      .ldh_r(HR_VBL).db(0xA7).jrz("main")       // AND A
      .db(0xAF).ldh_w(HR_VBL)
      .call("logic")
      .jr("main");
    a.label("logic")                            // 400 × 7 ciclos M ≈ 2 800
      .ld_bc(400)
      .label("lg").db(0x0B, 0x78, 0xB1).jrnz("lg")
      .ret();
  }

  const rom = a.resolve();
  if (a.pc >= D_TILES) throw new Error("el código pisa los datos");
  // checksum de cabecera (0134-014C) y global
  let x = 0;
  for (let i = 0x134; i <= 0x14C; i++) x = (x - rom[i] - 1) & 0xFF;
  rom[0x14D] = x;
  let g = 0;
  for (let i = 0; i < rom.length; i++) if (i !== 0x14E && i !== 0x14F) g = (g + rom[i]) & 0xFFFF;
  rom[0x14E] = g >> 8; rom[0x14F] = g & 0xFF;
  return rom;
}
