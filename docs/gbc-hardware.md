# Referencia de hardware — Game Boy Color (CGB-E)

Fuente de verdad del núcleo (AGENTS.md §4.1.1). Cada dato lleva su fuente; lo dudoso va
marcado **`[VERIFICAR]`** con el flujo que debe resolverlo. Es un **esqueleto de fase 0**:
los flujos de la fase 1 lo completan antes de escribir código, y C2 cierra los
`[VERIFICAR]`.

Fuentes primarias (por orden de preferencia):

- **Pan Docs** (gbdev.io/pandocs): referencia general.
- **Gekkio, *Game Boy: Complete Technical Reference*** (gb-ctr): CPU y ciclos M.
- **mooneye-test-suite**, **SameSuite**, **Blargg**, **Mealybug Tearoom**, **age**: el
  comportamiento que prueban es dato (con la ROM como cita).
- **SameBoy** (código, licencia MIT): sólo para contrastar, nunca como única fuente.
- **The Cycle-Accurate Game Boy Docs** (AntonioND) y **GBEDG** (PPU, FIFO).

Unidades: **punto** (dot) = 1/4 194 304 s, el reloj de la PPU, que no cambia con la doble
velocidad. **Ciclo M** = 4 puntos en velocidad normal y 2 en doble velocidad.

---

## 1. Relojes y frame

| Dato | Valor | Fuente |
|---|---|---|
| Reloj del sistema | 4 194 304 Hz (normal), 8 388 608 Hz (doble) | Pan Docs |
| Puntos por línea | 456 | Pan Docs |
| Líneas por frame | 154 (144 visibles + 10 de VBlank) | Pan Docs |
| Puntos por frame | 70 224 | 456 × 154 |
| Frecuencia de frame | ≈ 59,7275 Hz | 4 194 304 / 70 224 |
| Ciclos M por frame | 17 556 (normal), 35 112 (doble) | derivado |

## 2. Mapa de memoria

| Rango | Contenido | Notas |
|---|---|---|
| 0000–3FFF | ROM banco 0 | MBC1 en modo 1 puede mapear otros bancos (§10) |
| 4000–7FFF | ROM banco conmutable | según MBC |
| 8000–9FFF | VRAM, 2 bancos (VBK = FF4F bit 0) | bloqueada en modo 3 |
| A000–BFFF | RAM externa / RTC | habilitada con 0Ah en 0000–1FFF |
| C000–CFFF | WRAM banco 0 | |
| D000–DFFF | WRAM banco 1–7 (SVBK = FF70 bits 0–2; 0 → 1) | |
| E000–FDFF | Eco de C000–DDFF | |
| FE00–FE9F | OAM (40 × 4 bytes) | bloqueada en modos 2 y 3 y durante OAM DMA |
| FEA0–FEFF | No usable | en CGB-E la lectura depende de la dirección `[VERIFICAR M1]` |
| FF00–FF7F | E/S (§3) | |
| FF80–FFFE | HRAM | accesible durante OAM DMA |
| FFFF | IE | |

## 3. Registros de E/S

Bits no usados leen 1. Cada fila deberá llevar la máscara de lectura exacta (`[VERIFICAR
M1]`, contrastar con mooneye `boot_hwio-C`).

| Dir. | Nombre | Dir. | Nombre |
|---|---|---|---|
| FF00 | P1/JOYP | FF40 | LCDC |
| FF01 | SB | FF41 | STAT |
| FF02 | SC (bit 1: reloj rápido CGB) | FF42/43 | SCY / SCX |
| FF04 | DIV | FF44 | LY |
| FF05 | TIMA | FF45 | LYC |
| FF06 | TMA | FF46 | DMA (OAM) |
| FF07 | TAC | FF47–49 | BGP, OBP0, OBP1 (modo compatibilidad) |
| FF0F | IF | FF4A/4B | WY / WX |
| FF10–FF26 | NR10–NR52 (APU) | FF4D | KEY1 (cambio de velocidad) |
| FF30–FF3F | RAM de onda | FF4F | VBK |
| FF50 | desactivar boot ROM | FF51–FF55 | HDMA1–HDMA5 |
| FF56 | RP (infrarrojos, fuera de alcance) | FF68/69 | BCPS / BCPD |
| FF6A/6B | OCPS / OCPD | FF6C | OPRI |
| FF70 | SVBK | FF76/77 | PCM12 / PCM34 |
| FFFF | IE | | |

## 4. CPU SM83

- Registros A, F (Z N H C en bits 7–4; bits 3–0 siempre 0), B, C, D, E, H, L, SP, PC; IME.
- Sin IX/IY, sin registros alternativos, sin E/S aparte (`LDH (n),A` = `LD (FF00+n),A`).
- Cada acceso a memoria es un ciclo M. Los ciclos internos de cada instrucción (dónde
  caen) se toman de gb-ctr y se verifican contra SingleStepTests (CPU-01).
- 11 opcodes ilegales (D3 DB DD E3 E4 EB EC ED F4 FC FD): bloquean la CPU.
- **EI**: IME pasa a 1 tras la instrucción siguiente. **DI**: inmediato. **RETI**: IME=1
  inmediato.
- **Despacho de IRQ**: 5 ciclos M; vectores 40h (VBlank), 48h (STAT), 50h (Timer),
  58h (Serie), 60h (Joypad); prioridad al bit más bajo. Caso `ie_push`: el bit atendido
  se decide *después* de escribir el byte alto del PC; si ya no hay IRQ, PC=0000h
  (mooneye `ie_push`).
- **HALT**: con IME=0 y `IE&IF`≠0 al ejecutarlo → halt bug (el PC no se incrementa al leer
  el siguiente opcode). Con IME=1 e IRQ pendiente no se entra: se despacha a continuación.
  `EI; HALT` con IRQ pendiente: HALT se ejecuta aún con IME=0 → halt bug; el despacho
  retrocede el PC del fetch descartado, así que la dirección de vuelta es el propio HALT
  (Pan Docs, "halt bug"). Mientras dura, un ciclo M por paso; en el paso en que `IE&IF`≠0
  sale y en la misma llamada despacha (IME=1) o hace el fetch siguiente (IME=0), sin ciclo
  extra propio. `[VERIFICAR M1]` ciclo extra de salida en CGB con mooneye
  `halt_ime0_nointr_timing` / `halt_ime1_timing2-GS` (Pan Docs dice "+1 ciclo M si estaba
  en HALT"; con este modelo ese ciclo es el tick de HALT en que se levantó IF).
- **STOP**: 2 bytes (10 xx) si no hay IRQ pendiente (el segundo se lee y se descarta);
  1 byte si `IE&IF`≠0 (Pan Docs "Using the STOP instruction", SameBoy). Después decide la
  máquina (`bus_stop`): con KEY1.0=1 cambia la velocidad (§9); si no, para la CPU y el LCD
  hasta que se pulse un botón `[VERIFICAR M1]` comportamiento exacto en CGB.
  SingleStepTests/sm83 (traducido de Ares) modela STOP como 1 byte con dos ciclos
  internos: es la única desviación respecto a esa suite (CPU-01 usa este dato para 10).
- **Opcodes ilegales**: el fetch ocurre (1 ciclo M) y el PC queda apuntando al opcode;
  después la CPU sólo consume ciclos internos, ni las IRQ la despiertan.
- **Ciclos M por instrucción** (verificados contra SingleStepTests/sm83, los 500 ficheros
  × 1 000 casos, con dirección/valor/tipo de cada ciclo): interno en `INC/DEC rr`,
  `ADD HL,rr`, `LD SP,HL`, `PUSH`/`RST`/`CALL` (antes de escribir), `JP nn`/`JP cc` tomado,
  `JR` tomado, `RET`/`RETI` (después de leer), `RET cc` (uno antes de evaluar y otro al
  cargar el PC si se toma), `LD HL,SP+e` (1) y `ADD SP,e` (2). `JP HL` es 1 ciclo.

## 5. Temporizador

- DIV = bits 15–8 de un contador interno de 16 bits que avanza 1 por punto en velocidad
  normal (por ciclo de sistema). Escribir DIV pone todo el contador a 0.
- TIMA se incrementa en el **flanco descendente** de `bit_TAC & TAC.2`, con bit_TAC =
  bit 9 (4 096 Hz), 3 (262 144 Hz), 5 (65 536 Hz), 7 (16 384 Hz) para TAC.1–0 = 00, 01,
  10, 11. Por eso escribir DIV o TAC puede provocar un incremento.
- Desbordamiento: TIMA lee 00h durante un ciclo M; en el siguiente se carga TMA y se
  pide la IRQ. Escribir TIMA en ese ciclo cancela la recarga; escribir TMA en el ciclo de
  la recarga carga el valor nuevo. Fuente: mooneye `acceptance/timer/*`.
- En doble velocidad el contador avanza al doble respecto a la PPU (va con el reloj de
  la CPU) `[VERIFICAR M1]`.
- Escribir TAC: el multiplexor cambia **antes** del paso del contador de ese ciclo M, así
  que el flanco se evalúa entre `bit_TAC_viejo(contador − 4)` y `bit_TAC_nuevo(contador −
  4)` y después el paso normal del ciclo se evalúa ya con el TAC nuevo. Lo fija mooneye
  `acceptance/timer/rapid_toggle` (pasa); el orden exacto dentro del ciclo es la
  interpretación más simple que lo cumple `[VERIFICAR]`.
- STOP (con o sin cambio de velocidad) pone el contador a 0 con los mismos efectos de
  flanco que escribir DIV (TIMA y secuenciador de la APU). En el cambio de velocidad del
  CGB E el bit de 262 kHz (TAC = 01) se muestrea un ciclo M tarde (contador + 4): AGE
  `spsw-tima-cgbE` `[VERIFICAR: sólo medido en revisión E]`.

## 6. OAM DMA y HDMA

- **OAM DMA** (FF46 = página fuente): 160 ciclos M copiando a FE00–FE9F, tras un retardo
  de arranque de 1 ciclo M `[VERIFICAR M1]`. Durante la copia la CPU sólo accede
  correctamente a HRAM; leer otras zonas devuelve lo que hay en el bus según la fuente de
  la DMA (conflicto de bus) `[VERIFICAR M1: tabla de buses externo/VRAM en CGB]`.
  Reiniciar una DMA en curso: mooneye `oam_dma_restart`.
- **GDMA** (FF55 bit 7 = 0): copia (n+1)×16 bytes de una vez; la CPU se detiene.
- **HDMA** (FF55 bit 7 = 1): 16 bytes al principio de cada HBlank (modo 0); la CPU se
  detiene mientras. Escribir FF55 con bit 7 = 0 durante una HDMA la cancela. Duración
  por bloque: 8 ciclos M en velocidad normal, 16 en doble (≈ 8 µs y 8 µs) `[VERIFICAR M1
  con SameSuite dma/*]`.
- Arrancar una HDMA con el LCD apagado o estando ya en modo 0 copia el primer bloque de
  inmediato (sin esperar al siguiente HBlank). Mealybug `dma/hdma_lcd_off` y
  `dma/hdma_mode0` (pasan). El ciclo M exacto del HBlank en que empieza cada bloque aún
  no es exacto: Mealybug `dma/hdma_timing-C` falla (GBC-1) `[VERIFICAR]`.
- Fuente en VRAM (8000–9FFF) o en E000–FFFF: la DMA lee FFh (no hay eco de WRAM para
  ella). Mealybug `dma/gdma_addr_mask` (pasa).
- Fuente: Pan Docs (CGB Registers), SameSuite.

## 7. PPU

### 7.1 Modos (por línea visible)

| Modo | Duración | Acceso CPU |
|---|---|---|
| 2 (búsqueda OAM) | 80 puntos | OAM no |
| 3 (dibujo) | 172–289 puntos, variable (§7.3) | VRAM, OAM y paletas no |
| 0 (HBlank) | resto hasta 456 | todo |
| 1 (VBlank) | líneas 144–153 | todo |

Implementación (`core/src/ppu.c`): la PPU se pone al día perezosamente saltando de
suceso en suceso. Los píxeles se emiten durante el modo 3 hasta el punto del acceso, así
que los cambios de registros, VRAM y paletas a mitad de línea se ven en la columna
correspondiente. No hay FIFO real: las penalizaciones del modo 3 se cargan al principio
de la línea (ver inexactitudes en §7.7).

**Regla de orden (CPU frente a PPU).** Un suceso de la PPU en el punto T sólo lo ve un
acceso de la CPU *posterior* a T; una escritura de la CPU en el punto T llega antes que
los sucesos de ese mismo punto. Es la semántica de `GB_SLEEP` en SameBoy (un estado sólo
avanza cuando el tiempo disponible supera el pedido). En el código: la PPU se pone al
día hasta `gb.now − 1` y `ppu_next_event()` devuelve el punto del suceso + 1.

**Línea de tiempo de una línea visible (CGB-E, velocidad normal).** Puntos contados
desde el principio de la línea; E = 84 + longitud del modo 3. Fuente: SameBoy
`display.c` (`GB_display_run`, "Lines 0 - 143"), contrastado con AGE `ly-cgbE`,
`stat-mode-cgbE`, `oam-read-cgbE`, `vram-read-cgbBCE` y mooneye `stat_lyc_onoff`, que
pasan:

| Punto | Suceso |
|---|---|
| 0 | OAM bloqueada para escribir (en doble velocidad, en el 2) |
| 3 | LY = línea; OAM bloqueada para leer; salvo en la línea 0: STAT lee modo 0, el comparador LYC no ve ninguna línea y **sale la IRQ de modo 2** (un punto antes de que STAT lea 2) |
| 4 | STAT lee modo 2; el comparador ve LY (flag e IRQ de LYC) |
| 80 | VRAM y paletas libres (fin de la búsqueda en OAM; ya lo estaban desde la línea anterior) |
| 84 | modo 3: VRAM, OAM bloqueadas |
| 87 | paletas (BCPD/OCPD) bloqueadas |
| E | STAT lee modo 0, VRAM y OAM (escritura) desbloqueadas, HBlank para la HDMA (en doble velocidad, todo en E+1) |
| E+1 | IRQ de modo 0; OAM desbloqueada para leer |
| E+3 | paletas: siguen bloqueadas en velocidad normal; libres en doble velocidad |
| E+5 | paletas libres |
| 454 | la fuente de modo 2 se arma para la línea siguiente (salvo en la 143) |

Las paletas **no** se liberan en E: en SameBoy `cgb_palettes_blocked` sigue a 1 desde el
87 hasta E+3, donde pasa a `!cgb_double_speed`, y a 0 en E+5 (`display.c`, fin del modo
3: `GB_SLEEP(gb, display, 33, 2)` / `36, 2`). Test: `timing.test.ts`, "PPU-06"
(BCPD/OCPD leen FFh en E+1 y E+2) `[VERIFICAR: sin ROM de hardware que lo fije]`.

**Qué despierta a la máquina.** Sólo los sucesos que pueden pedir una IRQ o una HDMA
con la configuración actual (`observable()` en `ppu.c`): 3 si STAT.5 (en la línea 0, si
STAT.6 y LYC = 0); 4 si STAT.6 y LYC = línea (en la línea 0 también con STAT.5); 84
(cuando aún no se sabe E), E y E+1 sólo con STAT.3 o HDMA activa; en VBlank el 2 de la
144 con STAT.5, el 4 con LYC = línea, el 5 de la 144 siempre, y el 8/12 de la 153 con
LYC = 153 / 0. `ppu_next_event()` busca en las líneas siguientes si hace falta. LY, modo
visible y bloqueos sólo los ve un acceso, que ya pone al día la PPU. Por eso escribir
STAT, LYC o arrancar una HDMA (FF55) reprograma el planificador.

- La línea 0 de cada frame sigue en modo 1 hasta el punto 4.
- La HDMA arranca su bloque en E (SameBoy lo hace en E+3); se deja en E por la lógica de
  FF55 de `gbc.c` (empezar en modo 0 copia al instante) `[VERIFICAR GBC-1]`.

### 7.2 STAT y LY
- La IRQ de STAT es la OR de las fuentes habilitadas (LYC=LY, modo 0, 1, 2); sólo se
  dispara en el flanco de subida de esa OR ("STAT blocking"). Test: `tests/core/ppu/timing.test.ts`.
- Líneas de VBlank (144–153): en el punto 0 el comparador LYC deja de ver línea; en el 2
  LY = línea; en el 4 el comparador ve LY. En la línea 144, punto 5: modo 1, IF.0
  (VBlank) e IRQ de STAT si la fuente de modo 1 está activa; ahí se intercambia el
  framebuffer y acaba `gb_run_frame`.
- Al entrar en VBlank la fuente de modo 2 también pide IRQ (sin subir la OR de STAT) en
  el punto 2 y otra vez en el 5 de la línea 144 (SameBoy; mooneye `vblank_stat_intr`, que
  aún falla en CGB: PPU-4) `[VERIFICAR]`.
- Línea 153 (CGB-E): LY lee 153 en los puntos 2–7 y 0 desde el 8; el comparador sigue
  viendo 153 hasta el 12 y ve 0 desde ahí (SameBoy; AGE `ly-cgbE`, `lcd-align-ly`)
  `[VERIFICAR: doble velocidad]`.
- Escrituras de LYC, WX y STAT en velocidad normal: llegan a la PPU 1 punto más tarde
  (conflicto de escritura del CGB en SameBoy, `GB_conflict_map_cgb`). En doble velocidad
  se aplican al momento.
- Al encender el LCD (LCDC.7 0→1) la primera línea dura 448 puntos sin modo 2 (STAT lee
  modo 0): OAM bloqueada para escribir en el 76, modo 3 en el 78, paletas en el 80 y VRAM
  en el 83; ese primer frame no se muestra (framebuffer blanco) `[VERIFICAR]`. Al
  apagarlo LY = 0, modo 0, y la pantalla se ve blanca.

### 7.3 Longitud del modo 3
172 puntos base + SCX % 8 + 6 si la ventana empieza en la línea + por sprite 6 puntos más
max(0, 5 − ((X + SCX) % 8)) para el primer sprite de cada tile de fondo (X = 0: 11)
(Pan Docs "Mode 3 length"; tests en `timing.test.ts`: SCX 0/3/4/5/8, ventana, sprite en
X = 8) `[VERIFICAR V1: casos de ventana con sprites y WX = 0; contrastar con GBEDG]`.

### 7.4 Fondo, ventana y sprites en CGB
- Atributos del mapa en VRAM banco 1: paleta (0–2), banco de tile (3), volteo X (5), Y
  (6), prioridad (7).
- LCDC.0 en CGB = "prioridad maestra": a 0, los sprites siempre encima.
- Sprites: hasta 10 por línea; en CGB, prioridad entre sprites por índice de OAM (OPRI=0)
  o por X como en DMG (OPRI=1). Atributo: paleta CGB (0–2), banco de tile (3).
- Ventana: contador de líneas interno que sólo avanza cuando la ventana se ha dibujado
  en esa línea. Se activa si en algún momento del frame WY == LY al empezar una línea
  (condición fijada hasta el frame siguiente) y WX ≤ 166 `[VERIFICAR V1: CGB evalúa
  WY == LY también con LCDC.5 = 0]`.
- Modo de compatibilidad DMG: prioridad entre sprites por X (y luego índice de OAM);
  LCDC.0 = 0 pinta el fondo/ventana con el tono 0 de BG0 sin pasar por BGP
  `[VERIFICAR V1]`. Ambos modos pasan cgb-acid2 y dmg-acid2 (`reference-cgb.png`).

### 7.5 Paletas
- 8 paletas de fondo y 8 de sprites, 4 colores RGB555 (2 bytes, little endian) = 64
  bytes cada grupo. BCPS/OCPS: índice (bits 0–5) y autoincremento (bit 7).
- En modo 3 las escrituras a BCPD/OCPD se ignoran y las lecturas dan FFh. Implementado:
  el índice **sí** avanza con autoincremento aunque la escritura se ignore
  `[VERIFICAR V1]`. BCPS/OCPS leen el bit 6 a 1. FF68–FF6C sólo existen en modo CGB (o
  con la boot ROM mapeada); en compatibilidad leen FFh.
- Modo de compatibilidad (cartucho sin bandera CGB): BGP/OBP0/OBP1 eligen el tono, que
  indexa la paleta BG0 (fondo) y OBJ0/OBJ1 (sprites) que cargó la boot ROM. Sin boot ROM
  se usa la paleta que la boot ROM del CGB asigna a los títulos que no reconoce (sin
  pulsar botones) `[VERIFICAR V1: contrastar con la tabla de la boot ROM]`:
  - BG0: 7FFFh, 1BEFh, 6180h, 0000h (blanco, verde claro, azul, negro).
  - OBJ0 = OBJ1: 7FFFh, 421Fh, 1CF2h, 0000h (blanco, rosa, granate, negro).
  En modo CGB sin boot ROM todas las paletas quedan en blanco (7FFFh).

### 7.6 Color en pantalla
- Sin corrección: canal de 5 bits → 8 bits (`c << 3 | c >> 2`). Es lo que usan los
  tests de captura (acid2) y el valor por defecto.
- Con corrección (`gb_set_color_correction(1)`): curva de byuu/Near (higan), que imita
  el LCD del CGB mezclando canales:
  `R = min(960, 26r + 4g + 2b) >> 2`, `G = min(960, 24g + 8b) >> 2`,
  `B = min(960, 6r + 4g + 22b) >> 2` (blanco → 240). Es preferencia del frontend, no
  estado de la máquina (no va en el estado guardado).
- Framebuffer doble: se intercambia al entrar en VBlank; `gb_framebuffer()` da siempre
  el último frame completo.

### 7.7 Inexactitudes conocidas (V1)
- Sin FIFO de píxeles: el modo 3 se calcula al empezar (búsqueda en OAM y fórmula de
  §7.3), con todas las penalizaciones delante. Cambios de SCX, de LCDC.1/5 o de la OAM a
  mitad del modo 3 no alteran su longitud, y los píxeles de una línea con sprites salen
  más tarde que en el hardware (hasta ~11 puntos por sprite).
- Las reglas de activación de la ventana a mitad de línea (WX cambiado durante el modo
  3, WX = 0 con SCX % 8, WX = 166) son las simplificadas de §7.4.
- La fuente de modo 2 en la línea 144 y la primera línea tras encender el LCD están
  modeladas a partir de SameBoy, mooneye y Pan Docs, sin comprobar en hardware.
- AGE `stat-int-*` y mooneye `intr_2_*` siguen fallando: la CPU lee STAT un ciclo M más
  tarde de lo esperado tras la IRQ de modo 2. La línea de tiempo de la PPU coincide con
  SameBoy, así que la sospecha es el muestreo de IE & IF en `sm83.c` (SameBoy lo hace al
  empezar la instrucción, *antes* de consumir los 4 ciclos pendientes del último acceso)
  `[VERIFICAR]`.

### 7.8 Bloqueo de VRAM, OAM y paletas
Sólo con el LCD encendido; lecturas FFh, escrituras ignoradas. Las ventanas de lectura y
de escritura de la OAM son distintas (tabla de §7.1):
Ventanas [desde, hasta), en puntos de la línea (fuente: SameBoy `GB_display_run`):
- OAM, escritura: 0 (2 en doble velocidad) a E (E+1 en doble velocidad).
- OAM, lectura: 3 a E+1.
- VRAM: 84 a E (E+1 en doble velocidad).
- Paletas: 87 a E+5 en velocidad normal, 87 a E+3 en doble velocidad (no se liberan en
  E, ver §7.1).
- Primera línea tras encender el LCD: OAM escritura desde 76, lectura desde 78, VRAM
  desde 83 (78 en doble velocidad), paletas desde 80; los finales, como arriba.
- VBlank: todo libre.

`gbc.c` usa `ppu_oam_blocked()` para leer la OAM y `ppu_oam_write_blocked()` para
escribirla (AGE `oam-write-*` pasa). En `ppu.c` los bloqueos no son sucesos de la línea:
se calculan en el acceso a partir del punto, E y la velocidad, porque sólo los observa
la CPU tras poner al día la PPU.

## 8. APU

Fuentes: Pan Docs ("Audio", "Audio Registers", "Audio details"), Blargg `cgb_sound`
(readme y tests 01–12), SameSuite `apu/*`. Implementación: `core/src/apu.c`; tests:
`tests/core/apu/`.

### 8.1 Relojes
- El reloj de la APU es de 2 MHz (un tick = 2 puntos); **no** cambia con la doble
  velocidad (§8.5).
- Secuenciador de frame a 512 Hz, avanzado por el flanco descendente del bit 4 de DIV
  (bit 12 del contador interno; bit 13 en doble velocidad, así sigue a 512 Hz). Escribir
  en DIV puede producir ese flanco (lo resuelve gbc.c). Pasos 0–7: longitud en 0, 2, 4, 6
  (256 Hz); barrido en 2 y 6 (128 Hz); envolvente en 7 (64 Hz).
- Al encender (NR52.7 0 → 1) el secuenciador se reinicia: el próximo paso es el 0.

### 8.2 Canales
| Canal | Periodo del generador | Frecuencia | Notas |
|---|---|---|---|
| 1, 2 pulso | (2048 − x) × 4 puntos por paso, 8 pasos | 131 072 / (2048 − x) Hz | ciclos 12,5/25/50/75 %: `00000001`, `10000001`, `10000111`, `01111110` |
| 3 onda | (2048 − x) × 2 puntos por muestra, 32 muestras | 65 536 / (2048 − x) Hz | nibble alto primero; NR32: mudo, 100 %, 50 %, 25 % (desplazamiento 4, 0, 1, 2) |
| 4 ruido | (r ? 16·r : 8) << s puntos por paso del LFSR | 262 144 / (r·2^s) Hz (r = 0 → 0,5) | s ≥ 14: el LFSR no avanza |

- LFSR (modelo equivalente de Pan Docs): 15 bits a 7FFFh al disparar; bit nuevo = b0 XOR
  b1 al bit 14 (y también al 6 con NR43.3); salida = volumen si b0 = 0. apu.c usa la forma
  invertida de SameBoy (0 al disparar, salida = b0), ver §8.5.
- Longitud: 64 pasos (256 en el canal 3), `len = máx − NRx1`; a 0 apaga el canal.
- Envolvente: periodo 0 = parada; sube/baja 1 dentro de 0–15; no apaga el canal.
- Barrido (canal 1): al disparar, sombra = frecuencia, temporizador = periodo (0 → 8) y,
  si el desplazamiento ≠ 0, cálculo inmediato con comprobación de desbordamiento (> 2047
  apaga). En cada pulso con periodo ≠ 0: nueva frecuencia, se escribe en NR13/14 si el
  desplazamiento ≠ 0, y segunda comprobación. Quitar NR10.3 tras haber calculado en modo
  resta desde el disparo apaga el canal (Blargg 04/05).
- DAC: canales 1, 2, 4 encendidos si NRx2 & F8h ≠ 0; canal 3 con NR30.7. Apagar el DAC
  apaga el canal; disparar con el DAC apagado no lo enciende.
- Disparo (NRx4.7): enciende el canal, longitud 0 → máxima, recarga el temporizador de
  frecuencia, volumen y envolvente; canal 3: posición 0 (la primera muestra nueva es la 1;
  hasta entonces suena el byte que ya tenía el búfer); canal 4: LFSR = 7FFFh.
- Pulso extra de longitud: si al escribir NRx4 se habilita la longitud y el próximo paso
  del secuenciador **no** cuenta longitud, se descuenta uno en el acto (y si llega a 0 sin
  disparo, se apaga); si además se dispara con longitud 0, se carga máx − 1 (Blargg 03).

### 8.3 Registros
- Lectura: los bits no usados o de sólo escritura leen 1. Máscaras (OR) FF10–FF2F:
  `80 3F 00 FF BF | FF 3F 00 FF BF | 7F FF 9F FF BF | FF FF 00 00 BF | 00 00 (NR52) | FF…`.
  NR52 = `70h | encendida<<7 | canales activos (bits 0–3)`.
- NR52.7 = 0 apaga la APU: borra FF10–FF25 y, en CGB, **también los contadores de
  longitud** (Blargg `cgb_sound` readme / 08: "on CGB, length counters are reset when
  powered up"). La RAM de onda se conserva. Apagada, en CGB, todo FF10–FF25 es de sólo
  lectura (en DMG las longitudes seguían escribiéndose).
- RAM de onda en CGB: con el canal 3 activo, leer o escribir FF30–FF3F accede al byte que
  el canal está reproduciendo (posición/2), en cualquier momento (sin la ventana de un
  ciclo del DMG). Con el canal parado, acceso normal. Contenido al encender en CGB:
  `00 FF 00 FF …` (Pan Docs).
- PCM12 (FF76): nibble bajo = salida digital del canal 1, alto = canal 2; PCM34 (FF77):
  canal 3 (ya desplazado por NR32) y canal 4. 0 con el canal parado. Sólo lectura.
- Estado sin boot ROM (Pan Docs "Power Up Sequence"): NR52 = F1, NR50 = 77, NR51 = F3,
  NR11 = 80 (lee BF), NR12 = F3; el canal 1 queda activo con la envolvente ya en 0
  (aproximación: el sonido del logo ya se ha extinguido).

### 8.4 Mezcla y salida
- DAC: salida digital d (0–15) → analógica proporcional a 2d − 15 (con DAC encendido y el
  canal parado, d = 0: el escalón de continua lo quita el paso alto). DAC apagado → 0.
- NR51 elige qué canales van a cada lado; NR50 multiplica cada lado por vol + 1 (1–8).
  VIN no se emula (ningún cartucho soportado lo usa).
- Paso alto (condensador de salida): `out = in − cap; cap = in − out·k`, sólo mientras
  algún DAC está encendido; con todos apagados la salida es 0 exacto. k = 0,999958 por
  punto (valor del DMG en Pan Docs) `[VERIFICAR M2: Pan Docs indica 0,998943 "para MGB y
  CGB", pero ese valor por punto daría un corte de ~700 Hz; falta saber a qué reloj se
  refiere. Se usa el del DMG (~28 Hz)]`.
- Resampleado (decisión de implementación, no hardware): la salida escalonada se integra
  exactamente en bins de 32 puntos, el paso alto se aplica por bin y las muestras de
  salida son el promedio (filtro de caja) de 4 194 304 / rate puntos. Escala: ±1,0 = 4
  canales a 15 con volumen maestro 8.

### 8.5 Modelo al tick de 2 MHz (CGB-E)
Fuente: SameBoy (`Core/apu.c`, `timing.c`, ramas de revisión E), contrastado con SameSuite
`apu/channel_*` (46 tests) y Blargg `cgb_sound` 09, que pasan. Corrige lo dicho arriba
donde difiere:
- **Tick de la APU = 2 puntos (2 MHz) en ambas velocidades.** Pulso: paso cada
  (2048 − f) × 2 ticks; onda: muestra cada (2048 − f) ticks; contador del ruido: un paso
  cada `(NR43 & 7) × 4` ticks (0 → 2), y el LFSR avanza en el flanco de subida del bit
  `NR43 >> 4` de ese contador de 14 bits. `lf_div` (fase de 1 MHz) empieza a 1 al encender
  la APU y cambia cada tick; la alineación de los disparos depende de ella.
- **Fase respecto a la CPU:** el evento del secuenciador (flanco de bajada del bit 12/13 de
  DIV) ve la APU un ciclo M por detrás del instante del acceso; los accesos de la CPU la
  ven al día. Encender la APU con ese bit de DIV a 1 se salta el primer evento.
- **Retardos de disparo (pulso):** canal inactivo: 6 − lf_div ticks, más un paso extra del
  ciclo de trabajo según los bits de la cuenta; activo: 4 − lf_div (+2 en un caso de
  f = 7FFh). La salida sigue a 0 hasta el primer paso. El índice del ciclo de trabajo sólo
  lo reinicia apagar la APU. Onda: cuenta = (2048 − f) + 3 ticks y la primera salida es el
  nibble alto del byte que ya tenía el búfer.
- **Envolvente en dos fases:** en el flanco de subida del bit de DIV, si la cuenta del
  periodo es 0 se recarga y se "arma" el reloj; en el flanco de bajada siguiente se mueve
  el volumen (en doble velocidad, un tick más tarde). La cuenta del periodo baja en el
  paso 7 del divisor en los canales sin reloj armado.
- **Modo zombi de NRx2 (CGB-E):** escribir NRx2 con el canal activo hace una única
  transición vieja → nueva: si el reloj está armado recarga la cuenta; periodo 0 → ≠ 0 sin
  bloqueo da un paso; cambiar la dirección invierte el volumen (`v ^ F` o `E − v` hacia
  subir, `10h − v` hacia bajar). Ver `nrx2_glitch` en apu.c.
- **Barrido:** el cálculo y la comprobación de desbordamiento tardan unos ciclos de 1 MHz
  (recarga 2–3 + desplazamiento); el del disparo **no** es instantáneo. Con NR10 bits
  0-2 = 0 la cuenta del cálculo se **congela** (no avanza ni termina) hasta que se vuelva a
  escribir NR10 con desplazamiento ≠ 0 (SameBoy). En el núcleo, un cálculo congelado no
  obliga a la puesta al día a ir de ciclo M en ciclo M (test «NR10 = 00 durante el
  cálculo…» en tests/core/apu).
- **Ruido:** LFSR = 0 al disparar (lógica invertida: bit nuevo = NOT(b0 XOR b1)). La cuenta
  inicial depende de la alineación (`prepare_noise_start`) y escribir NR43 puede dar pasos
  espurios del LFSR al pasar por el valor intermedio `viejo & 7F | nuevo & 80`.
- `[VERIFICAR]` Fase del secuenciador y del generador en el estado sin boot ROM.
- No se modelan: las lecturas "buggy" de la RAM de onda con el canal parado pero aún
  disparado (necesitan el bus de direcciones de la CPU; en NR30 se aproxima con PC & F) y
  el retoque de SameBoy al escribir DIV durante el cálculo del barrido.

## 9. Doble velocidad

- KEY1 bit 0 = preparar; STOP efectúa el cambio; KEY1 bit 7 = velocidad actual.
- STOP con KEY1.0 = 1 pone a 0 el contador de DIV (con sus efectos de flanco, §5), borra
  KEY1.0 y detiene la CPU **32 767 ciclos M** (no ≈ 2 050: con 32 768 DIV sale un paso
  alto). Medido con AGE `speed-switch/spsw-div` y `spsw-mode0` (pasan); la PPU, el
  temporizador y la APU siguen corriendo durante la pausa.
- Reparto de esa pausa entre velocidades, ajustado con `spsw-mode0`/`spsw-tima-cgbE`
  `[VERIFICAR]`: al pasar a doble, los 2 primeros ciclos M aún van a velocidad normal;
  al volver a normal, el cambio es inmediato pero se pierde 1 punto suelto de la PPU.
- La CPU ya ha captado el byte siguiente a STOP antes de la pausa y lo ejecuta después
  (AGE `spsw-stop-prefetch`). El núcleo lo vuelve a leer tras la pausa, porque la
  captación está en `sm83.c`: falla (GBC-3).
- Tras pasar a doble velocidad el contador de longitud de la APU va retrasado 1 ciclo M
  respecto al de antes (alterna en cada cambio; AGE `spsw-ch2-lc-delay`). No está
  modelado (requiere estado en `apu.c`): falla (GBC-3).
- Afecta a CPU, temporizador, serie, OAM DMA; **no** a la PPU, HDMA (en tiempo) ni a la
  APU (salvo el bit de DIV que usa el secuenciador).

## 10. Cartuchos

### 10.1 Cabecera (0100–014F)
| Dir. | Campo |
|---|---|
| 0100–0103 | Entrada (normalmente `NOP; JP $0150`) |
| 0104–0133 | Logo (lo comprueba la boot ROM) |
| 0134–0142 | Título |
| 0143 | Bandera CGB: 80h compatible, C0h sólo CGB |
| 0144–0145 | Licencia nueva |
| 0146 | Bandera SGB |
| 0147 | Tipo de cartucho |
| 0148 | Tamaño ROM (32 KB << n) |
| 0149 | Tamaño RAM (0, —, 8 KB, 32 KB, 128 KB, 64 KB) |
| 014A | Destino |
| 014B | Licencia antigua (33h → usar la nueva) |
| 014C | Versión |
| 014D | Checksum de cabecera: `x = 0; for a in 0134..014C: x = x − rom[a] − 1` (8 bits) |
| 014E–014F | Checksum global (big endian, suma de todos los bytes salvo estos dos; nadie lo comprueba) |

### 10.2 Tipos soportados (0147)
00 ROM · 01–03 MBC1 (+RAM, +pila) · 05–06 MBC2 · 0F–13 MBC3 (0F/10 con RTC) · 19–1E MBC5
(1C–1E con rumble, ignorado). Otros → error claro al cargar.

### 10.3 MBCs (resumen; detalle en Pan Docs)
- **MBC1:** 0000–1FFF RAM on/off; 2000–3FFF banco ROM (5 bits, 0 → 1); 4000–5FFF 2 bits
  (banco RAM o bits altos de ROM); 6000–7FFF modo. Fuente: mooneye `emulator-only/mbc1`.
- **MBC2:** 512 × 4 bits de RAM interna; el bit 8 de la dirección elige RAM on/off o banco.
- **MBC3:** 7 bits de banco ROM (0 → 1), RAM 0–3 o registros RTC 08h–0Ch, latch con 00→01
  en 6000–7FFF. Las lecturas del RTC devuelven siempre la copia latcheada: lo escrito en
  un registro no se ve hasta el siguiente latch. Escribir los segundos reinicia el
  divisor de subsegundo. El RTC avanza con los ciclos emulados (1 s = 4 194 304 puntos,
  también en doble velocidad). Fuentes: Mealybug `mbc3_rtc` y `rtc3test` (pasan).
- **MBC5:** 9 bits de banco ROM (el 0 es válido), 4 bits de banco RAM.

### 10.4 `.sav`
RAM tal cual; con RTC, 48 bytes al final (registros actuales, registros latcheados y
marca de tiempo Unix de 64 bits) en el formato de BGB/VBA `[VERIFICAR M3]`.

## 11. Estado sin boot ROM

Registros tras la boot ROM del CGB con cartucho CGB: AF=1180h, BC=0000h, DE=FF56h,
HL=000Dh, SP=FFFEh, PC=0100h `[VERIFICAR M1: valores con cartucho DMG; contrastar con
mooneye boot_regs-cgb]`. Registros de E/S: tabla en §3 cuando M1 la complete (mooneye
`boot_hwio-C`). PPU (V1): LCDC = 91h, STAT con modo 1, BGP = FCh, OBP0 = OBP1 = FFh,
LY = 144 en el punto 0 (inicio del VBlank) en el instante del reset, con la IRQ de VBlank
ya pedida en IF. Así cada `gb_run_frame` (múltiplos de 70 224 puntos desde el reset)
acaba al empezar el VBlank `[VERIFICAR V1: fase real tras la boot ROM; mooneye
boot_div/boot_hwio]`. Paletas: §7.5.

Contador de DIV en el instante del reset: 1EA0h con cartucho CGB (DIV = 1Eh) y 2674h en
compatibilidad DMG (DIV = 26h). El primero lo fija mooneye `misc/boot_div-cgbABCDE`
(pasa); el segundo se derivó de la misma medición con la duración del arranque en modo
compatibilidad `[VERIFICAR]`. FF4F se lee FEh | VBK también en compatibilidad DMG. En
`misc/boot_hwio-C` sólo queda BCPS/OCPS, que deberían leerse C8h/D0h en compatibilidad;
eso está en `ppu.c` (GBC-5).
