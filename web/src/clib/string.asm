; string.asm — memcpy, memset, memcmp, strlen, strcpy, strcmp, strcat (string.h).
; Convención de pila de docs/c-abi.md: 1.er argumento en HL, el resto en [SP+2], [SP+4].
; Los contadores de 16 bits usan el par B:C como dos contadores de 8 (C vueltas y luego
; B veces 256), que en SM83 sale más barato que comparar BC con cero en cada byte.

SECTION "clib string", ROM0

; void *memcpy(void *dst, const void *src, unsigned int n)
_memcpy::
    push hl
    ld hl, sp+4
    ld e, [hl]
    inc hl
    ld d, [hl]
    inc hl
    ld c, [hl]
    inc hl
    ld b, [hl]
    pop hl
    push hl
    ld a, b
    or c
    jr z, .done
    ld a, c
    or a
    jr z, .loop
    inc b
.loop:
    ld a, [de]
    ld [hl+], a
    inc de
    dec c
    jr nz, .loop
    dec b
    jr nz, .loop
.done:
    pop hl
    ret

; void *memset(void *dst, int v, unsigned int n)
_memset::
    push hl
    ld hl, sp+4
    ld e, [hl]
    inc hl
    inc hl
    ld c, [hl]
    inc hl
    ld b, [hl]
    pop hl
    push hl
    ld a, b
    or c
    jr z, .done
    ld a, c
    or a
    jr z, .loop
    inc b
.loop:
    ld a, e
    ld [hl+], a
    dec c
    jr nz, .loop
    dec b
    jr nz, .loop
.done:
    pop hl
    ret

; int memcmp(const void *a, const void *b, unsigned int n): diferencia (como unsigned
; char) de los primeros bytes distintos; 0 si son iguales.
_memcmp::
    push hl
    ld hl, sp+4
    ld e, [hl]
    inc hl
    ld d, [hl]
    inc hl
    ld c, [hl]
    inc hl
    ld b, [hl]
    pop hl
    ld a, b
    or c
    jr z, StrEqual
    ld a, c
    or a
    jr z, .loop
    inc b
.loop:
    ld a, [de]
    cp [hl]
    jr nz, StrDiff
    inc de
    inc hl
    dec c
    jr nz, .loop
    dec b
    jr nz, .loop
StrEqual:
    ld hl, 0
    ret

; HL = [HL] - [DE] como int (de -255 a 255).
StrDiff:
    ld a, [de]
    ld b, a
    ld a, [hl]
    sub b
    ld l, a
    sbc a                   ; A = FFh si hubo préstamo
    ld h, a
    ret

; int strcmp(const char *a, const char *b)
_strcmp::
    push hl
    ld hl, sp+4
    ld e, [hl]
    inc hl
    ld d, [hl]
    pop hl
.loop:
    ld a, [de]
    cp [hl]
    jr nz, StrDiff
    or a
    jr z, StrEqual
    inc de
    inc hl
    jr .loop

; unsigned int strlen(const char *s)
_strlen::
    ld d, h
    ld e, l
.loop:
    ld a, [hl+]
    or a
    jr nz, .loop
    dec hl
    ld a, l
    sub e
    ld l, a
    ld a, h
    sbc d
    ld h, a
    ret

; char *strcpy(char *dst, const char *src)
_strcpy::
    push hl
    ld hl, sp+4
    ld e, [hl]
    inc hl
    ld d, [hl]
    pop hl
    push hl
.loop:
    ld a, [de]
    ld [hl+], a
    inc de
    or a
    jr nz, .loop
    pop hl
    ret

; char *strcat(char *dst, const char *src)
_strcat::
    push hl
    ld hl, sp+4
    ld e, [hl]
    inc hl
    ld d, [hl]
    pop hl
    push hl
.end:
    ld a, [hl+]
    or a
    jr nz, .end
    dec hl
.loop:
    ld a, [de]
    ld [hl+], a
    inc de
    or a
    jr nz, .loop
    pop hl
    ret
