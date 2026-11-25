// Boot ROM de prueba ESCRITA POR NOSOTROS (no contiene código de Nintendo). Replica las
// comprobaciones documentadas de la boot ROM del CGB para probar las ROMs que exporta el
// IDE (PLAN.md, E1). Ensamblada a mano; el listado de abajo es la fuente.
//
// Comprobaciones y fuentes:
//  1. Logo (0104-0133). Pan Docs "The Cartridge Header" → "0104-0133 — Nintendo Logo":
//     la boot ROM compara el logo del cartucho con su copia y, si no coincide, se
//     bloquea. El CGB sólo compara los 24 primeros bytes; aquí se comparan los 48 (más
//     estricto: una ROM que pase aquí pasa también en DMG). La copia del logo NO está en
//     este fichero: la pasa el test (sacada de una ROM de la comunidad descargada con
//     npm run fetch, ver tests/export/boot.test.ts).
//  2. Checksum de cabecera (014D). Pan Docs, mismo apartado → "014D — Header checksum":
//     x = 0; para 0134..014C: x = x − rom[a] − 1; si no coincide, la boot ROM se bloquea.
//     docs/gbc-hardware.md §10.1.
//  3. Modo de compatibilidad. Pan Docs "CGB Registers" → "FF4C — KEY0": si el bit 7 de
//     0143 está a 0, la boot ROM escribe 04h en KEY0 (modo DMG) antes de soltar el control.
//  4. Traspaso. Pan Docs "Power Up Sequence": la última instrucción de la boot ROM
//     escribe en FF50 (la desmapea) justo antes de 0100, donde sigue la CPU; A = 11h
//     identifica un CGB (docs/gbc-hardware.md §11). Aquí, `ldh [$50], a` en 00FE.
//
// El checksum global no lo comprueba el hardware (Pan Docs, "014E-014F — Global
// checksum"; docs/gbc-hardware.md §10.1).
//
// Listado (0000-00FF; 0200-08FF contiene sólo el logo esperado en 0200):
//
//   0000  31 FE FF    ld   sp, $FFFE
//   0003  21 04 01    ld   hl, $0104        ; logo del cartucho
//   0006  11 00 02    ld   de, LOGO         ; copia esperada ($0200)
//   0009  0E 30       ld   c, 48
//   000B  1A        .logo: ld a, [de]
//   000C  BE          cp   [hl]
//   000D  20 21       jr   nz, Lock
//   000F  13          inc  de
//   0010  23          inc  hl
//   0011  0D          dec  c
//   0012  20 F7       jr   nz, .logo
//   0014  AF          xor  a                ; hl = $0134
//   0015  0E 19       ld   c, $14D - $134
//   0017  96        .sum: sub [hl]
//   0018  3D          dec  a
//   0019  23          inc  hl
//   001A  0D          dec  c
//   001B  20 FA       jr   nz, .sum
//   001D  BE          cp   [hl]             ; hl = $014D
//   001E  20 10       jr   nz, Lock
//   0020  FA 43 01    ld   a, [$0143]
//   0023  E6 80       and  $80
//   0025  20 04       jr   nz, .cgb
//   0027  3E 04       ld   a, $04
//   0029  E0 4C       ldh  [$4C], a         ; KEY0: compatibilidad DMG
//   002B  3E 11     .cgb: ld a, $11
//   002D  C3 FE 00    jp   $00FE
//   0030  18 FE     Lock: jr Lock
//   ...   00          (relleno)
//   00FE  E0 50       ldh  [$50], a         ; desmapea la boot ROM; sigue en 0100

/** Tamaño que exige gb_boot_rom (core/include/gb.h, GB_BOOT_MAX: 0000-00FF + 0200-08FF). */
export const BOOT_SIZE = 2304;
/** PC donde se queda bloqueada si falla una comprobación. */
export const LOCK_PC = 0x0030;
const LOGO_AT = 0x0200;

const CODE: ReadonlyArray<readonly [number, number[]]> = [
  [0x0000, [0x31, 0xfe, 0xff]],
  [0x0003, [0x21, 0x04, 0x01]],
  [0x0006, [0x11, LOGO_AT & 0xff, LOGO_AT >> 8]],
  [0x0009, [0x0e, 0x30]],
  [0x000b, [0x1a, 0xbe, 0x20, 0x21, 0x13, 0x23, 0x0d, 0x20, 0xf7]],
  [0x0014, [0xaf, 0x0e, 0x19]],
  [0x0017, [0x96, 0x3d, 0x23, 0x0d, 0x20, 0xfa]],
  [0x001d, [0xbe, 0x20, 0x10]],
  [0x0020, [0xfa, 0x43, 0x01, 0xe6, 0x80, 0x20, 0x04]],
  [0x0027, [0x3e, 0x04, 0xe0, 0x4c]],
  [0x002b, [0x3e, 0x11, 0xc3, 0xfe, 0x00]],
  [0x0030, [0x18, 0xfe]],
  [0x00fe, [0xe0, 0x50]],
];

/** Imagen de 2 304 bytes indexada por dirección (0100-01FF no se usa: es el cartucho). */
export function buildBootCheck(logo: Uint8Array): Uint8Array {
  if (logo.length !== 48) throw new Error("el logo esperado tiene 48 bytes");
  const img = new Uint8Array(BOOT_SIZE);
  for (const [addr, bytes] of CODE) img.set(bytes, addr);
  img.set(logo, LOGO_AT);
  return img;
}
