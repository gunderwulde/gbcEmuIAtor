# AGENTS.md — gbcEmuIAtor

Emulador web de **Game Boy Color** con precisión de ciclo M (y de punto en la PPU), más un
IDE de ensamblador SM83 y de C a la izquierda del emulador. Este fichero define *cómo* se
trabaja. *Qué* se hace y en qué orden está en [PLAN.md](PLAN.md). La referencia de
hardware es [docs/gbc-hardware.md](docs/gbc-hardware.md).

Proyecto hermano de **zxemuIAtor** (ZX Spectrum 48K), del que hereda la metodología, la
forma de repartir el trabajo y buena parte del diseño del IDE. Lo aprendido allí está
resumido en [PLAN.md](PLAN.md) («Lecciones de zxemuIAtor»).

## 1. Alcance fijado (no reabrir sin el usuario)

- Modelo: **CGB (CPU CGB-E)**. Los cartuchos sólo de DMG se ejecutan en el **modo de
  compatibilidad del CGB**, como en el hardware real. Sin DMG puro, SGB, GBA ni cable link
  real (el puerto serie existe sin nadie al otro lado: lo necesitan los tests de Blargg).
  Sin infrarrojos.
- Fidelidad: CPU exacta al ciclo M (orden de los accesos a bus dentro de cada
  instrucción), PPU al punto (modo 3 de longitud variable, cambios a mitad de línea),
  temporizadores con sus retardos y flancos, OAM DMA con conflictos de bus, HDMA/GDMA,
  doble velocidad, APU con secuenciador de frame, comportamiento del halt bug, retardo de
  EI, bloqueo de IRQ de STAT. **Fuera de alcance:** corrupción de OAM (es de DMG), ruido
  analógico del LCD, fantasmas del LCD.
- Cartuchos: ROM sola, MBC1, MBC2, MBC3 (+RTC), MBC5 (rumble ignorado). RAM con pila →
  `.sav`. Sin MBC6/MBC7/HuC/MMM01/multicartuchos MBC1M.
- Formatos: `.gb`, `.gbc`, `.sav` (+ RTC al estilo de BGB/VBA al final), estados propios
  (`.gbstate`, versión en la cabecera). Sin formatos de estado de otros emuladores.
- Boot ROM: **no se distribuye la de Nintendo.** Por defecto se arranca sin boot ROM, con
  el estado posterior al arranque documentado (incluida la paleta de compatibilidad para
  juegos DMG). El usuario puede cargar la suya desde la UI (se guarda en su navegador,
  nunca en el repo). Ver [rom/README.md](rom/README.md).
- Núcleo: **C99 → wasm32 con clang**, sin libc, sin Emscripten.
- Frontend: **Vite + TypeScript**, CodeMirror 6, AudioWorklet, Gamepad API.
- IDE: ensamblador SM83 con sintaxis **compatible con un subconjunto de RGBDS** (secciones
  y bancos), construir ROM y arrancarla al instante, depurador (registros, paso,
  breakpoints por banco, desensamblado, memoria, visores de VRAM: tiles, mapas, OAM y
  paletas), resaltado de sintaxis, exportar `.gbc` con cabecera y checksums correctos.
  Pestañas en el editor y **C para SM83**: compilador propio en TypeScript (subconjunto
  "C práctico", sin float/long), que genera ensamblador para el ensamblador propio, más
  una librería básica y ejemplos (PLAN.md, fase 2C). Sin GBDK/SDCC.
- Sin ROMs comerciales en el repo ni en los tests. Las ROMs de prueba de la comunidad se
  descargan con `npm run fetch`, y los ejemplos son homebrew propio.

## 2. Estructura del repositorio

```
core/                  Núcleo C → wasm
  include/gb.h         ABI pública (lo único que ve JS). CONTRATO CONGELADO.
  include/testbus.h    ABI de core-test.wasm. CONGELADO.
  src/bus.h            Contrato CPU↔máquina (static inline + unity build). CONGELADO.
  src/machine.h        Contrato entre módulos de la máquina (struct gb, ppu_*, apu_*, cart_*, sched_*). CONGELADO.
  src/base.h           memcpy/memset sin libc, GB_ASSERT
  src/sm83.c           CPU SM83 (se incluye desde gbc.c y testbus.c, no se compila suelto)
  src/gbc.c            Máquina: mapa de memoria, bancos de WRAM/VRAM, E/S, IRQ, temporizador, DMA/HDMA, doble velocidad, planificador
  src/ppu.c            PPU: modos, FIFO de píxeles, paletas CGB, framebuffer RGBA 160×144
  src/apu.c            APU: 4 canales, secuenciador de frame, mezcla y resampleado
  src/cart.c           Cabecera, MBC1/2/3/5, RTC, RAM con pila
  src/state.c          Guardar/cargar estado
  src/debug.c          Breakpoints (banco:dirección), paso, ejecutar hasta…
  src/testbus.c        Máquina plana de 64 KB sin periféricos (sólo build de tests)
rom/                   Boot ROMs del usuario (NO versionadas) y README con la política
build/wasm/            Salida de build:core (no versionada); core.wasm se copia a web/public/wasm/
tools/                 Scripts Node: build-core, fetch-tests, bench
web/                   App Vite
  src/emu/             Envoltorio wasm, bucle, vídeo, audio, joypad/gamepad
  src/sm83isa/         Tabla única de instrucciones SM83 (ensamblador y desensamblador)
  src/asm/             Ensamblador SM83 (TS puro, sin DOM)
  src/disasm/          Desensamblador (TS puro, comparte tabla con asm)
  src/cc/              Compilador C → ensamblador SM83 (TS puro, sin DOM)
  src/clib/            Librería C de usuario (.h, .c, .asm) y ejemplos C
  src/export/          Cabecera de cartucho, checksums, .gbc, .sav
  src/res/             Conversores de recursos (PNG → tiles 2bpp + paletas CGB, mapas)
  src/ui/              Editor, depurador, visores de VRAM, layout
tests/                 Vitest: core/, asm/, disasm/, cc/, clib/, export/, ui/
tests/fixtures/        Descargados por tools/fetch-tests (en .gitignore)
tests/fixtures-own/    ROMs de prueba propias en ensamblador (versionadas)
docs/
```

## 3. Comandos

| Comando | Qué hace |
|---|---|
| `npm run build:core` | Compila `core.wasm` (máquina real), `core-test.wasm` (bus plano) y `core-probe.wasm` (máquina real con hooks de test) |
| `npm run fetch` | Descarga las suites de tests a `tests/fixtures/` (con SHA-256 verificado) |
| `npm run dev` | Vite en desarrollo |
| `npm test` | Vitest completo (requiere build:core y fetch) |
| `npm run test:cpu` | Sólo suites de CPU (SingleStepTests/sm83, cpu_instrs, instr_timing) |
| `npm run test:acc` | Suites de exactitud de la máquina (mooneye, SameSuite, acid2, Mealybug); lento |
| `npm run bench` | Mide MHz emulados y ms/frame; imprime comparación con la línea base |
| `npm run test:perf` | Tests de tiempo (`*.bench-test.ts`: ensamblador, compilador C), de uno en uno; fuera de `npm test` para que la carga no los falsee |

Flags de clang: `--target=wasm32 -nostdlib -O2 -std=c99 -Wall -Wextra -Werror
-Wl,--no-entry`. Las funciones públicas se marcan con `GB_EXPORT`
(`__attribute__((export_name("…")))`, definida en `gb.h`); `--export-dynamic` no basta.
La memoria la exporta el módulo (`memory`). Nada de `malloc`: toda la memoria del núcleo
es estática (incluida la zona de 8 MB para la ROM del cartucho y los 128 KB de RAM
externa).

Toolchain previsto (igual que zxemuIAtor): Node 26 LTS y LLVM 23
(`C:\Program Files\LLVM\bin`, **no está en el PATH**: `tools/build-core.mjs` usa
`$LLVM_BIN` o esa ruta por defecto).

## 4. Metodología: Carmack / Abrash

Se aplica igual al **escribir** y al **revisar**. Un cambio que la incumple no se integra
aunque los tests pasen.

### 4.1 Principios de creación

1. **Entender el hardware antes de escribir código** (Abrash). Cada comportamiento del
   núcleo se apoya en una entrada de `docs/gbc-hardware.md` o en una ROM de test de la
   comunidad. Si no existe, se investiga y se documenta *primero*.
2. **La verdad la dice la medición, no la intuición.** Nada de optimizar sin un número de
   `npm run bench` antes y después, adjunto al cambio. Nada de afirmar exactitud sin un
   test que la demuestre.
3. **Código directo y en línea** (Carmack, "inlined code"). El bucle caliente es un
   `switch` plano sobre el opcode (tabla base y CB), con los ciclos M de bus escritos
   explícitamente en el orden real. Nada de capas de abstracción, tablas de punteros a
   función en el camino caliente ni "frameworks" de instrucciones. Repetir tres líneas es
   preferible a una indirección que oculte el timing.
4. **El ciclo M es la unidad de tiempo.** Cada acceso a bus de la CPU (`bus_read`,
   `bus_write`) y cada ciclo interno (`bus_tick`) avanza la máquina un ciclo M en el sitio
   donde ocurre. El patrón de bus de cada instrucción debe poder leerse en el código y
   compararse línea a línea con la tabla de la referencia (y con los ciclos de
   SingleStepTests).
5. **Estado explícito y visible.** Toda la máquina vive en structs estáticos planos
   (`Sm83`, `Gb`). Nada global oculto. Esto permite estados guardados, rebobinado y tests
   deterministas gratis.
6. **Determinismo total.** Mismo estado inicial + mismas entradas por ciclo = mismo
   resultado bit a bit. Nada de `Date`, aleatorio ni dependencias del frame rate dentro
   del núcleo. El RTC del MBC3 avanza con los ciclos emulados; sólo al cargar un `.sav`
   el frontend le entrega el tiempo real transcurrido, como dato de entrada.
7. **Lo más simple que sea correcto.** Sin generalizar para DMG/SGB/GBA "por si acaso".
   Si alguna vez se añade, se reescribe lo necesario.
8. **Hacer trabajo sólo cuando hace falta** (Abrash). Los periféricos no se avanzan ciclo
   a ciclo si nadie los mira: un **planificador de eventos** (próximo evento por
   periférico: fin de modo de la PPU, desbordamiento de TIMA, paso del secuenciador de la
   APU, fin de DMA) y **puesta al día perezosa** antes de cualquier acceso que pueda
   observarlos (lectura/escritura de sus registros, de VRAM/OAM/paletas) y al fin del
   frame. La PPU sigue siendo exacta al punto porque se pone al día *hasta* el ciclo del
   acceso.
9. **Asserts y comprobaciones baratas por todas partes en debug.** El build de tests
   activa `GB_ASSERT`; el de producción las elimina.
10. **Leer el código generado cuando importa.** Para el bucle caliente se inspecciona el
    `.wat` (`wasm-objdump`/`wasm2wat`) al optimizar.

### 4.2 Principios de revisión

El revisor (otro agente, nunca el autor) recorre esta lista y responde a cada punto con
evidencia (línea, test o número), no con opinión:

- [ ] ¿Cada comportamiento nuevo tiene una fuente citada en docs o un test que lo fije?
- [ ] ¿Los patrones de ciclos M coinciden con la referencia? (comparar a mano al menos
      las instrucciones tocadas)
- [ ] ¿La puesta al día perezosa cubre **todos** los accesos que observan el periférico
      tocado? (registros, VRAM, OAM, paletas, IF, DMA)
- [ ] ¿Hay alguna abstracción, indirección o generalización que no se pague sola?
- [ ] ¿Hay estado oculto, asignación dinámica o no determinismo en el núcleo?
- [ ] ¿Se ha medido el rendimiento si el cambio toca el camino caliente? ¿Empeora > 2 %?
- [ ] ¿Pasan todas las suites? ¿Se ha añadido un test que fallaba antes del cambio?
- [ ] ¿Se puede borrar algo? (el mejor código es el que no existe)
- [ ] ¿Cumple el ABI congelado de `gb.h`? Cambiarlo requiere aprobación del coordinador.

El resultado de la revisión es: **aprobado**, o una lista de hallazgos concretos con
`fichero:línea` y escenario de fallo.

### 4.3 Tests

El diseño completo está en [docs/TEST-PLAN.md](docs/TEST-PLAN.md). Regla de oro: el valor
esperado **nunca** sale del código bajo prueba (suite externa, dato documentado, modelo
de referencia independiente o captura de referencia de hardware real publicada por la
suite).

### 4.4 Definición de terminado

Un trabajo está terminado cuando: compila sin warnings con `-Werror`, pasa `npm test`,
tiene tests propios, el bench no ha empeorado (si aplica), ha pasado la revisión de 4.2
y `docs/` refleja lo aprendido.

## 5. Contratos entre módulos

### 5.1 CPU ↔ máquina (`core/src/bus.h`)

La CPU no conoce la Game Boy. Llama a funciones `static inline` que cada build define;
cada una consume **un ciclo M**:

```c
uint8_t bus_read(uint16_t a);            /* ciclo M de lectura */
void    bus_write(uint16_t a, uint8_t v);/* ciclo M de escritura */
void    bus_tick(void);                  /* ciclo M interno (sin acceso a bus) */
uint8_t bus_irq(void);                   /* IE & IF & 0x1F, sin avanzar el tiempo */
void    bus_irq_ack(int bit);            /* la CPU atiende la interrupción `bit` (borra IF) */
int     bus_stop(void);                  /* STOP: la máquina decide (cambio de velocidad o parada) */
```

No hay espacio de E/S aparte: todo es memoria (FF00–FF7F, FFFF). El contador de ciclos
vive en la máquina; la CPU lo avanza vía estas llamadas. En doble velocidad un ciclo M
dura 2 puntos de la PPU en vez de 4: eso lo resuelve la máquina, no la CPU. `gbc.c` y
`testbus.c` son los dos únicos implementadores, elegidos al compilar (dos `.wasm`).

### 5.2 Núcleo ↔ JS (`core/include/gb.h`)

ABI congelada al final de la fase 0. Todas las funciones son `gb_*`, sólo enteros y
punteros a regiones estáticas:

- Ciclo de vida: `gb_init`, `gb_reset`, `gb_insert(rom_len)` (la ROM ya está en
  `gb_rom()`), `gb_boot_rom(len)` (0 = sin boot ROM).
- Ejecución: `gb_run_frame()` → motivo de parada (frame completo / breakpoint / STOP),
  `gb_step()` (una instrucción), `gb_cycles_lo()`/`gb_cycles_hi()`, `gb_frame()`.
- Regiones: `gb_framebuffer()` (RGBA 160×144), `gb_set_color_correction(int)`,
  `gb_audio(int rate)` → nº de muestras estéreo del último frame y `gb_audio_buffer()`
  (float intercalado L/R), `gb_rom()` (8 MB), `gb_sram()` + `gb_sram_size()`, `gb_regs()`
  (struct de registros con layout documentado), `gb_io_buffer()` (zona para pasar
  estados y `.sav`).
- Vistas de depuración (sin efectos laterales): `gb_vram()` (2 bancos), `gb_wram()`
  (8 bancos), `gb_oam()`, `gb_hram()`, `gb_palettes()` (BG y OBJ, 64+64 bytes),
  `gb_io()` (FF00–FF7F tal como se leerían), `gb_peek(addr)` (sin efectos).
- Entrada: `gb_joypad(mask)` (bit 0 Derecha … bit 7 Start, ver `gb.h`).
- Ficheros: `gb_load_sav(len)`, `gb_save_sav()` → len, `gb_rtc_advance(seconds)`,
  `gb_save_state()` → len, `gb_load_state(len)` (en `gb_io_buffer`).
- Depuración: `gb_bp_set(bank, addr, on)` (bank = −1: cualquiera),
  `gb_bp_clear_all()`, `gb_poke(addr, v)`, `gb_set_pc(addr)`.

### 5.3 Ensamblador ↔ UI

`assemble(source: string, opts) → { rom: Uint8Array /*imagen completa, bancos de 16 KB*/,
sections: Array<{name, kind: "ROM0"|"ROMX"|"WRAM0"|"WRAMX"|"HRAM"|"SRAM"|"VRAM", bank,
addr, size}>, entry: number, symbols: Map<string, {bank, addr}>, lineMap: Array<{bank,
addr, line, file, len}>, errors: Array<{line, col, file, msg}> }`. Puro, sin DOM,
determinista. Ver [web/src/asm/README.md](web/src/asm/README.md).

### 5.4 Compilador C ↔ ensamblador

`compile(files: Map<nombre, fuente>, opts) → { asm, errors, cLineMap }`. Genera fuente
que acepta el ensamblador de 5.3. ABI de C en `docs/c-abi.md`. Ver
[web/src/cc/README.md](web/src/cc/README.md).

## 6. Reglas de trabajo para agentes

- **Un agente, un directorio.** Cada tarea de PLAN.md declara los ficheros que posee.
  No se editan ficheros de otro flujo; si hace falta, se pide al coordinador.
- `gb.h`, `testbus.h`, `bus.h` y `machine.h` sólo los cambia el coordinador.
- En Windows, editar ficheros con las herramientas de edición, nunca con
  `Get-Content | Set-Content` de PowerShell 5 (rompe el UTF-8), ni con heredocs de shell
  o `node -e` cuando el contenido lleva `\n` o barras invertidas (se destrozan).
- Los tests van en el mismo cambio que el código. Primero el test que falla.
- Las suites externas no se modifican ni se "ajustan" para pasar.
- Si un dato de hardware es dudoso, se marca `[VERIFICAR]` en docs y se abre la duda,
  no se inventa.
- Comentarios: explicar el *porqué* del hardware ("la PPU descarta SCX%8 píxeles al
  principio del modo 3"), no el *qué* del código.
- Idioma: código y nombres en inglés; docs y comentarios de hardware en español.
- Nada de dependencias npm nuevas sin justificarlo en el cambio (permitidas de base:
  vite, typescript, vitest, codemirror 6).
- Nada de material con copyright de Nintendo en el repo (boot ROM, juegos). El logo de la
  cabecera lo genera el exportador porque el hardware lo exige; no se usa en la UI.
- Commits pequeños, uno por tarea, con mensaje que cite la tarea de PLAN.md (`[C1] …`).
