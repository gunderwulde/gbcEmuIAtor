/* string.h — funciones de memoria y cadenas (string.asm). */
#ifndef STRING_H
#define STRING_H

#pragma link "string.asm"

void *memcpy(void *dst, const void *src, unsigned int n);
void *memset(void *dst, int v, unsigned int n);
int memcmp(const void *a, const void *b, unsigned int n);
unsigned int strlen(const char *s);
char *strcpy(char *dst, const char *src);
char *strcat(char *dst, const char *src);
int strcmp(const char *a, const char *b);

#endif
