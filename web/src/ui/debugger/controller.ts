// Controlador del depurador (D1): máquina de estados explícita, sin DOM, con tests
// (tests/ui/debugger/controller.test.ts contra el núcleo real).
//
// Estados:
//   paused    el bucle está parado; se aceptan paso, paso por encima, salir, hasta el
//             cursor, continuar y cambios de breakpoints.
//   running   el bucle corre libre; sólo para en breakpoints de usuario (o pausa).
//   stepping  hay un objetivo en curso (`goal`):
//               over   bucle en marcha con un breakpoint temporal tras el CALL/RST;
//               runTo  bucle en marcha con un breakpoint temporal en el cursor;
//               out    el bucle está parado y el controlador ejecuta gb_step por tandas.
//
// Transiciones (cualquier otra orden se ignora y devuelve false):
//   paused  --continue-->  running          (antes, un gb_step: salir del breakpoint)
//   paused  --step------>  paused           (gb_step; si queda en HALT, sigue hasta salir)
//   paused  --stepOver-->  paused           (no es CALL/RST, o el CALL no salta)
//                       \-> stepping(over)
//   paused  --stepOut--->  stepping(out)
//   paused  --runTo----->  stepping(runTo)
//   running|stepping --pause--> paused      (quita el temporal en ese mismo instante)
//   running|stepping --stop observado (notifyStop)--> paused, o se reanuda si la parada
//                       no es de nadie (temporal de otra profundidad, banco distinto)
//   stepping(out) --retorno encontrado / breakpoint / límite--> paused
//
// Lección de zxemuIAtor (carrera de runTo): el breakpoint temporal NO se quita en una
// microtarea mientras el bucle corre; sólo al observar la parada (notifyStop) o al
// pausar. Las reanudaciones y las tandas de "salir" van por `schedule` y llevan una
// generación: si entretanto llegó otra orden, la tarea programada no hace nada.
import { isCall, isReturn, normBank, opAt, type ByteReader } from "../../disasm";
import { STOP_BREAKPOINT, STOP_WATCHPOINT, type DebugTarget } from "./target";

export type DbgState = "paused" | "running" | "stepping";

export interface Breakpoint {
  /** Normalizado con normBank: banco en 4000-7FFF, -1 en el resto. */
  bank: number;
  addr: number;
  /** Origen en el código fuente, si se puso desde el editor o se pudo asociar. */
  file?: string;
  line?: number;
}

export type Goal =
  | { kind: "over"; bank: number; addr: number; sp: number }
  | { kind: "runTo"; bank: number; addr: number }
  | { kind: "out"; depth: number; steps: number };

export type StopKind = "pause" | "step" | "breakpoint" | "watchpoint" | "over" | "out" | "runTo" | "limit";

export interface StopInfo { kind: StopKind; pc: number; bank: number; msg?: string }

export interface ControllerHost {
  /** Arranca el bucle de emulación (rAF). */
  start(): void;
  /** Lo para (idempotente). */
  stop(): void;
  /** Programa trabajo fuera de la pila actual (por defecto setTimeout 0). */
  schedule?(cb: () => void): void;
}

/** Vectores de interrupción: VBlank, STAT, temporizador, serie, joypad. */
const IRQ_VECTORS = new Set([0x40, 0x48, 0x50, 0x58, 0x60]);
/** Ciclos M como mucho al dar un paso con la CPU en HALT (≈ 4 frames). */
const HALT_STEP_LIMIT = 4 * 17556;
/** "Salir": instrucciones por tanda y en total antes de rendirse (≈ 2 s emulados). */
const OUT_CHUNK = 20000;
const OUT_LIMIT = 2_000_000;

export const bpKey = (bank: number, addr: number): string => `${bank}:${addr & 0xffff}`;

export class DebugController {
  state: DbgState = "paused";
  goal: Goal | null = null;
  lastStop: StopInfo | null = null;
  /** Instrucciones como mucho en "salir" antes de rendirse. */
  outLimit = OUT_LIMIT;
  private user = new Map<string, Breakpoint>();
  private wps: Array<{ lo: number; hi: number }> = [];
  private gen = 0;
  private listeners = new Set<() => void>();
  private readonly read: ByteReader;
  private readonly schedule: (cb: () => void) => void;

  constructor(private t: DebugTarget, private host: ControllerHost) {
    this.read = (a) => t.peek(a);
    this.schedule = host.schedule ?? ((cb) => { setTimeout(cb, 0); });
  }

  /** Se llama tras cada cambio de estado o de breakpoints. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void { for (const cb of this.listeners) cb(); }

  // ---------------------------------------------------------------------------------
  // Breakpoints de usuario: la verdad está aquí; el núcleo recibe una copia (sync).

  breakpoints(): Breakpoint[] { return [...this.user.values()]; }

  hasBreakpoint(bank: number, addr: number): boolean {
    return this.user.has(bpKey(normBank(bank, addr), addr));
  }

  setBreakpoint(bp: Breakpoint, on: boolean): void {
    const b = { ...bp, bank: normBank(bp.bank, bp.addr), addr: bp.addr & 0xffff };
    const k = bpKey(b.bank, b.addr);
    if (on) this.user.set(k, b); else this.user.delete(k);
    this.sync();
    this.emit();
  }

  /** Pone o quita; devuelve si queda puesto. */
  toggleBreakpoint(bp: Breakpoint): boolean {
    const on = !this.hasBreakpoint(bp.bank, bp.addr);
    this.setBreakpoint(bp, on);
    return on;
  }

  /** Sustituye todo el conjunto (p. ej. al reconstruir y volver a mapear las líneas). */
  replaceBreakpoints(list: readonly Breakpoint[]): void {
    this.user.clear();
    for (const bp of list) {
      const b = { ...bp, bank: normBank(bp.bank, bp.addr), addr: bp.addr & 0xffff };
      this.user.set(bpKey(b.bank, b.addr), b);
    }
    this.sync();
    this.emit();
  }

  clearBreakpoints(): void { this.replaceBreakpoints([]); }

  /**
   * Copia al núcleo los de usuario más el temporal del objetivo. El núcleo guarda un
   * banco por dirección: si una dirección tiene varios (bancos distintos), se le pone
   * -1 y notifyStop descarta las paradas que no correspondan.
   */
  private sync(): void {
    const m = new Map<number, number>();
    const add = (bank: number, addr: number): void => {
      const cur = m.get(addr);
      m.set(addr, cur === undefined || cur === bank ? bank : -1);
    };
    for (const b of this.user.values()) add(b.bank, b.addr);
    const g = this.goal;
    if (g && g.kind !== "out") add(g.bank, g.addr);
    this.t.bpClearAll();
    for (const [addr, bank] of m) this.t.bpSet(bank, addr, true);
  }

  private here(): { pc: number; bank: number } {
    const pc = this.t.pc();
    return { pc, bank: normBank(this.t.romBank(), pc) };
  }

  private userHit(): boolean {
    const { pc, bank } = this.here();
    return this.user.has(bpKey(bank, pc));
  }

  private finish(kind: StopKind, msg?: string): void {
    this.gen++;
    const hadTemp = this.goal !== null && this.goal.kind !== "out";
    this.goal = null;
    this.state = "paused";
    if (hadTemp) this.sync();
    const { pc, bank } = this.here();
    this.lastStop = msg === undefined ? { kind, pc, bank } : { kind, pc, bank, msg };
    this.emit();
  }

  // ---------------------------------------------------------------------------------
  // Órdenes

  pause(): boolean {
    if (this.state === "paused") return false;
    this.state = "paused"; // antes de host.stop(): si el host avisa de vuelta, ya cuadra
    this.host.stop();
    this.finish("pause");
    return true;
  }

  continue(): boolean {
    if (this.state !== "paused") return false;
    // Si estamos sobre un breakpoint, el núcleo pararía otra vez sin ejecutar nada.
    this.t.step();
    this.gen++;
    this.goal = null;
    this.state = "running";
    this.lastStop = null;
    this.emit();
    this.host.start();
    return true;
  }

  step(): boolean {
    if (this.state !== "paused") return false;
    this.t.step();
    // En HALT gb_step avanza un ciclo M: se sigue hasta que la CPU despierte.
    let n = 0;
    while (this.t.halted() && n < HALT_STEP_LIMIT) { this.t.step(); n++; }
    this.finish("step", this.t.halted() ? "la CPU sigue en HALT/STOP" : undefined);
    return true;
  }

  stepOver(): boolean {
    if (this.state !== "paused") return false;
    const { pc } = this.here();
    const op = opAt(this.read, pc);
    if (!isCall(op) || this.t.halted()) return this.step();
    const next = (pc + op!.length) & 0xffff;
    const goal: Goal = { kind: "over", bank: normBank(this.t.romBank(), next), addr: next, sp: this.t.sp() };
    this.t.step();
    // CALL cc sin salto (o un breakpoint en el destino inmediato): ya hemos llegado.
    if (this.t.pc() === next && this.t.sp() === goal.sp) { this.finish("step"); return true; }
    if (this.userHit()) { this.finish("breakpoint"); return true; }
    this.runWithGoal(goal);
    return true;
  }

  runTo(bank: number, addr: number): boolean {
    if (this.state !== "paused") return false;
    this.t.step(); // como continue: salir de la instrucción actual
    this.runWithGoal({ kind: "runTo", bank: normBank(bank, addr), addr: addr & 0xffff });
    return true;
  }

  private runWithGoal(goal: Goal): void {
    this.gen++;
    this.goal = goal;
    this.state = "stepping";
    this.lastStop = null;
    this.sync();
    this.emit();
    this.host.start();
  }

  /**
   * Salir de la función: no se sabe dónde está la dirección de retorno (la función pudo
   * apilar cosas), así que se ejecuta instrucción a instrucción llevando la profundidad
   * de llamadas: +1 por CALL/RST que salta o por despacho de IRQ (SP baja 2 y en la pila
   * queda el PC anterior, con PC en un vector), −1 por RET/RETI que salta (SP sube 2).
   * Se para cuando la profundidad baja de 0: hemos vuelto al llamador. Se para antes si
   * se llega a un breakpoint de usuario o tras OUT_LIMIT instrucciones (main sin retorno).
   */
  stepOut(): boolean {
    if (this.state !== "paused") return false;
    this.gen++;
    this.goal = { kind: "out", depth: 0, steps: 0 };
    this.state = "stepping";
    this.lastStop = null;
    this.emit();
    const gen = this.gen;
    this.schedule(() => this.outChunk(gen));
    return true;
  }

  private outChunk(gen: number): void {
    const g = this.goal;
    if (gen !== this.gen || !g || g.kind !== "out") return;
    const t = this.t;
    for (let i = 0; i < OUT_CHUNK; i++) {
      const pc = t.pc(), sp = t.sp();
      const op = t.halted() ? undefined : opAt(this.read, pc);
      t.step();
      g.steps++;
      const npc = t.pc(), nsp = t.sp();
      if (nsp === ((sp - 2) & 0xffff)) {
        const pushed = t.peek(nsp) | (t.peek((nsp + 1) & 0xffff) << 8);
        if ((IRQ_VECTORS.has(npc) && pushed === pc) || isCall(op)) g.depth++;
      } else if (isReturn(op) && nsp === ((sp + 2) & 0xffff)) {
        if (--g.depth < 0) { this.finish("out"); return; }
      }
      if (this.userHit()) { this.finish("breakpoint"); return; }
      if (g.steps >= this.outLimit) { this.finish("limit", "no se encontró el retorno de la función"); return; }
    }
    this.schedule(() => this.outChunk(gen));
  }

  /**
   * El bucle de emulación ha parado por su cuenta (gb_run_frame devolvió un motivo que
   * no es fin de frame). El host ya ha parado el bucle antes de llamar aquí.
   */
  notifyStop(reason: number): void {
    if (this.state === "paused") return; // parada antigua: ya estábamos en pausa
    this.host.stop();
    if (reason === STOP_WATCHPOINT) { this.finish("watchpoint"); return; }
    if (reason !== STOP_BREAKPOINT) { this.finish("pause"); return; }
    const g = this.goal;
    const { pc, bank } = this.here();
    if (g && g.kind !== "out" && pc === g.addr && (g.bank < 0 || g.bank === bank) &&
        (g.kind !== "over" || this.t.sp() >= g.sp)) {
      this.finish(g.kind);
      return;
    }
    if (this.userHit()) { this.finish("breakpoint"); return; }
    // Nadie reclama la parada: el temporal en una llamada recursiva más profunda, o una
    // dirección compartida por breakpoints de varios bancos. Se reanuda fuera de esta
    // pila (el host puede estar aún dentro de su callback de frame).
    const gen = this.gen;
    this.schedule(() => {
      if (gen !== this.gen || this.state === "paused") return;
      this.t.step();
      this.host.start();
    });
  }

  /**
   * El host arrancó o paró el bucle por su cuenta (cargar ROM, reset, su botón de
   * pausa). Cancela cualquier objetivo. Las llamadas que el propio controlador provoca
   * con host.start()/stop() se ignoran porque el estado ya cuadra.
   */
  syncRunning(running: boolean): void {
    if (running === (this.state !== "paused")) return;
    if (running) {
      this.gen++;
      const hadTemp = this.goal !== null && this.goal.kind !== "out";
      this.goal = null;
      this.state = "running";
      this.lastStop = null;
      if (hadTemp) this.sync();
      this.emit();
    } else {
      this.finish("pause");
    }
  }

  /** Watchpoint de escritura en [lo, hi]; false si el núcleo no lo admite o no caben más. */
  setWatchpoint(lo: number, hi: number, on: boolean): boolean {
    if (lo > hi) [lo, hi] = [hi, lo];
    const ok = this.t.wp?.set(lo, hi, on) ?? false;
    const i = this.wps.findIndex((w) => w.lo === lo && w.hi === hi);
    if (ok && on && i < 0) this.wps.push({ lo, hi });
    if (ok && !on && i >= 0) this.wps.splice(i, 1);
    this.emit();
    return ok;
  }

  watchpoints(): ReadonlyArray<{ lo: number; hi: number }> { return this.wps; }

  get watchpointsSupported(): boolean { return this.t.wp !== undefined; }
}
