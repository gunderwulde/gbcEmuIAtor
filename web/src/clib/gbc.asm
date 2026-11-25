; gbc.asm — rutinas de la librería gbc.h en ensamblador (L1).
;
; Convención de pila de docs/c-abi.md: 1.er argumento en A (8 bits) o HL (16 bits); los
; demás en la pila, [SP+2] = 2.º, [SP+4] = 3.º… (palabras de 2 bytes, los de 8 bits en el
; byte bajo). Retorno en A o HL. Se pueden pisar AF, BC, DE y HL.
;
; Están en ensamblador las rutinas que se llaman muchas veces por frame o que mueven
; muchos bytes (copias a VRAM, mapas, paletas, sprites, texto, joypad) y las que necesitan
; instrucciones sin equivalente en C (halt, stop, ei/di, reti).
;
; Regla de acceso a VRAM y paletas (docs/gbc-hardware.md §7.8): la CPU no puede tocarlas
; en el modo 3. Se lee STAT y se espera a que los bits 1-0 sean 0 (HBlank) o 1 (VBlank);
; desde esa lectura quedan al menos 20 ciclos M (los 80 puntos del modo 2 de la línea
; siguiente) antes del modo 3, y la escritura se hace a menos de 8 ciclos M. Con el LCD
; apagado STAT lee modo 0, así que la misma espera no cuesta nada.
; [VERIFICAR] La primera línea tras encender el LCD pasa de modo 0 a modo 3 en el punto
; 78 sin modo 2: una escritura justo en ese borde podría perderse. Cargar los gráficos
; con el LCD apagado (o en VBlank) evita el caso.
;
; Interrupciones: si se atiende una IRQ entre la lectura de STAT y la escritura, ésta
; puede caer en el modo 3 y perderse. Con IME a 1 cada byte se hace con di: leer STAT,
; si no es accesible ei (la IRQ pendiente entra tras el jr) y reintentar; si lo es,
; escribir y ei. IME no se puede leer, así que _gbc_ime (gbc.c) lleva una copia que
; actualizan ei(), di() y wait_vbl(); cada rutina la consulta al entrar y, con IME a 0,
; usa el bucle sin protección (nada puede interrumpirlo). Consecuencias: el programa
; debe cambiar IME con ei()/di() de gbc.h y no con ei/di sueltos en ensamblador, y una
; ISR que llame a estas rutinas con _gbc_ime a 1 vuelve a habilitar IME dentro de la ISR.
; lcd_off usa el mismo patrón entre ver LY >= 144 y escribir LCDC.

DEF GBC_P1    EQU $FF00
DEF GBC_IF    EQU $FF0F
DEF GBC_LCDC  EQU $FF40
DEF GBC_STAT  EQU $FF41
DEF GBC_SCY   EQU $FF42
DEF GBC_SCX   EQU $FF43
DEF GBC_LY    EQU $FF44
DEF GBC_WY    EQU $FF4A
DEF GBC_WX    EQU $FF4B
DEF GBC_KEY1  EQU $FF4D
DEF GBC_VBK   EQU $FF4F
DEF GBC_HDMA1 EQU $FF51
DEF GBC_HDMA2 EQU $FF52
DEF GBC_HDMA3 EQU $FF53
DEF GBC_HDMA4 EQU $FF54
DEF GBC_HDMA5 EQU $FF55
DEF GBC_BCPS  EQU $FF68
DEF GBC_OCPS  EQU $FF6A
DEF GBC_SVBK  EQU $FF70
DEF GBC_IE    EQU $FFFF

; Variables de trabajo de las rutinas (no se conservan entre llamadas: el crt0 no las
; pone a cero y no hace falta).
SECTION "gbc scratch", WRAM0
GbcArgPtr:  DS 2        ; printf: siguiente argumento en la pila
GbcPad:     DS 1        ; printf: carácter de relleno (' ' o '0')
GbcWidth:   DS 1        ; printf: anchura mínima
GbcNeg:     DS 1        ; printf: 1 si el número es negativo
GbcHexAdj:  DS 1        ; printf: 'a'-'0'-10 o 'A'-'0'-10
GbcBuf:     DS 8        ; printf: dígitos (se escriben hacia atrás)
GbcTmp:     DS 2
GbcTmp2:    DS 2
GbcRX:      DS 1        ; rectángulos de mapa
GbcRY:      DS 1
GbcRW:      DS 1
GbcRH:      DS 1
GbcRMap:    DS 1
GbcRFlags:  DS 1

SECTION "gbc lib", ROM0

; ------------------------------------------------------------------ Interrupción VBlank

; Rutina de VBlank de la librería: sólo cuenta frames. Guarda lo que pisa y vuelve con
; RETI (vuelve a habilitar IME sin el retardo de EI).
_gbc_vbl_isr::
    push af
    push hl
    ld hl, _vbl_count
    inc [hl]
    jr nz, .done
    inc hl
    inc [hl]
.done:
    pop hl
    pop af
    reti

; ------------------------------------------------------------------ LCD

_lcd_on::
    ldh a, [GBC_LCDC]
    or $80
    ldh [GBC_LCDC], a
    ret

; Apagar el LCD fuera de VBlank puede dañar la pantalla real: se espera a LY >= 144.
; (En la línea 153 LY ya lee 0 desde el punto 8; entonces se espera al VBlank siguiente.)
_lcd_off::
    ldh a, [GBC_LCDC]
    bit 7, a
    ret z
.wait:                      ; di en cada vuelta: una IRQ larga entre ver LY >= 144 y
    di                      ; escribir LCDC podría llevar la escritura fuera del VBlank
    ldh a, [GBC_LY]
    cp 144
    jr nc, .off
    ld a, [_gbc_ime]
    or a
    jr z, .wait
    ei
    jr .wait
.off:
    ldh a, [GBC_LCDC]
    res 7, a
    ldh [GBC_LCDC], a
    ld a, [_gbc_ime]
    or a
    ret z
    ei
    ret

; Espera al principio del próximo VBlank. Tras el arranque sin boot ROM IF.0 ya está a 1
; (docs §1): se borra antes de habilitar la IRQ para no despertar con un VBlank viejo.
; Con el LCD apagado no hay VBlank: vuelve enseguida.
_wait_vbl::
    ldh a, [GBC_LCDC]
    bit 7, a
    ret z
    di
    ldh a, [GBC_IF]
    and $FE
    ldh [GBC_IF], a
    ldh a, [GBC_IE]
    or $01
    ldh [GBC_IE], a
    ld a, 1
    ld [_gbc_ime], a
    ld hl, _vbl_count
    ld b, [hl]
    ei
.w:
    halt
    ld a, [hl]
    cp b
    jr z, .w                ; otra IRQ (STAT, timer…) también despierta al HALT
    ret

; void delay(unsigned int frames)
_delay::
    ld a, h
    or l
    ret z
    push hl
    call _wait_vbl
    pop hl
    dec hl
    jr _delay

; void scroll(unsigned char x, unsigned char y)
_scroll::
    ldh [GBC_SCX], a
    ld hl, sp+2
    ld a, [hl]
    ldh [GBC_SCY], a
    ret

; void window(unsigned char x, unsigned char y): el hardware dibuja la ventana desde la
; columna WX-7.
_window::
    add 7
    ldh [GBC_WX], a
    ld hl, sp+2
    ld a, [hl]
    ldh [GBC_WY], a
    ret

_window_on::
    ldh a, [GBC_LCDC]
    or $60                  ; LCDC.5 ventana visible, LCDC.6 mapa de 9C00h
    ldh [GBC_LCDC], a
    ret

_window_off::
    ldh a, [GBC_LCDC]
    and ~$20
    ldh [GBC_LCDC], a
    ret

_sprites_on::
    ldh a, [GBC_LCDC]
    or $02
    ldh [GBC_LCDC], a
    ret

_sprites_off::
    ldh a, [GBC_LCDC]
    and ~$02
    ldh [GBC_LCDC], a
    ret

; void sprites_8x16(unsigned char on)
_sprites_8x16::
    ld b, $04
    jr GbcLcdcBit

; void bg_priority(unsigned char on): en modo CGB LCDC.0 no oculta el fondo; a 0 hace que
; los sprites queden encima aunque el fondo o el sprite pidan prioridad.
_bg_priority::
    ld b, $01
GbcLcdcBit:                 ; A = 0 borra el bit B de LCDC; otro valor lo pone
    or a
    ld a, b
    jr z, .clear
    ld b, a
    ldh a, [GBC_LCDC]
    or b
    ldh [GBC_LCDC], a
    ret
.clear:
    cpl
    ld b, a
    ldh a, [GBC_LCDC]
    and b
    ldh [GBC_LCDC], a
    ret

; ------------------------------------------------------------------ Bancos

; void vram_bank(unsigned char n)
_vram_bank::
    and 1
    ldh [GBC_VBK], a
    ret

; void wram_bank(unsigned char n): SVBK con 0 selecciona el banco 1 (docs §2).
_wram_bank::
    and 7
    ldh [GBC_SVBK], a
    ret

; void rom_bank(unsigned char n). __cur_bank se actualiza ANTES de escribir en el MBC
; (docs/c-abi.md §8): si una interrupción hace una llamada __banked entre medias,
; restaura el banco correcto. Sólo se escribe en 2000h: en MBC1/MBC3 todo 2000h-3FFFh
; es el registro de banco, y en MBC5 el bit 8 (3000h) queda a 0 desde el arranque.
; n = 0: en MBC1/MBC3 el hardware lo convierte en el banco 1; en MBC5 mapea de verdad el
; banco 0 en 4000h-7FFFh (docs §10.3). En MBC1 sólo llega a los bancos 1-31 (5 bits).
_rom_bank::
    ldh [__cur_bank], a
    ld [$2000], a
    ret

; La RAM del cartucho se habilita escribiendo 0Ah en 0000h-1FFFh (MBC1/3/5).
_sram_on::
    ld a, $0A
    ld [$0000], a
    ret

_sram_off::
    xor a
    ld [$0000], a
    ret

; void sram_bank(unsigned char n): 4000h-5FFFh. En MBC1 ese registro sólo elige el banco
; de RAM en el modo 1 (escribir 1 en 6000h-7FFFh); en el modo 0, el del arranque, se usa
; el banco 0 de RAM y estos 2 bits pasan a ser los altos del banco de ROM. No se pone el
; modo aquí porque en el modo 1 los mismos bits cambian también el banco visto en
; 0000h-3FFFh de las ROM de 1 MB o más. MBC3: 0-3 (08h-0Ch es el RTC); MBC5: 0-15.
_sram_bank::
    ld [$4000], a
    ret

; ------------------------------------------------------------------ CPU e interrupciones

; Cambio de velocidad: KEY1.0 = 1 y STOP (docs §5). Durante STOP no debe haber ninguna
; interrupción pendiente y habilitada, así que se vacía IE mientras tanto. P1 = 30h
; deselecciona el joypad para que una tecla no despierte al STOP.
_cpu_fast::
    ldh a, [GBC_KEY1]
    bit 7, a
    ret nz
    jr GbcSpeedSwitch

_cpu_slow::
    ldh a, [GBC_KEY1]
    bit 7, a
    ret z
GbcSpeedSwitch:
    ldh a, [GBC_IE]
    ld b, a
    xor a
    ldh [GBC_IE], a
    ld a, $30
    ldh [GBC_P1], a
    ld a, $01
    ldh [GBC_KEY1], a
    stop
    ld a, b
    ldh [GBC_IE], a
    ret

; unsigned char cpu_is_fast(void): KEY1.7 = velocidad actual.
_cpu_is_fast::
    ldh a, [GBC_KEY1]
    rlca
    and 1
    ret

; void irq_enable(unsigned char mask)
_irq_enable::
    ld b, a
    ldh a, [GBC_IE]
    or b
    ldh [GBC_IE], a
    ret

; void irq_disable(unsigned char mask)
_irq_disable::
    cpl
    ld b, a
    ldh a, [GBC_IE]
    and b
    ldh [GBC_IE], a
    ret

; IME no se puede leer: _gbc_ime (gbc.c) lleva una copia para que las esperas a STAT
; sepan si deben protegerse (ver la cabecera del fichero).
_ei::
    ld a, 1
    ld [_gbc_ime], a
    ei
    ret

_di::
    di
    xor a
    ld [_gbc_ime], a
    ret

; ------------------------------------------------------------------ VRAM

; Escribe B en [HL] esperando a que la VRAM sea accesible. Sólo pisa A.
GbcVramPut:
    ld a, [_gbc_ime]
    or a
    jr nz, .irq
.w:
    ldh a, [GBC_STAT]
    and 2
    jr nz, .w
    ld [hl], b
    ret
.irq:
    di
    ldh a, [GBC_STAT]
    and 2
    jr z, .ok
    ei                      ; la IRQ pendiente se atiende tras el jr
    jr .irq
.ok:
    ld [hl], b
    ei
    ret

; void vram_set(unsigned int addr, unsigned char v)
_vram_set::
    push hl
    ld hl, sp+4
    ld b, [hl]
    pop hl
    jr GbcVramPut

; unsigned char vram_get(unsigned int addr)
_vram_get::
    ld a, [_gbc_ime]
    or a
    jr nz, .irq
.w:
    ldh a, [GBC_STAT]
    and 2
    jr nz, .w
    ld a, [hl]
    ret
.irq:
    di
    ldh a, [GBC_STAT]
    and 2
    jr z, .ok
    ei
    jr .irq
.ok:
    ld a, [hl]
    ei
    ret

; void vram_copy(unsigned int dst, const void *src, unsigned int len)
_vram_copy::
    push hl
    ld hl, sp+4
    ld e, [hl]
    inc hl
    ld d, [hl]              ; DE = origen
    inc hl
    ld c, [hl]
    inc hl
    ld b, [hl]              ; BC = longitud
    pop hl                  ; HL = destino
    ; sigue en GbcCopy

; Copia BC bytes de [DE] a [HL] (VRAM). Con el LCD apagado usa GDMA si todo está
; alineado a 16 y el origen es legible por la DMA (no VRAM ni E000h+, docs §4); si no,
; un bucle sin esperas. Con el LCD encendido, byte a byte esperando a STAT.
GbcCopy:
    ld a, b
    or c
    ret z
    ldh a, [GBC_LCDC]
    bit 7, a
    jr nz, .slow
    ld a, l
    or e
    or c
    and $0F
    jr nz, .fast
    ld a, d
    cp $E0
    jr nc, .fast
    and $E0
    cp $80
    jr z, .fast
.gdma:
    ld a, d
    ldh [GBC_HDMA1], a
    ld a, e
    ldh [GBC_HDMA2], a
    ld a, h
    ldh [GBC_HDMA3], a
    ld a, l
    ldh [GBC_HDMA4], a
    ld a, b
    cp 8
    jr c, .last             ; quedan menos de 2048 bytes
    ld a, $7F               ; 128 bloques de 16 bytes: el máximo de una GDMA
    ldh [GBC_HDMA5], a
    ld a, h
    add 8
    ld h, a
    ld a, d
    add 8
    ld d, a
    ld a, b
    sub 8
    ld b, a
    or c
    jr nz, .gdma
    ret
.last:
    ld a, c                 ; A = (B << 4) | (C >> 4) = len / 16 (B < 8)
    and $F0
    or b
    swap a
    dec a                   ; HDMA5 bits 6-0 = bloques - 1; bit 7 = 0: GDMA
    ldh [GBC_HDMA5], a
    ret
.fast:
    ld a, c                 ; contador de 16 bits con dos de 8: C vueltas y luego
    or a                    ; B veces 256
    jr z, .floop
    inc b
.floop:
    ld a, [de]
    ld [hl+], a
    inc de
    dec c
    jr nz, .floop
    dec b
    jr nz, .floop
    ret
.slow:
    ld a, c
    or a
    jr z, .sk
    inc b
.sk:
    ld a, [_gbc_ime]
    or a
    jr nz, .iloop
.sloop:
    ldh a, [GBC_STAT]
    and 2
    jr nz, .sloop
    ld a, [de]
    ld [hl+], a
    inc de
    dec c
    jr nz, .sloop
    dec b
    jr nz, .sloop
    ret
.iloop:                     ; con IME a 1: di entre la lectura de STAT y la escritura
    di
    ldh a, [GBC_STAT]
    and 2
    jr z, .iok
    ei
    jr .iloop
.iok:
    ld a, [de]
    ld [hl+], a
    ei
    inc de
    dec c
    jr nz, .iloop
    dec b
    jr nz, .iloop
    ret

; void vram_fill(unsigned int dst, unsigned char v, unsigned int len)
_vram_fill::
    push hl
    ld hl, sp+4
    ld e, [hl]              ; E = valor
    inc hl
    inc hl
    ld c, [hl]
    inc hl
    ld b, [hl]              ; BC = longitud
    pop hl
    ; sigue en GbcFill

; Escribe E en BC bytes desde [HL] (VRAM), esperando a STAT en cada byte.
GbcFill:
    ld a, b
    or c
    ret z
    ld a, c
    or a
    jr z, .k
    inc b
.k:
    ld a, [_gbc_ime]
    or a
    jr nz, .iloop
.loop:
    ldh a, [GBC_STAT]
    and 2
    jr nz, .loop
    ld a, e
    ld [hl+], a
    dec c
    jr nz, .loop
    dec b
    jr nz, .loop
    ret
.iloop:
    di
    ldh a, [GBC_STAT]
    and 2
    jr z, .iok
    ei
    jr .iloop
.iok:
    ld a, e
    ld [hl+], a
    ei
    dec c
    jr nz, .iloop
    dec b
    jr nz, .iloop
    ret

; void set_sprite_tiles(unsigned char first, unsigned int n, const void *data)
; Los tiles de sprites están siempre en 8000h + 16·n.
_set_sprite_tiles::
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl
    ld a, h
    or $80
    ld h, a
    push hl
    ld hl, sp+4
    ld c, [hl]
    inc hl
    ld b, [hl]              ; BC = n
    inc hl
    ld e, [hl]
    inc hl
    ld d, [hl]              ; DE = datos
    sla c                   ; BC = 16·n
    rl b
    sla c
    rl b
    sla c
    rl b
    sla c
    rl b
    pop hl
    jp GbcCopy

; void set_bg_tiles(unsigned char first, unsigned int n, const void *data)
; Con LCDC.4 = 1 el fondo usa 8000h + 16·n (igual que los sprites). Con LCDC.4 = 0 los
; tiles 0-127 están en 9000h y los 128-255 en 8800h (direccionamiento con signo, docs
; §7.3): si el bloque cruza el 128 se parte en dos copias.
_set_bg_tiles::
    ld c, a
    ldh a, [GBC_LCDC]
    bit 4, a
    ld a, c
    jr nz, _set_sprite_tiles
    cp 128
    jr nc, _set_sprite_tiles
    ld hl, sp+2
    ld e, [hl]
    inc hl
    ld d, [hl]              ; DE = n
    inc hl
    ld a, [hl+]
    ld [GbcTmp], a
    ld a, [hl]
    ld [GbcTmp+1], a        ; GbcTmp = datos
    ld a, d
    or e
    ret z
    ld a, 128
    sub c
    ld b, a                 ; B = tiles que caben hasta el 127
    ld a, d
    or a
    jr nz, .k
    ld a, e
    cp b
    jr nc, .k
    ld b, e                 ; caben todos
.k:
    ld a, e
    sub b
    ld [GbcTmp2], a
    ld a, d
    sbc 0
    ld [GbcTmp2+1], a       ; GbcTmp2 = tiles para 8800h
    ld l, c
    ld h, 0
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl
    ld a, h
    add $90
    ld h, a
    push hl                 ; destino = 9000h + 16·first
    ld l, b
    ld h, 0
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl
    ld b, h
    ld c, l                 ; BC = 16·k
    ld hl, GbcTmp
    ld a, [hl+]
    ld h, [hl]
    ld l, a
    ld d, h
    ld e, l                 ; DE = datos
    add hl, bc
    ld a, l
    ld [GbcTmp], a
    ld a, h
    ld [GbcTmp+1], a        ; GbcTmp = datos del resto
    pop hl
    call GbcCopy
    ld hl, GbcTmp2
    ld a, [hl+]
    ld b, [hl]
    ld c, a
    or b
    ret z
    sla c
    rl b
    sla c
    rl b
    sla c
    rl b
    sla c
    rl b
    ld hl, GbcTmp
    ld a, [hl+]
    ld d, [hl]
    ld e, a
    ld hl, $8800
    jp GbcCopy

; ------------------------------------------------------------------ DMA de VRAM

; void gdma_copy(unsigned int dst, const void *src, unsigned int len)
_gdma_copy::
    ld b, $00
    jr GbcDma

; void hdma_copy(unsigned int dst, const void *src, unsigned int len)
; Con el LCD apagado no hay HBlanks: se hace GDMA (la HDMA copiaría sólo un bloque).
_hdma_copy::
    ldh a, [GBC_LCDC]
    and $80
    ld b, a
GbcDma:                     ; B = bit 7 de HDMA5
    ld a, h
    ldh [GBC_HDMA3], a
    ld a, l
    ldh [GBC_HDMA4], a
    ld hl, sp+2
    ld a, [hl+]
    ld c, a
    ld a, [hl+]
    ldh [GBC_HDMA1], a
    ld a, c
    ldh [GBC_HDMA2], a
    ld a, [hl+]
    ld c, a
    ld h, [hl]
    ld l, c                 ; HL = longitud
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l                    ; L = bloques (1-128)
    ld a, l
    or a
    ret z
    dec a
    and $7F
    or b
    ldh [GBC_HDMA5], a
    ret

; unsigned char hdma_busy(void): HDMA5.7 lee 0 mientras la HDMA está activa.
_hdma_busy::
    ldh a, [GBC_HDMA5]
    rlca
    and 1
    xor 1
    ret

; ------------------------------------------------------------------ Mapas

; Rectángulo de mapa. Entrada: A = x, B = byte alto del mapa (98h/9Ch), C = bit 0 banco
; de VRAM (0 tiles, 1 atributos), bit 1 relleno (el 5.º argumento es el valor) en vez de
; copia (el 5.º es un puntero). Pila como la función C: [SP+2] y, [SP+4] w, [SP+6] h,
; [SP+8] datos/valor. Las filas del mapa son de 32 celdas.
GbcRect:
    ld [GbcRX], a
    ld a, b
    ld [GbcRMap], a
    ld a, c
    ld [GbcRFlags], a
    ld hl, sp+2
    ld a, [hl+]
    ld [GbcRY], a
    inc hl
    ld a, [hl+]
    ld [GbcRW], a
    or a
    ret z
    inc hl
    ld a, [hl+]
    ld [GbcRH], a
    or a
    ret z
    inc hl
    ld a, [hl+]
    ld e, a
    ld d, [hl]              ; DE = datos (o E = valor)
    ldh a, [GBC_VBK]
    push af
    ld a, [GbcRFlags]
    and 1
    ldh [GBC_VBK], a
    ld a, [GbcRY]
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl              ; y·32: los 5 bits bajos quedan a 0, x (< 32) no lleva acarreo
    ld a, [GbcRX]
    add l
    ld l, a
    ld a, [GbcRMap]
    add h
    ld h, a
    ld a, [_gbc_ime]        ; bit 2 de las banderas: IME a 1, bucles protegidos
    add a
    add a
    ld b, a
    ld a, [GbcRFlags]
    or b
    ld [GbcRFlags], a
    ld a, [GbcRH]
    ld c, a
.row:
    push hl
    ld a, [GbcRW]
    ld b, a
    ld a, [GbcRFlags]
    bit 2, a
    jr nz, .irow
    bit 1, a
    jr nz, .fill
.copy:
    ldh a, [GBC_STAT]
    and 2
    jr nz, .copy
    ld a, [de]
    ld [hl+], a
    inc de
    dec b
    jr nz, .copy
    jr .next
.fill:
    ldh a, [GBC_STAT]
    and 2
    jr nz, .fill
    ld a, e
    ld [hl+], a
    dec b
    jr nz, .fill
    jr .next
.irow:
    bit 1, a
    jr nz, .ifill
.icopy:
    di
    ldh a, [GBC_STAT]
    and 2
    jr z, .icok
    ei
    jr .icopy
.icok:
    ld a, [de]
    ld [hl+], a
    ei
    inc de
    dec b
    jr nz, .icopy
    jr .next
.ifill:
    di
    ldh a, [GBC_STAT]
    and 2
    jr z, .ifok
    ei
    jr .ifill
.ifok:
    ld a, e
    ld [hl+], a
    ei
    dec b
    jr nz, .ifill
.next:
    pop hl
    ld a, l
    add 32
    ld l, a
    jr nc, .nc
    inc h
.nc:
    dec c
    jr nz, .row
    pop af
    ldh [GBC_VBK], a
    ret

_set_bg_map::
    ld bc, $9800
    jp GbcRect
_set_bg_attr::
    ld bc, $9801
    jp GbcRect
_fill_bg::
    ld bc, $9802
    jp GbcRect
_fill_bg_attr::
    ld bc, $9803
    jp GbcRect
_set_win_map::
    ld bc, $9C00
    jp GbcRect
_set_win_attr::
    ld bc, $9C01
    jp GbcRect
_fill_win::
    ld bc, $9C02
    jp GbcRect
_fill_win_attr::
    ld bc, $9C03
    jp GbcRect

; A = y, C = x -> HL = 9800h + 32·y + x. Pisa A.
GbcBgAddr:
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl
    ld a, l
    add c
    ld l, a
    ld a, h
    add $98
    ld h, a
    ret

; void set_bg_tile(unsigned char x, unsigned char y, unsigned char tile)
_set_bg_tile::
    ld c, a
    ld hl, sp+2
    ld a, [hl+]
    inc hl
    ld b, [hl]
    call GbcBgAddr
    ldh a, [GBC_VBK]
    ld c, a
    xor a
    ldh [GBC_VBK], a
    call GbcVramPut
    ld a, c
    ldh [GBC_VBK], a
    ret

; unsigned char get_bg_tile(unsigned char x, unsigned char y)
_get_bg_tile::
    ld c, a
    ld hl, sp+2
    ld a, [hl]
    call GbcBgAddr
    ldh a, [GBC_VBK]
    ld c, a
    xor a
    ldh [GBC_VBK], a
    call _vram_get
    ld b, a
    ld a, c
    ldh [GBC_VBK], a
    ld a, b
    ret

; ------------------------------------------------------------------ Paletas

; void set_bg_palette(unsigned char n, const unsigned int *colors)
; BCPS/OCPS con el bit 7 avanzan el índice tras cada escritura en BCPD/OCPD. Las paletas
; están bloqueadas durante el modo 3 (y unos puntos más): se espera a STAT en cada byte.
_set_bg_palette::
    ld c, LOW(GBC_BCPS)
    jr GbcSetPal

_set_sprite_palette::
    ld c, LOW(GBC_OCPS)
GbcSetPal:
    and 7
    add a
    add a
    add a
    or $80
    ldh [c], a
    inc c                   ; BCPD / OCPD
    ld hl, sp+2
    ld a, [hl+]
    ld h, [hl]
    ld l, a
    ld b, 8
    ld a, [_gbc_ime]
    ld e, a                 ; E = copia de IME (ver GbcVramPut)
.loop:
    di
    ldh a, [GBC_STAT]
    and 2
    jr z, .ok
    ld a, e
    or a
    jr z, .loop
    ei
    jr .loop
.ok:
    ld a, [hl+]
    ldh [c], a
    ld a, e
    or a
    jr z, .n
    ei
.n:
    dec b
    jr nz, .loop
    ret

; void set_bg_color(unsigned char pal, unsigned char idx, unsigned int color)
_set_bg_color::
    ld c, LOW(GBC_BCPS)
    jr GbcSetColor

_set_sprite_color::
    ld c, LOW(GBC_OCPS)
GbcSetColor:
    and 7
    add a
    add a
    add a
    ld b, a
    ld hl, sp+2
    ld a, [hl+]
    and 3
    add a
    add b
    or $80
    ldh [c], a
    inc c
    inc hl
    ld e, [hl]
    inc hl
    ld d, [hl]
    ld a, [_gbc_ime]
    ld b, a                 ; B = copia de IME (ver GbcVramPut)
.w1:
    di
    ldh a, [GBC_STAT]
    and 2
    jr z, .o1
    ld a, b
    or a
    jr z, .w1
    ei
    jr .w1
.o1:
    ld a, e
    ldh [c], a
.w2:                        ; sin ei entre los dos bytes: lo normal es que sigan en la
    di                      ; misma ventana y no se abre hueco a la IRQ
    ldh a, [GBC_STAT]
    and 2
    jr z, .o2
    ld a, b
    or a
    jr z, .w2
    ei
    jr .w2
.o2:
    ld a, d
    ldh [c], a
    ld a, b
    or a
    ret z
    ei
    ret

; ------------------------------------------------------------------ Sprites (OAM sombra)

; DE = entrada n de la OAM sombra; vuelve con acarreo a 0 si n >= 40 (no se toca nada:
; más allá de C09Fh están los marcos del compilador).
GbcOamPtr:
    cp 40
    ret nc
    add a
    add a
    ld e, a
    ld d, HIGH(_shadow_oam)
    scf
    ret

; void sprite_set(unsigned char n, unsigned char x, unsigned char y, unsigned char tile,
;                 unsigned char attr): la OAM guarda Y+16 y X+8.
_sprite_set::
    call GbcOamPtr
    ret nc
    ld hl, sp+4
    ld a, [hl]
    add 16
    ld [de], a
    inc e
    ld hl, sp+2
    ld a, [hl]
    add 8
    ld [de], a
    inc e
    ld hl, sp+6
    ld a, [hl+]
    ld [de], a
    inc e
    inc hl
    ld a, [hl]
    ld [de], a
    ret

; void sprite_move(unsigned char n, unsigned char x, unsigned char y)
_sprite_move::
    call GbcOamPtr
    ret nc
    ld hl, sp+4
    ld a, [hl]
    add 16
    ld [de], a
    inc e
    ld hl, sp+2
    ld a, [hl]
    add 8
    ld [de], a
    ret

; void sprite_tile(unsigned char n, unsigned char tile)
_sprite_tile::
    call GbcOamPtr
    ret nc
    inc e
    inc e
    ld hl, sp+2
    ld a, [hl]
    ld [de], a
    ret

; void sprite_attr(unsigned char n, unsigned char attr)
_sprite_attr::
    call GbcOamPtr
    ret nc
    inc e
    inc e
    inc e
    ld hl, sp+2
    ld a, [hl]
    ld [de], a
    ret

; void sprite_hide(unsigned char n): Y = 0 deja el sprite por encima de la pantalla.
_sprite_hide::
    call GbcOamPtr
    ret nc
    xor a
    ld [de], a
    ret

_sprites_hide_all::
    ld hl, _shadow_oam
    ld b, 40
    xor a
.loop:
    ld [hl+], a
    inc l
    inc l
    inc l
    dec b
    jr nz, .loop
    ret

; void oam_flush(void): OAM DMA de la sombra (160 ciclos M). Durante la DMA la CPU sólo
; puede leer HRAM; una interrupción saltaría a ROM: se vacía IE mientras dura.
_oam_flush::
    ldh a, [GBC_IE]
    ld b, a
    xor a
    ldh [GBC_IE], a
    ld a, HIGH(_shadow_oam)
    call __oam_dma_hram
    ld a, b
    ldh [GBC_IE], a
    ret

; ------------------------------------------------------------------ Texto

; void text_init(unsigned char first_tile): la fuente (ASCII 32-127) en los tiles
; first_tile..first_tile+95 del fondo.
_text_init::
    ld b, a
    sub 32
    ld [_gbc_tfont], a
    ld a, $98
    ld [_gbc_tmap], a
    xor a
    ld [_gbc_tx], a
    ld [_gbc_ty], a
    ld [_gbc_tattr], a
    ld hl, _gbc_font
    push hl
    ld hl, 96
    push hl
    ld a, b
    call _set_bg_tiles
    add sp, 4
    ret

; void text_layer(unsigned char layer)
_text_layer::
    or a
    ld a, $98
    jr z, .set
    ld a, $9C
.set:
    ld [_gbc_tmap], a
    ret

; void text_attr(unsigned char attr)
_text_attr::
    ld [_gbc_tattr], a
    ret

; void at(unsigned char x, unsigned char y)
_at::
    ld [_gbc_tx], a
    ld hl, sp+2
    ld a, [hl]
    ld [_gbc_ty], a
    ret

; void cls(void): espacios (con el atributo actual) en los 32×32 del mapa de texto.
_cls::
    xor a
    ld [_gbc_tx], a
    ld [_gbc_ty], a
    ldh a, [GBC_VBK]
    push af
    xor a
    ldh [GBC_VBK], a
    ld a, [_gbc_tfont]
    add 32
    ld e, a
    ld a, [_gbc_tmap]
    ld h, a
    ld l, 0
    ld bc, 1024
    call GbcFill
    ld a, 1
    ldh [GBC_VBK], a
    ld a, [_gbc_tattr]
    ld e, a
    ld a, [_gbc_tmap]
    ld h, a
    ld l, 0
    ld bc, 1024
    call GbcFill
    pop af
    ldh [GBC_VBK], a
    ret

; int putchar(int c): el tile en el banco 0 de VRAM y el atributo en el banco 1.
_putchar::
    push hl
    ld a, l
    cp 10
    jr nz, .char
    xor a
    ld [_gbc_tx], a
    jr .newline
.char:
    ld b, a
    ld a, [_gbc_tfont]
    add b
    ld b, a                 ; B = tile
    ld a, [_gbc_ty]
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl
    ld a, [_gbc_tx]
    add l
    ld l, a
    ld a, [_gbc_tmap]
    add h
    ld h, a
    ldh a, [GBC_VBK]
    ld c, a
    xor a
    ldh [GBC_VBK], a
    call GbcVramPut
    ld a, 1
    ldh [GBC_VBK], a
    ld a, [_gbc_tattr]
    ld b, a
    call GbcVramPut
    ld a, c
    ldh [GBC_VBK], a
    ld a, [_gbc_tx]
    inc a
    ld [_gbc_tx], a
    cp 20
    jr c, .done
    xor a
    ld [_gbc_tx], a
.newline:
    ld a, [_gbc_ty]
    inc a
    cp 18
    jr c, .sety
    xor a
.sety:
    ld [_gbc_ty], a
.done:
    pop hl
    ret

; void print(const char *s)
_print::
    ld a, [hl+]
    or a
    ret z
    push hl
    ld l, a
    ld h, 0
    call _putchar
    pop hl
    jr _print

; putchar(A) conservando BC, DE y HL.
GbcPutA:
    push bc
    push de
    push hl
    ld l, a
    ld h, 0
    call _putchar
    pop hl
    pop de
    pop bc
    ret

; void printf(const char *fmt, ...): los argumentos variables están en la pila desde
; [SP+2], ya promocionados a int (docs/c-abi.md §3.1). No es reentrante.
_printf::
    push hl
    ld hl, sp+4
    ld a, l
    ld [GbcArgPtr], a
    ld a, h
    ld [GbcArgPtr+1], a
    pop hl
.loop:
    ld a, [hl+]
    or a
    ret z
    cp "%"
    jr z, .fmt
.put:
    call GbcPutA
    jr .loop
.fmt:
    ld a, " "
    ld [GbcPad], a
    xor a
    ld [GbcWidth], a
    ld [GbcNeg], a
    ld a, [hl]
    cp "0"
    jr nz, .width
    ld [GbcPad], a
    inc hl
.width:
    ld a, [hl]
    sub "0"
    jr c, .conv
    cp 10
    jr nc, .conv
    ld b, a
    ld a, [GbcWidth]
    ld c, a
    add a
    add a
    add c
    add a                   ; anchura · 10
    add b
    ld [GbcWidth], a
    inc hl
    jr .width
.conv:
    ld a, [hl+]
    or a
    ret z
    cp "%"
    jr z, .put
    push hl
    call GbcConv
    pop hl
    jr .loop

; A = letra de conversión de printf.
GbcConv:
    cp "c"
    jr z, .c
    cp "s"
    jr z, .s
    cp "d"
    jr z, .d
    cp "i"
    jr z, .d
    cp "u"
    jr z, .u
    cp "x"
    jr z, .x
    cp "X"
    jr z, .xu
    jp GbcPutA              ; conversión desconocida: se escribe tal cual
.c:
    call GbcNextArg
    ld a, e
    jp GbcPutA
.s:
    call GbcNextArg
.sloop:
    ld a, [de]
    or a
    ret z
    inc de
    call GbcPutA
    jr .sloop
.d:
    call GbcNextArg
    bit 7, d
    jr z, GbcFmtDec
    xor a                   ; DE = -DE
    sub e
    ld e, a
    ld a, 0
    sbc d
    ld d, a
    ld a, 1
    ld [GbcNeg], a
    jr GbcFmtDec
.u:
    call GbcNextArg
    jr GbcFmtDec
.x:
    call GbcNextArg
    ld a, "a" - "0" - 10
    jr .hex
.xu:
    call GbcNextArg
    ld a, "A" - "0" - 10
.hex:
    ld [GbcHexAdj], a
    jr GbcFmtHex

; DE = siguiente argumento de printf.
GbcNextArg:
    ld hl, GbcArgPtr
    ld a, [hl+]
    ld h, [hl]
    ld l, a
    ld e, [hl]
    inc hl
    ld d, [hl]
    inc hl
    ld a, l
    ld [GbcArgPtr], a
    ld a, h
    ld [GbcArgPtr+1], a
    ret

; HL = HL / 10, A = HL % 10 (división con restas, 16 vueltas). Pisa C.
GbcDiv10:
    xor a
    ld c, 16
.loop:
    add hl, hl
    rla
    cp 10
    jr c, .next
    sub 10
    inc l
.next:
    dec c
    jr nz, .loop
    ret

; Escribe DE en decimal sin signo (con GbcNeg, GbcPad y GbcWidth).
GbcFmtDec:
    ld h, d
    ld l, e
    ld de, GbcBuf + 8
    ld b, 0
.loop:
    call GbcDiv10
    add "0"
    dec de
    ld [de], a
    inc b
    ld a, h
    or l
    jr nz, .loop
    jr GbcEmitNum

; Escribe DE en hexadecimal.
GbcFmtHex:
    ld h, d
    ld l, e
    ld de, GbcBuf + 8
    ld b, 0
.loop:
    ld a, l
    and $0F
    cp 10
    jr c, .digit
    ld c, a
    ld a, [GbcHexAdj]
    add c
.digit:
    add "0"
    dec de
    ld [de], a
    inc b
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    ld a, h
    or l
    jr nz, .loop
    ; sigue en GbcEmitNum

; DE = primer dígito, B = número de dígitos. Relleno a la izquierda hasta GbcWidth: con
; '0' el signo va antes de los ceros ("-0042"); con ' ', después de los espacios.
GbcEmitNum:
    ld a, [GbcNeg]
    add b
    ld c, a
    ld a, [GbcWidth]
    sub c
    jr c, .nopad
    jr z, .nopad
    ld c, a                 ; C = caracteres de relleno
    ld a, [GbcPad]
    cp "0"
    jr nz, .spaces
    call .sign
.zeros:
    ld a, "0"
    call GbcPutA
    dec c
    jr nz, .zeros
    jr .digits
.spaces:
    ld a, " "
    call GbcPutA
    dec c
    jr nz, .spaces
.nopad:
    call .sign
.digits:
    ld a, [de]
    inc de
    call GbcPutA
    dec b
    jr nz, .digits
    ret
.sign:
    ld a, [GbcNeg]
    or a
    ret z
    ld a, "-"
    jp GbcPutA

; ------------------------------------------------------------------ Joypad

; unsigned char joypad(void). P1 a nivel bajo: bit 4 = 0 selecciona la cruceta (bits
; 0-3: derecha, izquierda, arriba, abajo), bit 5 = 0 los botones (A, B, Select, Start).
; Se lee varias veces porque las líneas tardan unos ciclos en asentarse tras cambiar la
; selección (como hacen los juegos).
_joypad::
    ld a, $20
    ldh [GBC_P1], a
    ldh a, [GBC_P1]
    ldh a, [GBC_P1]
    cpl
    and $0F
    ld b, a
    ld a, $10
    ldh [GBC_P1], a
    ldh a, [GBC_P1]
    ldh a, [GBC_P1]
    ldh a, [GBC_P1]
    ldh a, [GBC_P1]
    cpl
    and $0F
    swap a
    or b
    ld b, a
    ld a, $30
    ldh [GBC_P1], a
    ld a, b
    ret

; unsigned char joypad_pressed(void): flancos de subida desde la llamada anterior.
_joypad_pressed::
    call _joypad
    ld b, a
    ld a, [_gbc_pad_prev]
    cpl
    and b
    ld c, a
    ld a, b
    ld [_gbc_pad_prev], a
    ld a, c
    ret

; unsigned char wait_key(void)
_wait_key::
.up:
    call _wait_vbl
    call _joypad
    or a
    jr nz, .up
.down:
    call _wait_vbl
    call _joypad
    or a
    jr z, .down
    ld [_gbc_pad_prev], a
    ret
