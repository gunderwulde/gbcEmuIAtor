// U1: puente con el compilador de C (K1, web/src/cc) y la librería de C (L1, web/src/clib).
// Se cargan con import.meta.glob para que la UI compile y funcione (sólo ensamblador)
// aunque esos módulos aún no existan o no exporten todo; los tipos son los de sus README.
// Sin DOM: lo usan la UI y los tests.

/** Error o aviso del compilador (web/src/cc/README.md). */
export interface CcDiag {
  file: string;
  line: number;
  col: number;
  msg: string;
  severity: "error" | "warning";
}

/** Línea C → línea del ensamblador generado (la del comentario "; fichero:línea: …"). */
export interface CLine {
  file: string;
  line: number;
  asmLine: number;
}

export interface CcOutput {
  asm: string;
  errors: CcDiag[];
  cLineMap: CLine[];
}

export type IncludeResolver = (name: string, from: string) => string | undefined;

export interface CcOptions {
  main: string;
  includeResolver?: IncludeResolver;
}

export type CompileFn = (files: Map<string, string>, opts: CcOptions) => CcOutput;

/** Ejemplo de C de la librería: varios ficheros y cuál es el principal. */
export interface CExample {
  id: string;
  title: string;
  files: ReadonlyMap<string, string>;
  main: string;
}

type Loose = Record<string, unknown>;

const ccMod = Object.values(import.meta.glob<Loose>("../../cc/index.ts", { eager: true }))[0];
const clibMod = Object.values(import.meta.glob<Loose>("../../clib/index.ts", { eager: true }))[0];

const pick = <T>(mod: Loose | undefined, names: string[]): T | undefined => {
  if (!mod) return undefined;
  for (const n of names) if (mod[n] !== undefined) return mod[n] as T;
  return undefined;
};

/** compile() de K1, o undefined si aún no está. */
export const ccCompile: CompileFn | undefined = pick<CompileFn>(ccMod, ["compile"]);

/** Resolver de #include/#pragma link de la librería (L1), o undefined. */
export const clibResolver: IncludeResolver | undefined = (() => {
  const f = pick<(name: string, from?: string) => string | undefined>(clibMod, ["includeResolver", "clibResolve", "resolveInclude", "resolve"]);
  return f ? (name: string, from: string) => f(name, from) : undefined;
})();

const toMap = (v: unknown): Map<string, string> =>
  v instanceof Map ? new Map(v as Map<string, string>) : new Map(Object.entries((v ?? {}) as Record<string, string>));

/** Ficheros de la librería (nombre → texto), para verlos en pestañas de sólo lectura. */
export const clibFiles: ReadonlyMap<string, string> = toMap(pick(clibMod, ["CLIB_FILES", "LIB_FILES", "files", "clibFiles"]));

/** Ejemplos de C de L1, normalizados a CExample. */
export const clibExamples: readonly CExample[] = (() => {
  const raw = pick<unknown[]>(clibMod, ["C_EXAMPLES", "EXAMPLES", "examples", "cExamples"]);
  if (!Array.isArray(raw)) return [];
  const out: CExample[] = [];
  for (const r of raw as Loose[]) {
    if (typeof r?.id !== "string" || typeof r.main !== "string") continue;
    const files = toMap(r.files);
    if (!files.has(r.main)) continue;
    out.push({ id: r.id, title: typeof r.title === "string" ? r.title : r.id, files, main: r.main });
  }
  return out;
})();
