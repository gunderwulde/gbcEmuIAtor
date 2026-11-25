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
  el siguiente opcode). `[VERIFICAR C1]` duración del despertar en CGB.
- **STOP**: 2 bytes (10 00). Con KEY1.0=1 cambia la velocidad (§9); si no, para la CPU y
  el LCD hasta que se pulse un botón `[VERIFICAR M1]` comportamiento exacto en CGB.

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
- Fuente: Pan Docs (CGB Registers), SameSuite.

## 7. PPU

### 7.1 Modos (por línea visible)

| Modo | Duración | Acceso CPU |
|---|---|---|
| 2 (búsqueda OAM) | 80 puntos | OAM no |
| 3 (dibujo) | 172–289 puntos, variable (§7.3) | VRAM, OAM y paletas no |
| 0 (HBlank) | resto hasta 456 | todo |
| 1 (VBlank) | líneas 144–153 | todo |

### 7.2 STAT y LY
- La IRQ de STAT es la OR de las fuentes habilitadas (LYC=LY, modo 0, 1, 2); sólo se
  dispara en el flanco de subida de esa OR ("STAT blocking").
- En la línea 153, LY lee 0 poco después de empezar la línea `[VERIFICAR V1: punto
  exacto en CGB]`.
- Al encender el LCD, la primera línea no tiene modo 2 y dura distinto `[VERIFICAR V1]`.

### 7.3 Longitud del modo 3
172 puntos base + SCX % 8 + 6 por activar la ventana + 6–11 por sprite según su X
respecto al tile de fondo `[VERIFICAR V1: fórmula exacta; contrastar con GBEDG y con el
modelo REF de PPU-02]`.

### 7.4 Fondo, ventana y sprites en CGB
- Atributos del mapa en VRAM banco 1: paleta (0–2), banco de tile (3), volteo X (5), Y
  (6), prioridad (7).
- LCDC.0 en CGB = "prioridad maestra": a 0, los sprites siempre encima.
- Sprites: hasta 10 por línea; en CGB, prioridad entre sprites por índice de OAM (OPRI=0)
  o por X como en DMG (OPRI=1). Atributo: paleta CGB (0–2), banco de tile (3).
- Ventana: contador de líneas interno que sólo avanza cuando la ventana se ha dibujado
  en esa línea.

### 7.5 Paletas
- 8 paletas de fondo y 8 de sprites, 4 colores RGB555 (2 bytes, little endian) = 64
  bytes cada grupo. BCPS/OCPS: índice (bits 0–5) y autoincremento (bit 7).
- En modo 3 las escrituras a BCPD/OCPD se ignoran y las lecturas dan FFh `[VERIFICAR V1:
  ¿avanza el índice?]`.
- Modo de compatibilidad (cartucho sin bandera CGB): BGP/OBP0/OBP1 indexan las paletas
  que la boot ROM cargó. Sin boot ROM usamos una paleta fija documentada aquí
  `[VERIFICAR V1: elegir y documentar]`.

### 7.6 Color en pantalla
- Sin corrección: canal de 5 bits → 8 bits (`c << 3 | c >> 2`).
- Con corrección (LCD del CGB, más apagado y con mezcla entre canales): curva a
  documentar con su fuente `[VERIFICAR V1]`. Los tests de captura (`HW`) se comparan sin
  corrección salvo que la suite diga lo contrario.

## 8. APU

- Canales: 1 pulso con barrido, 2 pulso, 3 onda (32 muestras de 4 bits), 4 ruido (LFSR de
  15/7 bits).
- Secuenciador de frame a 512 Hz, avanzado por el flanco descendente del bit 4 de DIV
  (bit 5 en doble velocidad): longitud a 256 Hz, barrido a 128 Hz, envolvente a 64 Hz.
- NR52 bit 7 = 0 apaga la APU y borra los registros (salvo la RAM de onda y, en CGB, los
  contadores de longitud `[VERIFICAR M2]`).
- PCM12/PCM34 (CGB): salida digital actual de cada canal (lo usa SameSuite).
- Fuente: Pan Docs (Audio), Blargg `cgb_sound`, SameSuite `apu/*`.

## 9. Doble velocidad

- KEY1 bit 0 = preparar; STOP efectúa el cambio; KEY1 bit 7 = velocidad actual.
- La pausa del cambio dura ≈ 2 050 ciclos M (8 200 puntos) `[VERIFICAR M1]`; DIV se
  pone a 0.
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
  en 6000–7FFF.
- **MBC5:** 9 bits de banco ROM (el 0 es válido), 4 bits de banco RAM.

### 10.4 `.sav`
RAM tal cual; con RTC, 48 bytes al final (registros actuales, registros latcheados y
marca de tiempo Unix de 64 bits) en el formato de BGB/VBA `[VERIFICAR M3]`.

## 11. Estado sin boot ROM

Registros tras la boot ROM del CGB con cartucho CGB: AF=1180h, BC=0000h, DE=FF56h,
HL=000Dh, SP=FFFEh, PC=0100h `[VERIFICAR M1: valores con cartucho DMG; contrastar con
mooneye boot_regs-cgb]`. Registros de E/S: tabla en §3 cuando M1 la complete (mooneye
`boot_hwio-C`). LCD encendido, en la línea y modo que deje la boot ROM `[VERIFICAR V1]`.
