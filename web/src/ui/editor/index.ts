// Piezas del editor del IDE (I1) que monta el editor de pestañas (U1, web/src/ui/tabs):
// la API que ve el depurador (D1), el margen de breakpoints, la línea en ejecución y el
// tema. El editor no guarda la verdad de los breakpoints: avisa del clic y el depurador
// le devuelve el conjunto con setBreakpointLines.
import { RangeSet, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, type DecorationSet } from "@codemirror/view";
import type { AsmResult } from "../../asm";
import type { DocLines } from "./diagnostics";

export interface EditorApi {
  getSource(): string;
  setSource(text: string): void;
  fileName(): string;
  onBuild(cb: (r: { ok: boolean; result: AsmResult }) => void): void;
  setBreakpointLines(lines: ReadonlySet<number>): void;
  onToggleBreakpoint(cb: (line: number) => void): void;
  showExecLine(line: number | null): void;
  /** Línea (base 1) donde está el cursor principal. */
  cursorLine(): number;
  focus(): void;
}

// --- Margen de breakpoints ---------------------------------------------------------

class BreakpointMarker extends GutterMarker {
  override toDOM(): Node {
    const d = document.createElement("span");
    d.className = "cm-bp-dot";
    d.textContent = "●";
    return d;
  }
}
export const bpMarker = new BreakpointMarker();
export const spacer = new (class extends GutterMarker {
  override toDOM(): Node { return document.createTextNode("●"); }
})();

export const setBpLines = StateEffect.define<ReadonlySet<number>>();
export const bpField = StateField.define<RangeSet<GutterMarker>>({
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

export const setExec = StateEffect.define<number | null>();
const execDeco = Decoration.line({ class: "cm-exec-line" });
export const execField = StateField.define<DecorationSet>({
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

export const theme = EditorView.theme({
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

export function docLines(doc: Text): DocLines {
  return { lines: doc.lines, line: (n) => { const l = doc.line(n); return { from: l.from, text: l.text }; } };
}
