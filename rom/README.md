# rom/ — Boot ROM y ROMs

## Política

- **No se versiona ningún fichero de Nintendo.** La boot ROM del CGB (2 304 bytes:
  0000–00FF y 0200–08FF) tiene copyright y, a diferencia de la ROM del Spectrum en
  zxemuIAtor, no hay permiso para distribuirla.
- **No se versionan juegos comerciales**, ni en `rom/` ni en `tests/`.
- `.gitignore` excluye `rom/*.bin`, `rom/*.gb` y `rom/*.gbc`.

## Arranque sin boot ROM (por defecto)

El núcleo deja la máquina en el estado que dejaría la boot ROM al saltar a 0100h
(registros, E/S, paletas, LCD), documentado en
[docs/gbc-hardware.md](../docs/gbc-hardware.md) §11 y verificado con mooneye
`boot_regs-cgb` y `boot_hwio-C`. Para el IDE es lo mejor: el programa está en pantalla
en el primer frame.

Limitación: en los cartuchos sólo-DMG la boot ROM elige la paleta de compatibilidad por
el título. Sin boot ROM se usa una paleta fija (docs §7.5).

## Boot ROM del usuario (opcional)

Desde la UI ("Boot ROM…") se puede cargar un volcado propio. Se guarda en IndexedDB del
navegador, nunca en el repositorio ni en el servidor. El núcleo lo recibe por
`gb_boot_rom(len)`, comprueba el tamaño y la mapea hasta que se escribe en FF50.

## Boot ROM de prueba (tests)

`tests/fixtures-own/boot-check/boot-check.ts` genera una boot ROM **escrita por
nosotros** (ensamblada a mano, listado en el fichero) que replica las comprobaciones
documentadas del arranque del CGB (logo, checksum de cabecera, KEY0 = 04h para
cartuchos DMG) para probar las ROMs que exporta el IDE (PLAN.md, E1); si algo falla se
queda en un bucle en 0030h. El logo no se guarda en ella: los tests se lo pasan
tomado de las ROMs de la comunidad que descarga `npm run fetch` (cgb-acid2, dmg-acid2,
Blargg), que son también el oráculo del logo del exportador.

## Para desarrolladores

Las suites de test (Blargg, mooneye, SameSuite, acid2, Mealybug, age) se descargan con
`npm run fetch` a `tests/fixtures/` y no se versionan; sus licencias se anotan en el
README que genera el script.
