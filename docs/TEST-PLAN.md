# Plan de tests — CPU SM83 y máquina CGB

Qué hay que probar para afirmar que la CPU, la PPU, la APU, los temporizadores y los
cartuchos son correctos, cómo y contra qué. Complementa [PLAN.md](../PLAN.md) (quién lo
hace) y [gbc-hardware.md](gbc-hardware.md) (los datos).

## 0. Principios

1. **El oráculo nunca es el código bajo prueba.** Cada valor esperado sale de una de
   estas fuentes, y el test dice cuál:
   - `EXT`: suite externa (SingleStepTests, Blargg, mooneye, SameSuite, acid2, Mealybug,
     age).
   - `DOC`: dato de `gbc-hardware.md` con su fuente primaria.
   - `REF`: **modelo de referencia independiente** en TypeScript (`tests/ref/`), escrito
     por un agente distinto del autor del núcleo, lento y obvio a propósito (un punto por
     iteración, sin cachés, sin planificador de eventos).
   - `HW`: captura de hardware real publicada por la suite (imágenes de referencia de
     acid2/Mealybug).
2. **Probar los tests** (mutación). Cada categoría debe fallar con al menos un fallo
   inyectado a propósito (§8). Un test que nunca ha fallado no demuestra nada.
3. **Primera discrepancia, con contexto.** Cada runner informa del primer punto de
   divergencia: instrucción, ciclo, registros antes/después, ciclos de bus esperados
   frente a obtenidos; en capturas, PNG de diferencias.
4. **Determinismo.** Ningún test depende del reloj real ni de la velocidad de la máquina
   (el RTC tampoco: avanza con ciclos emulados).
5. **Tres velocidades**: `fast` (< 10 s, en cada cambio), `full` (< 3 min, antes de
   integrar), `soak` (sin límite, nocturno o manual: SingleStepTests completo, todas las
   ROMs de exactitud).
6. **Sin ROMs comerciales.** Sólo suites de test y homebrew propio.

## 1. Builds e instrumentación necesarios

| Build | Contenido | Uso |
|---|---|---|
| `core-test.wasm` | CPU + `testbus.c` (64 KB planos, sin periféricos) | CPU-* |
| `core-probe.wasm` | Máquina CGB real + `-DGB_TEST_HOOKS` | SYS-*, PPU-*, APU-*, CART-*, ROM-* |
| `core.wasm` | Producción, sin hooks | humo y bench |

Exports de test (sólo con `GB_TEST_HOOKS`; sección aparte en `gb.h`, la añade el
coordinador):

- `gb_t_cycles()` / `gb_t_run_until(cycle)`: ejecutar instrucciones hasta alcanzar o
  superar un ciclo.
- `gb_t_buslog_enable(on)`, `gb_t_buslog()`, `gb_t_buslog_len()`: registro de ciclos
  `{cycle, kind: R|W|I (interno), addr, val}`.
- `gb_t_ppu_state()`: LY, punto dentro de la línea, modo, longitud del último modo 3.
- `gb_t_serial_log()` / `gb_t_serial_len()`: bytes enviados por el puerto serie (Blargg y
  los programas de prueba del compilador C).
- `gb_t_ld_b_b()`: contador de veces que se ejecutó `LD B,B` (mooneye) y PC de la última.
- `gb_t_apu_log()`: cambios `(ciclo, canal, nivel)` del frame actual.
- `gb_t_sched_disable(on)`: fuerza puesta al día ciclo a ciclo (para comparar el camino
  perezoso con el exacto, ver SYS-10).

En `testbus.c` también hay registro de ciclos (es lo que compara SingleStepTests).

### Utilidades de test (`tests/util/`)

- `runRom(path, {until, maxFrames})`: carga una ROM en `core-probe`, ejecuta y devuelve
  framebuffer, salida serie, estado de `LD B,B` y registros.
- `blarggResult(probe)`: texto de serie + texto en A000h (firma `DE B0 61`) → pasa/falla
  con el mensaje.
- `mooneyeResult(probe)`: registros en el `LD B,B` → pasa (3,5,8,13,21,34) / falla (42h).
- `fbCompare(fb, png, {colorCorrection})`: comparación exacta con la imagen de referencia
  de la suite; genera PNG de diferencias en `build/test-out/`.
- `asm(src)`: usa el ensamblador A1 para escribir ROMs de prueba. **Excepción**: los tests
  CPU-* nunca usan A1 (bytes escritos a mano), para que un fallo del ensamblador no
  oculte uno de la CPU.

---

## 2. CPU — tests unitarios por instrucción (`core-test.wasm`)

### CPU-01 SingleStepTests/sm83 · `EXT` · fast (25/opcode) · soak (1 000/opcode)
- 1 000 casos por opcode (tabla base y CB): estado inicial, estado final, memoria y la
  **lista de ciclos M** (dirección, valor, tipo de acceso).
- Comparar todo: registros, IME, memoria tocada, número de ciclos y cada ciclo.
- Aceptación: 100 %. Sin lista de exclusiones.

### CPU-02 Flags por familia · `DOC` · fast
Casos dirigidos (además de CPU-01, para que el fallo diga *qué* regla se ha roto):

| Grupo | Qué se comprueba |
|---|---|
| ADD/ADC/SUB/SBC/CP | H por acarreo del bit 3, C del bit 7; N |
| `ADD HL,rr` | H del bit 11, C del bit 15, Z intacto |
| `ADD SP,e` / `LD HL,SP+e` | H y C del byte bajo **sin signo**, Z=N=0 |
| `INC/DEC r` | C intacto; H por el bit 3 |
| DAA | todas las combinaciones de A×(N,H,C) contra tabla de `DOC` |
| `SCF/CCF/CPL` | N y H |
| rotaciones de A (`RLCA` …) frente a CB (`RLC A`) | Z=0 en las de A |
| `BIT n,r` | Z, N=0, H=1, C intacto |

### CPU-03 Interrupciones y HALT · `DOC`+`EXT` · fast
| Caso | Esperado |
|---|---|
| Despacho | 5 ciclos M (2 internos, 2 escrituras del PC, salto); IF del bit atendido a 0 |
| Prioridad | el bit más bajo de `IE & IF` |
| `ie_push` | si el byte alto del PC se escribe en FFFFh y cancela la IRQ → salta a 0000h |
| EI | la IRQ no se atiende hasta después de la instrucción siguiente; `EI; DI` no atiende |
| HALT con IME=1 | despierta y atiende |
| HALT con IME=0 y `IE&IF`=0 | espera; al llegar una IRQ continúa sin atenderla |
| HALT con IME=0 y `IE&IF`≠0 | **halt bug**: el byte siguiente se lee dos veces |
| `RETI` | IME=1 sin retardo |

### CPU-04 Opcodes ilegales y STOP · `DOC` · fast
- Los 11 ilegales bloquean la CPU (no avanza el PC; la máquina sigue).
- STOP con KEY1.0=0 → la máquina entra en parada; con KEY1.0=1 → `bus_stop()` y la CPU
  sigue tras la pausa (lo mide SYS-07 en la máquina real).

## 3. Máquina — `core-probe.wasm`

### SYS-01 Mapa de memoria y bancos · `DOC` · fast
Eco C000–DDFF ↔ E000–FDFF; SVBK 0 → banco 1; VBK; FEA0–FEFF (valor de lectura en CGB
según docs §2 `[VERIFICAR]`); bits no usados de los registros de E/S leen 1 (tabla de
docs §3, uno por registro).

### SYS-02 Temporizador · `EXT` (mooneye `acceptance/timer/*`) + `DOC` · fast
Frecuencias de TAC, recarga retrasada, escritura a TIMA durante la recarga, escritura a
TMA durante la recarga, reset de DIV provocando incremento, cambio de TAC provocando
incremento.

### SYS-03 Interrupciones en la máquina · `EXT` · fast
mooneye `acceptance/interrupts/ie_push`, `acceptance/if_ie_registers`,
`acceptance/rapid_di_ei`, `acceptance/halt_ime*`; Blargg `interrupt_time`, `halt_bug`.

### SYS-04 OAM DMA · `EXT` · fast
mooneye `acceptance/oam_dma/*`, `oam_dma_start`, `oam_dma_restart`, `oam_dma_timing`;
conflictos de bus: la CPU lee lo que la DMA pone en el bus fuera de HRAM (docs §6).

### SYS-05 HDMA/GDMA · `EXT` (SameSuite `dma/*`) + propio · full
16 bytes por HBlank; GDMA detiene la CPU; cancelar HDMA (bit 7 de FF55 a 0); HDMA con el
LCD apagado; en doble velocidad. Tests propios (`tests/fixtures-own/hdma-*.asm`) con el
valor esperado sacado de SameSuite o de docs.

### SYS-06 Joypad · `DOC` · fast
Selección de fila (P14/P15), lectura activa a 0, IRQ en flanco de bajada.

### SYS-07 Doble velocidad · `DOC` + propio · fast
KEY1 tras el cambio; duración de la pausa del STOP; temporizador y DIV al doble respecto
a la PPU; la PPU no cambia de ritmo; la APU sigue a 512 Hz.

### SYS-08 Serie interno · `EXT` (Blargg lo usa) · fast
SC=81h → 8 bits a 8 192 Hz = 1 024 ciclos M en velocidad normal (SC bit 1 = reloj rápido
del CGB, 262 144 Hz); SB recibe FFh, IRQ al terminar.

### SYS-09 Estado post-arranque sin boot ROM · `EXT` (mooneye `boot_regs-cgb`, `boot_hwio-C`) · fast

### SYS-10 Planificador perezoso = ciclo a ciclo · `REF` · full
Mismas ROMs ejecutadas con `gb_t_sched_disable(1)` y sin él → mismos framebuffers, mismo
registro de APU y mismos registros durante N frames. Protege el principio 4.1.8.

## 4. PPU

### PPU-01 Ritmo de modos · `EXT` (mooneye `acceptance/ppu/*` CGB) + `DOC` · fast
Duración de cada modo, momento de IRQ de STAT por fuente, bloqueo de flanco de STAT,
LY=153 → 0, LYC=0 en la línea 153.

### PPU-02 Longitud del modo 3 · `REF` · fast
Tabla de casos (SCX%8 = 0…7; ventana en X = 0, 7, 166; 1…10 sprites en distintas X)
→ longitud en puntos según el modelo REF de FIFO, contrastado con los valores publicados
en docs §7.3.

### PPU-03 Imagen completa · `HW` · fast
cgb-acid2 y dmg-acid2 (modo compatibilidad) idénticos a la referencia.

### PPU-04 Cambios a mitad de línea · `HW` · full
Mealybug Tearoom: las ROMs marcadas como verificadas en CGB; el resto se lista en
`docs/accuracy.md` como "no aplica".

### PPU-05 Paletas CGB · `DOC` · fast
Autoincremento de BCPS/OCPS, escritura en modo 3 ignorada (y el índice sí avanza
`[VERIFICAR]`), lectura de BCPD.

### PPU-06 Acceso a VRAM/OAM por modo · `EXT`+`DOC` · fast
Lecturas FFh y escrituras perdidas en los modos bloqueados; LCD apagado → todo accesible.

## 5. APU

### APU-01 Blargg `cgb_sound` · `EXT` · full (12 pruebas)
### APU-02 SameSuite `apu/*` · `EXT` · full
### APU-03 Señal · `DOC` · fast
Pulso de duty 50 % a frecuencia conocida → fundamental ±0,5 %, sin DC tras el filtro;
canal de onda con la RAM de onda escrita a mano → forma esperada; silencio con NR52=0.

## 6. Cartuchos y estados

### CART-01 MBCs · `EXT` (mooneye `emulator-only/mbc1|mbc2|mbc5`) · fast
### CART-02 RTC del MBC3 · `EXT` (rtc3test sin tiempo real) + `DOC` · full
Latch, parada (bit 6 de DH), desbordamiento de días, avance por ciclos emulados.
### CART-03 `.sav` · `DOC` · fast
Formato con el bloque RTC de 48 bytes al final; round-trip.
### CART-04 Estados · propio · fast
Guardar → cargar → N frames = mismos framebuffers y audio; versión distinta → error claro.

## 7. Herramientas del IDE (sin núcleo o con `core-probe`)

- **ASM-*:** tabla de opcodes (referencia escrita a mano), directivas RGBDS, macros,
  secciones y bancos, errores con línea/fichero; ROM idéntica a la *golden* de RGBDS.
- **DIS-*:** round-trip ensamblar/desensamblar de todos los opcodes.
- **EXP-*:** checksums de cabecera y global contra valores calculados a mano; la ROM
  exportada pasa la boot ROM de prueba propia.
- **CC-*:** como en zxemuIAtor, con la salida por el puerto serie.
- **CLIB-*:** efecto de cada función sobre VRAM/OAM/paletas/APU.
- **UI-*:** lógica de pestañas, construir y arrancar, máquina de estados del depurador.

## 8. Mutación

`tools/mutate.mjs` aplica fallos conocidos al núcleo y comprueba que alguna suite los
detecta. Lista mínima:

| Mutación | Debe fallar |
|---|---|
| quitar el retardo de EI | CPU-03, SYS-03 |
| H de `ADD SP,e` desde el bit 11 | CPU-01, CPU-02 |
| recarga de TIMA sin retardo | SYS-02 |
| modo 3 de longitud fija | PPU-01, PPU-02, PPU-04 |
| OAM DMA sin conflictos de bus | SYS-04 |
| sin halt bug | CPU-03 |
| MBC1: banco 0 no se traduce a 1 | CART-01 |
| puesta al día perezosa olvidada en SCX | SYS-10, PPU-04 |
