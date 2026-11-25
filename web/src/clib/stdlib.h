/* stdlib.h — números aleatorios y abs (stdlib.asm, semilla en stdlib.c). */
#ifndef STDLIB_H
#define STDLIB_H

#pragma link "stdlib.c"
#pragma link "stdlib.asm"

#define RAND_MAX 32767

int rand(void);                 /* 0..RAND_MAX; misma secuencia en cada arranque */
void srand(unsigned int seed);  /* p. ej. srand(vbl_count) tras esperar una tecla */
int abs(int x);

#endif
