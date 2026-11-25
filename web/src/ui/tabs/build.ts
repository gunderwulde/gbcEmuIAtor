// U1: de pestañas a programa en marcha. Puro (sin DOM): lo usan la UI y los tests contra
// el núcleo real.
//
//  .asm → build/buildAndRun de I1 (INCLUDE = pestañas .asm/.inc de usuario y librería)
//  .c   → compile(.c principal + .h + .c sin main, includeResolver = pestañas y librería)
//         → texto generado (pestaña GEN_NAME) → build/buildAndRun de I1
//
// Los errores se traducen a (pestaña, línea): los del compilador van a su fichero; los
// del ensamblador sobre el texto generado van a la pestaña generada y, además, a la línea
// C de la que sale esa línea. El lineMap que se entrega al depurador ya está en líneas C.
import type { AsmError, AsmResult } from "../../asm";
import { build, buildAndRun, titleFor, type BuildResult, type RunTarget } from "../run";
import { buildStatus, type StatusLine } from "../editor/status";
import { ccCompile, clibFiles, clibResolver, type CcOutput, type CompileFn, type IncludeResolver } from "./deps";
import { GEN_NAME, kindOf, libTabName, type Tab, type TabsModel } from "./model";
import { asmLineOwners, cLineOf, mapToC } from "./srcmap";

export interface TabDiag {
  /** Pestaña: nombre de usuario, GEN_NAME o "<fichero de la librería>". */
  tab: string;
  line: number;
  /** 1-based (0 = sin columna). */
  col: number;
  msg: string;
  severity: "error" | "warning";
}

export interface TabsBuild {
  target: Tab;
  kind: "asm" | "c";
  /** Construido (y, con núcleo, insertado y reiniciado). */
  ok: boolean;
  /** Ensamblado, con el lineMap ya en líneas C si el programa es C. Sin ensamblar: undefined. */
  result?: AsmResult;
  /** Resultado de I1 (ROM con cabecera, errores de cabecera). */
  run?: BuildResult;
  /** Salida del compilador (sólo C). */
  cc?: CcOutput;
  diags: TabDiag[];
  status: StatusLine;
}

export interface TabsBuildOptions {
  keepWram?: boolean;
  /** Por defecto, el de K1 (deps.ts). Los tests pueden inyectar otro. */
  compile?: CompileFn;
  /** Por defecto, el de la librería de L1 (deps.ts). */
  resolver?: IncludeResolver;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const msText = (ms: number): string => `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;

/** Pestaña de un fichero que nombra el compilador o el ensamblador. */
export function tabOf(model: TabsModel, file: string): string {
  if (file === GEN_NAME) return file;
  const base = file.replace(/^.*[\\/]/, "");
  const t = model.find(base);
  if (t && !t.ro) return t.name;
  return clibFiles.has(base) ? libTabName(base) : base;
}

/**
 * Construye `target` (una pestaña .asm, o un .c con main) y, si se da `core` y no hay
 * errores, inserta la ROM y reinicia (buildAndRun de I1). Con errores el núcleo no se toca.
 */
export function buildTabs(model: TabsModel, target: Tab, opts: TabsBuildOptions = {}, core?: RunTarget): TabsBuild {
  const resolver = opts.resolver ?? clibResolver;
  const include = (name: string, from: string): string | undefined => model.userText(name) ?? resolver?.(name, from);
  const runOpts = { files: model.asmFiles(), include, keepWram: opts.keepWram, title: titleFor(target.name) };
  const assembleIt = (source: string, file: string): BuildResult =>
    core ? buildAndRun(core, source, { ...runOpts, file }) : build(source, { ...runOpts, file });

  if (kindOf(target.name) !== "c") {
    const run = assembleIt(target.text, target.name);
    const diags = [
      ...run.result.errors.map((e) => asmDiag(e, tabOf(model, e.file), "error")),
      ...run.result.warnings.map((e) => asmDiag(e, tabOf(model, e.file), "warning")),
    ];
    return { target, kind: "asm", ok: run.ok, result: run.result, run, diags, status: buildStatus(run, target.name) };
  }

  const compile = opts.compile ?? ccCompile;
  if (!compile) {
    return {
      target, kind: "c", ok: false, diags: [],
      status: { level: "error", text: "El compilador de C aún no está disponible en esta versión." },
    };
  }
  const t0 = now();
  const cc = compile(model.cFiles(target), { main: target.name, includeResolver: include });
  const tc = now() - t0;
  const diags: TabDiag[] = cc.errors.map((e) => ({ tab: tabOf(model, e.file), line: e.line, col: e.col, msg: e.msg, severity: e.severity }));
  const ccErrs = diags.filter((d) => d.severity === "error");
  const ccWarns = diags.length - ccErrs.length;
  if (ccErrs.length > 0 || cc.asm === "") {
    const first = ccErrs[0];
    const text = first
      ? `${plural(ccErrs.length, "error", "errores")} de C · ${first.tab}:${first.line}: ${first.msg} · ${msText(tc)}`
      : `El compilador no generó código · ${msText(tc)}`;
    return { target, kind: "c", ok: false, cc, diags, status: { level: "error", text } };
  }

  const run = assembleIt(cc.asm, GEN_NAME);
  const owners = asmLineOwners(cc.asm, cc.cLineMap);
  const fromAsm = (e: AsmError, severity: "error" | "warning"): void => {
    const tab = tabOf(model, e.file);
    diags.push(asmDiag(e, tab, severity));
    if (tab !== GEN_NAME) return;
    const c = cLineOf(owners, cc.cLineMap, e.line);
    if (c) diags.push({ tab: tabOf(model, c.file), line: c.line, col: 0, msg: `ensamblador (${GEN_NAME}:${e.line}): ${e.msg}`, severity });
  };
  for (const e of run.result.errors) fromAsm(e, "error");
  for (const e of run.result.warnings) fromAsm(e, "warning");
  const result: AsmResult = { ...run.result, lineMap: mapToC(cc.asm, cc.cLineMap, run.result.lineMap, GEN_NAME) };
  const ms = msText(tc + run.ms);

  let status: StatusLine;
  const asmErrs = run.result.errors;
  if (asmErrs.length > 0) {
    const e = asmErrs[0]!;
    const c = e.file === GEN_NAME ? cLineOf(owners, cc.cLineMap, e.line) : undefined;
    const where = `${e.file}:${e.line}${c ? ` (de ${tabOf(model, c.file)}:${c.line})` : ""}`;
    status = { level: "error", text: `${plural(asmErrs.length, "error", "errores")} al ensamblar el código generado · ${where}: ${e.msg} · ${ms}` };
  } else if (!run.ok) {
    status = { level: "error", text: `Cabecera: ${run.headerErrors.join("; ") || "error desconocido"} · ${ms}` };
  } else {
    const nWarn = ccWarns + run.result.warnings.length;
    const size = run.rom ? `ROM ${run.rom.length / 1024} KB` : "";
    const warn = nWarn ? ` · ${plural(nWarn, "aviso", "avisos")}` : "";
    const lines = cc.asm.split("\n").length;
    status = { level: nWarn ? "warning" : "ok", text: `Sin errores · C → ${lines} líneas de ensamblador · ${size}${warn} · ${ms}` };
  }
  return { target, kind: "c", ok: run.ok, result, run, cc, diags, status };
}

function asmDiag(e: AsmError, tab: string, severity: "error" | "warning"): TabDiag {
  return { tab, line: e.line, col: e.col, msg: e.msg, severity };
}
