// ÚNICA lista de fallos conocidos de las suites de exactitud (C2). Cada grupo lleva el
// hallazgo de docs/accuracy.md que lo explica (fichero del núcleo, línea e hipótesis).
// Los tests listados se ejecutan con `it.fails`: si uno empieza a pasar, la suite se pone
// roja para que se quite de aquí (y se actualice la tabla de docs/accuracy.md).

const FINDINGS: Record<string, string> = {
  "PPU-1": "PPU sin FIFO: penalizaciones del modo 3 cargadas al principio de la línea; los cambios de registros a mitad de línea caen en el píxel equivocado",
  "PPU-2": "temporización de los modos de STAT / IRQ de modo 2 / LY (bordes en los puntos 0, 80 y 80+m3len sin los desfases del CGB)",
  "PPU-4": "encendido del LCD, flag LYC y fuente de modo 2 al entrar en VBlank",
  "GBC-1": "HDMA: ciclo M del HBlank en que empieza la copia (hdma_timing-C)",
  "GBC-3": "cambio de velocidad (STOP): el opcode captado antes de la pausa (sm83.c) y el retardo de 1 ciclo M del contador de longitud de la APU (apu.c)",
  "GBC-5": "compatibilidad DMG: BCPS/OCPS legibles (C8h/D0h tras la boot ROM); está en ppu.c",
};

const GROUPS: Array<[keyof typeof FINDINGS, string[]]> = [
  ["PPU-1", [
    "age/m3-bg-bgp/m3-bg-bgp",
    "age/m3-bg-lcdc/m3-bg-lcdc",
    "age/m3-bg-lcdc/m3-bg-lcdc-ds",
    "age/m3-bg-lcdc/m3-bg-lcdc-nocgb",
    "age/m3-bg-scx/m3-bg-scx",
    "age/m3-bg-scx/m3-bg-scx-ds",
    "age/m3-bg-scx/m3-bg-scx-nocgb",
    "mealybug/ppu/m3_bgp_change",
    "mealybug/ppu/m3_bgp_change_sprites",
    "mealybug/ppu/m3_lcdc_bg_en_change",
    "mealybug/ppu/m3_lcdc_bg_en_change2",
    "mealybug/ppu/m3_lcdc_bg_map_change",
    "mealybug/ppu/m3_lcdc_bg_map_change2",
    "mealybug/ppu/m3_lcdc_obj_en_change",
    "mealybug/ppu/m3_lcdc_obj_en_change_variant",
    "mealybug/ppu/m3_lcdc_obj_size_change",
    "mealybug/ppu/m3_lcdc_obj_size_change_scx",
    "mealybug/ppu/m3_lcdc_tile_sel_change",
    "mealybug/ppu/m3_lcdc_tile_sel_change2",
    "mealybug/ppu/m3_lcdc_tile_sel_win_change",
    "mealybug/ppu/m3_lcdc_tile_sel_win_change2",
    "mealybug/ppu/m3_lcdc_win_en_change_multiple",
    "mealybug/ppu/m3_lcdc_win_map_change",
    "mealybug/ppu/m3_lcdc_win_map_change2",
    "mealybug/ppu/m3_obp0_change",
    "mealybug/ppu/m3_scx_high_5_bits",
    "mealybug/ppu/m3_scx_high_5_bits_change2",
    "mealybug/ppu/m3_scx_low_3_bits",
    "mealybug/ppu/m3_scy_change",
    "mealybug/ppu/m3_scy_change2",
    "mealybug/ppu/m3_window_timing",
    "mealybug/ppu/m3_window_timing_wx_0",
    "mealybug/ppu/m3_wx_4_change_sprites",
  ]],
  ["PPU-2", [
    "age/lcd-align-ly/lcd-align-ly-cgbE",
    "age/stat-interrupt/stat-int-dmgC-cgbBCE",
    "age/stat-interrupt/stat-int-ncmBCE",
    "age/stat-mode-sprites/stat-mode-sprites-dmgC-cgbBCE",
    "age/stat-mode-sprites/stat-mode-sprites-ds-cgbBCE",
    "age/stat-mode-window/stat-mode-window-cgbBCE",
    "age/stat-mode-window/stat-mode-window-ds-cgbBCE",
    "age/stat-mode-window/stat-mode-window-ncmBCE",
    "mooneye/acceptance/ppu/intr_2_mode0_timing",
    "mooneye/acceptance/ppu/intr_2_mode0_timing_sprites",
    "mooneye/acceptance/ppu/intr_2_mode3_timing",
    "mooneye/acceptance/ppu/intr_2_oam_ok_timing",
  ]],
  ["PPU-4", [
    "mooneye/misc/ppu/vblank_stat_intr-C",
  ]],
  ["GBC-1", [
    "mealybug/dma/hdma_timing-C",
  ]],
  ["GBC-3", [
    "age/speed-switch/spsw-ch2-lc-delay-cgbBCE",
    "age/speed-switch/spsw-stop-prefetch-cgbBCE",
  ]],
  ["GBC-5", [
    "mooneye/misc/boot_hwio-C",
  ]],
];

export const KNOWN_FAILURES: Record<string, string> = {};
for (const [f, ids] of GROUPS) {
  for (const id of ids) {
    if (KNOWN_FAILURES[id]) throw new Error(`known-failures: ${id} repetido`);
    KNOWN_FAILURES[id] = `${f} ${FINDINGS[f]}`;
  }
}
