// Correspondencia línea de fuente ↔ banco:dirección a partir de `AsmResult.lineMap`.
// Sin DOM. Los bancos se normalizan con normBank (sólo ROMX distingue bancos).
import type { AsmLineMapEntry } from "../../asm";
import { normBank } from "../../disasm";

export interface Loc { bank: number; addr: number }
export interface SrcLoc { file: string; line: number }

interface Span { bank: number; addr: number; end: number; file: string; line: number }

export class SourceMap {
  /** fichero → (línea → primera entrada de esa línea), y líneas con código ordenadas. */
  private byLine = new Map<string, { first: Map<number, Loc>; lines: number[] }>();
  /** Tramos ordenados por (banco, dirección) para buscar la línea de un PC. */
  private spans: Span[] = [];

  constructor(lineMap: readonly AsmLineMapEntry[]) {
    for (const e of lineMap) {
      let f = this.byLine.get(e.file);
      if (!f) this.byLine.set(e.file, (f = { first: new Map(), lines: [] }));
      const bank = normBank(e.bank, e.addr);
      // "Primera entrada de la línea": una macro o un REPT pueden emitir varias veces.
      if (!f.first.has(e.line)) { f.first.set(e.line, { bank, addr: e.addr }); f.lines.push(e.line); }
      if (e.len > 0) this.spans.push({ bank, addr: e.addr, end: e.addr + e.len, file: e.file, line: e.line });
    }
    for (const f of this.byLine.values()) f.lines.sort((a, b) => a - b);
    this.spans.sort((a, b) => a.bank - b.bank || a.addr - b.addr);
  }

  /**
   * Dirección de la línea `line` de `file`. Una línea sin código (comentario, etiqueta
   * sola) se lleva a la siguiente que tenga código, como en cualquier IDE; `line` en el
   * resultado es la línea efectiva.
   */
  lineToAddr(file: string, line: number): (Loc & { line: number }) | undefined {
    const f = this.byLine.get(file);
    if (!f) return undefined;
    const exact = f.first.get(line);
    if (exact) return { ...exact, line };
    let lo = 0, hi = f.lines.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (f.lines[m]! < line) lo = m + 1; else hi = m; }
    const next = f.lines[lo];
    return next === undefined ? undefined : { ...f.first.get(next)!, line: next };
  }

  /** Línea que contiene `addr` (en el banco `bank`, ya normalizado). */
  addrToLine(bank: number, addr: number): SrcLoc | undefined {
    const s = this.spans;
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      const e = s[m]!;
      if (e.bank < bank || (e.bank === bank && e.addr <= addr)) lo = m + 1; else hi = m;
    }
    // Tramos solapados (no debería haberlos): se mira hacia atrás unos pocos.
    for (let i = lo - 1; i >= 0 && i >= lo - 4; i--) {
      const e = s[i]!;
      if (e.bank !== bank) break;
      if (addr >= e.addr && addr < e.end) return { file: e.file, line: e.line };
    }
    return undefined;
  }
}
