; 10-save.asm — reserva la RAM del cartucho para la partida guardada.
;
; Basta con declarar una sección SRAM para que el exportador marque el cartucho como
; MBC5 + RAM + pila (y el emulador guarde un .sav). Desde C se accede con una variable
; en dirección fija: __at(0xA000) unsigned char save[8];

SECTION "estrellas save", SRAM[$A000]
    ds 8
