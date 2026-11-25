; palettes.asm — paletas CGB animadas.
; Un solo tile propio de rayas diagonales con los 4 colores cubre la pantalla; cada fila
; de tiles usa una de las 8 paletas de fondo (atributos en el banco 1 de VRAM). Cada 4
; frames, en el VBlank, se reescriben las 8 paletas (32 colores) tomándolos de un arco
; iris de 32 colores con un desplazamiento que avanza: los colores fluyen sin tocar VRAM.

DEF rLCDC EQU $FF40
DEF rLY   EQU $FF44
DEF rVBK  EQU $FF4F
DEF rBCPS EQU $FF68
DEF rBCPD EQU $FF69

MACRO rgb
    dw (\1) | (\2) << 5 | (\3) << 10
ENDM

SECTION "Vars", HRAM
hFrame: ds 1

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

    ; Mapa (banco 0): todo tile 0.
    xor a
    ldh [rVBK], a
    ld hl, $9800
    ld bc, 32 * 32
.map:
    xor a
    ld [hl+], a
    dec bc
    ld a, b
    or c
    jr nz, .map

    ; Atributos (banco 1): paleta = fila & 7.
    ld a, 1
    ldh [rVBK], a
    ld hl, $9800
    ld d, 0
.attrRow:
    ld a, d
    and 7
    ld e, 32
.attrCol:
    ld [hl+], a
    dec e
    jr nz, .attrCol
    inc d
    ld a, d
    cp 32
    jr nz, .attrRow
    xor a
    ldh [rVBK], a

    xor a
    ldh [hFrame], a
    call LoadPalettes
    ld a, %10010001         ; LCD on, fondo on, tiles en $8000, mapa en $9800
    ldh [rLCDC], a

.loop:
    call WaitVBlank
    call LoadPalettes
    ldh a, [hFrame]
    inc a
    ldh [hFrame], a
    jr .loop

; Escribe los 32 colores de las 8 paletas de fondo: color i = Rainbow[(i + hFrame/4) & 31].
; Sólo en VBlank (en el modo 3 la RAM de paletas no es accesible).
LoadPalettes:
    ld a, $80
    ldh [rBCPS], a
    ldh a, [hFrame]
    srl a
    srl a
    ld c, a
    ld b, 32
.color:
    ld a, c
    and 31
    add a                   ; 2 bytes por color
    ld e, a
    ld d, 0
    ld hl, Rainbow
    add hl, de
    ld a, [hl+]
    ldh [rBCPD], a
    ld a, [hl]
    ldh [rBCPD], a
    inc c
    dec b
    jr nz, .color
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

SECTION "Data", ROM0

; Arco iris de 32 colores: 6 tramos (rojo → amarillo → verde → cian → azul → magenta → rojo)
; calculados en tiempo de ensamblado.
Rainbow:
FOR I, 32
    DEF HUE = I * 6
    DEF SEG = HUE / 32
    DEF F = HUE % 32
    IF SEG == 0
        rgb 31, F, 0
    ELIF SEG == 1
        rgb 31 - F, 31, 0
    ELIF SEG == 2
        rgb 0, 31, F
    ELIF SEG == 3
        rgb 0, 31 - F, 31
    ELIF SEG == 4
        rgb F, 0, 31
    ELSE
        rgb 31, 0, 31 - F
    ENDC
ENDR
RainbowEnd:

ASSERT RainbowEnd - Rainbow == 64, "el arco iris debe tener 32 colores"

Tiles:
    ; 0: rayas diagonales con los colores 0-3
    dw `00112233, `01122330, `11223300, `12233001
    dw `22330011, `23300112, `33001122, `30011223
TilesEnd:
