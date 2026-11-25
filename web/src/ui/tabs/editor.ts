// U1: editor con pestañas (.asm, .inc, .c, .h), lista de ficheros lateral (Ctrl+B),
// ejemplos de ensamblador y de C, y Ctrl+Enter que construye lo que toca (ver model.ts):
// un .asm se ensambla como en I1; un .c se compila (K1), se ensambla y se arranca.
//
// Un solo EditorView y un EditorState por pestaña (se cambia con setState: cada pestaña
// conserva su deshacer, su selección y sus diagnósticos). Cumple EditorApi de I1, así que
// el depurador (D1) no sabe que hay pestañas: fileName() es la pestaña activa y el lineMap
// que recibe en onBuild ya está en líneas C (srcmap.ts). Al cambiar de pestaña se avisa
// con onSwitch para que el depurador vuelva a pintar breakpoints y línea en ejecución.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentUnit } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { EditorState, Prec, StateEffect, type Extension } from "@codemirror/state";
import {
  EditorView, drawSelection, gutter, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
} from "@codemirror/view";
import type { AsmResult } from "../../asm";
import type { Core } from "../../emu/core";
import { browserStorage } from "../editor/autosave";
import { toDiagnostics } from "../editor/diagnostics";
import {
  bpField, docLines, execField, setBpLines, setExec, spacer, theme, type EditorApi,
} from "../editor";
import { sm83 } from "../editor/language";
import { buildTabs, type TabDiag } from "./build";
import { cLang } from "./clang";
import { ccCompile, clibFiles } from "./deps";
import {
  ASM_EXAMPLES, C_EXAMPLES, DEFAULT_ASM_EXAMPLE, DEFAULT_C_EXAMPLE, isExampleText, tabExampleById, type TabExample,
} from "./examples";
import { GEN_NAME, TabsModel, isRunnable, langOf, libTabName, type Prefs, type Tab } from "./model";
import "../editor/editor.css";
import "./tabs.css";

export interface TabsEditorApi extends EditorApi {
  /** Se cambió la pestaña activa (o su nombre): el depurador debe repintar. */
  onSwitch(cb: () => void): void;
  /** Nombre del último programa construido (título de la ROM, nombre del .sav). */
  builtName(): string;
  readonly model: TabsModel;
}

const KEEP_WRAM_KEY = "gbc.editor.keepWram";
const SIDE_KEY = "gbc.tabs.side";
const SAVE_DELAY_MS = 400;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function mountTabsEditor(container: HTMLElement, deps: { core: Core; resume: () => void }): TabsEditorApi {
  const storage = browserStorage();
  const prefs: Prefs = {
    get: (k) => { try { return storage?.getItem(k) ?? null; } catch { return null; } },
    set: (k, v) => { try { storage?.setItem(k, v); } catch { /* sin almacenamiento */ } },
  };
  const model = TabsModel.load(prefs, {
    asm: DEFAULT_ASM_EXAMPLE.files.get(DEFAULT_ASM_EXAMPLE.main)!,
    c: DEFAULT_C_EXAMPLE && { files: DEFAULT_C_EXAMPLE.files, main: DEFAULT_C_EXAMPLE.main },
    start: ccCompile ? "c" : "asm",
  });
  const buildCbs: Array<(r: { ok: boolean; result: AsmResult }) => void> = [];
  const toggleCbs: Array<(line: number) => void> = [];
  const switchCbs: Array<() => void> = [];
  const states = new Map<number, EditorState>();
  const scrollTops = new Map<number, number>();
  /** Diagnósticos de la última construcción, por nombre de pestaña. */
  let diagsByTab = new Map<string, TabDiag[]>();
  /** Ensamblador generado por la última compilación C (para la pestaña de sólo lectura). */
  let genText = "";
  let built = model.main?.name ?? "main.asm";

  // ---- DOM ----
  const root = el("div", "ed tabs-ed");
  const bar = el("div", "ed-bar");
  const sideBtn = el("button", "tabs-side-btn", "☰");
  sideBtn.title = "Mostrar u ocultar la lista de ficheros (Ctrl+B)";
  const examples = el("select", "ed-examples");
  examples.title = "Abrir un ejemplo en pestañas y ejecutarlo";
  examples.append(new Option("Ejemplos…", ""));
  const groups: Array<[string, readonly TabExample[]]> = [["C", C_EXAMPLES], ["Ensamblador", ASM_EXAMPLES]];
  for (const [label, list] of groups) {
    const g = el("optgroup");
    g.label = label;
    for (const ex of list) g.append(new Option(ex.title, ex.id));
    examples.append(g);
  }
  const buildBtn = el("button", "ed-build", "▶ Construir y ejecutar");
  buildBtn.title = "Construir la pestaña activa (o la principal ▶), cargar la ROM y arrancar (Ctrl+Enter)";
  const genBtn = el("button", "tabs-gen-btn", "Ver ensamblador");
  genBtn.title = "Ensamblador generado por el compilador de C en la última construcción (sólo lectura)";
  const keepLabel = el("label", "ed-keep");
  keepLabel.title = "Conservar la WRAM al reiniciar, para iterar sin perder el estado";
  const keep = el("input");
  keep.type = "checkbox";
  keep.checked = prefs.get(KEEP_WRAM_KEY) === "1";
  keep.onchange = () => prefs.set(KEEP_WRAM_KEY, keep.checked ? "1" : "0");
  keepLabel.append(keep, " Mantener WRAM");
  bar.append(sideBtn, examples, buildBtn, genBtn, keepLabel);

  const strip = el("div", "tabs-strip");
  strip.setAttribute("role", "tablist");
  strip.setAttribute("aria-label", "Ficheros abiertos");
  const body = el("div", "tabs-body");
  const side = el("nav", "tabs-side");
  side.setAttribute("aria-label", "Ficheros");
  const host = el("div", "ed-cm");
  body.append(side, host);
  const status = el("div", "ed-status", "Ctrl+Enter: construir y ejecutar · Ctrl+B: lista de ficheros");
  status.setAttribute("role", "status");
  root.append(bar, strip, body, status);
  container.append(root);

  const setSide = (open: boolean): void => {
    root.classList.toggle("side-open", open);
    sideBtn.classList.toggle("on", open);
    prefs.set(SIDE_KEY, open ? "1" : "0");
  };
  setSide(prefs.get(SIDE_KEY) === "1");

  const say = (text: string, level: "ok" | "warning" | "error" | "" = ""): void => {
    status.textContent = text;
    if (level) status.dataset.level = level; else delete status.dataset.level;
  };

  // ---- Guardado (con retardo; se fuerza antes de construir y al salir) ----
  let saveTimer = 0;
  const saveNow = (): void => { clearTimeout(saveTimer); saveTimer = 0; model.save(prefs); };
  const scheduleSave = (): void => { clearTimeout(saveTimer); saveTimer = window.setTimeout(saveNow, SAVE_DELAY_MS); };
  window.addEventListener("pagehide", saveNow);

  // ---- Estados de CodeMirror ----
  const buildKey = Prec.highest(keymap.of([
    { key: "Mod-Enter", run: () => { doBuild(); return true; } },
    { key: "Mod-b", run: () => { setSide(!root.classList.contains("side-open")); return true; } },
  ]));
  const bpGutter = gutter({
    class: "cm-bp-gutter",
    markers: (v) => v.state.field(bpField),
    initialSpacer: () => spacer,
    domEventHandlers: {
      mousedown(v, line) {
        const n = v.state.doc.lineAt(line.from).number;
        for (const cb of toggleCbs) cb(n);
        return true;
      },
    },
  });

  function extensions(tab: Tab): Extension[] {
    const c = langOf(tab) === "c";
    const ext: Extension[] = [
      buildKey, bpField, execField, bpGutter, lineNumbers(), lintGutter(), highlightActiveLineGutter(),
      history(), drawSelection(), bracketMatching(), highlightActiveLine(),
      indentUnit.of("    "), EditorState.tabSize.of(c ? 4 : 8),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      c ? cLang() : sm83(), theme,
    ];
    if (tab.ro) ext.push(EditorState.readOnly.of(true));
    else {
      const id = tab.id;
      ext.push(EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        const t = model.get(id);
        if (!t) return;
        const wasRunnable = isRunnable(t);
        t.text = u.state.doc.toString();
        scheduleSave();
        if (isRunnable(t) !== wasRunnable) render(); // se escribió o borró main()
      }));
    }
    return ext;
  }

  /** Estado nuevo de `tab` con su texto y los diagnósticos de la última construcción. */
  function freshState(tab: Tab): EditorState {
    const s = EditorState.create({ doc: tab.text, extensions: extensions(tab) });
    return withDiags(s, tab.name);
  }
  function diagsFor(doc: EditorState["doc"], name: string): ReturnType<typeof toDiagnostics> {
    const ds = diagsByTab.get(name) ?? [];
    const of = (sev: "error" | "warning") =>
      ds.filter((d) => d.severity === sev).map((d) => ({ file: name, line: d.line, col: d.col, msg: d.msg }));
    return toDiagnostics(docLines(doc), name, of("error"), of("warning"));
  }
  function withDiags(s: EditorState, name: string): EditorState {
    return s.update(setDiagnostics(s, diagsFor(s.doc, name))).state;
  }
  function stateOf(tab: Tab): EditorState {
    let s = states.get(tab.id);
    if (!s) { s = freshState(tab); states.set(tab.id, s); }
    return s;
  }

  const first = model.active ?? model.tabs[0]!;
  model.setActive(first.id);
  const view = new EditorView({ parent: host, state: stateOf(first) });
  let shownId = first.id;

  /** Guarda el estado de la pestaña mostrada (antes de cambiar de pestaña o de estado). */
  function stash(): void {
    if (!model.get(shownId)) return;
    states.set(shownId, view.state);
    scrollTops.set(shownId, view.scrollDOM.scrollTop);
  }

  /** Muestra la pestaña activa del modelo en el EditorView. */
  function show(focus = false): void {
    const tab = model.active;
    if (!tab) return;
    if (tab.id !== shownId) {
      stash();
      shownId = tab.id;
      view.setState(stateOf(tab));
      // La línea en ejecución la vuelve a poner el depurador si está en esta pestaña.
      view.dispatch({ effects: setExec.of(null) });
      const top = scrollTops.get(tab.id) ?? 0;
      requestAnimationFrame(() => { view.scrollDOM.scrollTop = top; });
      for (const cb of switchCbs) cb();
    }
    render();
    if (focus) view.focus();
  }

  /** Sustituye el estado de `tab` (texto o lenguaje nuevos); si es la visible, en el view. */
  function replaceState(tab: Tab): void {
    const s = freshState(tab);
    states.set(tab.id, s);
    if (tab.id === shownId) view.setState(s);
  }

  function activate(id: number, focus = true): void {
    model.setActive(id);
    if (!model.get(id)?.ro) scheduleSave();
    show(focus);
  }

  // ---- Pestañas: barra y lista lateral ----
  let renaming: number | null = null;

  function render(): void {
    strip.replaceChildren();
    for (const tab of model.tabs) strip.append(tabButton(tab));
    const add = el("button", "tabs-add", "+");
    add.title = "Fichero nuevo (.asm, .inc, .c o .h)";
    add.onclick = () => newFile("asm");
    strip.append(add);
    renderSide();
    genBtn.disabled = genText === "";
  }

  function tabButton(tab: Tab): HTMLElement {
    const b = el("div", "tabs-tab");
    b.setAttribute("role", "tab");
    b.tabIndex = tab.id === model.activeId ? 0 : -1;
    b.setAttribute("aria-selected", String(tab.id === model.activeId));
    b.dataset.id = String(tab.id);
    if (tab.ro) b.classList.add("ro");
    if (tab.id === model.mainId) b.classList.add("main");
    b.title = tab.ro
      ? tab.ro === "gen" ? "Ensamblador generado (sólo lectura)" : "Librería de C (sólo lectura)"
      : `${tab.name}${tab.id === model.mainId ? " · principal (lo que ejecuta Ctrl+Enter si la activa no se puede ejecutar)" : ""} · doble clic: renombrar`;
    if (tab.id === model.mainId) b.append(el("span", "tabs-main", "▶"));
    if (renaming === tab.id) b.append(renameInput(tab));
    else b.append(el("span", "tabs-name", tab.name));
    const x = el("button", "tabs-close", "×");
    x.title = "Cerrar";
    x.tabIndex = -1;
    x.onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };
    b.append(x);
    b.onclick = () => { if (renaming !== tab.id) activate(tab.id); };
    b.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } };
    b.ondblclick = () => startRename(tab.id);
    b.onkeydown = (e) => tabKey(e, tab);
    return b;
  }

  function tabKey(e: KeyboardEvent, tab: Tab): void {
    if (renaming === tab.id) return;
    const i = model.indexOf(tab.id);
    let to: Tab | undefined;
    if (e.key === "ArrowRight") to = model.tabs[(i + 1) % model.tabs.length];
    else if (e.key === "ArrowLeft") to = model.tabs[(i - 1 + model.tabs.length) % model.tabs.length];
    else if (e.key === "Home") to = model.tabs[0];
    else if (e.key === "End") to = model.tabs[model.tabs.length - 1];
    else if (e.key === "F2") { e.preventDefault(); e.stopPropagation(); startRename(tab.id); return; }
    else if (e.key === "Delete") { e.preventDefault(); closeTab(tab.id); return; }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(tab.id); return; }
    else return;
    e.preventDefault();
    if (!to) return;
    activate(to.id, false);
    (strip.querySelector(`[data-id="${to.id}"]`) as HTMLElement | null)?.focus();
  }

  function renameInput(tab: Tab): HTMLInputElement {
    const inp = el("input", "tabs-rename");
    inp.value = tab.name;
    inp.size = Math.max(6, tab.name.length + 1);
    inp.setAttribute("aria-label", "Nuevo nombre");
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      renaming = null;
      if (commit && inp.value !== tab.name) renameTab(tab, inp.value);
      render();
      view.focus();
    };
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    };
    inp.onblur = () => finish(true);
    inp.onclick = (e) => e.stopPropagation();
    inp.ondblclick = (e) => e.stopPropagation();
    return inp;
  }

  function startRename(id: number): void {
    const tab = model.get(id);
    if (!tab || tab.ro) return;
    renaming = id;
    render();
    const inp = strip.querySelector<HTMLInputElement>(".tabs-rename");
    if (inp) { inp.focus(); inp.setSelectionRange(0, inp.value.replace(/\.[^.]*$/, "").length); }
  }

  function renameTab(tab: Tab, name: string): void {
    const oldLang = langOf(tab);
    const err = model.rename(tab.id, name.trim());
    if (err) { say(err, "error"); return; }
    if (langOf(tab) !== oldLang) { stash(); replaceState(tab); }
    saveNow();
    say(`Renombrada a «${tab.name}»`);
    if (tab.id === shownId) for (const cb of switchCbs) cb();
  }

  function newFile(ext: "asm" | "inc" | "c" | "h"): void {
    const name = window.prompt("Nombre del fichero nuevo (.asm, .inc, .c o .h):", model.freeName("nuevo", ext));
    if (name === null) return;
    let tab: Tab;
    try { tab = model.add(name.trim(), ""); }
    catch (e) { say((e as Error).message, "error"); return; }
    saveNow();
    activate(tab.id);
  }

  function closeTab(id: number): void {
    const tab = model.get(id);
    if (!tab) return;
    const valuable = !tab.ro && tab.text.trim() !== "" && !isExampleText(tab.text);
    if (valuable && !window.confirm(`¿Cerrar «${tab.name}»? Se perderá su contenido.`)) return;
    const wasLastUser = !tab.ro && model.user.length === 1;
    model.close(id);
    if (wasLastUser) replaceState(tab); // la última pestaña de usuario se vacía, no se cierra
    else { states.delete(id); scrollTops.delete(id); }
    if (!tab.ro) saveNow();
    show();
  }

  function renderSide(): void {
    side.replaceChildren();
    const section = (title: string): HTMLElement => {
      const h = el("div", "tabs-side-title", title);
      side.append(h);
      const ul = el("ul", "tabs-side-list");
      side.append(ul);
      return ul;
    };
    const item = (ul: HTMLElement, label: string, opts: { active?: boolean; main?: boolean; ro?: boolean; title?: string; onClick: () => void; onDbl?: () => void }): void => {
      const li = el("li");
      const b = el("button", "tabs-side-item");
      if (opts.active) b.classList.add("active");
      if (opts.ro) b.classList.add("ro");
      if (opts.main) b.append(el("span", "tabs-main", "▶"));
      b.append(el("span", "tabs-name", label));
      if (opts.title) b.title = opts.title;
      b.onclick = opts.onClick;
      if (opts.onDbl) b.ondblclick = opts.onDbl;
      li.append(b);
      ul.append(li);
    };

    const proj = section("Proyecto");
    const sorted = [...model.user].sort((a, b) => a.name.localeCompare(b.name));
    for (const t of sorted) {
      item(proj, t.name, {
        active: t.id === model.activeId, main: t.id === model.mainId,
        title: `${t.name} · doble clic: renombrar`,
        onClick: () => activate(t.id), onDbl: () => startRename(t.id),
      });
    }
    const nu = el("div", "tabs-side-new");
    nu.append("Nuevo:");
    for (const ext of ["c", "h", "asm", "inc"] as const) {
      const b = el("button", "", `.${ext}`);
      b.title = `Fichero .${ext} nuevo`;
      b.onclick = () => newFile(ext);
      nu.append(b);
    }
    side.append(nu);

    if (clibFiles.size > 0) {
      const lib = section("Librería de C");
      for (const name of [...clibFiles.keys()].sort()) {
        const tn = libTabName(name);
        item(lib, name, { ro: true, active: model.active?.name === tn, title: "Sólo lectura", onClick: () => openLib(name) });
      }
    }
    if (genText !== "") {
      const gen = section("Generado");
      item(gen, GEN_NAME, { ro: true, active: model.active?.name === GEN_NAME, title: "Ensamblador de la última compilación C", onClick: openGen });
    }
  }

  function openLib(name: string): void {
    const text = clibFiles.get(name);
    if (text === undefined) return;
    const tab = model.addReadOnly(libTabName(name), text, "lib");
    activate(tab.id);
  }

  function openGen(): void {
    if (genText === "") return;
    const existed = model.find(GEN_NAME);
    const tab = model.addReadOnly(GEN_NAME, genText, "gen");
    if (existed) replaceState(tab);
    activate(tab.id);
  }

  // ---- Ejemplos ----
  function openExample(ex: TabExample): void {
    // Pestañas con el mismo nombre y cambios propios: se pide confirmación una vez.
    const clash = [...ex.files].filter(([name, text]) => {
      const t = model.find(name);
      return t && !t.ro && t.text !== text && t.text.trim() !== "" && !isExampleText(t.text);
    }).map(([name]) => name);
    if (clash.length > 0 && !window.confirm(`¿Sustituir ${clash.map((n) => `«${n}»`).join(", ")} por el ejemplo «${ex.title}»? Se perderán los cambios.`)) return;
    let mainTab: Tab | undefined;
    for (const [name, text] of ex.files) {
      let t = model.find(name);
      if (t && !t.ro) { if (t.text !== text) { t.text = text; replaceState(t); } }
      else t = model.add(name, text, model.tabs.length);
      if (name === ex.main) mainTab = t;
    }
    if (!mainTab) return;
    model.setActive(mainTab.id);
    model.setMain(mainTab.id);
    saveNow();
    show();
    doBuild();
  }

  // ---- Construir ----
  /** Diagnósticos de la última construcción en todas las pestañas con estado. */
  function applyDiags(): void {
    for (const tab of model.tabs) {
      if (tab.id === shownId) { view.dispatch(setDiagnostics(view.state, diagsFor(view.state.doc, tab.name))); continue; }
      const s = states.get(tab.id);
      if (s) states.set(tab.id, withDiags(s, tab.name));
    }
  }

  function doBuild(): void {
    saveNow();
    stash();
    const target = model.runTarget();
    if (!target) {
      say("Nada que ejecutar: abre un .asm o un .c con main() (o marca la principal ejecutándola).", "error");
      return;
    }
    model.setMain(target.id);
    saveNow();
    let r: ReturnType<typeof buildTabs>;
    try {
      r = buildTabs(model, target, { keepWram: keep.checked }, deps.core);
    } catch (e) {
      say(`No se pudo construir: ${(e as Error).message}`, "error");
      return;
    }
    diagsByTab = new Map();
    for (const d of r.diags) {
      const list = diagsByTab.get(d.tab) ?? [];
      list.push(d);
      diagsByTab.set(d.tab, list);
    }
    if (r.cc && r.cc.asm !== "") genText = r.cc.asm;
    // Errores sólo en el generado (o en la librería): se abre su pestaña para que se vean.
    const firstErr = r.diags.find((d) => d.severity === "error");
    if (firstErr && !model.find(firstErr.tab)) {
      if (firstErr.tab === GEN_NAME && genText !== "") model.addReadOnly(GEN_NAME, genText, "gen");
      else if (firstErr.tab.startsWith("<")) {
        const text = clibFiles.get(firstErr.tab.slice(1, -1));
        if (text !== undefined) model.addReadOnly(firstErr.tab, text, "lib");
      }
    }
    const gen = model.find(GEN_NAME);
    if (gen?.ro === "gen" && gen.text !== genText) { gen.text = genText; replaceState(gen); }
    applyDiags();
    say(r.status.text, r.status.level);
    if (r.ok) { built = target.name; deps.resume(); }
    render();
    if (r.result) for (const cb of buildCbs) cb({ ok: r.ok, result: r.result });
  }

  // ---- Barra ----
  sideBtn.onclick = () => setSide(!root.classList.contains("side-open"));
  buildBtn.onclick = () => { doBuild(); view.focus(); };
  genBtn.onclick = openGen;
  examples.onchange = () => {
    const ex = tabExampleById(examples.value);
    examples.value = "";
    if (ex) openExample(ex);
  };
  // Atajos también con el foco en la barra, las pestañas o la lista (no sólo en el texto).
  root.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === "Enter") { e.preventDefault(); doBuild(); }
    else if (e.key.toLowerCase() === "b" && !e.shiftKey) { e.preventDefault(); setSide(!root.classList.contains("side-open")); }
  });

  render();

  const api: TabsEditorApi = {
    model,
    getSource: () => view.state.doc.toString(),
    setSource(text) {
      const tab = model.active;
      if (!tab || tab.ro) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        effects: [setExec.of(null), EditorView.scrollIntoView(0)],
      });
      view.dispatch(setDiagnostics(view.state, []));
    },
    /** Pestaña activa; las de la librería con su nombre de fichero (el del lineMap). */
    fileName() {
      const t = model.active;
      if (!t) return "main.asm";
      return t.ro === "lib" ? t.name.slice(1, -1) : t.name;
    },
    builtName: () => built,
    onBuild(cb) { buildCbs.push(cb); },
    onSwitch(cb) { switchCbs.push(cb); },
    setBreakpointLines(lines) { view.dispatch({ effects: setBpLines.of(lines) }); },
    onToggleBreakpoint(cb) { toggleCbs.push(cb); },
    showExecLine(line) {
      const effects: StateEffect<unknown>[] = [setExec.of(line)];
      if (line !== null && line >= 1 && line <= view.state.doc.lines)
        effects.push(EditorView.scrollIntoView(view.state.doc.line(line).from, { y: "nearest" }));
      view.dispatch({ effects });
    },
    cursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
    focus() { view.focus(); },
  };
  return api;
}
