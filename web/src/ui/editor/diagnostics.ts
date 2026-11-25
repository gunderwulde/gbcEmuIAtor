// Errores y avisos del ensamblador → diagnósticos del editor (posiciones absolutas en el
// documento). TS puro: el documento se describe con una función que da el texto de cada
// línea (1-based), así que se prueba sin CodeMirror.
import type { AsmError } from "../../asm";

export interface EditorDiagnostic {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
}

export interface DocLines {
  lines: number;
  /** Texto de la línea `n` (1-based) y su desplazamiento en el documento. */
  line(n: number): { from: number; text: string };
}

/** Documento a partir de un texto plano (para tests y para quien no use CodeMirror). */
export function textLines(text: string): DocLines {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return {
    lines: starts.length,
    line(n) {
      const from = starts[n - 1]!;
      const end = n < starts.length ? starts[n]! - 1 : text.length;
      return { from, text: text.slice(from, end).replace(/\r$/, "") };
    },
  };
}

/**
 * Sólo los mensajes de `file` (los de un INCLUDE no se pueden subrayar en este fichero).
 * El subrayado empieza en la columna del error (1-based) y abarca la palabra que hay ahí;
 * sin columna, o fuera de la línea, abarca la línea sin la sangría ni el comentario.
 */
export function toDiagnostics(
  doc: DocLines,
  file: string,
  errors: readonly AsmError[],
  warnings: readonly AsmError[] = [],
): EditorDiagnostic[] {
  const out: EditorDiagnostic[] = [];
  const add = (e: AsmError, severity: "error" | "warning") => {
    if (e.file !== file || doc.lines < 1) return;
    const n = Math.min(Math.max(e.line, 1), doc.lines);
    const { from, text } = doc.line(n);
    let a: number, b: number;
    if (e.col >= 1 && e.col <= text.length) {
      a = e.col - 1;
      const m = /^(?:"[^"]*"?|[\w.$%#@`]+|\S)/.exec(text.slice(a));
      b = a + (m ? m[0].length : 1);
    } else {
      const body = text.replace(/;.*$/, "").trimEnd();
      a = body.length - body.trimStart().length;
      b = body.length;
    }
    if (b <= a) b = Math.min(a + 1, text.length);
    out.push({ from: from + a, to: from + Math.max(a, b), severity, message: e.msg });
  };
  for (const e of errors) add(e, "error");
  for (const w of warnings) add(w, "warning");
  return out;
}

/** Errores de otros ficheros (INCLUDE): se resumen en la línea de estado. */
export function otherFileErrors(file: string, errors: readonly AsmError[]): AsmError[] {
  return errors.filter((e) => e.file !== file);
}
