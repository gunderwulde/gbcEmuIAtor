/* gbc_vbl.c — declara la rutina de la IRQ de VBlank de la librería (el cuerpo está en
 * gbc.asm: incrementa vbl_count). gbc.h lo enlaza salvo que el programa defina
 * GBC_NO_VBL_ISR para poner la suya. */
void gbc_vbl_isr(void) __interrupt(vblank);
