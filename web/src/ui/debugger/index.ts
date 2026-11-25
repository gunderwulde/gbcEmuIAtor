// Panel del depurador (D1): registros y E/S, desensamblado con breakpoints, memoria en
// hexadecimal editable y órdenes de ejecución con teclado (F5, F10, F11, Mayús+F11,
// Ctrl+F10). La lógica vive en DebugController (sin DOM); aquí sólo se pinta y se
// traducen los clics. Las vistas de memoria leen las regiones de depuración de gb.h
// (gb_peek, gb_io, gb_rom, gb_vram, gb_wram, gb_sram), que no tienen efectos laterales.
import type { AsmResult } from "../../asm";
import { disasmRange, findStart, normBank, romReader, symbolTable, type ByteReader, type DisasmLine } from "../../disasm";
import type { Core } from "../../emu/core";
import type { EditorApi } from "../editor";
import { DebugController, type Breakpoint } from "./controller";
import { STOP_TEXT, flagsText, hex2, hex4, ioSummary, irqText, locText, parseLoc, parseRange, romBankCount } from "./format";
import { SourceMap } from "./source";
import { wasmTarget } from "./target";
import "./debugger.css";

export interface DebuggerHost {
  core: Core;
  /** Arranca el bucle de emulación. No debe llamar de vuelta a onStop. */
  start(): void;
  /** Para el bucle (idempotente). */
  stop(): void;
  /** El bucle se ha parado solo (gb_run_frame ≠ fin de frame); se llama ya parado. */
  onStop(cb: (reason: number) => void): void;
  /** Ctrl+F10 en el editor corre hasta la línea del cursor. */
  editor?: EditorApi;
}

export interface DebuggerApi {
  /** Repinta (al fin de frame se limita solo mientras corre). */
  refresh(): void;
  isPaused(): boolean;
  /** El host arrancó o paró el bucle por su cuenta (cargar ROM, reset, botón Pausa). */
  syncRunning(running: boolean): void;
  readonly controller: DebugController;
}

const DIS_ROWS = 26;
const MEM_ROWS = 16;
const RUNNING_REFRESH_MS = 250;
const ROM_MAX = 8 << 20;

type Region = "bus" | "rom" | "vram" | "wram" | "sram";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, title: string, onclick: () => void): HTMLButtonElement {
  const b = el("button", undefined, text);
  b.title = title;
  b.onclick = onclick;
  return b;
}

export function mountDebugger(container: HTMLElement, host: DebuggerHost): DebuggerApi {
  const x = host.core.x;
  const target = wasmTarget(x);
  const ctl = new DebugController(target, { start: () => host.start(), stop: () => host.stop() });
  const editor = host.editor;

  let srcMap: SourceMap | null = null;
  let symbols: ReturnType<typeof symbolTable> | null = null;
  let message = "";

  const mem = (ptr: number, len: number): Uint8Array => new Uint8Array(x.memory.buffer, ptr, len);
  const rom = (): Uint8Array => mem(x.gb_rom() as number, ROM_MAX);
  const io = (): Uint8Array => mem(x.gb_io() as number, 0x81);
  const romBanks = (): number => romBankCount(rom()[0x148] ?? 0);

  // ---------------------------------------------------------------------------------
  // Esqueleto
  // ---------------------------------------------------------------------------------
  container.classList.add("dbg");
  container.replaceChildren();

  const bar = el("div", "dbg-bar");
  const btnRun = button("Continuar", "Continuar / pausa (F5)", () => toggleRun());
  const btnStep = button("Paso", "Paso a paso (F11)", () => ctl.step());
  const btnOver = button("Por encima", "Paso por encima (F10)", () => ctl.stepOver());
  const btnOut = button("Salir", "Salir de la función (Mayús+F11)", () => ctl.stepOut());
  const btnCursor = button("Hasta cursor", "Ejecutar hasta la fila o línea seleccionada (Ctrl+F10)", () => runToCursor());
  const status = el("span", "dbg-status");
  bar.append(btnRun, btnStep, btnOver, btnOut, btnCursor, status);

  const regsBox = el("div", "dbg-regs");
  const ioBox = el("div", "dbg-io");
  const top = el("div", "dbg-top");
  top.append(regsBox, ioBox);

  // Desensamblado
  const disBar = el("div", "dbg-row");
  const follow = el("input");
  follow.type = "checkbox";
  follow.checked = true;
  const followLbl = el("label", undefined, " seguir PC");
  followLbl.prepend(follow);
  const bankSel = el("select");
  const gotoIn = el("input", "dbg-goto");
  gotoIn.placeholder = "ir a: $0150, 2:4000, etiqueta";
  disBar.append(followLbl, el("span", "dbg-dim", "ROMX:"), bankSel, gotoIn);
  const disBox = el("div", "dbg-dis");
  disBox.tabIndex = 0;

  // Breakpoints
  const bpBox = el("div", "dbg-bps");

  // Memoria
  const memBar = el("div", "dbg-row");
  const regionSel = el("select");
  for (const [v, t] of [["bus", "Bus (editable)"], ["rom", "ROM"], ["vram", "VRAM"], ["wram", "WRAM"], ["sram", "RAM ext."]] as const) {
    const o = el("option", undefined, t);
    o.value = v;
    regionSel.append(o);
  }
  const memBankSel = el("select");
  const memGoto = el("input", "dbg-goto");
  memGoto.placeholder = "dirección";
  memBar.append(regionSel, memBankSel, memGoto);
  const memBox = el("div", "dbg-mem");
  const wpBox = el("div", "dbg-row dbg-wps");

  const sec = (title: string, ...body: HTMLElement[]): HTMLElement => {
    const s = el("section", "dbg-sec");
    s.append(el("h3", undefined, title), ...body);
    return s;
  };
  container.append(
    bar, top,
    sec("Desensamblado", disBar, disBox),
    sec("Breakpoints", bpBox),
    sec("Memoria", memBar, memBox, wpBox),
  );

  // ---------------------------------------------------------------------------------
  // Registros y E/S
  // ---------------------------------------------------------------------------------
  const dv = (): DataView => new DataView(x.memory.buffer, x.gb_regs() as number, 20);

  function renderRegs(): void {
    const r = dv();
    const u16 = (o: number): number => r.getUint16(o, true);
    const f = r.getUint8(0);
    const halted = r.getUint8(14), stopped = r.getUint8(16), ime = r.getUint8(12), ei = r.getUint8(13);
    const pc = u16(10);
    const bank = normBank(target.romBank(), pc);
    const rows: Array<[string, string]> = [
      ["AF", hex4(u16(0))], ["BC", hex4(u16(2))], ["DE", hex4(u16(4))], ["HL", hex4(u16(6))],
      ["SP", hex4(u16(8))], ["PC", locText(bank, pc)],
      ["Flags", flagsText(f)], ["IME", ime ? "1" : ei ? "0 (EI pendiente)" : "0"],
      ["CPU", stopped ? "STOP" : halted ? "HALT" : r.getUint8(17) ? "bloqueada" : "—"],
    ];
    regsBox.replaceChildren(...rows.map(([k, v]) => {
      const d = el("div");
      d.append(el("span", "dbg-k", k), el("span", "dbg-v", v));
      return d;
    }));
  }

  function renderIo(): void {
    const s = ioSummary(io());
    const rows: Array<[string, string]> = [
      ["IE", `${hex2(s.ie)} ${irqText(s.ie)}`],
      ["IF", `${hex2(s.if)} ${irqText(s.if)}`],
      ["LCDC", `${hex2(s.lcdc)}${s.lcdOn ? "" : " (apagado)"}`],
      ["LY", `${s.ly}`],
      ["STAT", `${hex2(s.stat)} modo ${s.mode}`],
      ["Velocidad", `${s.double ? "doble" : "normal"}${s.armed ? " (cambio preparado)" : ""}`],
      ["Bancos", `ROM ${target.romBank()} · WRAM ${s.wramBank} · VRAM ${s.vramBank}`],
    ];
    ioBox.replaceChildren(...rows.map(([k, v]) => {
      const d = el("div");
      d.append(el("span", "dbg-k", k), el("span", "dbg-v", v));
      return d;
    }));
  }

  // ---------------------------------------------------------------------------------
  // Desensamblado
  // ---------------------------------------------------------------------------------
  let viewBank: number | null = null;   // null = el mapeado
  let anchor = 0;                       // primera dirección visible
  let selected: { bank: number; addr: number } | null = null;
  let disLines: DisasmLine[] = [];

  function fillBankSel(sel: HTMLSelectElement, n: number, withMapped: boolean, cur: string): void {
    const want = (withMapped ? 1 : 0) + n;
    if (sel.options.length !== want) {
      sel.replaceChildren();
      if (withMapped) { const o = el("option", undefined, "mapeado"); o.value = "map"; sel.append(o); }
      for (let i = 0; i < n; i++) { const o = el("option", undefined, String(i)); o.value = String(i); sel.append(o); }
    }
    sel.value = cur;
  }

  function disReader(): { read: ByteReader; bank: number } {
    if (viewBank === null) return { read: target.peek, bank: target.romBank() };
    const fromRom = romReader(rom(), viewBank);
    return { read: (a) => ((a & 0xffff) < 0x8000 ? fromRom(a) : target.peek(a)), bank: viewBank };
  }

  function renderDis(): void {
    fillBankSel(bankSel, romBanks(), true, viewBank === null ? "map" : String(viewBank));
    const { read, bank } = disReader();
    const pc = target.pc();
    const pcBank = normBank(target.romBank(), pc);
    if (follow.checked) {
      const visible = disLines.some((l) => l.addr === pc) && disLines.findIndex((l) => l.addr === pc) < DIS_ROWS - 4;
      if (!visible) anchor = findStart(read, pc, 6);
    }
    const opts = symbols ? { bank, symbols } : { bank };
    disLines = disasmRange(read, anchor, DIS_ROWS, opts);
    const rows: HTMLElement[] = [];
    for (const l of disLines) {
      const label = symbols?.name(l.bank, l.addr);
      if (label) rows.push(el("div", "dbg-label", `${label}:`));
      const row = el("div", "dbg-line");
      row.dataset.addr = String(l.addr);
      row.dataset.bank = String(l.bank);
      if (l.addr === pc && l.bank === normBank(pcBank, l.addr) && ctl.state === "paused") row.classList.add("pc");
      if (selected && selected.addr === l.addr && selected.bank === l.bank) row.classList.add("sel");
      const gut = el("span", "dbg-gut");
      if (ctl.hasBreakpoint(l.bank, l.addr)) gut.classList.add("bp");
      const tgt = l.target !== undefined ? symbols?.name(normBank(bank, l.target), l.target) : undefined;
      row.append(
        gut,
        el("span", "dbg-addr", locText(l.bank, l.addr)),
        el("span", "dbg-bytes", l.bytes.map(hex2).join(" ")),
        el("span", "dbg-text", l.text + (tgt ? `  ; ${tgt}` : "")),
      );
      rows.push(row);
    }
    disBox.replaceChildren(...rows);
  }

  function lineOf(ev: Event): { bank: number; addr: number; row: HTMLElement } | null {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".dbg-line");
    if (!row) return null;
    return { bank: Number(row.dataset.bank), addr: Number(row.dataset.addr), row };
  }

  disBox.onclick = (ev) => {
    const l = lineOf(ev);
    if (!l) return;
    if ((ev.target as HTMLElement).classList.contains("dbg-gut")) toggleBp(l.bank, l.addr);
    else { selected = { bank: l.bank, addr: l.addr }; renderDis(); }
  };
  disBox.ondblclick = (ev) => {
    const l = lineOf(ev);
    const d = l && disLines.find((d) => d.addr === l.addr);
    if (d?.target !== undefined) goTo(viewBank, d.target);
  };
  disBox.onwheel = (ev) => {
    ev.preventDefault();
    follow.checked = false;
    const { read } = disReader();
    if (ev.deltaY > 0) anchor = disLines[Math.min(3, disLines.length - 1)]?.addr ?? anchor;
    else anchor = findStart(read, anchor, 3);
    renderDis();
  };
  bankSel.onchange = () => {
    viewBank = bankSel.value === "map" ? null : Number(bankSel.value);
    renderDis();
  };
  follow.onchange = () => renderDis();
  gotoIn.onkeydown = (ev) => {
    if (ev.key !== "Enter") return;
    const loc = parseLoc(gotoIn.value, symbols?.find);
    if (!loc) { say(`No reconozco «${gotoIn.value}»`); return; }
    goTo(loc.bank !== null && loc.addr >= 0x4000 && loc.addr < 0x8000 ? loc.bank : viewBank, loc.addr);
  };

  function goTo(bank: number | null, addr: number): void {
    follow.checked = false;
    viewBank = bank;
    anchor = addr & 0xffff;
    selected = { bank: normBank(bank ?? target.romBank(), anchor), addr: anchor };
    renderDis();
  }

  // ---------------------------------------------------------------------------------
  // Breakpoints (la verdad la guarda el controlador; el editor sólo la refleja)
  // ---------------------------------------------------------------------------------
  function toggleBp(bank: number, addr: number): void {
    const src = srcMap?.addrToLine(bank, addr);
    const bp: Breakpoint = src ? { bank, addr, file: src.file, line: src.line } : { bank, addr };
    ctl.toggleBreakpoint(bp);
  }

  function renderBps(): void {
    const list = ctl.breakpoints().sort((a, b) => a.bank - b.bank || a.addr - b.addr);
    if (!list.length) { bpBox.replaceChildren(el("span", "dbg-dim", "Ninguno. Clic en el margen del desensamblado o del editor.")); return; }
    const items = list.map((b) => {
      const d = el("div", "dbg-bp");
      const go = el("span", "dbg-link", locText(b.bank, b.addr) + (b.line !== undefined ? `  ${b.file}:${b.line}` : ""));
      go.onclick = () => goTo(b.bank < 0 ? viewBank : b.bank, b.addr);
      const del = button("×", "Quitar", () => ctl.setBreakpoint(b, false));
      del.className = "dbg-x";
      d.append(go, del);
      return d;
    });
    const clear = button("Quitar todos", "Quitar todos los breakpoints", () => ctl.clearBreakpoints());
    bpBox.replaceChildren(...items, clear);
  }

  function editorBpLines(): Set<number> {
    const lines = new Set<number>();
    if (!editor) return lines;
    const file = editor.fileName();
    for (const b of ctl.breakpoints()) {
      if (b.file === file && b.line !== undefined) { lines.add(b.line); continue; }
      const src = b.file === undefined ? srcMap?.addrToLine(b.bank, b.addr) : undefined;
      if (src && src.file === file) lines.add(src.line);
    }
    return lines;
  }

  if (editor) {
    editor.onToggleBreakpoint((line) => {
      const file = editor.fileName();
      const loc = srcMap?.lineToAddr(file, line);
      if (!loc) { say(srcMap ? "Esa línea no genera código" : "Construye el programa para poner breakpoints en el código"); return; }
      ctl.toggleBreakpoint({ bank: loc.bank, addr: loc.addr, file, line: loc.line });
    });
    editor.onBuild(({ ok, result }) => { if (ok) adoptBuild(result); });
  }

  /** Tras construir: nuevo mapa de fuente y símbolos; los breakpoints de línea se recolocan. */
  function adoptBuild(r: AsmResult): void {
    srcMap = new SourceMap(r.lineMap);
    symbols = symbolTable(r.symbols);
    const next: Breakpoint[] = [];
    for (const b of ctl.breakpoints()) {
      if (b.file === undefined || b.line === undefined) { next.push(b); continue; }
      const loc = srcMap.lineToAddr(b.file, b.line);
      if (loc) next.push({ bank: loc.bank, addr: loc.addr, file: b.file, line: loc.line });
    }
    // Siempre: la ROM nueva se acaba de insertar y el núcleo debe recibir el conjunto.
    ctl.replaceBreakpoints(next);
  }

  // ---------------------------------------------------------------------------------
  // Memoria
  // ---------------------------------------------------------------------------------
  let region: Region = "bus";
  let memBank = 0;
  let memBase = 0xc000;
  let editing: number | null = null;

  interface View { size: number; show: number; read(off: number): number; write?(off: number, v: number): void }

  function memView(): View {
    switch (region) {
      case "bus":
        return { size: 0x10000, show: 0, read: target.peek, write: (o, v) => { x.gb_poke(o, v); } };
      case "rom": {
        const r = rom(), base = memBank * 0x4000;
        return { size: 0x4000, show: memBank ? 0x4000 : 0, read: (o) => r[base + o] ?? 0xff };
      }
      case "vram": {
        const v = mem(x.gb_vram() as number, 0x4000), base = memBank * 0x2000;
        return { size: 0x2000, show: 0x8000, read: (o) => v[base + o]! };
      }
      case "wram": {
        const w = mem(x.gb_wram() as number, 0x8000), base = memBank * 0x1000;
        return { size: 0x1000, show: memBank ? 0xd000 : 0xc000, read: (o) => w[base + o]! };
      }
      case "sram": {
        const n = x.gb_sram_size() >>> 0, s = mem(x.gb_sram() as number, n), base = memBank * 0x2000;
        return { size: Math.min(0x2000, Math.max(0, n - base)), show: 0xa000, read: (o) => s[base + o]! };
      }
    }
  }

  function memBankCount(): number {
    switch (region) {
      case "bus": return 0;
      case "rom": return romBanks();
      case "vram": return 2;
      case "wram": return 8;
      case "sram": return Math.max(1, Math.ceil((x.gb_sram_size() >>> 0) / 0x2000));
    }
  }

  function renderMem(): void {
    const nb = memBankCount();
    memBankSel.hidden = nb === 0;
    if (nb) { memBank = Math.min(memBank, nb - 1); fillBankSel(memBankSel, nb, false, String(memBank)); }
    const v = memView();
    const span = MEM_ROWS * 16;
    const maxBase = Math.max(0, v.size - span);
    let off = Math.min(Math.max(0, memBase - v.show), maxBase) & ~0xf;
    memBase = off + v.show;
    const rows: HTMLElement[] = [];
    if (!v.size) { memBox.replaceChildren(el("span", "dbg-dim", "El cartucho no tiene RAM externa.")); return; }
    for (let r = 0; r < MEM_ROWS && off < v.size; r++, off += 16) {
      const row = el("div", "dbg-mrow");
      row.append(el("span", "dbg-addr", hex4(v.show + off)));
      let ascii = "";
      for (let i = 0; i < 16 && off + i < v.size; i++) {
        const o = off + i, b = v.read(o);
        if (editing === o && v.write) {
          const inp = el("input", "dbg-edit");
          inp.value = hex2(b);
          inp.maxLength = 2;
          inp.dataset.off = String(o);
          row.append(inp);
          queueMicrotask(() => { inp.focus(); inp.select(); });
        } else {
          const c = el("span", "dbg-byte" + (v.write ? " w" : ""), hex2(b));
          c.dataset.off = String(o);
          row.append(c);
        }
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
      }
      row.append(el("span", "dbg-ascii", ascii));
      rows.push(row);
    }
    memBox.replaceChildren(...rows);
  }

  memBox.onclick = (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.classList.contains("dbg-byte") || !t.classList.contains("w")) return;
    editing = Number(t.dataset.off);
    renderMem();
  };
  memBox.onkeydown = (ev) => {
    const t = ev.target as HTMLInputElement;
    if (!t.classList.contains("dbg-edit")) return;
    if (ev.key === "Escape") { editing = null; renderMem(); return; }
    if (ev.key !== "Enter" && ev.key !== "Tab") return;
    ev.preventDefault();
    const o = Number(t.dataset.off), v = parseInt(t.value, 16);
    const view = memView();
    if (!/^[0-9a-f]{1,2}$/i.test(t.value) || !view.write) { say("Byte no válido (00-FF)"); return; }
    view.write(o, v);
    // Enter/Tab avanza al siguiente byte, como en un editor hexadecimal.
    editing = o + 1 < view.size ? o + 1 : null;
    if (editing !== null && editing - (memBase - view.show) >= MEM_ROWS * 16) memBase += 16;
    renderAll();
  };
  memBox.addEventListener("focusout", (ev) => {
    if ((ev.target as HTMLElement).classList.contains("dbg-edit") && !memBox.contains(ev.relatedTarget as Node)) {
      editing = null;
      renderMem();
    }
  });
  memBox.onwheel = (ev) => {
    ev.preventDefault();
    memBase += ev.deltaY > 0 ? 0x40 : -0x40;
    if (memBase < 0) memBase = 0;
    renderMem();
  };
  regionSel.onchange = () => {
    region = regionSel.value as Region;
    memBank = region === "rom" || region === "wram" ? 1 : 0;
    memBase = { bus: 0xc000, rom: 0x4000, vram: 0x8000, wram: 0xd000, sram: 0xa000 }[region];
    editing = null;
    renderMem();
  };
  memBankSel.onchange = () => {
    memBank = Number(memBankSel.value);
    if (region === "rom") memBase = memBank ? 0x4000 : 0;
    if (region === "wram") memBase = memBank ? 0xd000 : 0xc000;
    renderMem();
  };
  memGoto.onkeydown = (ev) => {
    if (ev.key !== "Enter") return;
    const loc = parseLoc(memGoto.value, symbols?.find);
    if (!loc) { say(`No reconozco «${memGoto.value}»`); return; }
    if (loc.bank !== null && region === "rom") memBank = loc.bank;
    memBase = loc.addr;
    renderMem();
  };

  function renderWps(): void {
    if (!ctl.watchpointsSupported) {
      wpBox.replaceChildren(el("span", "dbg-dim", "Watchpoints de escritura: el núcleo aún no los exporta."));
      return;
    }
    const inp = el("input", "dbg-goto");
    inp.placeholder = "C000-C0FF";
    const add = (): void => {
      const r = parseRange(inp.value);
      if (!r) { say("Rango no válido"); return; }
      if (!ctl.setWatchpoint(r.lo, r.hi, true)) say("No caben más watchpoints");
    };
    inp.onkeydown = (ev) => { if (ev.key === "Enter") add(); };
    const chips = ctl.watchpoints().map((w) => {
      const c = el("span", "dbg-chip", w.lo === w.hi ? hex4(w.lo) : `${hex4(w.lo)}-${hex4(w.hi)}`);
      const del = button("×", "Quitar", () => ctl.setWatchpoint(w.lo, w.hi, false));
      del.className = "dbg-x";
      c.append(del);
      return c;
    });
    wpBox.replaceChildren(el("span", "dbg-dim", "Vigilar escritura:"), inp, button("Añadir", "Parar tras escribir en el rango", add), ...chips);
  }

  // ---------------------------------------------------------------------------------
  // Órdenes y teclado
  // ---------------------------------------------------------------------------------
  function toggleRun(): void {
    if (ctl.state === "paused") ctl.continue(); else ctl.pause();
  }

  function runToCursor(): void {
    const inEditor = !!document.activeElement?.closest(".cm-editor");
    if (inEditor && editor?.cursorLine) {
      const loc = srcMap?.lineToAddr(editor.fileName(), editor.cursorLine());
      if (!loc) { say("Esa línea no tiene código construido"); return; }
      ctl.runTo(loc.bank, loc.addr);
      return;
    }
    if (!selected) { say("Selecciona una fila del desensamblado"); return; }
    ctl.runTo(selected.bank, selected.addr);
  }

  function onKey(ev: KeyboardEvent): void {
    let act: (() => unknown) | null = null;
    if (ev.key === "F5" && !ev.ctrlKey && !ev.shiftKey) act = toggleRun;
    else if (ev.key === "F10" && ev.ctrlKey) act = runToCursor;
    else if (ev.key === "F10") act = () => ctl.stepOver();
    else if (ev.key === "F11" && ev.shiftKey) act = () => ctl.stepOut();
    else if (ev.key === "F11") act = () => ctl.step();
    if (!act) return;
    ev.preventDefault();   // F5 recargaría la página y F11 pondría pantalla completa
    act();
  }
  document.addEventListener("keydown", onKey, true);

  function say(text: string): void {
    message = text;
    renderStatus();
  }

  function renderStatus(): void {
    const running = ctl.state !== "paused";
    btnRun.textContent = running ? "Pausa" : "Continuar";
    btnRun.classList.toggle("on", !running);
    for (const b of [btnStep, btnOver, btnOut, btnCursor]) b.disabled = running;
    container.classList.toggle("running", running);
    const st = ctl.lastStop;
    let text = ctl.state === "running" ? (ctl.goal ? "Ejecutando hacia el objetivo…" : "En ejecución")
      : ctl.state === "stepping" ? "Saliendo de la función…"
        : st ? `${STOP_TEXT[st.kind] ?? st.kind} en ${locText(st.bank, st.pc)}${st.msg ? ` · ${st.msg}` : ""}` : "En pausa";
    if (message) text += ` — ${message}`;
    status.textContent = text;
  }

  // ---------------------------------------------------------------------------------
  // Repintado
  // ---------------------------------------------------------------------------------
  let lastRunPaint = 0;
  let lastExec: number | null | undefined;

  function syncEditor(): void {
    if (!editor) return;
    editor.setBreakpointLines(editorBpLines());
    let exec: number | null = null;
    if (ctl.state === "paused" && srcMap) {
      const pc = target.pc();
      const src = srcMap.addrToLine(normBank(target.romBank(), pc), pc);
      if (src && src.file === editor.fileName()) exec = src.line;
    }
    if (exec !== lastExec) { lastExec = exec; editor.showExecLine(exec); }
  }

  function renderAll(): void {
    renderStatus();
    renderRegs();
    renderIo();
    renderDis();
    renderBps();
    renderMem();
    renderWps();
  }

  ctl.onChange(() => {
    message = "";
    renderAll();
    syncEditor();
  });
  host.onStop((reason) => ctl.notifyStop(reason));

  renderAll();

  return {
    refresh() {
      if (ctl.state !== "paused") {
        // Mientras corre basta con registros y E/S unas pocas veces por segundo.
        const now = performance.now();
        if (now - lastRunPaint < RUNNING_REFRESH_MS) return;
        lastRunPaint = now;
        renderRegs();
        renderIo();
        return;
      }
      renderAll();
    },
    isPaused: () => ctl.state === "paused",
    syncRunning(running) { ctl.syncRunning(running); },
    controller: ctl,
  };
}
