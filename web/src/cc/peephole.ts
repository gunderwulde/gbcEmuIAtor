// Peephole (K1): reglas locales sobre el texto que genera codegen.ts. Sólo mira las
// instrucciones del propio compilador; los bloques __asm del usuario van entre ASM_BEGIN
// y ASM_END y son una barrera (ni se tocan ni se cruzan). Las etiquetas también son
// barrera (alguien puede saltar a ellas). Casos en tests/cc/peephole.test.ts.

import { ASM_BEGIN, ASM_END } from "./codegen";

const INSN = "        ";
const isInsn = (s: string) => s.startsWith(INSN) && s.length > 8 && s[8] !== ";";
const isLabel = (s: string) => /^[A-Za-z_.][\w.]*:$/.test(s);
const body = (s: string) => s.slice(8);

const INV: Record<string, string> = { z: "nz", nz: "z", c: "nc", nc: "c" };
/** Instrucciones de ALU que dejan Z según A (para quitar un `or a` detrás). */
const SETS_Z = /^(and|or|xor|sub|add a,|adc a,|sbc a,|inc a$|dec a$)/;
/** Instrucciones que no tocan HL ni SP (para ver que una recarga de HL sobra). */
const KEEPS_HL = /^(ld \[hl\],[a-e]|ld \[hl\],\$?\w+|ld [a-e],\[hl\]|inc \[hl\]|dec \[hl\]|(add a,|adc a,|sub |sbc a,|and |or |xor |cp )\[hl\])$/;

export interface PeepOpts {
  /** Etiquetas que no se pueden suponer memoria normal (variables __at): no se quita su recarga. */
  volatile?: Set<string>;
}

/** Aplica las reglas hasta punto fijo y relaja saltos a `jr`. Devuelve las reglas aplicadas. */
export function peephole(lines: string[], opts: PeepOpts = {}): number {
  let total = 0;
  for (let pass = 0; pass < 10; pass++) {
    const n = onePass(lines, opts.volatile ?? new Set());
    total += n;
    if (n === 0) break;
  }
  return total + relax(lines);
}

function onePass(L: string[], vol: Set<string>): number {
  let hits = 0;
  let inAsm = false;
  // Índices de instrucciones del compilador; las barreras (etiquetas, asm) son null o -1.
  const seq: (number | null)[] = [];
  for (let i = 0; i < L.length; i++) {
    const s = L[i]!;
    if (s === ASM_BEGIN) { inAsm = true; seq.push(-1); continue; }
    if (s === ASM_END) { inAsm = false; seq.push(-1); continue; }
    if (inAsm) continue;
    if (isInsn(s)) seq.push(i);
    else if (isLabel(s)) seq.push(null, i, null);
  }
  const del = new Set<number>();
  const get = (k: number) => { const i = seq[k]; return i === null || i === undefined || i < 0 || del.has(i) || isLabel(L[i]!) ? null : i; };
  /** Las n instrucciones que siguen a k (sin barreras) o null. */
  const after = (k: number, n: number): number[] | null => {
    const out: number[] = [];
    for (let q = k; q < seq.length && out.length < n; q++) {
      const x = seq[q];
      if (x === null || x === undefined || x < 0) return null;
      if (del.has(x)) continue;
      if (isLabel(L[x]!)) return null;
      out.push(x);
    }
    return out.length === n ? out : null;
  };
  const memOk = (x: string) => !vol.has(x.replace(/[+-]\d+$/, "")) && !/^\$/.test(x);
  for (let k = 0; k < seq.length; k++) {
    const i = get(k);
    if (i === null) continue;
    const a = body(L[i]!);
    const nx = after(k + 1, 1);
    const j = nx ? nx[0]! : null;
    const b = j !== null ? body(L[j]!) : null;

    if (b !== null) {
      // push/pop del mismo par: nada; de HL a DE: copia por registros (4+3 → 2 ciclos M).
      if ((a === "push hl" && b === "pop hl") || (a === "push de" && b === "pop de") || (a === "push af" && b === "pop af")) { del.add(i); del.add(j!); hits++; continue; }
      if (a === "push hl" && b === "pop de") { L[i] = INSN + "ld d,h"; L[j!] = INSN + "ld e,l"; hits++; continue; }
      if (a === "push de" && b === "pop hl") { L[i] = INSN + "ld h,d"; L[j!] = INSN + "ld l,e"; hits++; continue; }
      // ld a,r / ld r,a  -> la segunda sobra.
      const mr = /^ld a,([bcdehl])$/.exec(a);
      if (mr && b === `ld ${mr[1]},a`) { del.add(j!); hits++; continue; }
      const mr2 = /^ld ([bcdehl]),a$/.exec(a);
      if (mr2 && b === `ld a,${mr2[1]}`) { del.add(j!); hits++; continue; }
      // ld a,r seguido de algo que escribe A sin leerla.
      if (/^ld a,[bcdehl]$/.test(a) && (/^ld a,(?!.*\ba\b)/.test(b) || /^ldh a,/.test(b) || b === "xor a")) { del.add(i); hits++; continue; }
      // ld [X],a / ld a,[X]  -> la recarga sobra.
      const st = /^(ld|ldh) \[([^\]]+)\],a$/.exec(a);
      if (st && b === `${st[1]} a,[${st[2]}]` && st[1] === "ld" && memOk(st[2]!)) { del.add(j!); hits++; continue; }
      // ALU que ya deja Z / or a / salto por z o nz.
      if (b === "or a" && SETS_Z.test(a)) {
        const n2 = after(k + 2, 1);
        if (n2 && /^j[pr] n?z,/.test(body(L[n2[0]!]!))) { del.add(j!); hits++; continue; }
      }
      // ld hl,X / (algo que no toca HL) / ld hl,X  -> la segunda carga sobra.
      if (/^ld hl,/.test(a) && KEEPS_HL.test(b)) {
        const n2 = after(k + 2, 1);
        if (n2 && body(L[n2[0]!]!) === a) { del.add(n2[0]!); hits++; continue; }
      }
    }
    // Guardar HL y volver a cargarlo de la misma dirección absoluta:
    //   ld a,l / ld [X],a / ld a,h / ld [X+1],a / ld hl,X / ld a,[hl+] / ld h,[hl] / ld l,a
    if (a === "ld a,l") {
      const w = after(k + 1, 7);
      const m = w && /^ld \[([^\]]+)\],a$/.exec(body(L[w[0]!]!));
      if (w && m && memOk(m[1]!) && body(L[w[1]!]!) === "ld a,h" && body(L[w[2]!]!) === `ld [${m[1]}+1],a`
        && body(L[w[3]!]!) === `ld hl,${m[1]}` && body(L[w[4]!]!) === "ld a,[hl+]" && body(L[w[5]!]!) === "ld h,[hl]" && body(L[w[6]!]!) === "ld l,a") {
        del.add(w[3]!); del.add(w[4]!); del.add(w[5]!);
        L[w[6]!] = INSN + "ld a,l";
        hits++;
        continue;
      }
    }
    // Lo mismo con un hueco en la pila (sin keep: DE guarda el valor):
    //   ld hl,sp+N / ld a,e / ld [hl+],a / ld [hl],d / ld hl,sp+N / ld a,[hl+] / ld h,[hl] / ld l,a
    if (/^ld hl,sp\+\d+$/.test(a)) {
      const w = after(k + 1, 7);
      if (w && body(L[w[0]!]!) === "ld a,e" && body(L[w[1]!]!) === "ld [hl+],a" && body(L[w[2]!]!) === "ld [hl],d"
        && body(L[w[3]!]!) === a && body(L[w[4]!]!) === "ld a,[hl+]" && body(L[w[5]!]!) === "ld h,[hl]" && body(L[w[6]!]!) === "ld l,a") {
        L[w[3]!] = INSN + "ld h,d";
        L[w[4]!] = INSN + "ld l,e";
        del.add(w[5]!); del.add(w[6]!);
        hits++;
        continue;
      }
      // ld hl,sp+N / ld [hl],a / ld hl,sp+N / ld a,[hl]  -> sobran las dos últimas.
      const v = after(k + 1, 3);
      if (v && body(L[v[0]!]!) === "ld [hl],a" && body(L[v[1]!]!) === a && body(L[v[2]!]!) === "ld a,[hl]") {
        del.add(v[1]!); del.add(v[2]!); hits++; continue;
      }
    }
    // jp cc,L1 / jp L2 / L1:   ->  jp !cc,L2 / L1:
    const jc = /^jp (n?z|n?c),(\S+)$/.exec(a);
    if (jc && b !== null && /^jp [^,\s]+$/.test(b) && b !== "jp hl") {
      if (labelsAfter(L, seq, k + 2, del).has(jc[2]!)) {
        L[i] = INSN + `jp ${INV[jc[1]!]},${b.slice(3)}`;
        del.add(j!);
        hits++;
        continue;
      }
    }
    // jp L / L:   y   jp cc,L / L:
    const jm = /^j[pr] (?:(?:n?z|n?c),)?([^,\s]+)$/.exec(a);
    if (jm && a !== "jp hl" && labelsAfter(L, seq, k + 1, del).has(jm[1]!)) { del.add(i); hits++; continue; }
    // Código muerto tras salto incondicional o ret, hasta la siguiente etiqueta.
    if (/^j[pr] [^,\s]+$/.test(a) || a === "ret" || a === "reti") {
      for (let q = k + 1; q < seq.length; q++) {
        const x = seq[q];
        if (x === null || x === undefined || x < 0) break;
        if (del.has(x)) continue;
        if (isLabel(L[x]!)) break;
        del.add(x);
        hits++;
      }
    }
  }
  if (del.size) {
    const keep = L.filter((_, i) => !del.has(i));
    L.length = 0;
    L.push(...keep);
  }
  return hits;
}

/** Etiquetas que siguen inmediatamente (sin instrucciones entre medias) a la posición k. */
function labelsAfter(L: string[], seq: (number | null)[], k: number, del: Set<number>): Set<string> {
  const out = new Set<string>();
  for (let q = k; q < seq.length; q++) {
    const x = seq[q];
    if (x === null || x === undefined) continue;
    if (x < 0) break;
    if (del.has(x)) continue;
    if (isLabel(L[x]!)) { out.add(L[x]!.slice(0, -1)); continue; }
    break;
  }
  return out;
}

/**
 * Tamaño en bytes de una instrucción emitida por el compilador. Por exceso si no la
 * reconoce (3): así una distancia calculada nunca es menor que la real.
 */
export function insnSize(s: string): number {
  if (/^(dw)\b/.test(s)) return 2 * s.slice(3).split(",").length;
  if (/^db\b/.test(s)) return 64; // no aparece en código de funciones; cota alta
  if (/^(ld (bc|de|hl|sp),(?!sp)[^[]|ld \[[^\]]+\],sp|jp |call )/.test(s) && s !== "jp hl") return 3;
  if (/^ld (\[[^\]h][^\]]*\],a|a,\[[^\]]*\])$/.test(s) && !/\[(hl[+-]?|bc|de|c)\]/.test(s)) return 3;
  if (/^(ldh |jr |add sp,|ld hl,sp\+|stop)/.test(s)) return 2;
  if (/^(rlc|rrc|rl|rr|sla|sra|swap|srl|bit|res|set) /.test(s)) return 2;
  if (/^ld \[hl\],[^abcdehl]/.test(s) || /^ld \[hl\],\$/.test(s)) return 2;
  if (/^ld [abcdehl],(?![abcdehl]$|\[)/.test(s)) return 2;
  if (/^(add a,|adc a,|sub |sbc a,|and |or |xor |cp )(?![abcdehl]$|\[hl\]$)/.test(s)) return 2;
  return 1;
}

/** `jp`/`jp cc` → `jr` cuando el destino está a menos de ±127 bytes (2 en vez de 3). */
function relax(L: string[]): number {
  let hits = 0;
  for (;;) {
    // Posición de cada línea, dentro de tramos sin ensamblador del usuario.
    const pos = new Array<number>(L.length).fill(-1);
    const seg = new Array<number>(L.length).fill(-1);
    const labels = new Map<string, number>();
    let p = 0, inAsm = false, s = 0, scope = "";
    for (let i = 0; i < L.length; i++) {
      const x = L[i]!;
      if (x === ASM_BEGIN) { inAsm = true; s++; continue; }
      if (x === ASM_END) { inAsm = false; s++; continue; }
      if (inAsm) continue;
      pos[i] = p;
      seg[i] = s;
      if (isLabel(x)) {
        const n = x.slice(0, -1);
        if (!n.startsWith(".")) scope = n;
        labels.set(`${s}:${n.startsWith(".") ? scope + n : n}`, i);
      } else if (isInsn(x)) p += insnSize(body(x));
      else if (/^SECTION /.test(x)) s++;
    }
    let changed = 0;
    scope = "";
    for (let i = 0; i < L.length; i++) {
      const x = L[i]!;
      if (seg[i]! < 0) continue;
      if (isLabel(x)) { const n = x.slice(0, -1); if (!n.startsWith(".")) scope = n; continue; }
      if (!isInsn(x)) continue;
      const m = /^jp (?:(n?z|n?c),)?([A-Za-z_.][\w.]*)$/.exec(body(x));
      if (!m) continue;
      const t = labels.get(`${seg[i]}:${m[2]!.startsWith(".") ? scope + m[2] : m[2]}`);
      if (t === undefined) continue;
      const d = pos[t]! - (pos[i]! + 2);
      // Margen de 1: la propia conversión acorta el código entre medias (nunca alarga).
      if (d < -127 || d > 126) continue;
      L[i] = INSN + `jr ${m[1] ? m[1] + "," : ""}${m[2]}`;
      changed++;
    }
    hits += changed;
    if (!changed) return hits;
  }
}
