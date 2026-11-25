# PLAN.md — gbcEmuIAtor

Cómo se reparte el trabajo entre agentes y qué puede hacerse en paralelo. Las reglas de
trabajo y la metodología están en [AGENTS.md](AGENTS.md); los datos de hardware, en
[docs/gbc-hardware.md](docs/gbc-hardware.md); el diseño de los tests, en
[docs/TEST-PLAN.md](docs/TEST-PLAN.md).

Cada tarea indica: **posee** (ficheros que sólo ella edita), **depende de**, y
**aceptación** (condición objetiva de terminado). Toda tarea termina con una revisión
Carmack/Abrash (AGENTS.md §4.2) hecha por un agente distinto del autor.

```
Fase 0 (secuencial, coordinador)
   │  toolchain · esqueleto · gb.h/bus.h/machine.h congelados · stubs que compilan
   ▼
Fase 1 (paralela, 8 agentes) ────────────────────────────────────────────
   C1 CPU SM83     T1 Arnés tests     M1 Máquina (mapa, IRQ, timer, DMA)
   V1 PPU          M2 APU             M3 Cartuchos/estados
   W1 Shell web    A1 Ensamblador
   ▼  (integración por el coordinador: core.wasm real en la web)
Fase 2 (paralela, 6 agentes) ────────────────────────────────────────────
   I1 IDE editor   D1 Depurador+desasm   G1 Visores VRAM   E1 Exportar .gbc/.sav
   C2 Exactitud (mooneye, SameSuite, acid2, Mealybug)      P1 Rendimiento
   ▼
Fase 2C (paralela) K1 compilador C · L1 librería C · U1 pestañas + C en la UI
   ▼                 AV ejemplo de aventura original en C (tras K1 + L1)
Fase 3 (secuencial) revisión global · pulido · README
   ▼
Fase 4 (opcional) R1 recursos (PNG → tiles/paletas/mapas) · P1x proyectos .gbproj
```

---

## Fase 0 — Cimientos (coordinador, secuencial)

Nada de esto se paraleliza: fija los contratos de los que depende todo lo demás.

| # | Tarea | Aceptación |
|---|---|---|
| 0.1 | Toolchain (Node LTS, LLVM con clang + wasm-ld); `git init` | `node -v`, `clang --version` y `wasm-ld --version` responden |
| 0.2 | `package.json`, Vite + TS + Vitest, `.gitignore` (`build/`, `tests/fixtures/`, `rom/*.bin`), `tsconfig` | `npm run dev` sirve una página vacía; `npm test` corre (0 tests) |
| 0.3 | `tools/build-core.mjs`: compila `core.wasm`, `core-test.wasm` y `core-probe.wasm` (máquina real + `GB_TEST_HOOKS`, ver [docs/TEST-PLAN.md](docs/TEST-PLAN.md) §1) con los flags de AGENTS.md §3 | Los tres `.wasm` generados sin warnings |
| 0.4 | `tools/fetch-tests.mjs`: SingleStepTests/sm83, Blargg (`cpu_instrs`, `instr_timing`, `mem_timing`, `mem_timing-2`, `halt_bug`, `interrupt_time`, `cgb_sound`), mooneye-test-suite, SameSuite, cgb-acid2, dmg-acid2, Mealybug Tearoom, age-test-roms. Versiones fijadas por commit/tag | Ficheros en `tests/fixtures/` con SHA-256 verificado; licencias anotadas en `tests/fixtures/README.md` generado |
| 0.5 | `core/include/gb.h`, `core/src/bus.h` y `core/src/machine.h` definitivos; stubs de todos los `gb_*` | Compila; un test Vitest instancia los tres wasm y llama a cada export |
| 0.6 | Layout del struct de registros (`gb_regs`) documentado en `gb.h` y su espejo TS en `web/src/emu/regs.ts` | Test que comprueba offsets |
| 0.7 | Esqueleto de `docs/gbc-hardware.md` revisado: cada sección con su fuente primaria y los `[VERIFICAR]` abiertos repartidos a C1/M1/V1/M2/M3 | Ninguna sección sin fuente |

**Fin de fase 0:** `gb.h`/`bus.h`/`machine.h` congelados. A partir de aquí todos los
flujos de la fase 1 arrancan a la vez.

---

## Fase 1 — Construcción en paralelo

Los ocho flujos sólo comparten los contratos de la fase 0, así que no se bloquean entre
sí. Cada uno trabaja contra stubs o mocks hasta la integración.

### C1 — CPU SM83
- **Posee:** `core/src/sm83.c` (unity build: lo incluyen gbc.c y testbus.c; ver bus.h),
  `tests/core/cpu/singlestep*`, `tests/core/cpu/blargg*`
- **Depende de:** 0.5
- **Trabajo:**
  1. Struct `Sm83` plano (A, F, B, C, D, E, H, L, SP, PC, IME, ime_pending (retardo de EI),
     halted, halt_bug, stopped).
  2. `sm83_step()`: `switch` por opcode para la tabla base y la CB. Cada instrucción
     escribe sus ciclos M en orden real con `bus_read/bus_write/bus_tick` (AGENTS.md
     §4.1.3–4). Ojo a los casos con ciclo interno en medio (`PUSH`, `CALL`, `RET cc`,
     `ADD HL,rr`, `LD HL,SP+e`, `ADD SP,e`, `INC/DEC rr`, `JP HL`).
  3. Flags con tablas `const` precalculadas donde se pague (medirlo).
  4. Interrupciones: despacho de 5 ciclos M con la lectura de IE a mitad (el caso de
     mooneye `ie_push`: si el `PUSH` del PC sobrescribe IE se cancela y salta a 0000h);
     HALT (con y sin IME, halt bug), EI con retardo de una instrucción, `RETI`, `DI`.
  5. STOP: delega en `bus_stop()` (cambio de velocidad lo resuelve M1).
  6. Opcodes ilegales (D3, DB, DD, E3, E4, EB, EC, ED, F4, FC, FD): bloquean la CPU.
- **Aceptación:** 100 % SingleStepTests/sm83 (estado y ciclos M con dirección y tipo de
  acceso) en `core-test.wasm`; Blargg `cpu_instrs` (11/11) e `instr_timing` en la
  máquina real en cuanto M1 tenga temporizador y serie.

### T1 — Arnés de tests del núcleo
- **Diseño de los tests:** [docs/TEST-PLAN.md](docs/TEST-PLAN.md) (IDs CPU-*, SYS-*,
  PPU-*, APU-*, CART-*). Los modelos de referencia `tests/ref/` los escribe un agente
  distinto de C1/M1/V1.
- **Posee:** `core/src/testbus.c`, `tests/ref/**`, `tests/util/**` (salvo `wasm.ts`),
  `tests/core/rom-runner*`, `tools/fetch-tests.mjs` (tras 0.4), `tools/mutate.mjs`
- **Depende de:** 0.5
- **Trabajo:**
  1. `testbus.c`: 64 KB planos, contador de ciclos, **registro de ciclos de bus**
     (`R/W/-` con dirección y valor) en el formato de SingleStepTests.
  2. Runners genéricos de ROMs de test sobre `core-probe.wasm`:
     - **Blargg:** texto por el puerto serie (SB/SC) y en memoria en A000h (firma
       `DE B0 61`); busca "Passed"/"Failed".
     - **mooneye:** al ejecutar `LD B,B` (40h) comprueba B,C,D,E,H,L = 3,5,8,13,21,34
       (Fibonacci) para éxito; 42h en todos para fallo.
     - **Capturas:** `fbHash(fb)` y comparación con la imagen de referencia de la suite
       (acid2, Mealybug, SameSuite), tolerando sólo la corrección de color documentada.
  3. Informe legible: primera discrepancia con diff de registros/ciclos; para capturas,
     PNG de diferencias en `build/test-out/`.
- **Aceptación:** los runners funcionan sobre la CPU de C1 a medida que avanza; una ROM
  artificial mínima (escrita a mano en bytes) que hace `LD B,B` con Fibonacci pasa.

### M1 — Máquina CGB (sin PPU ni APU)
- **Posee:** `core/src/gbc.c`, `tests/core/sys/**`
- **Depende de:** 0.5
- **Trabajo:**
  1. Mapa de memoria completo (docs §2) con bancos de WRAM (SVBK) y VRAM (VBK), eco,
     zona prohibida FEA0–FEFF, HRAM, IE, FF50 (desactivar boot ROM).
  2. Planificador de eventos (`sched_*` de `machine.h`) y bucle de frame: `gb_run_frame()`
     ejecuta hasta el fin de VBlank del frame (70 224 puntos) y arrastra el exceso.
  3. DIV/TIMA/TMA/TAC con el contador interno de 16 bits: flanco descendente del bit
     elegido (incluidos los "glitches" al escribir DIV o TAC), retardo de 1 ciclo M en la
     recarga de TIMA y escritura a TIMA en ese ciclo (docs §5).
  4. IF/IE, joypad (P1 con selección de fila, IRQ en flanco), serie interno (SC bit 0 a 1
     con reloj interno, 8 bits a 8 192 Hz; sin nadie al otro lado entra FFh).
  5. OAM DMA (160 ciclos M, retardo de arranque, la CPU sólo ve HRAM; conflictos de bus
     documentados en docs §6). HDMA/GDMA (FF51–55) con el ritmo de HBlank que marque V1.
  6. KEY1 + STOP: cambio de velocidad con su pausa; en doble velocidad cada ciclo M son
     2 puntos de PPU y el temporizador va al doble.
  7. Estado inicial sin boot ROM (docs §11) y con boot ROM del usuario mapeada en
     0000–00FF y 0200–08FF.
- **Aceptación:** mooneye `acceptance/timer/*`, `acceptance/interrupts/*`,
  `acceptance/oam_dma/*`, `acceptance/halt_ime*`, `acceptance/ei_*`, `acceptance/di_*`,
  `acceptance/boot_regs-cgb` (sin boot ROM), `misc/*` del CGB; Blargg `mem_timing`,
  `mem_timing-2`, `halt_bug`, `interrupt_time`.

### V1 — PPU
- **Posee:** `core/src/ppu.c`, `tests/core/ppu/**`
- **Depende de:** 0.5
- **Trabajo:**
  1. Modos 2/3/0/1 al punto; LY, LYC, STAT con la OR de fuentes y el bloqueo de flanco
     ("STAT blocking"); el caso de LY=153 que pasa a 0 antes de tiempo (docs §7).
  2. Búsqueda en OAM (10 sprites por línea, prioridad CGB por índice de OAM salvo OPRI).
  3. FIFO de fondo y de sprites con el fetcher; modo 3 de longitud variable (SCX%8,
     ventana, sprites); ventana con su contador de líneas interno.
  4. Atributos CGB del mapa (paleta, banco de tile, volteos, prioridad) y LCDC.0 como
     "prioridad maestra" del CGB.
  5. Paletas CGB (BCPS/BCPD/OCPS/OCPD con autoincremento; inaccesibles en modo 3) y modo
     de compatibilidad DMG (BGP/OBP0/OBP1 mapeados a las paletas que dejó el arranque).
  6. Bloqueo de VRAM/OAM a la CPU según el modo; encender/apagar el LCD (la primera
     línea tras encender es especial).
  7. Framebuffer RGBA 160×144, con corrección de color opcional (curva documentada en
     docs §7.6) y sin ella (RGB555 escalado).
  8. Interfaz de puesta al día perezosa: `ppu_catch_up(cycle)` desde M1 antes de todo
     acceso a FF40–FF4B, FF4F, FF51–55, FF68–FF6C, VRAM y OAM.
- **Aceptación:** cgb-acid2 y dmg-acid2 (en modo compatibilidad) idénticos a la captura de
  referencia; mooneye `acceptance/ppu/*` aplicables al CGB; Mealybug Tearoom (las que la
  suite marca como verificadas en CGB) según su captura.

### M2 — APU
- **Posee:** `core/src/apu.c`, `web/src/emu/audio.ts`, `web/src/emu/audio-worklet.ts`,
  `tests/core/apu/**`
- **Depende de:** 0.5
- **Trabajo:**
  1. Cuatro canales (pulso con barrido, pulso, onda, ruido), envolventes, longitud,
     secuenciador de frame a 512 Hz ligado al bit de DIV (docs §8), NR50/NR51/NR52,
     registros PCM12/PCM34 del CGB, acceso a la RAM de onda con el canal activo.
  2. Mezcla estéreo por cambios (registro `(ciclo, nivel)` por canal, como el beeper de
     zxemuIAtor), integración por periodo de muestra, bloqueo de DC y paso bajo.
  3. En la web: AudioWorklet con ring buffer (SharedArrayBuffer si hay aislamiento de
     origen; si no, `postMessage`). Expone el nivel de llenado para que W1 regule el
     ritmo.
- **Aceptación:** Blargg `cgb_sound` (12/12); SameSuite `apu/*`; test de un pulso al 50 %
  a frecuencia fija → fundamental correcta ±0,5 % y sin DC; sin cortes audibles en 60 s.

### M3 — Cartuchos, `.sav` y estados
- **Posee:** `core/src/cart.c`, `core/src/state.c`, `tests/core/cart/**`,
  `tests/core/state/**`
- **Depende de:** 0.5
- **Trabajo:** parser de cabecera (tipo, tamaños, bandera CGB, checksums: avisar, no
  rechazar); MBC1 (modo 0/1, banco 0 → 1, bits altos), MBC2 (RAM de 512×4 bits),
  MBC3 + RTC (latch, registros, días con acarreo; avanza con los ciclos emulados), MBC5
  (9 bits de banco, banco 0 válido); RAM externa habilitada sólo con 0Ah; `.sav` con el
  bloque de RTC de 48 bytes estándar al final; estado completo versionado.
- **Aceptación:** mooneye `emulator-only/mbc1/*`, `mbc2/*`, `mbc5/*`; rtc3test (las
  pruebas que no dependen de tiempo real); round-trip de estado bit a bit (estado →
  guardar → cargar → N frames = mismos framebuffers y audio que sin guardar).

### W1 — Shell web
- **Posee:** `web/index.html`, `web/src/main.ts`, `web/src/emu/core.ts`,
  `web/src/emu/display.ts`, `web/src/emu/input.ts`, `web/src/emu/loop.ts`,
  `web/src/ui/layout.*`
- **Depende de:** 0.5 (un mock que pinta ruido sirve hasta la integración)
- **Trabajo:**
  1. Layout: panel IDE a la **izquierda** (redimensionable), emulador a la derecha con la
     barra de controles (reset, pausa, cargar ROM, boot ROM propia, corrección de color,
     escala, guardar/cargar estado).
  2. `core.ts`: carga del wasm, vistas tipadas sobre las regiones de `gb.h`.
  3. `display.ts`: `ImageData` sobre el framebuffer del wasm (sin copias), escalado
     entero con `image-rendering: pixelated`.
  4. `input.ts`: teclado (flechas, Z/X = B/A, Enter = Start, Shift derecho = Select,
     configurable) y Gamepad API; el foco va al emulador sólo con el canvas enfocado.
  5. `loop.ts`: reloj maestro de audio (consulta a M2); sin audio, acumulador con
     `requestAnimationFrame` a 59,7275 Hz.
  6. Arrastrar y soltar `.gb`/`.gbc`/`.sav`/`.gbstate`; `.sav` persistente en IndexedDB
     por título + checksum global.
- **Aceptación:** con el mock, la UI funciona en Chrome y Firefox; layout correcto a
  1280 px y 1920 px; tests de la tabla de mapeo de teclas.

### A1 — Ensamblador SM83
- **Posee:** `web/src/sm83isa/**`, `web/src/asm/**`, `tests/asm/**`
- **Depende de:** nada (puede empezar incluso en la fase 0)
- **Trabajo:** ver [web/src/asm/README.md](web/src/asm/README.md).
  1. `sm83isa`: tabla única de los 244 opcodes base válidos (256 menos los 11 ilegales y el prefijo CB) y los 256 CB → codificación, ciclos
     M (con y sin salto). La usa también el desensamblador (D1).
  2. Lexer y parser de dos pasadas con sintaxis RGBDS: etiquetas globales y locales
     (`.loc`), `@`, expresiones (`HIGH/LOW/BANK()/SIZEOF()/STARTOF()`), números `$FF`,
     `%1010`, `&17`, `` `0123 `` (gráficos 2bpp), `"texto"`.
  3. Directivas: `SECTION "nombre", ROM0|ROMX|WRAM0|WRAMX|HRAM|SRAM|VRAM[$dir], BANK[n]`,
     `DB/DW/DS`, `INCBIN`, `INCLUDE`, `EQU/DEF/=`, `MACRO/ENDM` con `\1…\9` y `\@`,
     `IF/ELIF/ELSE/ENDC`, `REPT/ENDR`, `CHARMAP`, `ASSERT`.
  4. Colocación de secciones por banco (fijas primero, luego flotantes por tamaño) con
     error si un banco se desborda; imagen de ROM potencia de 2 ≥ 32 KB.
  5. Salida según AGENTS.md §5.3.
- **Aceptación:** cada entrada de la tabla ensambla a los bytes esperados (tabla de
  referencia escrita a mano a partir de la tabla de opcodes de Pan Docs/gbdev); un
  programa de prueba ensamblado con RGBDS real (bytes guardados en
  `tests/asm/golden/`, generados una vez fuera del repo) da la misma ROM byte a byte;
  ensamblar 5 000 líneas en menos de 50 ms.

### Integración de la fase 1 (coordinador)
Cuando C1 + M1 + V1 pasan su aceptación: `core.wasm` real en W1; una ROM homebrew
propia (`tests/fixtures-own/hello.gbc`) arranca en el navegador con imagen y sonido. M3 y
A1 se enganchan a la UI de forma mínima (cargar ROM, botón "Construir" que de momento
sólo muestra errores).

---

## Fase 2 — IDE, exactitud y rendimiento (paralela)

### I1 — Editor y "construir y arrancar"
- **Posee:** `web/src/ui/editor/**`, `web/src/ui/run.ts`
- **Depende de:** A1, W1, integración de fase 1
- **Trabajo:** CodeMirror 6 con lenguaje SM83/RGBDS (mnemónicos, registros, directivas,
  números, etiquetas, macros), errores como diagnósticos, guardado automático en
  localStorage, ejemplos precargados (hola mundo con fuente propia, scroll del fondo,
  sprite movido con la cruceta, paletas CGB animadas). **Construir y arrancar**
  (Ctrl+Enter): ensamblar → completar cabecera (E1) → `gb_insert` → reset → ejecutar.
  Sin boot ROM, el programa está en pantalla en el primer frame. Opción "mantener WRAM"
  para iterar sin perder estado.
- **Aceptación:** el ejemplo "hola mundo" se ve en pantalla tras Ctrl+Enter; los errores
  aparecen subrayados en la línea y el fichero correctos.

### D1 — Desensamblador y depurador
- **Posee:** `web/src/disasm/**`, `web/src/ui/debugger/**`, `core/src/debug.c`
- **Depende de:** A1 (`sm83isa`), integración de fase 1
- **Trabajo:** desensamblador sobre `sm83isa` consciente de bancos (`ROMX` según el MBC
  actual); panel de registros, flags, IME, IE/IF, LY/modo de la PPU, velocidad;
  pausa/continuar/paso/paso por encima/salir de la función/hasta el cursor; breakpoints
  `banco:dirección` desde el margen del editor (por `lineMap`) y desde el desensamblado;
  watchpoints de escritura en un rango; visor de memoria hexadecimal editable con
  selector de banco. En el núcleo: mapa de bits de breakpoints consultado en
  `gb_run_frame` con coste mínimo cuando no hay ninguno.
  **Lección de zxemuIAtor:** `runTo` no debe quitar el breakpoint temporal en una
  microtarea si el bucle sigue en marcha (carrera observada allí); el estado del
  controlador es una máquina de estados explícita con tests.
- **Aceptación:** round-trip `ensamblar(desensamblar(bytes)) == bytes` para los 256
  opcodes base y los 256 CB con todos los operandos posibles; con breakpoints
  desactivados el bench no empeora más de un 1 %.

### G1 — Visores de VRAM
- **Posee:** `web/src/ui/vram/**`, `tests/ui/vram/**`
- **Depende de:** W1, integración de fase 1
- **Trabajo:** visor de tiles (2 bancos × 384, con la paleta elegida), de los dos mapas
  (con atributos CGB y el rectángulo de SCX/SCY y la ventana), de OAM (40 sprites con
  posición, atributos y tile) y de las 16 paletas. Lee sólo vistas de depuración de
  `gb.h` (sin efectos laterales). Se refresca a fin de frame o en pausa.
- **Aceptación:** tests sin DOM de la decodificación (tile 2bpp → píxeles; atributos)
  contra valores escritos a mano; con cgb-acid2 cargado, el mapa reconstruido coincide
  con el framebuffer en las zonas sin sprites.

### E1 — Exportar `.gbc` y `.sav`
- **Posee:** `web/src/export/**`, `tests/export/**`
- **Depende de:** A1; M3 para `.sav`
- **Trabajo:** cabecera de cartucho (logo, título, bandera CGB 80h/C0h, licencia, tipo de
  cartucho y tamaños deducidos de las secciones usadas o fijados por el usuario,
  checksum de cabecera y global), relleno a potencia de 2, descarga. Exportar/importar
  `.sav` y estados.
- **Aceptación:** la ROM exportada arranca en el propio emulador **con** una boot ROM de
  prueba que verifique logo y checksum (escrita por nosotros en `tests/fixtures-own/`,
  replicando las comprobaciones documentadas) y sin ella; checksums contra valores
  calculados a mano en el test.

### C2 — Exactitud de la máquina
- **Posee:** `tests/accuracy/**`, `tests/fixtures-own/**` (ROMs de prueba propias en asm)
- **Depende de:** integración de fase 1. Corrige vía hallazgos dirigidos a C1/M1/V1/M2
  (no edita sus ficheros).
- **Trabajo:** pasar en la máquina real todo mooneye aplicable al CGB, SameSuite,
  Mealybug Tearoom, age-test-roms; ROMs propias para lo que no cubran (doble velocidad
  con HDMA, cambio de velocidad con el LCD encendido, escrituras a paletas en modo 3);
  resolver todos los `[VERIFICAR]` de docs. Tabla de estado de cada test en
  `docs/accuracy.md` (pasa/falla/no aplica, y por qué).
- **Aceptación:** cero `[VERIFICAR]` pendientes; cada test propio documenta la fuente del
  valor esperado; la tabla de estado no tiene fallos sin explicar.

### P1 — Rendimiento
- **Posee:** `tools/bench.mjs`, `bench/**`
- **Depende de:** integración de fase 1. Propone cambios a C1/M1/V1/M2 con números; no
  edita sus ficheros.
- **Trabajo:** bench reproducible (ROM homebrew propia con carga fija de CPU, PPU con
  ventana y 10 sprites por línea, APU con los 4 canales; N frames, mediana); línea base;
  inspección del `.wat` del bucle caliente; propuestas medidas.
- **Aceptación:** ≥ 10× tiempo real (frame < 1,7 ms) en un portátil moderno, o el
  informe de por qué no y qué lo limita (la PPU al punto es mucho más cara que la ULA).

---

## Fase 2C — C para SM83 (paralela)

Compilador propio de C a SM83 en TypeScript puro (sin DOM, sin dependencias,
determinista) que genera **fuente de ensamblador** para A1. Reutiliza ensamblado, depurador
y exportación sin tocarlos. Descartados GBDK/SDCC por las mismas razones que en
zxemuIAtor (binario enorme, GPL, difícil de mapear al depurador).

**Punto de partida:** el preprocesador, lexer, parser y comprobación de tipos de
`zxemuIAtor/web/src/cc` se **copian** (no se comparten como paquete) y se adaptan; el
generador de código es nuevo. Ver [web/src/cc/README.md](web/src/cc/README.md).

**Subconjunto "C práctico" (v1):** el mismo que en zxemuIAtor: `char`/`int`/`short` con
y sin signo (8 y 16 bits), punteros, arrays, `struct`, `typedef`, `enum`, `const`,
`static`, globales con inicializador, recursión, todo el control de flujo, todos los
operadores, preprocesador simple, ensamblador en línea (`__asm … __endasm;`), `__naked`.
Añadidos de la GB: `__banked`/`#pragma bank n` (código en ROMX con trampolín en ROM0),
`__at(dir)` para variables en direcciones fijas (registros de E/S), `#pragma section`.
**Fuera de v1:** `float`, `long`, `union`, punteros a función, varargs de usuario,
bitfields, VLA.

**ABI (fijada por K1 antes de que empiece L1, en `docs/c-abi.md`):** el SM83 no tiene
IX/IY ni `EX DE,HL`, así que el marco en pila es caro (`LD HL,SP+e`). Por eso, desde la v1
(lección de K2 en zxemuIAtor): **locales y parámetros en direcciones fijas de WRAM para
funciones no recursivas** (el grafo de llamadas se conoce: compilación de programa
completo) y marco en pila sólo para las recursivas; retorno en A (8 bits) / DE o BC
(16 bits) — a decidir en K1 con medidas; símbolos `_nombre`; arranque `crt0` (cabecera,
pila en HRAM o WRAM alta, BSS a cero, copia de `.data`, rutina de OAM DMA a HRAM,
`call _main`, bucle `HALT`).

### K1 — Compilador de C a SM83
- **Posee:** `web/src/cc/**`, `tests/cc/**`, `docs/c-abi.md`
- **Depende de:** A1 (sintaxis que acepta el ensamblador)
- **Trabajo:** front-end adaptado de zxemuIAtor; generación directa sobre el AST con
  acumulador A/HL; condiciones sobre flags desde el principio (`cp`/`jr`, sin
  materializar 0/1); peephole sencillo medido; `lineMap` C → ensamblador; runtime de
  multiplicación/división/desplazamientos en `crt`. Comprueba que código, datos y BSS
  caben en su banco/zona y da error (lección de Sootland en C: el BSS desbordado no se
  vio hasta que el juego se colgó).
- **Aceptación:** suite de programas C con salida esperada escrita a mano, ejecutados en
  `core-probe` (resultados por el puerto serie, como Blargg); oráculo adicional: el
  mismo programa con `cc` nativo y `int16_t`; compilar 2 000 líneas < 200 ms. Banco de
  ciclos M (fib, criba, burbuja, blit de sprites) con cifras en el informe.

### L1 — Librería básica (`gbc.h` de usuario)
- **Posee:** `web/src/clib/**`, `tests/clib/**`
- **Depende de:** ABI de K1; puede empezar con rutinas en ensamblador en paralelo.
- **Trabajo:** ver [web/src/clib/README.md](web/src/clib/README.md) (API y serie de 10
  ejemplos, de "hola mundo" a un mini-juego).
- **Aceptación:** cada función con un test en el núcleo real verificado por framebuffer,
  VRAM, OAM, paletas o registros de la APU con valores escritos a mano; cada ejemplo
  compila sin errores ni avisos y tiene un test que verifica su efecto visible.

### U1 — Pestañas en el panel del editor y C en la UI
- **Posee:** `web/src/ui/tabs/**`, `tests/ui/tabs/**`; ediciones pequeñas en
  `web/src/ui/editor/**`, `web/src/ui/run.ts`, `web/src/main.ts`, `index.html`,
  `style.css`
- **Depende de:** I1, D1; K1 para el modo C
- **Trabajo:** como U1 de zxemuIAtor: pestañas `.asm`/`.inc`/`.c`/`.h`, guardado en
  localStorage, pestaña principal, Ctrl+Enter compila → ensambla → arranca, ver el
  ensamblador generado, depurador sobre líneas C vía `cLineMap`, ejemplos C precargados.
  Lista de ficheros en un panel lateral colapsable (Ctrl+B) desde el principio.
- **Aceptación:** tests sin DOM de la lógica de pestañas y del flujo compilar/arrancar
  contra el núcleo real; el ejemplo C por defecto es visual.

### AV — Ejemplo grande: aventura original en C
Demostración de punta a punta de la cadena C → ensamblador → ROM `.gbc` con un juego
completo y pequeño, **de diseño propio**: ni personajes, ni mapas, ni gráficos, ni música,
ni textos de ningún juego existente (AGENTS.md §6). Sirve además de prueba de carga del
compilador y de la librería en un programa real.
- **Posee:** `web/src/clib/examples/adventure/**`, `tests/clib/adventure/**`
- **Depende de:** K1, L1 (y U1 para precargarlo en la UI).
- **Trabajo:**
  - Aventura de vista cenital por pantallas fijas (scroll de pantalla a pantalla):
    protagonista con 4 direcciones y animación de 2 fotogramas, colisión con el mapa,
    2–3 tipos de enemigo con IA sencilla, un arma, vida, objetos que abren paso
    (llave → puerta, objeto → obstáculo) y una mazmorra corta con un jefe final.
  - Mundo de ~16 pantallas exteriores + ~8 de mazmorra, mapas de 20×18 tiles con
    atributos CGB (hasta 8 paletas de fondo, 8 de objetos).
  - Gráficos, fuente y mapas originales, escritos como arrays C (o generados con R1 si la
    fase 4 está hecha); música y efectos con la APU desde la librería.
  - HUD en la ventana (vida, objetos), pantalla de título, fin de partida y guardado en la
    RAM con pila del cartucho (MBC5 + RAM + pila: `.sav`).
  - Código dividido en varios `.c`/`.h` (mapa, actores, jugador, HUD, sonido) para
    ejercitar las pestañas y la compilación multi-fichero; ROM de 64–128 KB con bancos.
- **Aceptación:**
  - Compila sin errores ni avisos y la ROM exportada pasa la validación de cabecera y
    checksums de E1.
  - Tests en el núcleo real con entradas de joypad grabadas: el título llega a pantalla,
    el jugador se mueve y choca con un muro (posición en OAM), se cambia de pantalla
    (mapa en VRAM), se recoge una llave y se abre la puerta, y la partida guardada
    sobrevive a `gb_save_sav` → `gb_reset` → `gb_load_sav`.
  - Corre a 60 fps en el núcleo real: ningún frame de la partida grabada se pasa del
    VBlank siguiente (medido con el contador de frames, no a ojo).

---

## Fase 3 — Cierre (secuencial)

1. Revisión global Carmack/Abrash por un agente que no haya escrito el núcleo, leyendo
   el código sin las conclusiones de los autores.
2. Pulido de UX: estado vacío, mensajes de error de carga (cabecera inválida, MBC no
   soportado), atajos documentados en la UI.
3. `README.md`: uso, compilación, política de boot ROM y de ROMs.

## Fase 4 — Recursos y proyectos (opcional, a confirmar con el usuario)

- **R1 — Recursos:** conversores en `web/src/res/` (PNG → tiles 2bpp con hasta 8 paletas
  CGB de 4 colores y deduplicación; mapa de tiles + atributos; fuentes). Se usan desde
  el ensamblador con `INCBIN` sobre un recurso virtual, como `res/` en zxemuIAtor.
- **PX — Proyectos:** manifiesto `.gbproj` (ficheros, principal, opciones de cabecera),
  ejemplos de proyecto en el menú de ejemplos, exportar/importar.

---

## Matriz de paralelismo

| Flujo | Fase | Bloqueado por | Bloquea a |
|---|---|---|---|
| C1 CPU | 1 | 0.5 | integración, C2, P1, K1 (tests en núcleo) |
| T1 Arnés | 1 | 0.5 | aceptación de C1/M1/V1/M2 |
| M1 Máquina | 1 | 0.5 | integración, C2, P1 |
| V1 PPU | 1 | 0.5 | integración, G1, C2, P1 |
| M2 APU | 1 | 0.5 | loop real de W1 |
| M3 Cartuchos | 1 | 0.5 | E1 (.sav), integración (ROMs >32 KB) |
| W1 Shell web | 1 | 0.5 | I1, D1, G1 |
| A1 Ensamblador | 0–1 | — | I1, D1, E1, K1 |
| I1 Editor | 2 | A1, W1, integración | U1 |
| D1 Depurador | 2 | A1, integración | U1 |
| G1 Visores VRAM | 2 | W1, integración | — |
| E1 Exportar | 2 | A1, M3 | I1 (cabecera al construir) |
| C2 Exactitud | 2 | integración | fase 3 |
| P1 Rendimiento | 2 | integración | fase 3 |
| K1 Compilador C | 2C | A1 | L1 (ABI), U1 (modo C) |
| L1 Librería C | 2C | ABI de K1 | ejemplos C de U1 |
| U1 Pestañas + C | 2C | I1, D1, K1 | fase 3 |
| AV Aventura en C | 2C | K1, L1 (U1 para la UI) | fase 3 |

Máximo de agentes simultáneos: **8** en la fase 1 y **6** en la fase 2, más un revisor por
tarea al cerrar.

## Lecciones de zxemuIAtor (aplicar desde el principio)

- **Contratos congelados pronto** funcionaron: ningún flujo de la fase 1 bloqueó a otro.
- **El oráculo externo primero.** Las suites de la comunidad encontraron fallos que los
  tests propios no veían; los tests propios sólo para lo que las suites no cubren.
- **Optimizar el compilador C pronto en lo estructural** (locales fijas, condiciones en
  flags): rehacerlo después (K2) costó más que hacerlo en K1.
- **Comprobar límites de memoria en el enlazado**: un BSS que pisa otra zona no da error,
  cuelga el programa mucho después.
- **Rutinas calientes de la librería en ensamblador** (blit de sprites): el C propio es
  ~2× más lento en bucles internos; medir y no pelearse con el compilador.
- **Tests de tiempo fuera de `npm test`** (`test:perf`): con la máquina cargada daban
  falsos fallos.
- **Depurador como máquina de estados con tests** (carrera de `runTo`).

## Riesgos conocidos

- **Coste de la PPU al punto** en wasm: el FIFO por píxel es caro. Plan: camino rápido
  por línea cuando no hay escrituras a registros de PPU durante el modo 3 (detectado por
  la puesta al día perezosa) y camino exacto sólo si las hay. Medido por P1.
- **Mealybug Tearoom** tiene casos que ni los emuladores de referencia pasan en CGB: la
  aceptación se limita a los marcados como verificados en hardware CGB.
- **Juegos DMG sin boot ROM:** la paleta de compatibilidad la elige la boot ROM por hash
  del título; sin ella usamos una paleta fija documentada (y la tabla completa sólo si
  hay boot ROM del usuario). `[VERIFICAR]` si se puede reproducir la tabla sin copiar
  datos de Nintendo.
- **Ritmo de audio vs. pantalla** (59,73 Hz frente a 60/144 Hz): reloj maestro de audio.
- **SharedArrayBuffer** requiere COOP/COEP; si el hosting no puede, `postMessage` (M2).
- **Compilador C propio**: más lento y grande que SDCC/GBDK; se acepta a cambio de
  integración total con el depurador. Optimizar sólo con números.
