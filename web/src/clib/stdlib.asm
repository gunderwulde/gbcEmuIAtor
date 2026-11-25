; stdlib.asm — rand, srand, abs (stdlib.h).

SECTION "clib stdlib", ROM0

; int rand(void): xorshift de 16 bits con la terna (7, 9, 8):
;   x ^= x << 7; x ^= x >> 9; x ^= x << 8
; Periodo 65535 (todos los estados salvo 0). Forma con RRA de John Metcalf (2015).
; Devuelve los 15 bits bajos (0-32767, RAND_MAX).
_rand::
    ld hl, _gbc_seed
    ld a, [hl+]
    ld h, [hl]
    ld l, a
    ld a, h
    rra
    ld a, l
    rra
    xor h
    ld h, a
    ld a, l
    rra
    ld a, h
    rra
    xor l
    ld l, a
    xor h
    ld h, a
    ld a, l
    ld [_gbc_seed], a
    ld a, h
    ld [_gbc_seed+1], a
    res 7, h
    ret

; void srand(unsigned int seed): el estado 0 es un punto fijo del xorshift; se cambia por 1.
_srand::
    ld a, h
    or l
    jr nz, .set
    inc l
.set:
    ld a, l
    ld [_gbc_seed], a
    ld a, h
    ld [_gbc_seed+1], a
    ret

; int abs(int x)
_abs::
    bit 7, h
    ret z
    xor a
    sub l
    ld l, a
    ld a, 0
    sbc h
    ld h, a
    ret
