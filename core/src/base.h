/*
 * base.h — utilidades comunes del núcleo (sin libc).
 */
#ifndef BASE_H
#define BASE_H

#include "../include/gb.h"

/* Con -mbulk-memory, clang traduce estos builtins a memory.copy / memory.fill. */
#define gb_memcpy(d, s, n) __builtin_memcpy((d), (s), (n))
#define gb_memset(d, v, n) __builtin_memset((d), (v), (n))

/* Activas con -DGB_DEBUG (builds de test); desaparecen en producción. */
#ifdef GB_DEBUG
#define GB_ASSERT(c) do { if (!(c)) __builtin_trap(); } while (0)
#else
#define GB_ASSERT(c) ((void)0)
#endif

#endif /* BASE_H */
