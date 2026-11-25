// Visores de VRAM (G1): tiles, mapas de fondo, OAM y paletas. Sólo lee las vistas de
// depuración de gb.h (gb_vram, gb_oam, gb_palettes, gb_io, gb_cgb_mode), que no tienen
// efectos laterales. Se redibuja únicamente cuando se llama a refresh() (fin de frame o
// pausa) y sólo la pestaña visible; si el panel está oculto, refresh() no hace nada.
import type { Core } from "../../emu/core";
import {
  BANK_SIZE, MAP_SIZE, SHEET_H, SHEET_W, TILE_BYTES, bgColor, decodeAttr, decodeOam, hex4,
  mapEntry, mapTileAddr, objColor, paletteColor, renderMap, renderSprite, renderTileSheet,
  viewportRects, windowRect, type ColorCtx, type OamEntry, type PalSel,
} from "./decode";
import "./vram.css";

type Tab = "tiles" | "maps" | "oam" | "pals";

const TABS: Array<[Tab, string]> = [["tiles", "Tiles"], ["maps", "Mapas"], ["oam", "OAM"], ["pals", "Paletas"]];
const MAP_SCALE = 2;
const OAM_EMPTY = 0xff2a2524;  // fondo de las casillas de OAM (RGBA little endian)

interface Snapshot {
  cgb: boolean;
  vram: Uint8Array;
  oam: Uint8Array;
  io: Uint8Array;
  ctx: ColorCtx;
}

const h2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, "0");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function canvas(w: number, h: number, cls?: string): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = el("canvas", cls);
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) throw new Error("canvas 2D no disponible");
  g.imageSmoothingEnabled = false;
  return [c, g];
}

/** Coordenadas del ratón en píxeles internos del canvas (el CSS lo escala). */
function canvasPos(c: HTMLCanvasElement, e: MouseEvent): [number, number] {
  const r = c.getBoundingClientRect();
  return [Math.floor(((e.clientX - r.left) * c.width) / r.width), Math.floor(((e.clientY - r.top) * c.height) / r.height)];
}

export function mountVramViewer(container: HTMLElement, core: Core): { refresh(): void; destroy(): void } {
  const x = core.x;
  const mem = (): ArrayBuffer => x.memory.buffer as ArrayBuffer;
  let snap: Snapshot | null = null;
  let tab: Tab = (localStorage.getItem("vram.tab") as Tab | null) ?? "tiles";
  if (!TABS.some(([t]) => t === tab)) tab = "tiles";

  const root = el("div", "vram");
  const bar = el("div", "vram-tabs");
  const pages = {} as Record<Tab, HTMLDivElement>;
  const buttons = {} as Record<Tab, HTMLButtonElement>;
  const body = el("div", "vram-body");
  for (const [t, label] of TABS) {
    const b = el("button", "", label);
    b.type = "button";
    b.onclick = () => select(t);
    buttons[t] = b;
    bar.append(b);
    pages[t] = el("div", "vram-page");
    body.append(pages[t]);
  }
  root.append(bar, body);
  container.append(root);

  // ---------------------------------------------------------------- Tiles
  const palSel = el("select");
  palSel.append(new Option("Grises", "gray"));
  for (let i = 0; i < 8; i++) palSel.append(new Option(`BG${i}`, `bg${i}`));
  for (let i = 0; i < 8; i++) palSel.append(new Option(`OBJ${i}`, `obj${i}`));
  palSel.value = localStorage.getItem("vram.pal") ?? "bg0";
  palSel.onchange = () => { localStorage.setItem("vram.pal", palSel.value); draw(); };
  const tileInfo = el("div", "vram-info", " ");
  const tileHead = el("div", "vram-row");
  const palLabel = el("label", "", "Paleta ");
  palLabel.append(palSel);
  tileHead.append(palLabel);
  const sheets = el("div", "vram-sheets");
  const tileCanvases: Array<[HTMLCanvasElement, CanvasRenderingContext2D, ImageData]> = [];
  for (let bank = 0; bank < 2; bank++) {
    const fig = el("figure");
    const [c, g] = canvas(SHEET_W, SHEET_H, "vram-px");
    tileCanvases.push([c, g, g.createImageData(SHEET_W, SHEET_H)]);
    fig.append(c, el("figcaption", "", `Banco ${bank} (8000–97FF)`));
    sheets.append(fig);
    c.onmousemove = (e) => {
      const [px, py] = canvasPos(c, e);
      const t = (py >> 3) * 16 + (px >> 3);
      if (t < 0 || t >= 384) return;
      const idx8000 = t < 256 ? `8000: ${h2(t)}` : "8000: —";
      const idx8800 = t >= 128 ? `8800: ${h2((t - 256) & 0xff)}` : "8800: —";
      tileInfo.textContent = `Tile ${t} · banco ${bank} · ${hex4(0x8000 + t * TILE_BYTES)} · índice ${idx8000} / ${idx8800}`;
    };
  }
  pages.tiles.append(tileHead, sheets, tileInfo);

  function parsePal(): PalSel {
    const v = palSel.value;
    if (v === "gray") return { kind: "gray" };
    return v.startsWith("obj") ? { kind: "obj", index: +v.slice(3) } : { kind: "bg", index: +v.slice(2) };
  }

  function drawTiles(s: Snapshot): void {
    const sel = parsePal();
    for (let bank = 0; bank < 2; bank++) {
      const [, g, img] = tileCanvases[bank]!;
      renderTileSheet(s.vram, bank, s.ctx, sel, new Uint32Array(img.data.buffer));
      g.putImageData(img, 0, 0);
    }
  }

  // ---------------------------------------------------------------- Mapas
  const mapSel = el("select");
  mapSel.append(new Option("9800", "0"), new Option("9C00", "1"));
  mapSel.value = localStorage.getItem("vram.map") ?? "0";
  mapSel.onchange = () => { localStorage.setItem("vram.map", mapSel.value); draw(); };
  const gridChk = el("input");
  gridChk.type = "checkbox";
  gridChk.checked = localStorage.getItem("vram.grid") === "1";
  gridChk.onchange = () => { localStorage.setItem("vram.grid", gridChk.checked ? "1" : "0"); draw(); };
  const mapHead = el("div", "vram-row");
  const mapLabel = el("label", "", "Mapa ");
  mapLabel.append(mapSel);
  const gridLabel = el("label");
  gridLabel.append(gridChk, " Rejilla");
  const mapRegs = el("span", "vram-dim");
  mapHead.append(mapLabel, gridLabel, mapRegs);
  const [mapCanvas, mapG] = canvas(MAP_SIZE * MAP_SCALE, MAP_SIZE * MAP_SCALE, "vram-map");
  const [mapOff, mapOffG] = canvas(MAP_SIZE, MAP_SIZE);
  const mapImg = mapOffG.createImageData(MAP_SIZE, MAP_SIZE);
  const mapInfo = el("div", "vram-info", " ");
  const legend = el("div", "vram-legend");
  legend.innerHTML = '<span class="k-bg"></span>Fondo (SCX/SCY) <span class="k-win"></span>Ventana';
  pages.maps.append(mapHead, mapCanvas, legend, mapInfo);
  mapCanvas.onmousemove = (e) => {
    if (!snap) return;
    const [px, py] = canvasPos(mapCanvas, e);
    const cx = (px / MAP_SCALE) >> 3, cy = (py / MAP_SCALE) >> 3;
    if (cx < 0 || cx > 31 || cy < 0 || cy > 31) return;
    const m = +mapSel.value;
    const { offset, tile, attr } = mapEntry(snap.vram, m, cx, cy);
    const lcdc = snap.io[0x40]!;
    let s = `(${cx},${cy}) · ${hex4(0x8000 + offset)} · tile ${h2(tile)} → ${hex4(0x8000 + mapTileAddr(tile, lcdc))}`;
    if (snap.cgb) {
      const a = decodeAttr(attr);
      s += ` · atr ${h2(attr)}: pal ${a.palette}, banco ${a.bank}${a.xflip ? ", X" : ""}${a.yflip ? ", Y" : ""}${a.priority ? ", prioridad" : ""}`;
    }
    mapInfo.textContent = s;
  };

  function drawMaps(s: Snapshot): void {
    const io = s.io, lcdc = io[0x40]!;
    const m = +mapSel.value;
    const scy = io[0x42]!, scx = io[0x43]!, wy = io[0x4a]!, wx = io[0x4b]!;
    renderMap(s.vram, m, lcdc, s.ctx, new Uint32Array(mapImg.data.buffer));
    mapOffG.putImageData(mapImg, 0, 0);
    mapG.drawImage(mapOff, 0, 0, MAP_SIZE * MAP_SCALE, MAP_SIZE * MAP_SCALE);
    if (gridChk.checked) {
      mapG.fillStyle = "rgba(128,128,128,.35)";
      for (let i = 1; i < 32; i++) {
        mapG.fillRect(i * 8 * MAP_SCALE, 0, 1, MAP_SIZE * MAP_SCALE);
        mapG.fillRect(0, i * 8 * MAP_SCALE, MAP_SIZE * MAP_SCALE, 1);
      }
    }
    const stroke = (r: { x: number; y: number; w: number; h: number }, color: string): void => {
      mapG.strokeStyle = color;
      mapG.lineWidth = 2;
      mapG.strokeRect(r.x * MAP_SCALE + 1, r.y * MAP_SCALE + 1, r.w * MAP_SCALE - 2, r.h * MAP_SCALE - 2);
    };
    // LCDC.3 elige el mapa del fondo y LCDC.6 el de la ventana.
    if (((lcdc >> 3) & 1) === m) for (const r of viewportRects(scx, scy)) stroke(r, "#ff4d6a");
    const w = windowRect(lcdc, wx, wy);
    if (w && ((lcdc >> 6) & 1) === m) stroke(w, "#4dd0ff");
    mapRegs.textContent =
      `LCDC ${h2(lcdc)} · SCX ${scx} SCY ${scy} · WX ${wx} WY ${wy} · datos ${lcdc & 0x10 ? "8000" : "8800"}` +
      ` · fondo ${lcdc & 0x08 ? "9C00" : "9800"} · ventana ${lcdc & 0x20 ? (lcdc & 0x40 ? "9C00" : "9800") : "off"}`;
  }

  // ---------------------------------------------------------------- OAM
  const oamHead = el("div", "vram-row vram-dim");
  const oamGrid = el("div", "vram-oam");
  const oamInfo = el("div", "vram-info vram-oam-info", "Pasa el ratón por un sprite");
  const oamCells: Array<{ cell: HTMLDivElement; g: CanvasRenderingContext2D; img: ImageData }> = [];
  let oamEntries: OamEntry[] = [];
  let oamHover = -1;
  for (let i = 0; i < 40; i++) {
    const cell = el("div", "vram-oam-cell");
    const [c, g] = canvas(8, 16, "vram-px");
    cell.append(c, el("span", "", String(i)));
    cell.onmouseenter = () => { oamHover = i; showOam(); };
    cell.onmouseleave = () => { if (oamHover === i) oamHover = -1; };
    oamCells.push({ cell, g, img: g.createImageData(8, 16) });
    oamGrid.append(cell);
  }
  pages.oam.append(oamHead, oamGrid, oamInfo);

  function oamText(e: OamEntry, cgb: boolean): string {
    const flags = [e.xflip && "volteo X", e.yflip && "volteo Y", e.behindBg && "detrás del fondo"].filter(Boolean).join(", ");
    const pal = cgb ? `OBJ${e.palette} · banco ${e.bank}` : `OBP${e.palette}`;
    const tiles = e.tiles.map(h2).join("+");
    return `#${e.index} · X ${e.x} Y ${e.y} (OAM ${h2(e.x + 8)},${h2(e.y + 16)}) · tile ${tiles} · atr ${h2(e.attr)} · ${pal}` +
      (flags ? ` · ${flags}` : "") + (e.visible ? "" : " · fuera de pantalla");
  }

  function showOam(): void {
    const e = oamEntries[oamHover];
    if (e && snap) oamInfo.textContent = oamText(e, snap.cgb);
  }

  function drawOam(s: Snapshot): void {
    const lcdc = s.io[0x40]!;
    oamEntries = decodeOam(s.oam, lcdc, s.cgb);
    const tall = (lcdc & 4) !== 0;
    oamHead.textContent = `Sprites ${tall ? "8×16" : "8×8"} · ${lcdc & 2 ? "activados" : "desactivados"} (LCDC.1) · ${oamEntries.filter((e) => e.visible).length} en pantalla`;
    oamGrid.classList.toggle("tall", tall);
    for (const e of oamEntries) {
      const { cell, g, img } = oamCells[e.index]!;
      const px = new Uint32Array(img.data.buffer);
      px.fill(OAM_EMPTY);
      renderSprite(s.vram, e, s.ctx, px, 8, 0, 0, OAM_EMPTY);
      g.putImageData(img, 0, 0);
      cell.classList.toggle("off", !e.visible);
      cell.title = oamText(e, s.cgb);
    }
    showOam();
  }

  // ---------------------------------------------------------------- Paletas
  const palHead = el("div", "vram-row vram-dim");
  const palGrid = el("div", "vram-pals");
  const swatches: HTMLSpanElement[][] = [];
  for (let p = 0; p < 16; p++) {
    const row = el("div", "vram-pal");
    row.append(el("span", "vram-pal-name", p < 8 ? `BG${p}` : `OBJ${p - 8}`));
    const sw: HTMLSpanElement[] = [];
    for (let i = 0; i < 4; i++) {
      const s = el("span", "vram-sw");
      s.append(el("i"), el("code"));
      row.append(s);
      sw.push(s);
    }
    swatches.push(sw);
    palGrid.append(row);
  }
  pages.pals.append(palHead, palGrid);

  function drawPals(s: Snapshot): void {
    const css = (c: number): string => `rgb(${((c & 31) << 3) | ((c & 31) >> 2)},${(((c >> 5) & 31) << 3) | (((c >> 5) & 31) >> 2)},${(((c >> 10) & 31) << 3) | (((c >> 10) & 31) >> 2)})`;
    for (let p = 0; p < 16; p++) {
      for (let i = 0; i < 4; i++) {
        const c = paletteColor(s.ctx.pals, p >= 8, p & 7, i);
        const sw = swatches[p]![i]!;
        (sw.firstChild as HTMLElement).style.background = css(c);
        sw.lastChild!.textContent = hex4(c);
        sw.title = `${p < 8 ? "BG" : "OBJ"}${p & 7}.${i} = ${hex4(c)} (R ${c & 31}, G ${(c >> 5) & 31}, B ${(c >> 10) & 31})`;
      }
    }
    if (s.cgb) {
      palHead.textContent = "Modo CGB · RGB555 (hex) sin corrección de color";
    } else {
      // En compatibilidad DMG sólo se usan BG0, OBJ0 y OBJ1, a través de BGP/OBP0/OBP1.
      const map = (r: number, f: (i: number) => number): string => [0, 1, 2, 3].map((i) => `${i}→${(r >> (i * 2)) & 3}`).join(" ") +
        ` (${[0, 1, 2, 3].map((i) => hex4(f(i))).join(" ")})`;
      palHead.textContent = `Compatibilidad DMG · BGP ${h2(s.ctx.bgp)}: ${map(s.ctx.bgp, (i) => bgColor(s.ctx, 0, i))}` +
        ` · OBP0 ${h2(s.ctx.obp0)}: ${map(s.ctx.obp0, (i) => objColor(s.ctx, 0, i))}` +
        ` · OBP1 ${h2(s.ctx.obp1)}: ${map(s.ctx.obp1, (i) => objColor(s.ctx, 1, i))}`;
    }
  }

  // ---------------------------------------------------------------- Común
  function select(t: Tab): void {
    tab = t;
    localStorage.setItem("vram.tab", t);
    for (const [k] of TABS) {
      buttons[k].classList.toggle("on", k === t);
      pages[k].hidden = k !== t;
    }
    refresh();
  }

  function take(): Snapshot {
    const io = new Uint8Array(mem(), x.gb_io(), 0x81);
    return {
      cgb: x.gb_cgb_mode() !== 0,
      vram: new Uint8Array(mem(), x.gb_vram(), 2 * BANK_SIZE),
      oam: new Uint8Array(mem(), x.gb_oam(), 160),
      io,
      ctx: {
        cgb: x.gb_cgb_mode() !== 0,
        pals: new Uint8Array(mem(), x.gb_palettes(), 128),
        bgp: io[0x47]!, obp0: io[0x48]!, obp1: io[0x49]!,
      },
    };
  }

  function draw(): void {
    if (!snap) return;
    if (tab === "tiles") drawTiles(snap);
    else if (tab === "maps") drawMaps(snap);
    else if (tab === "oam") drawOam(snap);
    else drawPals(snap);
  }

  function refresh(): void {
    // Oculto (pestaña de otro panel, display:none…): no se hace nada.
    if (!root.isConnected || root.getClientRects().length === 0) return;
    snap = take();
    draw();
  }

  select(tab);

  return {
    refresh,
    destroy(): void {
      root.remove();
      snap = null;
    },
  };
}
