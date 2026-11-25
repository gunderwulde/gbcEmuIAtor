; expand.asm — rellena map_tiles y map_attrs (filas de 32, como el mapa de VRAM)
; a partir de room[] (10×8 metatiles).
;
; Es el bucle más caliente del cambio de pantalla: en C cuesta unos 250 ciclos M por
; metatile (los marcos estáticos pasan cada puntero por memoria) y el cambio no cabía en
; un frame; aquí son unos 60. void expand_room(void); puede pisar AF, BC, DE y HL.
; Las tablas mt_block y mt_pal están en el banco 2 (world.c), que es el que está puesto
; cuando world_load llama aquí.

_expand_room:
    ; Pasada 1: tiles. Metatile de bloque b → tiles 96+4b … 96+4b+3 (2×2).
    ld bc, _room
    ld de, _map_tiles
    ld a, 8
.tile_row:
    push af
    ld a, 10
.tile_cell:
    push af
    ld a, [bc]
    inc bc
    ld l, a
    ld h, 0
    push de
    ld de, _mt_block
    add hl, de
    pop de
    ld a, [hl]
    add a, a
    add a, a
    add a, 96
    ld h, d
    ld l, e
    ld [hl+], a                 ; arriba-izq.
    inc a
    ld [hl], a                  ; arriba-der.
    inc a
    push de
    ld de, 31
    add hl, de
    pop de
    ld [hl+], a                 ; abajo-izq.
    inc a
    ld [hl], a                  ; abajo-der.
    inc de
    inc de
    pop af
    dec a
    jr nz, .tile_cell
    ld hl, 44                   ; resto de la fila (12) y la de abajo, ya escrita (32)
    add hl, de
    ld d, h
    ld e, l
    pop af
    dec a
    jr nz, .tile_row

    ; Pasada 2: atributos (la paleta del metatile en sus 4 tiles).
    ld bc, _room
    ld de, _map_attrs
    ld a, 8
.attr_row:
    push af
    ld a, 10
.attr_cell:
    push af
    ld a, [bc]
    inc bc
    ld l, a
    ld h, 0
    push de
    ld de, _mt_pal
    add hl, de
    pop de
    ld a, [hl]
    ld h, d
    ld l, e
    ld [hl+], a
    ld [hl], a
    push de
    ld de, 31
    add hl, de
    pop de
    ld [hl+], a
    ld [hl], a
    inc de
    inc de
    pop af
    dec a
    jr nz, .attr_cell
    ld hl, 44
    add hl, de
    ld d, h
    ld e, l
    pop af
    dec a
    jr nz, .attr_row
    ret
