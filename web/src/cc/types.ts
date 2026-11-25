// Tipos de C (K1) y nodos del AST ya tipado. Layout en docs/c-abi.md §1.

export interface Pos { file: string; line: number; col: number }

export interface StructField { name: string; type: Type; off: number }
export interface StructInfo { tag: string; fields: StructField[]; size: number; complete: boolean; pos: Pos }

export type Type =
  | { k: "void"; c?: boolean }
  | { k: "int"; size: 1 | 2; signed: boolean; c?: boolean }
  | { k: "ptr"; to: Type; c?: boolean }
  | { k: "array"; of: Type; n: number | undefined; c?: boolean }
  | { k: "struct"; s: StructInfo; c?: boolean }
  | { k: "func"; ret: Type; params: Type[] | undefined; variadic: boolean; c?: boolean };

export const T_VOID: Type = { k: "void" };
export const T_INT: Type = { k: "int", size: 2, signed: true };
export const T_UINT: Type = { k: "int", size: 2, signed: false };
export const T_CHAR: Type = { k: "int", size: 1, signed: false };
export const T_SCHAR: Type = { k: "int", size: 1, signed: true };
export const T_VOIDP: Type = { k: "ptr", to: T_VOID };

export function sizeOf(t: Type): number {
  switch (t.k) {
    case "void": return 1; // como gcc: aritmética de void* de 1 en 1
    case "int": return t.size;
    case "ptr": return 2;
    case "array": return (t.n ?? 0) * sizeOf(t.of);
    case "struct": return t.s.size;
    case "func": return 2;
  }
}

export const isInt = (t: Type) => t.k === "int";
export const isPtr = (t: Type) => t.k === "ptr";
export const isScalar = (t: Type) => t.k === "int" || t.k === "ptr";
export const isChar = (t: Type) => t.k === "int" && t.size === 1;

export function unqual(t: Type): Type {
  if (!t.c) return t;
  const { c: _c, ...rest } = t as Type & { c?: boolean };
  return rest as Type;
}
export function withConst(t: Type): Type { return t.c ? t : ({ ...t, c: true } as Type); }

/** Pares de structs que se están comparando (structs que se apuntan a sí mismos). */
const comparing: [StructInfo, StructInfo][] = [];

/**
 * C99 6.2.7: dos structs de unidades distintas (la misma cabecera incluida por dos .c) son
 * compatibles si tienen la misma etiqueta y los mismos miembros con tipos compatibles; si
 * una está incompleta, basta la etiqueta.
 */
function sameStruct(a: StructInfo, b: StructInfo): boolean {
  if (a === b) return true;
  if (!a.tag || a.tag !== b.tag) return false;
  if (!a.complete || !b.complete) return true;
  if (a.fields.length !== b.fields.length) return false;
  if (comparing.some(([x, y]) => x === a && y === b)) return true;
  comparing.push([a, b]);
  try {
    return a.fields.every((f, i) => f.name === b.fields[i]!.name && sameType(f.type, b.fields[i]!.type));
  } finally {
    comparing.pop();
  }
}

export function sameType(a: Type, b: Type): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "void": return true;
    case "int": return a.size === (b as typeof a).size && a.signed === (b as typeof a).signed;
    case "ptr": return sameType(a.to, (b as typeof a).to);
    case "array": return sameType(a.of, (b as typeof a).of) && (a.n === undefined || (b as typeof a).n === undefined || a.n === (b as typeof a).n);
    case "struct": return sameStruct(a.s, (b as typeof a).s);
    case "func": {
      const f = b as typeof a;
      if (!sameType(a.ret, f.ret) || a.variadic !== f.variadic) return false;
      if (!a.params || !f.params) return true;
      return a.params.length === f.params.length && a.params.every((p, i) => sameType(p, f.params![i]!));
    }
  }
}

export function typeStr(t: Type): string {
  const c = t.c ? "const " : "";
  switch (t.k) {
    case "void": return c + "void";
    case "int": return c + (t.size === 1 ? (t.signed ? "signed char" : "char") : t.signed ? "int" : "unsigned int");
    case "ptr": return typeStr(t.to) + " *" + (t.c ? "const" : "");
    case "array": return `${typeStr(t.of)} [${t.n ?? ""}]`;
    case "struct": return c + "struct " + (t.s.tag || "<anónimo>");
    case "func": return `${typeStr(t.ret)} (${t.params ? t.params.map(typeStr).join(", ") + (t.variadic ? ", ..." : "") : ""})`;
  }
}

/** Normaliza un valor entero al rango de su tipo (envolvente de 8/16 bits). */
export function norm(v: number, t: Type): number {
  if (t.k === "ptr") return v & 0xffff;
  if (t.k !== "int") return v;
  if (t.size === 1) { v &= 0xff; return t.signed && v > 127 ? v - 256 : v; }
  v &= 0xffff;
  return t.signed && v > 32767 ? v - 65536 : v;
}

// ---- Símbolos --------------------------------------------------------------

export type IrqSource = "vblank" | "stat" | "timer" | "serial" | "joypad";
export const IRQ_VECTORS: Record<IrqSource, number> = { vblank: 0x40, stat: 0x48, timer: 0x50, serial: 0x58, joypad: 0x60 };

export interface FuncInfo {
  name: string;
  label: string;
  type: Extract<Type, { k: "func" }>;
  pos: Pos;
  defined: boolean;
  isStatic: boolean;
  naked: boolean;
  /** `__banked`: se llama por el trampolín __bcall (docs/c-abi.md §8). */
  banked: boolean;
  /** `__interrupt(fuente)`: rutina de interrupción. */
  interrupt?: IrqSource;
  /** Banco de ROM de la definición (0 = ROM0), según `#pragma bank`. */
  bank: number;
  /** Símbolos globales (labels) a los que se refiere el cuerpo: para eliminar lo no usado. */
  refs: Set<VarSym | FuncInfo>;
  fileIdx: number;
  body?: Stmt;
  /** Parámetros: `off` es el índice del parámetro (el marco lo coloca el codegen). */
  params?: VarSym[];
  /** Bytes de locales (las locales tienen `off` negativo: -frameSize..-1). */
  frameSize?: number;
  labels?: Map<string, { used: Pos | null; defined: boolean; label: string }>;
  file?: string;
  /** Se usa su dirección (`f` sin llamar): puede llamarse desde cualquier sitio. */
  addrTaken?: boolean;
  /** Convención de llamada (docs/c-abi.md §3.1); la decide index.ts con el grafo de llamadas. */
  conv?: "static" | "stack";
  /** Convención estática: dirección del marco (parámetros y luego locales) en WRAM. */
  frameBase?: number;
}

export interface VarSym {
  kind: "var";
  name: string;
  type: Type;
  /** global/static: label en ensamblador. local: offset negativo en el bloque de locales; param: índice. */
  storage: "global" | "local" | "param";
  label: string;
  off: number;
  /** `__at(dir)`: variable en dirección fija, sin almacenamiento. */
  at?: number;
  /** Banco de ROM de los datos const (según `#pragma bank`). */
  bank?: number;
  pos: Pos;
  defined?: boolean;
  init?: Init;
  isConst?: boolean;
  refs?: Set<VarSym | FuncInfo>;
  isStatic?: boolean;
  fileIdx?: number;
  /** static local: nombre de la función (para el label). */
  inFunc?: string;
  extern?: boolean;
}

export type Sym =
  | VarSym
  | { kind: "func"; f: FuncInfo }
  | { kind: "typedef"; type: Type }
  | { kind: "enum"; value: number };

/** Inicializador aplanado: escalares en su offset dentro del objeto. */
export interface InitItem { off: number; type: Type; e: Expr }
export type Init = { items: InitItem[]; size: number };

// ---- Expresiones (tipadas) ---------------------------------------------------

interface EBase { t: Type; pos: Pos }
export type Expr =
  | (EBase & { k: "num"; v: number })
  | (EBase & { k: "str"; bytes: number[] })
  | (EBase & { k: "var"; sym: VarSym })
  | (EBase & { k: "faddr"; f: FuncInfo })
  | (EBase & { k: "deref"; e: Expr })
  | (EBase & { k: "addr"; e: Expr })
  | (EBase & { k: "un"; op: "-" | "~" | "!"; e: Expr })
  | (EBase & { k: "bin"; op: BinOp; l: Expr; r: Expr })
  | (EBase & { k: "cmp"; op: CmpOp; l: Expr; r: Expr; signed: boolean })
  | (EBase & { k: "land" | "lor"; l: Expr; r: Expr })
  | (EBase & { k: "cond"; c: Expr; a: Expr; b: Expr })
  /** op: undefined = asignación simple; si no, compuesta (el valor de l se convierte a opT, se opera y se convierte a l.t). */
  | (EBase & { k: "assign"; op?: BinOp; opT?: Type; l: Expr; r: Expr })
  | (EBase & { k: "incdec"; post: boolean; delta: number; l: Expr })
  | (EBase & { k: "call"; f: FuncInfo; args: Expr[] })
  | (EBase & { k: "cast"; e: Expr })
  | (EBase & { k: "comma"; l: Expr; r: Expr });

export type BinOp = "+" | "-" | "*" | "/" | "%" | "<<" | ">>" | "&" | "|" | "^";
export type CmpOp = "==" | "!=" | "<" | ">" | "<=" | ">=";

// ---- Sentencias ----------------------------------------------------------------

interface SBase { pos: Pos }
export type Stmt =
  | (SBase & { k: "block"; body: Stmt[] })
  | (SBase & { k: "expr"; e: Expr })
  | (SBase & { k: "init"; v: VarSym; init: Init })
  | (SBase & { k: "if"; c: Expr; a: Stmt; b?: Stmt })
  | (SBase & { k: "while"; c: Expr; body: Stmt })
  | (SBase & { k: "do"; c: Expr; body: Stmt; cpos: Pos })
  | (SBase & { k: "for"; init?: Stmt; c?: Expr; step?: Expr; body: Stmt; cpos?: Pos; spos?: Pos })
  | (SBase & { k: "switch"; e: Expr; body: Stmt; cases: { v: number; label: string }[]; def?: string })
  | (SBase & { k: "case"; label: string })
  | (SBase & { k: "break" })
  | (SBase & { k: "continue" })
  | (SBase & { k: "return"; e?: Expr })
  | (SBase & { k: "goto"; label: string })
  | (SBase & { k: "label"; label: string })
  | (SBase & { k: "asm"; text: string; line: number })
  | (SBase & { k: "empty" });
