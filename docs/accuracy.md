# Exactitud frente a las suites de la comunidad (C2)

Estado del núcleo frente a las ROMs de test públicas, una prueba de vitest por ROM.
`npm run test:acc` (= `vitest run tests/accuracy`) ejecuta todas. Los fallos conocidos se
ejecutan con `it.fails`, así que la suite está **verde pero es honesta**: si un fallo
conocido empieza a pasar, la suite se pone roja hasta que se quite de la lista.

- Lista única de fallos conocidos: [tests/accuracy/known-failures.ts](../tests/accuracy/known-failures.ts).
  Cada grupo apunta a un hallazgo de este documento (`PPU-1`, `APU-1`…).
- Catálogo y reglas de aplicabilidad: [tests/accuracy/catalog.ts](../tests/accuracy/catalog.ts).
- Runners (Blargg, mooneye y capturas): [tests/util/runners.ts](../tests/util/runners.ts).
  Las capturas que no coinciden se escriben en `build/test-out/<id>-{emu,ref,diff}.png`.

Última ejecución: núcleo tal como estaba al cerrar C2 (build `core-probe.wasm`).

## Fuentes

Todo lo descarga `npm run fetch` (`tools/fetch-tests.mjs`) con SHA-256 verificado:

| Suite | Origen | Versión |
|---|---|---|
| mooneye, SameSuite, Mealybug Tearoom, AGE, rtc3test, Blargg cgb_sound, acid2 | [c-sp/game-boy-test-roms](https://github.com/c-sp/game-boy-test-roms) | release v7.0, zip SHA-256 `b9a9d7a1075aa35a3d07c07c34974048672d8520dca9e07a50178f5860c3832c` |
| Blargg cpu_instrs, instr_timing, mem_timing, mem_timing-2, interrupt_time, halt_bug | retrio/gb-test-roms | commit `c240dd7d700e5c0b00a7bbba52b53e4ee67b5f15` (capturas de halt_bug e interrupt_time: del zip de c-sp) |

El zip se lee con un lector propio (sin dependencias); sólo se extraen los prefijos
listados en `fetch-tests.mjs`. Ningún fichero descargado se ejecuta fuera del emulador.

## Criterios de éxito

Según `game-boy-test-roms-howto.md` de cada suite (c-sp):

- **mooneye, SameSuite, AGE y Mealybug `dma/`/`mbc/`**: al ejecutar `LD B,B` (40h),
  B,C,D,E,H,L = 3,5,8,13,21,34 es éxito. mooneye y SameSuite ponen 42h en todos si
  fallan; AGE puede dejar cualquier otro valor, que también es fallo.
- **Mealybug `ppu/`**: captura en `LD B,B` frente a la de CPU CGB D. Si sólo hay de
  CGB C, se usa ésa. No hay capturas de CGB E, y se asume que E se comporta como D, igual
  que hace SameBoy [VERIFICAR].
- **AGE con captura**: captura en `LD B,B` frente a la imagen cuyo sufijo cubre CGB E (o
  `ncmE` = CGB E en modo de compatibilidad).
- **Blargg**:
  - `cpu_instrs`, `instr_timing`, `mem_timing*` y `cgb_sound/rom_singles/*`: texto por el
    puerto serie o en A000h (firma DE B0 61).
  - `halt_bug` e `interrupt_time` sólo informan en pantalla. Se capturan a tiempo fijo
    (3 s emulados; el howto pide 2 s) y se comparan con la referencia de c-sp.
- **rtc3test**:
  - Las tres pantallas se seleccionan con pulsaciones de 0,1 s tras 1 s de menú.
  - Se capturan a tiempo fijo (13 s, 8 s y 26 s, con margen).
  - Se comparan con `rtc3test-*-cgb.png`.
- Colores del modo de compatibilidad para las capturas: los del howto (fondo
  `#000000 #0063C6 #7BFF31 #FFFFFF`, objetos `#000000 #943939 #FF8484 #FFFFFF`). El
  núcleo usa esa misma paleta en `ppu.c` (`compat_bg`/`compat_obj`) y la conversión RGB555
  → RGB888 `(x << 3) | (x >> 2)` sin corrección de color.
- Las capturas son exactas, píxel a píxel.

## Reglas de aplicabilidad (n.a.)

El modelo emulado es el CGB con CPU CGB-E (AGENTS.md §1). Un test no aplica si:

- **mooneye**: el sufijo no cubre CGB E. Sin sufijo, `C`, `cgb` o `cgbABCDE` aplican;
  `G`/`S`/`A`/`dmg*`/`mgb`/`sgb*`/`cgb0` no aplican (README de mooneye, «Test naming»).
  `manual-only/`, `madness/` y `utils/` no son automáticos. `multicart_*` es MBC1M,
  fuera de alcance.
- **SameSuite**: el sufijo de revisión no incluye E (`-cgb0B`, `-A`, `-cgbB`…). `sgb/`
  está fuera de alcance.
- **AGE**:
  - Ningún token del nombre cubre CGB E, por ejemplo `-cgbBC` o `-dmgC`.
  - La ROM está en `speed-switch/caution/`: la propia suite avisa de que puede dañar el
    hardware.
  - Las ROMs de captura sin imagen para CGB E tampoco aplican.
- **Mealybug `ppu/`**: no hay captura de CGB (C ni D).

## Resumen

| Suite | Pasa | Falla (conocido) | n.a. |
|---|---|---|---|
| Blargg | 18 | 0 | 0 |
| mooneye | 79 | 6 | 30 |
| SameSuite | 69 | 0 | 9 |
| Mealybug Tearoom | 3 | 27 | 5 |
| AGE | 17 | 17 | 13 |
| rtc3test | 3 | 0 | 0 |
| **Total** | **189** | **50** | **57** |

Fuera de `tests/accuracy`:

- `cgb-acid2` y `dmg-acid2` (en modo de compatibilidad del CGB) **pasan**:
  `tests/core/ppu/acid2.test.ts`, 2/2.
- SingleStepTests/sm83 y cpu_instrs/instr_timing por bus plano se ejecutan en
  `tests/core` (`npm run test:cpu`).

La CPU (`sm83.c`) no tiene ningún fallo: pasan todas las pruebas de temporización de
instrucciones de mooneye, Blargg `cpu_instrs`/`instr_timing`/`mem_timing*`/`halt_bug`/
`interrupt_time`, `ei_delay_halt` y los dos `halt` de AGE.

## Hallazgos por fichero del núcleo

Ordenados por impacto (número de tests que explican). Las líneas son las de `core/src`
al cerrar C2. Son hipótesis para el dueño de cada fichero: C2 no toca `core/`.

**Estado tras la tanda de correcciones de la fase 2 (X-PPU, X-APU, X-GBC):** resueltos
PPU-3, APU-1, APU-2, APU-3, GBC-2, GBC-4, CART-1 y parte de GBC-3 y GBC-5. Siguen
abiertos PPU-1 (33), PPU-2 (12), PPU-4 (1), GBC-1 (1), GBC-3 (2) y GBC-5 (1); la lista
viva es `tests/accuracy/known-failures.ts`. La línea de tiempo de la PPU ya sigue a
SameBoy (docs/gbc-hardware.md §7.1–7.8); lo que queda de PPU-2 apunta al muestreo de
IRQ de la CPU (sin confirmar). El texto de abajo describe el estado al cerrar C2.

### ppu.c

**PPU-1: no hay FIFO de píxeles; las penalizaciones del modo 3 se cargan al principio de la línea**

- **Explica 33 tests**: 26 Mealybug `ppu/m3_*` y 7 AGE `m3-bg-*`.
- **Dónde**:
  - `mode3_length` (ppu.c:179-211) calcula de una vez, en el punto 80, la longitud del
    modo 3: SCX%8, ventana y sprites.
  - `render_to` (ppu.c:325-330) emite el píxel *x* en el punto 80 + (m3len − 160) + x.
    Es decir, todas las penalizaciones se pagan antes del primer píxel.
  - `render_span` (ppu.c:225-323) lee LCDC/BGP/SCX/SCY/WX en el momento de emitir.
- **Comportamiento del hardware**: el fetcher de fondo trabaja en tiles de 8 píxeles (6
  puntos por fetch y 2 de espera) y los sprites lo paran en el píxel en que aparecen.
  Por eso un cambio de registro a mitad del modo 3 afecta a:
  - el tile que se está fetcheando: LCDC.3/4/6, SCY, SCX[7:3] se leen en pasos
    concretos del fetch;
  - el píxel que sale de la FIFO en ese punto: BGP, OBP.
  
  Fuentes: Pan Docs «Pixel FIFO», los README de Mealybug y la implementación de SameBoy
  (`display.c`, `render_pixel_if_possible`/fetcher).
- **Síntoma**: en `m3_bgp_change` el cambio de BGP cae unos 6-8 píxeles antes o
  después que en la referencia, y la discrepancia crece con los sprites
  (`m3_bgp_change_sprites`). En `m3_scx_*`, `m3_scy_*` y `m3_lcdc_*` aparecen tiles
  enteros mal elegidos, porque el registro se muestrea por píxel y no por fetch.
- **Hipótesis**: hace falta modelar el fetcher, con sus pasos y el momento en que lee
  cada registro, y la FIFO, con el desplazamiento de SCX%8 y las paradas de los sprites.
  O, como mínimo, distribuir las penalizaciones en el punto en que ocurren y muestrear
  los registros del fondo por tile. Es el cambio más grande pendiente en la PPU.

**PPU-2: temporización de los modos de STAT, de la IRQ de modo 2 y de LY**

- **Explica 18 tests**:
  - mooneye `intr_2_mode0_timing`, `intr_2_mode0_timing_sprites`,
    `intr_2_mode3_timing` y `intr_2_oam_ok_timing`;
  - AGE `stat-mode*` (8), `stat-int` (2), `ly` (2), `lcd-align-ly-cgbE` y
    `halt-m0-interrupt`.
- **Dónde**:
  - `new_line` (ppu.c:347-369) pone el modo 2 y LY en el punto 0.
  - `at_boundary` (ppu.c:371-396) pone el modo 3 exactamente en el punto 80 y el modo 0
    en 80 + m3len.
  - `next_boundary` (ppu.c:336-345).
- **Comportamiento del hardware**:
  - En CGB, el cambio de LY, el flag de modo leído en STAT y la petición de IRQ no
    coinciden en el mismo punto: hay desfases de unos 4 puntos (1 ciclo M) entre el
    modo visible en STAT y la IRQ.
  - En doble velocidad, la lectura se hace a mitad de ciclo M.
  - En la línea 0 tras encender el LCD la temporización es distinta.

  Fuentes: el código de mooneye (`intr_2_*`: mide en ciclos M desde la IRQ de modo 2
  hasta el cambio a modo 0/3), las notas de AGE, y SameBoy, que adelanta LY y el modo 2
  en CGB (`display.c`, estados de la línea).
- **Síntoma**: `intr_2_0_timing` pasa, pero los que miden hasta el modo 3/0 desde la IRQ
  de modo 2 fallan. Las fronteras están desplazadas un ciclo M respecto a la IRQ.
- **Hipótesis**:
  - Separar «IRQ de modo 2» (punto 0 de la línea, o −4 en CGB) de «STAT lee modo 2/3».
  - Añadir el retardo de ≈4 puntos entre el fin del modo 3 y la lectura de modo 0.
  - Al calcular `m3len`, verificar que el retardo de la ventana y los sprites cuadra con
    `intr_2_mode0_timing_sprites` (tabla de su fuente).
  
  [VERIFICAR] los valores exactos frente al código de mooneye/AGE antes de tocar nada.

**PPU-3: ventanas de bloqueo de VRAM y OAM** — *resuelto*

- **Explica 6 tests**: AGE `oam-read-cgbE/ncmE`, `oam-write-cgbBCE/ncmBCE` y
  `vram-read-cgbBCE/ncmBCE`.
- **Dónde**: `ppu_vram_blocked` y `ppu_oam_blocked` (ppu.c:564-565) bloquean
  exactamente cuando `P.mode` es 3 (o 2/3).
- **Comportamiento del hardware**: el bloqueo de OAM empieza y acaba unos puntos antes
  que el modo visible en STAT. La escritura en OAM se bloquea en momentos distintos que
  la lectura, y la VRAM se libera antes del fin del modo 3. Fuentes: los nombres y
  comentarios de AGE (`oam-read`, `oam-write` y `vram-read` miden lectura y escritura por
  separado) y SameBoy (`oam_read_blocked`/`oam_write_blocked`/`vram_read_blocked`, con
  sus propios puntos de transición).
- **Hipótesis**: el bloqueo necesita sus propias fronteras, distintas de las del modo de
  STAT, y separadas para lectura y escritura de OAM. Depende de PPU-2: conviene
  arreglarlas juntas.

**PPU-4: encendido del LCD, flag LYC y fuente de modo 2 en VBlank**

- **Explica 2 tests**: mooneye `stat_lyc_onoff` y `misc/ppu/vblank_stat_intr-C`.
- **Dónde**:
  - `lcd_on` (ppu.c:457-472) y `lcd_off` (ppu.c:474-483). Al apagar, el flag de
    coincidencia LYC debe congelarse; al encender, la comparación LY=LYC de la línea 0
    debe hacerse con el retardo de la primera línea.
  - `stat_update` (ppu.c:118-136): al entrar en VBlank (línea 144) se activa la fuente de
    modo 2, marcado [VERIFICAR V1].
- **Comportamiento del hardware**:
  - mooneye `stat_lyc_onoff`: el bit 2 de STAT conserva su último valor con el LCD
    apagado, y al encender no se recalcula hasta el primer punto de la línea 0.
  - `vblank_stat_intr-C`: en CGB la IRQ de modo 2 de la línea 144 llega en un momento
    concreto respecto a la de VBlank. El test falla, así que la duración o el instante
    del pulso de la línea 136 no son los del CGB.
- **Hipótesis**: guardar el flag LYC en `P` en vez de recalcularlo en cada lectura con el
  LCD apagado. Revisar el pulso de modo 2 de la línea 144 con el código de
  `vblank_stat_intr` [VERIFICAR].

### apu.c

**APU-1: sin retardos de disparo ni alineación con el reloj de la APU** — *resuelto*

- **Explica 46 tests**: SameSuite `channel_1/2/3/4` (45) y Blargg
  `cgb_sound/09-wave read while on`.
- **Dónde**:
  - `write_nrx4` (apu.c:272-315). El disparo carga `timer = (2048 − f) × 4` (pulso) o
    `× 2` (onda) en el mismo punto de la escritura, sin retardo. El ruido carga
    `noise_period()` y LFSR = 7FFF.
  - `run` (apu.c:143-188) cuenta en puntos sin alinear con el reloj de 1/2 MHz de la APU.
  - La lectura de la wave RAM con el canal activo (apu.c:389) y la escritura (apu.c:338)
    devuelven o tocan el byte `pos >> 1` sin la ventana de acceso.
  - PCM12/PCM34 (apu.c:385-386) devuelven la salida del canal tal como la da ese modelo.
- **Comportamiento del hardware**:
  - Tras el disparo, el primer paso de un canal de pulso llega con un retardo extra.
    SameBoy carga `sample_countdown` con el periodo más 6 ciclos de 2 MHz, menos la fase
    del reloj de 1 MHz (`lf_div`).
  - El canal de onda tarda 3 ciclos de 2 MHz más y no refresca el búfer de la muestra
    hasta el primer paso: `channel_3_first_sample`, `*_delay`.
  - El ruido también tiene su retardo de disparo, y su divisor cuenta desde un reloj
    común, no desde la escritura: `channel_4_align`, `frequency_alignment`.
  - Los SameSuite APU observan todo esto leyendo PCM12/PCM34 en ciclos concretos (README
    de SameSuite: CGB-E pasa todos).
  - Blargg 09 lee la wave RAM justo cuando el canal lee un byte: es el mismo retardo de
    3 ciclos.
- **Hipótesis**:
  - Llevar un contador de fase del reloj de 2 MHz común a los cuatro canales.
  - En el disparo, cargar los temporizadores con el retardo de SameBoy (+6 en pulso, +3
    en onda, en ciclos de 2 MHz, ajustados por la fase).
  - Que el ruido cuente desde ese reloj común.
  - Es el cambio que más tests arregla por línea de código.

  [VERIFICAR] las constantes contra las ROMs de SameSuite antes de fijarlas.

**APU-2: falta el modo zombi de NRx2** — *resuelto*

- **Explica 6 tests**: SameSuite `channel_1/2_nrx2_glitch`, `_nrx2_speed_change` y
  `_restart_nrx2_glitch`.
- **Dónde**: las escrituras en NR12/NR22/NR42 (apu.c:360-362) sólo actualizan el DAC.
- **Comportamiento del hardware**: escribir NRx2 con el canal activo altera el volumen
  actual según el valor viejo y el nuevo («zombie mode»: +1 si el periodo viejo era 0 y
  el modo no ha terminado, +2 si cambia la dirección…). La regla exacta del CGB-E está
  documentada en Pan Docs, «Obscure behavior», y en SameBoy (`nrx2_glitch`), que
  distingue revisiones.
- **Hipótesis**: implementar `nrx2_glitch` de SameBoy para revisión E. Depende también de
  APU-1, porque estos tests leen PCM en ciclos concretos.

**APU-3: fase del secuenciador de frame tras escribir DIV con el bit 10 a 1** — *resuelto*

- **Explica 3 tests**: SameSuite `div_trigger_volume_10`, `div_write_trigger_10` y
  `div_write_trigger_volume_10`. Las variantes sin `_10` pasan.
- **Dónde**: la escritura en DIV (gbc.c:241-247) llama a `apu_edge(old, 0)`, que sólo
  genera un paso si el bit 12 (o 13) estaba a 1. `apu_div_event` está en apu.c:250-265.
- **Comportamiento del hardware**: según el README de SameSuite, el DMG también pasa
  `div_write_trigger_10`, así que no depende de PCM. Con el bit 10 de DIV a 1 al
  escribirlo, el secuenciador se comporta como si saltara medio paso. En SameBoy, el
  contador de la APU se alimenta del bit 10 (`apu.div_divider` con «skip» en la
  escritura de DIV).
- **Hipótesis**: falta modelar el flanco o la fase intermedia del bit 10 al poner DIV a
  0. [VERIFICAR] con la fuente de `div_write_trigger_10.asm`.

### gbc.c

**GBC-3: cambio de velocidad (STOP con KEY1)**

- **Explica 5 tests**: AGE `spsw-ch2-lc-delay`, `spsw-div`, `spsw-mode0`,
  `spsw-stop-prefetch` y `spsw-tima-cgbE`.
- **Dónde**: `bus_stop` (gbc.c:405-413) pone DIV a 0, cambia la velocidad y espera 2050
  ciclos M en la velocidad nueva, todo marcado [VERIFICAR M1].
- **Comportamiento del hardware**:
  - La pausa del cambio de velocidad dura 2050 ciclos M en la velocidad **vieja** según
    unas fuentes y 32768 puntos según otras.
  - Durante ella DIV no avanza; la PPU sí, y se observa su modo (`spsw-mode0`).
  - La CPU ya ha leído el byte siguiente a STOP (`spsw-stop-prefetch`).
  - El canal 2 de la APU sufre el retardo del contador de longitud (`spsw-ch2-lc-delay`).

  Fuentes: Pan Docs «CGB Registers / KEY1» y SameBoy (`GB_STOP`/`speed_switch_countdown`).
- **Hipótesis**: revisar el número de ciclos y en qué velocidad se cuentan, si DIV se
  congela durante la pausa y el prefetch del byte de después de STOP. [VERIFICAR] con
  los comentarios de las ROMs AGE `spsw-*`.

**GBC-1: HDMA iniciada en modo 0 o con el LCD apagado**

- **Explica 3 tests**: SameSuite `hdma_lcd_off` y `hdma_mode0`, y Mealybug
  `dma/hdma_timing-C`.
- **Dónde**:
  - FF55 (gbc.c:276-292): al arrancar la HDMA sólo se activa `hdma_active` (línea 284).
  - El primer bloque se copia cuando `machine_events` (gbc.c:53) ve el siguiente flanco
    de HBlank.
  - `step_once` (gbc.c:490-498) la copia antes de la instrucción siguiente.
- **Comportamiento del hardware**: si la HDMA se arranca estando ya en modo 0, o con el
  LCD apagado (el modo es 0), se copia un bloque de inmediato. SameBoy activa
  `hdma_on` en la propia escritura de FF55 si `STAT & 3 == 0`; Pan Docs, «HDMA5»: «if
  the LCD is off… one block is transferred». `hdma_timing-C` mide además en qué ciclo M
  del HBlank empieza la copia.
- **Hipótesis**: en la escritura de FF55 con bit 7, si el LCD está apagado o
  `P.mode == 0` (sin haber entrado ya en HBlank en esta línea), poner
  `hdma_pending = 1`. Revisar el retardo entre el inicio del modo 0 y la copia para
  `hdma_timing-C` [VERIFICAR].

**GBC-2: máscara de la dirección de origen de GDMA/HDMA** — *resuelto*

- **Explica 1 test**: SameSuite `gdma_addr_mask`.
- **Dónde**: `dma_source_read` (gbc.c:158-169) lee VRAM para 8000-9FFF y WRAM (eco) para
  E000-FFFF. La usan `hdma_copy_block` (gbc.c:207-217) y la OAM DMA.
- **Comportamiento del hardware**: para HDMA/GDMA (no para la OAM DMA), un origen en
  8000-9FFF o E000-FFFF lee FFh. SameBoy (`hdma` en `memory.c`) devuelve 0xFF en esos
  rangos. La máscara de FF51-FF54 ya está bien.
- **Hipótesis**: una lectura de origen propia para HDMA que devuelva FFh en esos rangos.
  La de la OAM DMA no cambia: `oam_dma/sources` pasa en su variante aplicable.

**GBC-4: glitch de TAC (`rapid_toggle`)** — *resuelto*

- **Explica 1 test**: mooneye `acceptance/timer/rapid_toggle`.
- **Dónde**: la escritura en TAC (gbc.c:257-262) hace
  `timer_bit(div, old) && !timer_bit(div, new)` → `tima_inc()`. El incremento se aplica
  en el acto, sin pasar por el ciclo M en que el desbordamiento recarga TIMA (estados
  de `timer_mcycle`, gbc.c:83-93).
- **Comportamiento del hardware**: el multiplexor de TAC y el AND con el bit de
  habilitación forman una única señal. Un flanco de bajada producido por la escritura
  incrementa TIMA igual que uno normal, y si desborda pasa por el mismo retardo de
  recarga de un ciclo M (mooneye, comentarios de `rapid_toggle.s`; Pan Docs «Timer
  obscure behaviour»).
- **Hipótesis**: el incremento por la escritura de TAC (y de DIV, gbc.c:243) debe poner
  `tima_state = 1` si desborda, igual que el camino normal. Hay que comprobar que
  `tima_inc` lo hace y que la escritura se observa en el ciclo M correcto, no uno antes.

**GBC-5: estado tras el arranque sin boot ROM**

- **Explica 2 tests**: mooneye `misc/boot_div-cgbABCDE` y `misc/boot_hwio-C`.
- **Dónde**: `post_boot_state` (gbc.c:421-439): `gb.div = 0x1EA0` [VERIFICAR M1]. El
  resto de registros de E/S quedan con el valor de `ppu_reset`/`apu_reset`.
- **Comportamiento del hardware**:
  - `boot_div-cgbABCDE` mide la fase exacta de DIV (16 bits) al llegar a 0100h.
  - `boot_hwio-C` comprueba los valores leídos de FF00-FF7F tras la boot ROM del CGB,
    con la máscara de bits no usados.

  Fuente: el propio test (tabla en `boot_hwio-C.s`) y SameBoy con su boot ROM libre.
- **Hipótesis**:
  - Ajustar DIV a la fase que espera el test (el contador completo, no sólo FF04).
  - Revisar uno a uno los registros de la tabla de `boot_hwio-C` (FF26, FF41, FF4D,
    FF55, FF6C, FF70, FF72-FF77…).

  `boot_regs-cgb` y `unused_hwio-C` ya pasan.

### cart.c

**CART-1: fase del divisor de sub-segundo del RTC del MBC3** — *resuelto*

- **Explica 1 test**: Mealybug `mbc/mbc3_rtc`.
- **Dónde**:
  - La escritura de registros RTC (cart.c:216-227) pone `C.rtc.sub = 0` al escribir los
    segundos (línea 223) y copia el valor en `latched` (línea 224).
  - `rtc_catch_up` (cart.c:94-104).
  - El latch (cart.c:253-259).
- **Observación** (traza de bus con `core-probe`): el test escribe segundos = 59 y
  minutos = 0, espera y relee.
  - En la primera ronda espera 4 194 924 puntos, ve el paso de minuto y lo lee bien.
  - En la segunda espera 4 193 900 puntos (404 puntos **menos** de 1 s). El emulador
    aún no ha pasado el minuto y devuelve 59 s.
  - Las rondas con DH.6 (parada) tienen márgenes parecidos, de ±500 puntos.

  El test sondea, pues, en qué instante exacto pasa el segundo tras escribir los
  segundos o parar el reloj.
- **Hipótesis**: el divisor de 32 768 Hz del MBC3 real no se reinicia, o no se reinicia
  igual, al escribir los segundos. O conserva la fase al parar y reanudar con DH.6, y el
  paso llega antes de 1 s exacto después de la escritura. `rtc3test/sub-second-writes`
  pasa con el modelo actual, así que la regla ha de cumplir ambos tests. [VERIFICAR] con
  la fuente de `mbc3_rtc` y la documentación de rtc3test.
- Las lecturas de los bits no usados (DH = C1h tras escribir FFh, horas 1Fh, minutos y
  segundos 3Fh) y el desbordamiento de días (DH.7) ya coinciden.

### sm83.c

Sin hallazgos: ningún test aplicable falla por la CPU.

## Notas para los runners

- `tests/util/png-read.ts` es una copia ampliada de `tests/core/ppu/png.ts`: admite gris
  de 1/2/4 bits, el formato de las capturas de Mealybug. `png.ts` podría sustituirse por
  ella (pertenece a otro flujo, así que no se ha tocado).
- `runUntilLdBB` avanza en tramos de una línea (456 puntos). «En `LD B,B`» significa
  «como mucho una línea después», suficiente para los registros y para la captura,
  porque las ROMs de captura esperan en bucle tras `LD B,B`.
- Cada ROM usa una instancia nueva de `core-probe.wasm`.

## Tabla completa

Los nombres son relativos a la carpeta de la suite. «Falla» es un fallo conocido
(`it.fails`) y la columna da el hallazgo que lo explica.

### AGE

| Test | Resultado | Motivo / hallazgo |
|---|---|---|
| `halt/ei-halt-dmgC-cgbBCE` | pasa |  |
| `halt/halt-m0-interrupt-dmgC-cgbBCE` | pasa |  |
| `halt/halt-prefetch-dmgC-cgbBCE` | pasa |  |
| `lcd-align-ly/lcd-align-ly-cgbBC` | n.a. | otro modelo/revisión (sufijo AGE) |
| `lcd-align-ly/lcd-align-ly-cgbE` | falla | PPU-2 |
| `ly/ly-cgbE` | pasa |  |
| `ly/ly-dmgC-cgbBC` | n.a. | otro modelo/revisión (sufijo AGE) |
| `ly/ly-ncmBC` | n.a. | otro modelo/revisión (sufijo AGE) |
| `ly/ly-ncmE` | pasa |  |
| `m3-bg-bgp/m3-bg-bgp` | falla | PPU-1 |
| `m3-bg-lcdc/m3-bg-lcdc` | falla | PPU-1 |
| `m3-bg-lcdc/m3-bg-lcdc-ds` | falla | PPU-1 |
| `m3-bg-lcdc/m3-bg-lcdc-nocgb` | falla | PPU-1 |
| `m3-bg-scx/m3-bg-scx` | falla | PPU-1 |
| `m3-bg-scx/m3-bg-scx-ds` | falla | PPU-1 |
| `m3-bg-scx/m3-bg-scx-nocgb` | falla | PPU-1 |
| `oam/oam-read-cgbE` | pasa |  |
| `oam/oam-read-dmgC-cgbBC` | n.a. | otro modelo/revisión (sufijo AGE) |
| `oam/oam-read-ncmBC` | n.a. | otro modelo/revisión (sufijo AGE) |
| `oam/oam-read-ncmE` | pasa |  |
| `oam/oam-write-cgbBCE` | pasa |  |
| `oam/oam-write-dmgC` | n.a. | otro modelo/revisión (sufijo AGE) |
| `oam/oam-write-ncmBCE` | pasa |  |
| `speed-switch/caution/spsw-interrupts-cgbBC` | n.a. | la suite advierte que puede dañar el hardware |
| `speed-switch/caution/spsw-interrupts-cgbE` | n.a. | la suite advierte que puede dañar el hardware |
| `speed-switch/spsw-ch2-lc-delay-cgbBCE` | falla | GBC-3 |
| `speed-switch/spsw-div-cgbBCE` | pasa |  |
| `speed-switch/spsw-mode0-cgbBCE` | pasa |  |
| `speed-switch/spsw-stop-prefetch-cgbBCE` | falla | GBC-3 |
| `speed-switch/spsw-tima-cgbBC` | n.a. | otro modelo/revisión (sufijo AGE) |
| `speed-switch/spsw-tima-cgbE` | pasa |  |
| `stat-interrupt/stat-int-dmgC-cgbBCE` | falla | PPU-2 |
| `stat-interrupt/stat-int-ncmBCE` | falla | PPU-2 |
| `stat-mode-sprites/stat-mode-sprites-dmgC-cgbBCE` | falla | PPU-2 |
| `stat-mode-sprites/stat-mode-sprites-ds-cgbBCE` | falla | PPU-2 |
| `stat-mode-window/stat-mode-window-cgbBCE` | falla | PPU-2 |
| `stat-mode-window/stat-mode-window-dmgC` | n.a. | otro modelo/revisión (sufijo AGE) |
| `stat-mode-window/stat-mode-window-ds-cgbBCE` | falla | PPU-2 |
| `stat-mode-window/stat-mode-window-ncmBCE` | falla | PPU-2 |
| `stat-mode/stat-mode-cgbE` | pasa |  |
| `stat-mode/stat-mode-dmgC-cgbBC` | n.a. | otro modelo/revisión (sufijo AGE) |
| `stat-mode/stat-mode-ds-cgbBCE` | pasa |  |
| `stat-mode/stat-mode-ncmBC` | n.a. | otro modelo/revisión (sufijo AGE) |
| `stat-mode/stat-mode-ncmE` | pasa |  |
| `vram/vram-read-cgbBCE` | pasa |  |
| `vram/vram-read-dmgC` | n.a. | otro modelo/revisión (sufijo AGE) |
| `vram/vram-read-ncmBCE` | pasa |  |

### Blargg

| Test | Resultado | Motivo / hallazgo |
|---|---|---|
| `cgb_sound/rom_singles/01-registers` | pasa |  |
| `cgb_sound/rom_singles/02-len ctr` | pasa |  |
| `cgb_sound/rom_singles/03-trigger` | pasa |  |
| `cgb_sound/rom_singles/04-sweep` | pasa |  |
| `cgb_sound/rom_singles/05-sweep details` | pasa |  |
| `cgb_sound/rom_singles/06-overflow on trigger` | pasa |  |
| `cgb_sound/rom_singles/07-len sweep period sync` | pasa |  |
| `cgb_sound/rom_singles/08-len ctr during power` | pasa |  |
| `cgb_sound/rom_singles/09-wave read while on` | pasa |  |
| `cgb_sound/rom_singles/10-wave trigger while on` | pasa |  |
| `cgb_sound/rom_singles/11-regs after power` | pasa |  |
| `cgb_sound/rom_singles/12-wave` | pasa |  |
| `cpu_instrs/cpu_instrs` | pasa |  |
| `halt_bug` | pasa | captura |
| `instr_timing/instr_timing` | pasa |  |
| `interrupt_time/interrupt_time` | pasa | captura |
| `mem_timing-2/mem_timing` | pasa |  |
| `mem_timing/mem_timing` | pasa |  |

### Mealybug Tearoom

| Test | Resultado | Motivo / hallazgo |
|---|---|---|
| `dma/hdma_during_halt-C` | pasa |  |
| `dma/hdma_timing-C` | falla | GBC-1 |
| `mbc/mbc3_rtc` | pasa |  |
| `ppu/m2_win_en_toggle` | pasa |  |
| `ppu/m3_bgp_change` | falla | PPU-1 |
| `ppu/m3_bgp_change_sprites` | falla | PPU-1 |
| `ppu/m3_lcdc_bg_en_change` | falla | PPU-1 |
| `ppu/m3_lcdc_bg_en_change2` | falla | PPU-1 (referencia CGB C) |
| `ppu/m3_lcdc_bg_map_change` | falla | PPU-1 |
| `ppu/m3_lcdc_bg_map_change2` | falla | PPU-1 (referencia CGB C) |
| `ppu/m3_lcdc_obj_en_change` | falla | PPU-1 |
| `ppu/m3_lcdc_obj_en_change_variant` | falla | PPU-1 |
| `ppu/m3_lcdc_obj_size_change` | falla | PPU-1 |
| `ppu/m3_lcdc_obj_size_change_scx` | falla | PPU-1 |
| `ppu/m3_lcdc_tile_sel_change` | falla | PPU-1 |
| `ppu/m3_lcdc_tile_sel_change2` | falla | PPU-1 (referencia CGB C) |
| `ppu/m3_lcdc_tile_sel_win_change` | falla | PPU-1 |
| `ppu/m3_lcdc_tile_sel_win_change2` | falla | PPU-1 (referencia CGB C) |
| `ppu/m3_lcdc_win_en_change_multiple` | falla | PPU-1 |
| `ppu/m3_lcdc_win_en_change_multiple_wx` | n.a. | sin captura de referencia de CGB |
| `ppu/m3_lcdc_win_map_change` | falla | PPU-1 |
| `ppu/m3_lcdc_win_map_change2` | falla | PPU-1 (referencia CGB C) |
| `ppu/m3_obp0_change` | falla | PPU-1 |
| `ppu/m3_scx_high_5_bits` | falla | PPU-1 |
| `ppu/m3_scx_high_5_bits_change2` | falla | PPU-1 (referencia CGB C) |
| `ppu/m3_scx_low_3_bits` | falla | PPU-1 |
| `ppu/m3_scy_change` | falla | PPU-1 |
| `ppu/m3_scy_change2` | falla | PPU-1 (referencia CGB C) |
| `ppu/m3_window_timing` | falla | PPU-1 |
| `ppu/m3_window_timing_wx_0` | falla | PPU-1 |
| `ppu/m3_wx_4_change` | n.a. | sin captura de referencia de CGB |
| `ppu/m3_wx_4_change_sprites` | falla | PPU-1 |
| `ppu/m3_wx_5_change` | n.a. | sin captura de referencia de CGB |
| `ppu/m3_wx_6_change` | n.a. | sin captura de referencia de CGB |
| `ppu/win_without_bg` | n.a. | sin captura de referencia de CGB |

### mooneye

| Test | Resultado | Motivo / hallazgo |
|---|---|---|
| `acceptance/add_sp_e_timing` | pasa |  |
| `acceptance/bits/mem_oam` | pasa |  |
| `acceptance/bits/reg_f` | pasa |  |
| `acceptance/bits/unused_hwio-GS` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/boot_div-dmg0` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/boot_div-dmgABCmgb` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/boot_div-S` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/boot_div2-S` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/boot_hwio-dmg0` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/boot_hwio-dmgABCmgb` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/boot_hwio-S` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/boot_regs-dmg0` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/boot_regs-dmgABC` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/boot_regs-mgb` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/boot_regs-sgb` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/boot_regs-sgb2` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/call_cc_timing` | pasa |  |
| `acceptance/call_cc_timing2` | pasa |  |
| `acceptance/call_timing` | pasa |  |
| `acceptance/call_timing2` | pasa |  |
| `acceptance/di_timing-GS` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/div_timing` | pasa |  |
| `acceptance/ei_sequence` | pasa |  |
| `acceptance/ei_timing` | pasa |  |
| `acceptance/halt_ime0_ei` | pasa |  |
| `acceptance/halt_ime0_nointr_timing` | pasa |  |
| `acceptance/halt_ime1_timing` | pasa |  |
| `acceptance/halt_ime1_timing2-GS` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/if_ie_registers` | pasa |  |
| `acceptance/instr/daa` | pasa |  |
| `acceptance/interrupts/ie_push` | pasa |  |
| `acceptance/intr_timing` | pasa |  |
| `acceptance/jp_cc_timing` | pasa |  |
| `acceptance/jp_timing` | pasa |  |
| `acceptance/ld_hl_sp_e_timing` | pasa |  |
| `acceptance/oam_dma_restart` | pasa |  |
| `acceptance/oam_dma_start` | pasa |  |
| `acceptance/oam_dma_timing` | pasa |  |
| `acceptance/oam_dma/basic` | pasa |  |
| `acceptance/oam_dma/reg_read` | pasa |  |
| `acceptance/oam_dma/sources-GS` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/pop_timing` | pasa |  |
| `acceptance/ppu/hblank_ly_scx_timing-GS` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/ppu/intr_1_2_timing-GS` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/ppu/intr_2_0_timing` | pasa |  |
| `acceptance/ppu/intr_2_mode0_timing` | falla | PPU-2 |
| `acceptance/ppu/intr_2_mode0_timing_sprites` | falla | PPU-2 |
| `acceptance/ppu/intr_2_mode3_timing` | falla | PPU-2 |
| `acceptance/ppu/intr_2_oam_ok_timing` | falla | PPU-2 |
| `acceptance/ppu/lcdon_timing-GS` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/ppu/lcdon_write_timing-GS` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/ppu/stat_irq_blocking` | pasa |  |
| `acceptance/ppu/stat_lyc_onoff` | pasa |  |
| `acceptance/ppu/vblank_stat_intr-GS` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/push_timing` | pasa |  |
| `acceptance/rapid_di_ei` | pasa |  |
| `acceptance/ret_cc_timing` | pasa |  |
| `acceptance/ret_timing` | pasa |  |
| `acceptance/reti_intr_timing` | pasa |  |
| `acceptance/reti_timing` | pasa |  |
| `acceptance/rst_timing` | pasa |  |
| `acceptance/serial/boot_sclk_align-dmgABCmgb` | n.a. | otro modelo (sufijo de mooneye) |
| `acceptance/timer/div_write` | pasa |  |
| `acceptance/timer/rapid_toggle` | pasa |  |
| `acceptance/timer/tim00` | pasa |  |
| `acceptance/timer/tim00_div_trigger` | pasa |  |
| `acceptance/timer/tim01` | pasa |  |
| `acceptance/timer/tim01_div_trigger` | pasa |  |
| `acceptance/timer/tim10` | pasa |  |
| `acceptance/timer/tim10_div_trigger` | pasa |  |
| `acceptance/timer/tim11` | pasa |  |
| `acceptance/timer/tim11_div_trigger` | pasa |  |
| `acceptance/timer/tima_reload` | pasa |  |
| `acceptance/timer/tima_write_reloading` | pasa |  |
| `acceptance/timer/tma_write_reloading` | pasa |  |
| `emulator-only/mbc1/bits_bank1` | pasa |  |
| `emulator-only/mbc1/bits_bank2` | pasa |  |
| `emulator-only/mbc1/bits_mode` | pasa |  |
| `emulator-only/mbc1/bits_ramg` | pasa |  |
| `emulator-only/mbc1/multicart_rom_8Mb` | n.a. | MBC1M (multicartucho) fuera de alcance (AGENTS.md §1) |
| `emulator-only/mbc1/ram_256kb` | pasa |  |
| `emulator-only/mbc1/ram_64kb` | pasa |  |
| `emulator-only/mbc1/rom_16Mb` | pasa |  |
| `emulator-only/mbc1/rom_1Mb` | pasa |  |
| `emulator-only/mbc1/rom_2Mb` | pasa |  |
| `emulator-only/mbc1/rom_4Mb` | pasa |  |
| `emulator-only/mbc1/rom_512kb` | pasa |  |
| `emulator-only/mbc1/rom_8Mb` | pasa |  |
| `emulator-only/mbc2/bits_ramg` | pasa |  |
| `emulator-only/mbc2/bits_romb` | pasa |  |
| `emulator-only/mbc2/bits_unused` | pasa |  |
| `emulator-only/mbc2/ram` | pasa |  |
| `emulator-only/mbc2/rom_1Mb` | pasa |  |
| `emulator-only/mbc2/rom_2Mb` | pasa |  |
| `emulator-only/mbc2/rom_512kb` | pasa |  |
| `emulator-only/mbc5/rom_16Mb` | pasa |  |
| `emulator-only/mbc5/rom_1Mb` | pasa |  |
| `emulator-only/mbc5/rom_2Mb` | pasa |  |
| `emulator-only/mbc5/rom_32Mb` | pasa |  |
| `emulator-only/mbc5/rom_4Mb` | pasa |  |
| `emulator-only/mbc5/rom_512kb` | pasa |  |
| `emulator-only/mbc5/rom_64Mb` | pasa |  |
| `emulator-only/mbc5/rom_8Mb` | pasa |  |
| `madness/mgb_oam_dma_halt_sprites` | n.a. | no automática (madness) |
| `manual-only/sprite_priority` | n.a. | no automática (manual-only) |
| `misc/bits/unused_hwio-C` | pasa |  |
| `misc/boot_div-A` | n.a. | otro modelo (sufijo de mooneye) |
| `misc/boot_div-cgb0` | n.a. | otro modelo (sufijo de mooneye) |
| `misc/boot_div-cgbABCDE` | pasa |  |
| `misc/boot_hwio-C` | falla | GBC-5 |
| `misc/boot_regs-A` | n.a. | otro modelo (sufijo de mooneye) |
| `misc/boot_regs-cgb` | pasa |  |
| `misc/ppu/vblank_stat_intr-C` | falla | PPU-4 |
| `utils/bootrom_dumper` | n.a. | no automática (utils) |
| `utils/dump_boot_hwio` | n.a. | no automática (utils) |

### rtc3test

| Test | Resultado | Motivo / hallazgo |
|---|---|---|
| `basic-tests` | pasa | captura |
| `range-tests` | pasa | captura |
| `sub-second-writes` | pasa | captura |

### SameSuite

| Test | Resultado | Motivo / hallazgo |
|---|---|---|
| `apu/channel_1/channel_1_align` | pasa |  |
| `apu/channel_1/channel_1_align_cpu` | pasa |  |
| `apu/channel_1/channel_1_delay` | pasa |  |
| `apu/channel_1/channel_1_duty` | pasa |  |
| `apu/channel_1/channel_1_duty_delay` | pasa |  |
| `apu/channel_1/channel_1_extra_length_clocking-cgb0B` | n.a. | sólo revisión cgb0B (no CGB-E) |
| `apu/channel_1/channel_1_freq_change` | pasa |  |
| `apu/channel_1/channel_1_freq_change_timing-A` | n.a. | sólo revisión A (no CGB-E) |
| `apu/channel_1/channel_1_freq_change_timing-cgb0BC` | n.a. | sólo revisión cgb0BC (no CGB-E) |
| `apu/channel_1/channel_1_freq_change_timing-cgbDE` | pasa |  |
| `apu/channel_1/channel_1_nrx2_glitch` | pasa |  |
| `apu/channel_1/channel_1_nrx2_speed_change` | pasa |  |
| `apu/channel_1/channel_1_restart` | pasa |  |
| `apu/channel_1/channel_1_restart_nrx2_glitch` | pasa |  |
| `apu/channel_1/channel_1_stop_div` | pasa |  |
| `apu/channel_1/channel_1_stop_restart` | pasa |  |
| `apu/channel_1/channel_1_sweep` | pasa |  |
| `apu/channel_1/channel_1_sweep_restart` | pasa |  |
| `apu/channel_1/channel_1_sweep_restart_2` | pasa |  |
| `apu/channel_1/channel_1_volume` | pasa |  |
| `apu/channel_1/channel_1_volume_div` | pasa |  |
| `apu/channel_2/channel_2_align` | pasa |  |
| `apu/channel_2/channel_2_align_cpu` | pasa |  |
| `apu/channel_2/channel_2_delay` | pasa |  |
| `apu/channel_2/channel_2_duty` | pasa |  |
| `apu/channel_2/channel_2_duty_delay` | pasa |  |
| `apu/channel_2/channel_2_extra_length_clocking-cgb0B` | n.a. | sólo revisión cgb0B (no CGB-E) |
| `apu/channel_2/channel_2_freq_change` | pasa |  |
| `apu/channel_2/channel_2_nrx2_glitch` | pasa |  |
| `apu/channel_2/channel_2_nrx2_speed_change` | pasa |  |
| `apu/channel_2/channel_2_restart` | pasa |  |
| `apu/channel_2/channel_2_restart_nrx2_glitch` | pasa |  |
| `apu/channel_2/channel_2_stop_div` | pasa |  |
| `apu/channel_2/channel_2_stop_restart` | pasa |  |
| `apu/channel_2/channel_2_volume` | pasa |  |
| `apu/channel_2/channel_2_volume_div` | pasa |  |
| `apu/channel_3/channel_3_and_glitch` | pasa |  |
| `apu/channel_3/channel_3_delay` | pasa |  |
| `apu/channel_3/channel_3_extra_length_clocking-cgb0` | n.a. | sólo revisión cgb0 (no CGB-E) |
| `apu/channel_3/channel_3_extra_length_clocking-cgbB` | n.a. | sólo revisión cgbB (no CGB-E) |
| `apu/channel_3/channel_3_first_sample` | pasa |  |
| `apu/channel_3/channel_3_freq_change_delay` | pasa |  |
| `apu/channel_3/channel_3_restart_delay` | pasa |  |
| `apu/channel_3/channel_3_restart_during_delay` | pasa |  |
| `apu/channel_3/channel_3_restart_stop_delay` | pasa |  |
| `apu/channel_3/channel_3_shift_delay` | pasa |  |
| `apu/channel_3/channel_3_shift_skip_delay` | pasa |  |
| `apu/channel_3/channel_3_stop_delay` | pasa |  |
| `apu/channel_3/channel_3_stop_div` | pasa |  |
| `apu/channel_3/channel_3_wave_ram_dac_on_rw` | pasa |  |
| `apu/channel_3/channel_3_wave_ram_locked_write` | pasa |  |
| `apu/channel_3/channel_3_wave_ram_sync` | pasa |  |
| `apu/channel_4/channel_4_align` | pasa |  |
| `apu/channel_4/channel_4_delay` | pasa |  |
| `apu/channel_4/channel_4_equivalent_frequencies` | pasa |  |
| `apu/channel_4/channel_4_extra_length_clocking-cgb0B` | n.a. | sólo revisión cgb0B (no CGB-E) |
| `apu/channel_4/channel_4_freq_change` | pasa |  |
| `apu/channel_4/channel_4_frequency_alignment` | pasa |  |
| `apu/channel_4/channel_4_lfsr` | pasa |  |
| `apu/channel_4/channel_4_lfsr_15_7` | pasa |  |
| `apu/channel_4/channel_4_lfsr_7_15` | pasa |  |
| `apu/channel_4/channel_4_lfsr_restart` | pasa |  |
| `apu/channel_4/channel_4_lfsr_restart_fast` | pasa |  |
| `apu/channel_4/channel_4_lfsr15` | pasa |  |
| `apu/channel_4/channel_4_volume_div` | pasa |  |
| `apu/div_trigger_volume_10` | pasa |  |
| `apu/div_write_trigger` | pasa |  |
| `apu/div_write_trigger_10` | pasa |  |
| `apu/div_write_trigger_volume` | pasa |  |
| `apu/div_write_trigger_volume_10` | pasa |  |
| `dma/gbc_dma_cont` | pasa |  |
| `dma/gdma_addr_mask` | pasa |  |
| `dma/hdma_lcd_off` | pasa |  |
| `dma/hdma_mode0` | pasa |  |
| `interrupt/ei_delay_halt` | pasa |  |
| `ppu/blocking_bgpi_increase` | pasa |  |
| `sgb/command_mlt_req` | n.a. | SGB fuera de alcance |
| `sgb/command_mlt_req_1_incrementing` | n.a. | SGB fuera de alcance |
