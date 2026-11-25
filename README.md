# gbcEmuIAtor

Emulador web de **Game Boy Color** con precisión de ciclo, y a su izquierda un IDE para
programarla: ensamblador SM83 compatible con RGBDS, compilador de C propio, depurador,
visores de VRAM y exportación de ROMs `.gbc` listas para un cartucho flash.

> Estado: **planificación**. Todavía no hay código; este repositorio contiene el plan de
> trabajo y los contratos. Proyecto hermano de *zxemuIAtor* (ZX Spectrum 48K), del que
> hereda la metodología y el diseño del IDE.

## Documentos

| Documento | Para qué |
|---|---|
| [AGENTS.md](AGENTS.md) | Alcance fijado, estructura, comandos, metodología Carmack/Abrash, contratos y reglas de trabajo |
| [PLAN.md](PLAN.md) | Fases, tareas, ficheros que posee cada una, criterios de aceptación y paralelismo |
| [docs/gbc-hardware.md](docs/gbc-hardware.md) | Referencia de hardware (fuente de verdad del núcleo) |
| [docs/TEST-PLAN.md](docs/TEST-PLAN.md) | Qué se prueba, cómo y contra qué oráculo |
| [rom/README.md](rom/README.md) | Política de boot ROM y de ROMs |
| [web/src/asm/README.md](web/src/asm/README.md) | Ensamblador SM83 (sintaxis y API) |
| [web/src/cc/README.md](web/src/cc/README.md) | Compilador C → SM83 (API y diferencias con el de zxemuIAtor) |
| [web/src/clib/README.md](web/src/clib/README.md) | Librería C de usuario y ejemplos |

## Arquitectura en una línea

Núcleo en **C99 → wasm32** (clang, sin libc ni Emscripten; toda la memoria estática) +
frontend **Vite + TypeScript** (CodeMirror 6, AudioWorklet, Gamepad API). Ensamblador,
desensamblador y compilador C en TypeScript puro.

## Uso (cuando exista)

```sh
npm install
npm run fetch        # suites de test de la comunidad → tests/fixtures/
npm run build:core   # core.wasm, core-test.wasm, core-probe.wasm
npm run dev          # http://localhost:5173
npm test
```

Requiere Node LTS y LLVM (clang + wasm-ld). Si LLVM no está en el PATH, define
`LLVM_BIN`.

## ROMs y boot ROM

No se incluye ningún material de Nintendo: ni boot ROM ni juegos. El emulador arranca
sin boot ROM, con el estado posterior al arranque. Ver [rom/README.md](rom/README.md).
