; save.asm — reserva la RAM del cartucho para la partida guardada de la aventura.
;
; Con una sección SRAM el exportador marca el cartucho como MBC5 + RAM + pila (y el
; emulador guarda un .sav). Desde C se usa con __at(0xA000) unsigned char sav[64];

SECTION "aventura save", SRAM[$A000]
    ds 64
