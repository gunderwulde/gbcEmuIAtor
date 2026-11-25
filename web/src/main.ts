// Arranque de la app: carga el núcleo, conecta UI, bucle, entrada y persistencia.
import { Core, GbError, Stop, parseHeader, type CartInfo } from "./emu/core";
import { Display } from "./emu/display";
import { Input } from "./emu/input";
import { Loop } from "./emu/loop";
import { cartKey, getFile, putFile } from "./emu/storage";
import { mountDebugger } from "./ui/debugger";
import { mountTabsEditor } from "./ui/tabs";
import { mountSplitter } from "./ui/layout";
import { mountVramViewer } from "./ui/vram/viewer";

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} no existe`);
  return e as T;
};

const MBC_NAMES: Record<number, string> = {
  0x00: "ROM", 0x01: "MBC1", 0x02: "MBC1+RAM", 0x03: "MBC1+RAM+pila",
  0x05: "MBC2", 0x06: "MBC2+pila", 0x08: "ROM+RAM", 0x09: "ROM+RAM+pila",
  0x0F: "MBC3+RTC+pila", 0x10: "MBC3+RTC+RAM+pila", 0x11: "MBC3", 0x12: "MBC3+RAM",
  0x13: "MBC3+RAM+pila", 0x19: "MBC5", 0x1A: "MBC5+RAM", 0x1B: "MBC5+RAM+pila",
  0x1C: "MBC5+rumble", 0x1D: "MBC5+rumble+RAM", 0x1E: "MBC5+rumble+RAM+pila",
};
const BATTERY = new Set([0x03, 0x06, 0x09, 0x0F, 0x10, 0x13, 0x1B, 0x1E]);

/** Salida de audio: la implementa web/src/emu/audio.ts (tarea M2). */
interface AudioSink {
  readonly sampleRate: number;
  start(): Promise<void>;
  push(stereo: Float32Array): void;
  setEnabled(on: boolean): void;
  flush(): void;
}

const ui = {
  open: $<HTMLButtonElement>("btn-open"),
  reset: $<HTMLButtonElement>("btn-reset"),
  pause: $<HTMLButtonElement>("btn-pause"),
  saveState: $<HTMLButtonElement>("btn-save-state"),
  loadState: $<HTMLButtonElement>("btn-load-state"),
  savExport: $<HTMLButtonElement>("btn-sav-export"),
  savImport: $<HTMLButtonElement>("btn-sav-import"),
  sound: $<HTMLButtonElement>("btn-sound"),
  boot: $<HTMLButtonElement>("btn-boot"),
  cc: $<HTMLInputElement>("chk-cc"),
  scale: $<HTMLSelectElement>("sel-scale"),
  wrap: $<HTMLDivElement>("screen-wrap"),
  hint: $<HTMLDivElement>("drop-hint"),
  cart: $<HTMLSpanElement>("st-cart"),
  fps: $<HTMLSpanElement>("st-fps"),
  msg: $<HTMLDivElement>("msg"),
  fileRom: $<HTMLInputElement>("file-rom"),
  fileSav: $<HTMLInputElement>("file-sav"),
  fileBoot: $<HTMLInputElement>("file-boot"),
};

let msgTimer = 0;
function say(text: string, error = false): void {
  ui.msg.textContent = text;
  ui.msg.classList.toggle("error", error);
  clearTimeout(msgTimer);
  if (text) msgTimer = window.setTimeout(() => { ui.msg.textContent = ""; }, error ? 8000 : 3000);
}

function download(name: string, data: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function readFile(f: File): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

async function main(): Promise<void> {
  mountSplitter($("app"), $("ide"), $("splitter"));
  const core = await Core.load(`${import.meta.env.BASE_URL}wasm/core.wasm`);
  const display = new Display($<HTMLCanvasElement>("screen"));
  const vram = mountVramViewer($<HTMLElement>("vram"), core);
  const input = new Input();
  let audio: AudioSink | null = null;
  let soundOn = false;

  let cart: CartInfo | null = null;
  let key = "";
  let fileName = "";
  let paused = false;
  let fastForward = false;

  const bootStored = await getFile("boot:cgb");
  if (bootStored) {
    try { core.bootRom(bootStored.data); ui.boot.classList.add("on"); }
    catch (e) { say(`Boot ROM guardada no válida: ${(e as Error).message}`, true); }
  }

  const loop = new Loop({
    frame: () => {
      core.joypad(input.mask());
      const r = core.runFrame();
      if (audio && soundOn) {
        const s = core.audio(audio.sampleRate);
        if (!fastForward) audio.push(s);
      }
      if (r === Stop.Breakpoint || r === Stop.Watchpoint) {
        // Se avisa al depurador cuando el bucle ya está parado (nunca desde dentro del frame).
        queueMicrotask(() => { setRunning(false); for (const cb of stopCbs) cb(r); });
        return false;
      }
      return true;
    },
    present: () => { display.draw(core.framebuffer()); vram.refresh(); dbg?.refresh(); },
  });
  const stopCbs: Array<(r: number) => void> = [];
  let dbg: ReturnType<typeof mountDebugger> | null = null;

  // --- .sav: se guarda en IndexedDB en cuanto el juego escribe en la RAM con pila ---
  const hasBattery = (): boolean => !!cart && BATTERY.has(cart.type) && core.sramSize() > 0;
  async function flushSav(): Promise<void> {
    if (!hasBattery() || !core.sramDirty()) return;
    await putFile(`sav:${key}`, core.saveSav());
  }
  setInterval(() => { flushSav().catch((e) => say(`No se pudo guardar la partida: ${e}`, true)); }, 1000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) void flushSav(); });
  window.addEventListener("pagehide", () => { void flushSav(); });

  /** Arranca o para el bucle. No avisa al depurador: lo usa también él (start/stop). */
  function setRunning(run: boolean): void {
    paused = !run;
    if (run) loop.start(); else { loop.stop(); vram.refresh(); dbg?.refresh(); }
    ui.pause.textContent = run ? "Pausa" : "Continuar";
    ui.pause.classList.toggle("on", !run);
  }
  /** Arranques y paradas que decide la app (no el depurador): se le notifican. */
  function runByApp(run: boolean): void {
    setRunning(run);
    dbg?.syncRunning(run);
  }

  async function loadRom(data: Uint8Array, name: string): Promise<void> {
    await flushSav().catch(() => undefined);
    loop.stop();
    try {
      core.insert(data);
    } catch (e) {
      say(`No se pudo cargar ${name}: ${(e as Error).message}`, true);
      cart = null;
      return;
    }
    await cartInserted(data, name);
    localStorage.setItem("lastRomName", name);
    await putFile("rom:last", data).catch(() => undefined);
  }

  /** Lo común a una ROM abierta y a una construida en el IDE (ya está en el núcleo). */
  async function cartInserted(data: Uint8Array, name: string): Promise<void> {
    cart = parseHeader(data);
    key = cartKey(cart.title, cart.globalChecksum);
    fileName = name.replace(/\.[^.]*$/, "");
    if (hasBattery()) {
      const sav = await getFile(`sav:${key}`);
      if (sav) {
        try {
          core.loadSav(sav.data);
          core.rtcAdvance(Math.floor((Date.now() - sav.time) / 1000));
          say("Partida guardada recuperada");
        } catch (e) { say(`.sav ignorado: ${(e as Error).message}`, true); }
      }
    }
    const mode = core.cgbMode() ? "CGB" : "compatibilidad DMG";
    ui.cart.textContent = `${cart.title || name} · ${MBC_NAMES[cart.type] ?? `tipo ${cart.type.toString(16)}`} · ${mode}`;
    ui.hint.classList.add("hidden");
    for (const b of [ui.reset, ui.pause, ui.saveState, ui.loadState]) b.disabled = false;
    ui.savExport.disabled = ui.savImport.disabled = !hasBattery();
    runByApp(true);
  }

  // --- IDE: construir y ejecutar (Ctrl+Enter). buildAndRun ya ha insertado la ROM. ---
  const editor = mountTabsEditor($<HTMLElement>("editor"), { core, resume: () => runByApp(true) });
  dbg = mountDebugger($<HTMLElement>("debugger"), {
    core,
    start: () => setRunning(true),
    stop: () => setRunning(false),
    onStop: (cb) => stopCbs.push(cb),
    editor,
  });
  // Otra pestaña: el depurador repinta sus breakpoints y la línea en ejecución.
  editor.onSwitch(() => dbg?.controller.replaceBreakpoints(dbg.controller.breakpoints()));
  editor.onBuild(({ ok }) => {
    if (!ok) return;
    audio?.flush();
    const rom = new Uint8Array(core.x.memory.buffer, core.x.gb_rom(), 0x150).slice();
    void cartInserted(rom, editor.builtName());
  });

  // --- Abrir ROM: botón y arrastrar/soltar ---
  ui.open.onclick = () => ui.fileRom.click();
  ui.fileRom.onchange = async () => {
    const f = ui.fileRom.files?.[0];
    ui.fileRom.value = "";
    if (f) await loadRom(await readFile(f), f.name);
  };
  for (const ev of ["dragenter", "dragover"] as const)
    window.addEventListener(ev, (e) => { e.preventDefault(); ui.wrap.classList.add("drag"); });
  window.addEventListener("dragleave", () => ui.wrap.classList.remove("drag"));
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    ui.wrap.classList.remove("drag");
    const f = e.dataTransfer?.files[0];
    if (!f) return;
    if (/\.sav$/i.test(f.name)) await importSav(f);
    else if (/\.gbstate$/i.test(f.name)) await importState(f);
    else await loadRom(await readFile(f), f.name);
  });

  ui.reset.onclick = () => { core.reset(); audio?.flush(); runByApp(true); say("Reset"); };
  ui.pause.onclick = () => runByApp(paused);

  // --- Estados rápidos (uno por cartucho, en IndexedDB) ---
  async function saveState(): Promise<void> {
    if (!cart) return;
    await putFile(`state:${key}`, core.saveState());
    say("Estado guardado");
  }
  async function loadState(): Promise<void> {
    if (!cart) return;
    const st = await getFile(`state:${key}`);
    if (!st) { say("No hay estado guardado para este cartucho"); return; }
    try { core.loadState(st.data); audio?.flush(); display.draw(core.framebuffer()); say("Estado cargado"); }
    catch (e) { say((e as Error).message, true); }
  }
  async function importState(f: File): Promise<void> {
    if (!cart) { say("Carga primero el cartucho del estado", true); return; }
    try { core.loadState(await readFile(f)); audio?.flush(); display.draw(core.framebuffer()); say("Estado importado"); }
    catch (e) { say((e as Error).message, true); }
  }
  ui.saveState.onclick = () => void saveState().catch((e) => say(String(e), true));
  ui.loadState.onclick = () => void loadState();

  // --- .sav manual ---
  ui.savExport.onclick = () => { if (hasBattery()) download(`${fileName}.sav`, core.saveSav()); };
  ui.savImport.onclick = () => ui.fileSav.click();
  async function importSav(f: File): Promise<void> {
    if (!hasBattery()) { say("Este cartucho no tiene RAM con pila", true); return; }
    try {
      core.loadSav(await readFile(f));
      core.reset();
      await putFile(`sav:${key}`, core.saveSav());
      say(".sav importado; el juego se ha reiniciado");
    } catch (e) { say((e as Error).message, true); }
  }
  ui.fileSav.onchange = async () => {
    const f = ui.fileSav.files?.[0];
    ui.fileSav.value = "";
    if (f) await importSav(f);
  };

  // --- Boot ROM del usuario ---
  ui.boot.onclick = () => ui.fileBoot.click();
  ui.fileBoot.onchange = async () => {
    const f = ui.fileBoot.files?.[0];
    ui.fileBoot.value = "";
    if (!f) return;
    const data = await readFile(f);
    try {
      core.bootRom(data);
      await putFile("boot:cgb", data);
      ui.boot.classList.add("on");
      say("Boot ROM cargada; se usará en el próximo reset");
    } catch (e) { say((e as Error).message, true); }
  };

  // --- Sonido (el AudioContext exige un gesto del usuario) ---
  ui.sound.onclick = async () => {
    try {
      if (!audio) {
        const mod = await import("./emu/audio").catch(() => null);
        if (!mod) { say("Audio aún no disponible"); return; }
        audio = new mod.Audio() as AudioSink;
        await audio.start();
      }
      soundOn = !soundOn;
      audio.setEnabled(soundOn);
      ui.sound.textContent = soundOn ? "🔊 Sonido" : "🔇 Sonido";
      ui.sound.classList.toggle("on", soundOn);
    } catch (e) { say(`Audio: ${(e as Error).message}`, true); }
  };

  // --- Vídeo ---
  const applyScale = (): void => { ui.wrap.style.setProperty("--scale", ui.scale.value); };
  ui.scale.onchange = () => { applyScale(); localStorage.setItem("scale", ui.scale.value); };
  ui.scale.value = localStorage.getItem("scale") ?? "4";
  applyScale();
  ui.cc.onchange = () => { core.setColorCorrection(ui.cc.checked); localStorage.setItem("cc", ui.cc.checked ? "1" : "0"); };
  ui.cc.checked = localStorage.getItem("cc") !== "0";
  core.setColorCorrection(ui.cc.checked);

  // --- Atajos ---
  const typing = (e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.isContentEditable || !!t.closest(".cm-editor, input, select, textarea"));
  };
  window.addEventListener("keydown", (e) => {
    if (typing(e) && (e.code === "Tab" || e.code === "KeyP")) return;
    if (e.code === "Tab") { e.preventDefault(); fastForward = true; loop.speed = 4; }
    else if (e.code === "KeyP" && cart) runByApp(paused);
    else if (e.code === "F2") { e.preventDefault(); void saveState(); }
    else if (e.code === "F4") { e.preventDefault(); void loadState(); }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Tab") { fastForward = false; loop.speed = 1; }
  });

  setInterval(() => {
    ui.fps.textContent = loop.running ? `${loop.fps.toFixed(1)} fps${fastForward ? " ⏩" : ""}` : paused && cart ? "en pausa" : "";
  }, 500);

  // Recuperar la última ROM usada (queda sólo en este navegador).
  const last = await getFile("rom:last");
  if (last) {
    ui.hint.innerHTML = `Arrastra aquí una ROM .gb / .gbc<br />o <button id="btn-last">continuar con ${localStorage.getItem("lastRomName") ?? "la última ROM"}</button>`;
    ui.hint.style.pointerEvents = "auto";
    $<HTMLButtonElement>("btn-last").onclick = () => void loadRom(last.data, localStorage.getItem("lastRomName") ?? "rom.gb");
  }
}

main().catch((e) => {
  say(e instanceof GbError ? e.message : `Error al iniciar: ${(e as Error).message}`, true);
  console.error(e);
});
