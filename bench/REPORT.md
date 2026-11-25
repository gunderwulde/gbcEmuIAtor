# P1 — Rendimiento del núcleo

Medido con `npm run bench` (`tools/bench.mjs`) en un AMD Ryzen 5 2600, node v24.15.0,
Windows 11. Objetivo de PLAN.md P1: ≥ 10× tiempo real (< 1,67 ms/frame).

## Escenarios (`bench/rom.mjs`, homebrew CGB de 32 KB, determinista)

- **heavy:** BG, ventana y objetos 8×16 con 10 sprites por línea (OAM DMA en VBlank y
  en STAT/LYC), atributos CGB, los 4 canales de la APU sonando, IRQ de VBlank y STAT, y
  la CPU siempre ocupada.
- **idle:** el mismo vídeo y audio, pero la CPU espera en HALT y trabaja ≈16 % del frame.

`bench.mjs` calienta 240 frames, mide 15×128 frames y da la mediana. Con varios `--wasm`
intercala las medidas (A/B) y compara el hash del framebuffer y del audio: una
optimización no puede cambiarlos. **La máquina de medida tiene carga de fondo y la
dispersión entre repeticiones llega al 20–70 %: sólo valen las comparaciones A/B dentro
de una misma ejecución.** El umbral del 2 % de `--strict` sólo tiene sentido en una
máquina tranquila.

## Dónde se va el tiempo (núcleo previo a E1)

`node --cpu-prof`, tiempo propio por función:

| función | heavy | idle |
|---|---|---|
| `ppu_catch_up` | 55 % | 66 % |
| `m_cycle` | 11 % | 10 % |
| `step_once` | 11 % | 9 % |
| `bus_read` | 10 % | — |
| `apu_catch_up` | 2–3 % | 2–3 % |

Cotas medidas quitando cada componente (sobre E1):

| se quita | heavy | idle |
|---|---|---|
| todo el render | −36 % | −44 % |
| sprites | −18 % | −23 % |
| composición y paletas | −15 % | −20 % |
| `timer_mcycle` | −7 % | −5 % |
| `apu_catch_up` | −8 % | −8 % |

- **Clang no inlinea el ciclo M**: `llvm-objdump -d` mostraba `m_cycle`, `bus_read`,
  `bus_write`, `imm16`, `push16`, `pop16` y `exec_cb` como funciones separadas aunque
  sean `static inline` (principio 10: leer el código generado).
- `-O3` y `-flto` no ayudan: ±0 % en heavy, +1/+2 % (peor) en idle.

## Propuestas

Diffs en `bench/proposals/`, contra `core/src` y en este orden.

| ms/frame (mediana) | previo | E1 | E1+E2 | E1+E3 | E1+E2+E3 |
|---|---|---|---|---|---|
| heavy | 0,92 (18×) | 0,66 | 0,66 | 0,63 | 0,63 (26×) |
| idle | 0,78–0,89 (19–21×) | 0,51 | 0,37 | 0,50 | 0,37 (45×) |

Hashes de framebuffer y audio idénticos en todas las variantes. `tests/core` +
`tests/accuracy` dan la misma lista de resultados con el núcleo previo y con E1+E2+E3.

1. **E1, render por tramos (APLICADA).** `render_to` emite el tramo `[px, upto)` de una
   vez: mapa y tile se leen una vez por tile, la ventana corta el tramo en WX−7 y cada
   sprite se decodifica una vez por tramo, en orden de prioridad, rellenando sólo huecos.
   El tramo se sigue cortando en el punto en que la CPU accede a la PPU, así que los
   cambios a mitad de línea se siguen viendo. −28/−30 % heavy, −35/−40 % idle.
2. **E3, `always_inline` (APLICADA)** en `timer_mcycle`, `m_cycle`, `bus_read`,
   `bus_write` y `bus_tick`. −3/−5 %. El wasm pasa de 43 a 83 KB. Sin riesgo de
   exactitud. Pendiente de medir: inlinear sólo `m_cycle` y `bus_tick`.
3. **E2, avanzar de golpe en HALT (PENDIENTE de revisión).** Mientras la CPU está en
   HALT sin IRQ ni breakpoints, salta hasta el ciclo anterior al próximo suceso
   (`next_event`, fin del tramo, flanco del bit de TAC, flanco del bit 12/13 de DIV para
   el secuenciador de la APU); con serie, OAM DMA o recarga de TIMA en curso va ciclo a
   ciclo. −27 % adicional en idle, nada en heavy. Riesgo bajo-medio: `halt_skip` tiene
   que reproducir todo lo que hace `m_cycle`; se propone un assert de comparación con el
   camino lento en el build de tests antes de integrarla.
4. **No implementadas** (techo medido o estimado): timer como evento del planificador en
   vez de comprobarlo cada ciclo (hasta −5/−7 %), caché RGBA de la paleta (estimado
   −5/−8 %), APU por eventos (hasta −8 %).

## Integración de E1+E3

A/B en la misma ejecución (9×128 frames), núcleo previo frente a E1+E3:

| escenario | previo | E1+E3 | cambio |
|---|---|---|---|
| heavy | 0,948 ms (17,7×) | 0,639 ms (26,2×) | −32,6 % |
| idle | 0,846 ms (19,8×) | 0,528 ms (31,7×) | −37,6 % |

Mismos hashes de framebuffer y audio; `tests/core` 581/581. `render_pixel` se ha borrado
(ya no la usaba nadie) y sus comentarios de hardware han pasado a `render_span`.
`bench/baseline.json` se regenera con este núcleo.

## Correcciones de exactitud de la fase 2 (X-PPU, X-APU, X-GBC)

La línea de tiempo de la PPU según SameBoy, los retardos y la alineación de la APU y las
correcciones de máquina y cartucho hacen pasar ≈ 77 tests de exactitud más (fallos
conocidos: 127 → 50). Primera integración frente a E1+E3: +4…+17 %. Tras la revisión:

- **PPU:** los bloqueos de VRAM, OAM y paletas se calculan del punto al acceder (no como
  eventos), y la máquina sólo despierta por las fuentes de STAT habilitadas o por HDMA.
  Con la APU de E1+E3, la PPU nueva mide −1,6/−2,0 % (mín.) frente a E1+E3: no cuesta.
- **APU:** cuenta atrás del flanco del ruido precalculada y arreglo del barrido congelado
  (que forzaba tramos de 2 ticks); salida idéntica bit a bit, ±0 a −3 %.

A/B final (15×128 frames, máquina con carga):

| escenario | E1+E3 | fase 2 | cambio |
|---|---|---|---|
| heavy | 0,890 ms (18,8×) | 0,923 ms (18,1×) | +3,7 % |
| idle | 0,710 ms (23,6×) | 0,747 ms (22,4×) | +5,2 % |

Se acepta por encima del 2 %: el coste restante es el de los retardos de disparo y la
alineación con el reloj de 2 MHz de la APU (APU-1), que piden trocear el avance en los
puntos en que el hardware cambia de estado. Pendiente: APU por eventos (techo medido
−8 %) y E2. `bench/baseline.json` se regenera con este núcleo.
