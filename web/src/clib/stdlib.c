/* stdlib.c — estado del generador de rand() (stdlib.asm). Con valor inicial distinto de 0
 * (el 0 es un punto fijo del xorshift); va en .data y el crt0 lo copia al arrancar. */
unsigned int gbc_seed = 0xACE1;
