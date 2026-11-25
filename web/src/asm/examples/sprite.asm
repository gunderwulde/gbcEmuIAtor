; sprite.asm — un sprite que se mueve con la cruceta, en Game Boy Color.
; Fondo de puntos (tile 0) y una carita propia (tile 1) como objeto 0 de la OAM, con su
; paleta de objetos CGB. Cada frame se lee la cruceta (P1 con el bit 4 a 0) y, en el
; VBlank, se escribe la entrada de OAM directamente (sin DMA: sólo un objeto).

DEF rP1   EQU $FF00
DEF rLCDC EQU $FF40
DEF rLY   EQU $FF44
DEF rVBK  EQU $FF4F
DEF rBCPS EQU $FF68
DEF rBCPD EQU $FF69
DEF rOCPS EQU $FF6A         ; índice de paleta de objetos
DEF rOCPD EQU $FF6B
DEF OAM   EQU $FE00

; Bits de la cruceta tras leer P1 e invertir (1 = pulsado).
DEF PAD_RIGHT EQU 0
DEF PAD_LEFT  EQU 1
DEF PAD_UP    EQU 2
DEF PAD_DOWN  EQU 3

MACRO rgb
    dw (\1) | (\2) << 5 | (\3) << 10
ENDM

SECTION "Vars", HRAM
hX: ds 1                    ; posición en pantalla (0-152)
hY: ds 1                    ; (0-136)

SECTION "Entry", ROM0[$100]
    nop
    jp Main
    ds $150 - @, 0          ; cabecera del cartucho (la completa el IDE)

Main:
    di
    ld sp, $FFFE
    call WaitVBlank
    xor a
    ldh [rLCDC], a

    ld hl, $8000
    ld de, Tiles
    ld bc, TilesEnd - Tiles
    call Copy

    ; Mapa y atributos a 0 (tile 0, paleta 0).
    ld a, 1
    ldh [rVBK], a
    call ClearMap
    xor a
    ldh [rVBK], a
    call ClearMap

    ; OAM a 0: Y = 0 deja todos los objetos fuera de la pantalla.
    ld hl, OAM
    ld b, 160
    xor a
.clearOam:
    ld [hl+], a
    dec b
    jr nz, .clearOam

    ; Paleta de fondo 0 y paleta de objetos 0.
    ld a, $80
    ldh [rBCPS], a
    ldh [rOCPS], a
    ld hl, BgPalette
    ld b, 8
.bgPal:
    ld a, [hl+]
    ldh [rBCPD], a
    dec b
    jr nz, .bgPal
    ld hl, ObjPalette
    ld b, 8
.objPal:
    ld a, [hl+]
    ldh [rOCPD], a
    dec b
    jr nz, .objPal

    ld a, 76
    ldh [hX], a
    ld a, 68
    ldh [hY], a
    call UpdateOam

    ld a, %10010011         ; LCD on, tiles en $8000, objetos 8×8 on, fondo on
    ldh [rLCDC], a

.loop:
    call ReadPad
    ld b, a
    bit PAD_RIGHT, b
    jr z, .noRight
    ldh a, [hX]
    cp 160 - 8
    jr nc, .noRight
    inc a
    ldh [hX], a
.noRight:
    bit PAD_LEFT, b
    jr z, .noLeft
    ldh a, [hX]
    and a
    jr z, .noLeft
    dec a
    ldh [hX], a
.noLeft:
    bit PAD_DOWN, b
    jr z, .noDown
    ldh a, [hY]
    cp 144 - 8
    jr nc, .noDown
    inc a
    ldh [hY], a
.noDown:
    bit PAD_UP, b
    jr z, .noUp
    ldh a, [hY]
    and a
    jr z, .noUp
    dec a
    ldh [hY], a
.noUp:
    call WaitVBlank
    call UpdateOam
    jr .loop

; Objeto 0: Y+16, X+8 (las coordenadas de la OAM empiezan fuera de la pantalla).
UpdateOam:
    ld hl, OAM
    ldh a, [hY]
    add 16
    ld [hl+], a
    ldh a, [hX]
    add 8
    ld [hl+], a
    ld a, 1                 ; tile 1
    ld [hl+], a
    xor a                   ; atributos: paleta 0, banco 0, sin espejo
    ld [hl], a
    ret

; Cruceta → a (bits 0-3: derecha, izquierda, arriba, abajo; 1 = pulsado).
ReadPad:
    ld a, $20               ; bit 4 = 0: seleccionar la cruceta
    ldh [rP1], a
    ldh a, [rP1]            ; varias lecturas: las líneas tardan en estabilizarse
    ldh a, [rP1]
    ldh a, [rP1]
    cpl
    and $0F
    ld c, a
    ld a, $30               ; deseleccionar
    ldh [rP1], a
    ld a, c
    ret

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

Copy:
    ld a, [de]
    ld [hl+], a
    inc de
    dec bc
    ld a, b
    or c
    jr nz, Copy
    ret

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

BgPalette:
    rgb  3,  5,  9          ; fondo azul noche
    rgb  9, 12, 18          ; puntos
    rgb  0,  0,  0
    rgb  0,  0,  0
ObjPalette:
    rgb  0,  0,  0          ; color 0: transparente en los objetos
    rgb 31, 31,  0          ; cara amarilla
    rgb 31,  8,  4          ; boca y ojos
    rgb  4,  2,  0          ; contorno

Tiles:
    ; 0: fondo con un punto
    dw `10000000, `00000000, `00000000, `00000000
    dw `00001000, `00000000, `00000000, `00000000
    ; 1: carita
    dw `00333300, `03111130, `31211213, `31111113
    dw `31211213, `31122113, `03111130, `00333300
TilesEnd:
