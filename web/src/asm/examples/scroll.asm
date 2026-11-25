; scroll.asm — fondo que se desplaza en diagonal (SCX/SCY) en Game Boy Color.
; Dos tiles propios (ladrillo y rombo) en damero sobre todo el mapa de 32×32 y cuatro
; paletas CGB por franjas de filas (atributos en el banco 1 de VRAM). Cada frame, en el
; VBlank, se incrementa SCX; SCY, uno de cada dos frames.

DEF rLCDC EQU $FF40
DEF rSCY  EQU $FF42
DEF rSCX  EQU $FF43
DEF rLY   EQU $FF44
DEF rVBK  EQU $FF4F
DEF rBCPS EQU $FF68
DEF rBCPD EQU $FF69

; Color CGB de 15 bits: R | G << 5 | B << 10 (0-31 cada componente).
MACRO rgb
    dw (\1) | (\2) << 5 | (\3) << 10
ENDM

SECTION "Entry", ROM0[$100]
    nop
    jp Main
    ds $150 - @, 0          ; cabecera del cartucho (la completa el IDE)

Main:
    di
    ld sp, $FFFE
    call WaitVBlank
    xor a
    ldh [rLCDC], a          ; LCD apagado: VRAM libre

    ; Tiles → $8000.
    ld hl, $8000
    ld de, Tiles
    ld bc, TilesEnd - Tiles
    call Copy

    ; Mapa $9800 (banco 0): damero de tiles 0 y 1 según (fila XOR columna) & 1.
    xor a
    ldh [rVBK], a
    ld hl, $9800
    ld d, 0                 ; fila
.row:
    ld e, 0                 ; columna
.col:
    ld a, d
    xor e
    and 1
    ld [hl+], a
    inc e
    ld a, e
    cp 32
    jr nz, .col
    inc d
    ld a, d
    cp 32
    jr nz, .row

    ; Atributos (banco 1): paleta = (fila / 4) & 3 → franjas de 32 píxeles.
    ld a, 1
    ldh [rVBK], a
    ld hl, $9800
    ld d, 0
.attrRow:
    ld a, d
    srl a
    srl a
    and 3
    ld b, a
    ld e, 32
.attrCol:
    ld a, b
    ld [hl+], a
    dec e
    jr nz, .attrCol
    inc d
    ld a, d
    cp 32
    jr nz, .attrRow
    xor a
    ldh [rVBK], a

    ; Paletas de fondo 0-3 (4 colores × 2 bytes cada una), con autoincremento.
    ld a, $80
    ldh [rBCPS], a
    ld hl, Palettes
    ld b, PalettesEnd - Palettes
.pal:
    ld a, [hl+]
    ldh [rBCPD], a
    dec b
    jr nz, .pal

    xor a
    ldh [rSCX], a
    ldh [rSCY], a
    ld a, %10010001         ; LCD on, fondo on, tiles en $8000, mapa en $9800
    ldh [rLCDC], a

.loop:
    call WaitVBlank
    ldh a, [rSCX]
    inc a
    ldh [rSCX], a
    and 1
    jr nz, .loop
    ldh a, [rSCY]
    inc a
    ldh [rSCY], a
    jr .loop

; Espera al principio del siguiente VBlank (LY pasa a 144).
WaitVBlank:
.inVBlank:
    ldh a, [rLY]
    cp 144
    jr nc, .inVBlank
.notYet:
    ldh a, [rLY]
    cp 144
    jr c, .notYet
    ret

; Copia bc bytes de [de] a [hl].
Copy:
    ld a, [de]
    ld [hl+], a
    inc de
    dec bc
    ld a, b
    or c
    jr nz, Copy
    ret

SECTION "Data", ROM0

Palettes:
    rgb  4,  2,  8          ; 0: tonos ciruela
    rgb 12,  6, 18
    rgb 22, 12, 26
    rgb 31, 24, 31
    rgb  2,  6,  4          ; 1: verdes
    rgb  6, 16,  8
    rgb 14, 26, 12
    rgb 26, 31, 20
    rgb  8,  4,  2          ; 2: tierra
    rgb 18, 10,  4
    rgb 28, 18,  8
    rgb 31, 28, 18
    rgb  2,  4, 10          ; 3: azules
    rgb  4, 10, 22
    rgb 10, 20, 31
    rgb 24, 28, 31
PalettesEnd:

; Cada fila: 8 píxeles con su color 0-3.
Tiles:
    ; 0: ladrillo
    dw `33333333, `12221222, `12221222, `11111111
    dw `33333333, `22122212, `22122212, `11111111
    ; 1: rombo
    dw `00000000, `00033000, `00322300, `03211230
    dw `03211230, `00322300, `00033000, `00000000
TilesEnd:
