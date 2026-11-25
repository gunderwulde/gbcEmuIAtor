; hello.asm — "HELLO WORLD!" en Game Boy Color.
; Fuente propia de 8x8 definida con literales gráficos (`0123), paleta CGB y mapa de fondo.
; La cabecera ($0104-$014F) se reserva con DS: la rellena el exportador (logo, título, checksums).

DEF rLCDC EQU $FF40
DEF rLY   EQU $FF44
DEF rVBK  EQU $FF4F
DEF rBCPS EQU $FF68 ; índice de paleta de fondo (bit 7 = autoincremento)
DEF rBCPD EQU $FF69 ; dato de paleta de fondo

; Color CGB de 15 bits: R | G << 5 | B << 10 (0-31 cada componente).
MACRO rgb
    dw (\1) | (\2) << 5 | (\3) << 10
ENDM

; Caracteres del texto → números de tile de la fuente.
CHARMAP " ", 0
CHARMAP "!", 1
CHARMAP "D", 2
CHARMAP "E", 3
CHARMAP "H", 4
CHARMAP "L", 5
CHARMAP "O", 6
CHARMAP "R", 7
CHARMAP "W", 8

SECTION "Entry", ROM0[$100]
    nop
    jp Main
    ds $150 - @, 0          ; cabecera del cartucho

Main:
    di
    ld sp, $FFFE

    ; Apagar el LCD sólo durante el VBlank (LY >= 144).
.waitVBlank:
    ldh a, [rLY]
    cp 144
    jr c, .waitVBlank
    xor a
    ldh [rLCDC], a

    ; Fuente → tiles $8000 (banco 0 de VRAM).
    ld hl, $8000
    ld de, Font
    ld bc, FontEnd - Font
.copyFont:
    ld a, [de]
    ld [hl+], a
    inc de
    dec bc
    ld a, b
    or c
    jr nz, .copyFont

    ; Mapa de fondo $9800-$9BFF: atributos (banco 1) a 0 y tiles (banco 0) a espacio.
    ld a, 1
    ldh [rVBK], a
    call ClearMap
    xor a
    ldh [rVBK], a
    call ClearMap

    ; Texto en la fila 8, columna 4.
    ld hl, $9800 + 8 * 32 + 4
    ld de, Message
.copyText:
    ld a, [de]
    cp $FF
    jr z, .palette
    ld [hl+], a
    inc de
    jr .copyText

    ; Paleta de fondo 0: 4 colores × 2 bytes, con autoincremento.
.palette:
    ld a, $80
    ldh [rBCPS], a
    ld hl, Palette
    ld b, PaletteEnd - Palette
.copyPalette:
    ld a, [hl+]
    ldh [rBCPD], a
    dec b
    jr nz, .copyPalette

    ; LCD encendido, fondo activo, tiles en $8000, mapa en $9800.
    ld a, %10010001
    ldh [rLCDC], a
.forever:
    halt
    jr .forever

ClearMap:
    ld hl, $9800
    ld bc, 32 * 32
.loop:
    xor a
    ld [hl+], a
    dec bc
    ld a, b
    or c
    jr nz, .loop
    ret

SECTION "Data", ROM0

Message:
    db "HELLO WORLD!", $FF

Palette:
    rgb  2,  4, 12          ; 0: azul oscuro (fondo)
    rgb  8, 12, 24          ; 1
    rgb 20, 24, 31          ; 2
    rgb 31, 31, 31          ; 3: blanco (texto)
PaletteEnd:

; Cada fila: 8 píxeles, color 0-3 (bit 7 = píxel de la izquierda).
Font:
    ; " "
    dw `00000000, `00000000, `00000000, `00000000
    dw `00000000, `00000000, `00000000, `00000000
    ; "!"
    dw `00033000, `00033000, `00033000, `00033000
    dw `00033000, `00000000, `00033000, `00000000
    ; "D"
    dw `33333000, `33003300, `33000330, `33000330
    dw `33000330, `33003300, `33333000, `00000000
    ; "E"
    dw `33333330, `33000000, `33000000, `33333300
    dw `33000000, `33000000, `33333330, `00000000
    ; "H"
    dw `33000330, `33000330, `33000330, `33333330
    dw `33000330, `33000330, `33000330, `00000000
    ; "L"
    dw `33000000, `33000000, `33000000, `33000000
    dw `33000000, `33000000, `33333330, `00000000
    ; "O"
    dw `03333300, `33000330, `33000330, `33000330
    dw `33000330, `33000330, `03333300, `00000000
    ; "R"
    dw `33333300, `33000330, `33000330, `33333300
    dw `33033000, `33003300, `33000330, `00000000
    ; "W"
    dw `33000330, `33000330, `33000330, `33030330
    dw `33333330, `33303330, `33000330, `00000000
FontEnd:

ASSERT FontEnd - Font == 9 * 16, "la fuente debe tener 9 tiles"
