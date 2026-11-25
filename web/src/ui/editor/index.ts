// Editor del IDE (I1): CodeMirror 6 con el lenguaje SM83/RGBDS, errores del ensamblador
// como diagnósticos, guardado automático, ejemplos y «Construir y ejecutar» (Ctrl+Enter).
// También expone al depurador (D1) el margen de breakpoints y la línea en ejecución; el
// editor no guarda la verdad de los breakpoints: avisa del clic y el depurador le
// devuelve el conjunto con setBreakpointLines.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentUnit } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { EditorState, Prec, RangeSet, StateEffect, StateField, type Text } from "@codemirror/state";
import {
  Decoration, EditorView, GutterMarker, drawSelection, gutter, highlightActiveLine,
  highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet,
} from "@codemirror/view";
import type { AsmResult } from "../../asm";
import type { Core } from "../../emu/core";
import { buildAndRun, type BuildResult } from "../run";
import { Autosave, browserStorage } from "./autosave";
import { toDiagnostics, type DocLines } from "./diagnostics";
import { EXAMPLES, exampleById } from "./examples";
import { sm83 } from "./language";
import { buildStatus } from "./status";
import "./editor.css";

export interface EditorApi {
  getSource(): string;
  setSource(text: string): void;
  fileName(): string;
  onBuild(cb: (r: { ok: boolean; result: AsmResult }) => void): void;
  setBreakpointLines(lines: ReadonlySet<number>): void;
  onToggleBreakpoint(cb: (line: number) => void): void;
  showExecLine(line: number | null): void;
  focus(): void;
}

const FILE = "main.asm";
const KEEP_WRAM_KEY = "gbc.editor.keepWram";

// --- Margen de breakpoints ---------------------------------------------------------

class BreakpointMarker extends GutterMarker {
  override toDOM(): Node {
    const d = document.createElement("span");
    d.className = "cm-bp-dot";
    d.textContent = "●";
    return d;
  }
}
const bpMarker = new BreakpointMarker();
const spacer = new (class extends GutterMarker {
  override toDOM(): Node { return document.createTextNode("●"); }
})();

const setBpLines = StateEffect.define<ReadonlySet<number>>();
const bpField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setBpLines)) continue;
      const doc = tr.state.doc;
      const lines = [...e.value].filter((n) => n >= 1 && n <= doc.lines).sort((a, b) => a - b);
      set = RangeSet.of(lines.map((n) => bpMarker.range(doc.line(n).from)));
    }
    return set;
  },
});

// --- Línea en ejecución ----------------------------------------------------------------

const setExec = StateEffect.define<number | null>();
const execDeco = Decoration.line({ class: "cm-exec-line" });
const execField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setExec)) continue;
      const n = e.value;
      deco = n !== null && n >= 1 && n <= tr.state.doc.lines
        ? Decoration.set([execDeco.range(tr.state.doc.line(n).from)])
        : Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- Tema oscuro (variables de web/src/style.css) ------------------------------------

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--fg)", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace", lineHeight: "1.45" },
  ".cm-content": { caretColor: "var(--accent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#2e3c64 !important" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--dim)", borderRight: "1px solid var(--line)" },
  ".cm-activeLine": { backgroundColor: "#ffffff08" },
  ".cm-activeLineGutter": { backgroundColor: "#ffffff0d", color: "var(--fg)" },
  ".cm-matchingBracket": { outline: "1px solid var(--dim)", backgroundColor: "transparent" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--line)", color: "var(--fg)" },
}, { dark: true });

function docLines(doc: Text): DocLines {
  return { lines: doc.lines, line: (n) => { const l = doc.line(n); return { from: l.from, text: l.text }; } };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function mountEditor(container: HTMLElement, deps: { core: Core; resume: () => void }): EditorApi {
  const storage = browserStorage();
  const autosave = new Autosave(storage, `gbc.editor.src:${FILE}`);
  const buildCbs: Array<(r: { ok: boolean; result: AsmResult }) => void> = [];
  const toggleCbs: Array<(line: number) => void> = [];

  // Barra: ejemplos, construir, mantener WRAM.
  const root = el("div", "ed");
  const bar = el("div", "ed-bar");
  const examples = el("select", "ed-examples");
  examples.title = "Cargar un ejemplo (sustituye el código)";
  examples.append(new Option("Ejemplos…", ""));
  for (const ex of EXAMPLES) examples.append(new Option(ex.title, ex.id));
  const buildBtn = el("button", "ed-build", "▶ Construir y ejecutar");
  buildBtn.title = "Ensamblar, cargar la ROM y arrancar (Ctrl+Enter)";
  const keepLabel = el("label", "ed-keep");
  keepLabel.title = "Conservar la WRAM al reiniciar, para iterar sin perder el estado";
  const keep = el("input");
  keep.type = "checkbox";
  try { keep.checked = storage?.getItem(KEEP_WRAM_KEY) === "1"; } catch { /* sin almacenamiento */ }
  keep.onchange = () => { try { storage?.setItem(KEEP_WRAM_KEY, keep.checked ? "1" : "0"); } catch { /* idem */ } };
  keepLabel.append(keep, " Mantener WRAM");
  bar.append(examples, buildBtn, keepLabel);
  const host = el("div", "ed-cm");
  const status = el("div", "ed-status", "Ctrl+Enter: construir y ejecutar");
  status.setAttribute("role", "status");
  root.append(bar, host, status);
  container.append(root);

  function doBuild(): void {
    autosave.flush();
    const src = view.state.doc.toString();
    let r: BuildResult;
    try {
      r = buildAndRun(deps.core, src, { file: FILE, keepWram: keep.checked });
    } catch (e) {
      // gb_insert rechazó la ROM (no debería: la cabecera la acaba de validar E1).
      status.textContent = `No se pudo cargar la ROM: ${(e as Error).message}`;
      status.dataset.level = "error";
      return;
    }
    const diags = toDiagnostics(docLines(view.state.doc), FILE, r.result.errors, r.result.warnings);
    view.dispatch(setDiagnostics(view.state, diags));
    const st = buildStatus(r, FILE);
    status.textContent = st.text;
    status.dataset.level = st.level;
    if (r.ok) deps.resume();
    for (const cb of buildCbs) cb({ ok: r.ok, result: r.result });
  }

  const initial = autosave.load() ?? exampleById("hello")!.source;
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: initial,
      extensions: [
        Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => { doBuild(); return true; } }])),
        bpField,
        execField,
        gutter({
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
        }),
        lineNumbers(),
        lintGutter(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        bracketMatching(),
        highlightActiveLine(),
        indentUnit.of("    "),
        EditorState.tabSize.of(8),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        sm83(),
        theme,
        EditorView.updateListener.of((u) => { if (u.docChanged) autosave.schedule(u.state.doc.toString()); }),
      ],
    }),
  });

  buildBtn.onclick = () => { doBuild(); view.focus(); };
  examples.onchange = () => {
    const ex = exampleById(examples.value);
    examples.value = "";
    if (!ex) return;
    const cur = view.state.doc.toString();
    const pristine = cur.trim() === "" || EXAMPLES.some((e) => e.source === cur);
    if (!pristine && !window.confirm(`¿Sustituir el código actual por el ejemplo «${ex.title}»? Se perderán los cambios.`)) return;
    api.setSource(ex.source);
    doBuild();
  };
  window.addEventListener("pagehide", () => autosave.flush());

  const api: EditorApi = {
    getSource: () => view.state.doc.toString(),
    setSource(text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        effects: [setExec.of(null), EditorView.scrollIntoView(0)],
      });
      view.dispatch(setDiagnostics(view.state, []));
    },
    fileName: () => FILE,
    onBuild(cb) { buildCbs.push(cb); },
    setBreakpointLines(lines) { view.dispatch({ effects: setBpLines.of(lines) }); },
    onToggleBreakpoint(cb) { toggleCbs.push(cb); },
    showExecLine(line) {
      const effects: StateEffect<unknown>[] = [setExec.of(line)];
      if (line !== null && line >= 1 && line <= view.state.doc.lines)
        effects.push(EditorView.scrollIntoView(view.state.doc.line(line).from, { y: "nearest" }));
      view.dispatch({ effects });
    },
    focus() { view.focus(); },
  };
  return api;
}
