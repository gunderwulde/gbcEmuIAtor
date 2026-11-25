// Línea de estado del editor tras construir: errores, tamaño de la ROM y tiempo. TS puro.
import type { BuildResult } from "../run";

export interface StatusLine {
  text: string;
  level: "ok" | "warning" | "error";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function buildStatus(r: BuildResult, file: string): StatusLine {
  const ms = `${r.ms < 10 ? r.ms.toFixed(1) : Math.round(r.ms)} ms`;
  const { errors, warnings } = r.result;
  if (errors.length > 0) {
    const first = errors[0]!;
    const where = first.file === file ? `línea ${first.line}` : `${first.file}:${first.line}`;
    return { level: "error", text: `${plural(errors.length, "error", "errores")} · ${where}: ${first.msg} · ${ms}` };
  }
  if (!r.ok) return { level: "error", text: `Cabecera: ${r.headerErrors.join("; ") || "error desconocido"} · ${ms}` };
  const size = r.rom ? `${r.rom.length / 1024} KB` : "";
  const warn = warnings.length ? ` · ${plural(warnings.length, "aviso", "avisos")}` : "";
  return { level: warnings.length ? "warning" : "ok", text: `Sin errores · ROM ${size}${warn} · ${ms}` };
}
