// D1 · Controlador del depurador contra el núcleo real (core.wasm) con programas
// ensamblados aquí. El valor esperado sale del programa (direcciones de etiquetas que da
// el ensamblador y registros que el código incrementa), no del controlador.
//
// El "host" simula el bucle de main.ts: mientras está en marcha llama a gb_run_frame y,
// si devuelve una parada que no es fin de frame, para y avisa con notifyStop. `schedule`
// encola las tareas para ejecutarlas cuando el test decida (así se reproduce el orden
// microtarea/rAF que causó la carrera de runTo en zxemuIAtor).
import { beforeEach, describe, expect, it } from "vitest";
import { assemble, type AsmResult } from "../../../web/src/asm";
import { DebugController } from "../../../web/src/ui/debugger/controller";
import { SourceMap } from "../../../web/src/ui/debugger/source";
import { wasmTarget, type CoreExports, type DebugTarget } from "../../../web/src/ui/debugger/target";
import { instantiate } from "../../util/wasm";

const SRC = `
SECTION "entry", ROM0[$100]
    nop
    jp Main
    ds $150 - @, 0

Main:
    di
    ld sp, $DFF0
    ld bc, 0
    ld de, 0
Loop:
    ld a, 1
CallFunc:
    call Func
AfterFunc:
    inc b
    xor a
CallNotTaken:
    call nz, Func
AfterNotTaken:
    ld e, 3
CallRec:
    call Rec
AfterRec:
    ld a, 2
    ld [$2000], a
CallBank2:
    call $4000
    ld a, 3
    ld [$2000], a
CallBank3:
    call $4000
    jr Loop

Func:
    inc c
CallInner:
    call Inner
AfterInner:
    push hl
    pop hl
    ret

Inner:
    inc d
InnerRet:
    ret

Rec:
    dec e
    jr z, RecDone
RecCall:
    call Rec
RecAfter:
    nop
RecDone:
    ret

SECTION "b2", ROMX[$4000], BANK[2]
Bank2Code:
    ld h, 2
    ret

SECTION "b3", ROMX[$4000], BANK[3]
Bank3Code:
    ld h, 3
    ret
`;

let asm: AsmResult;
const sym = (n: string): number => {
  const s = asm.symbols.get(n);
  if (!s) throw new Error(`falta ${n}`);
  return s.addr;
};

interface Harness {
  x: CoreExports;
  t: DebugTarget;
  ctl: DebugController;
  host: { running: boolean; starts: number; tasks: Array<() => void> };
  /** Hace correr el bucle simulado hasta que pare o pasen `frames`. */
  pump(frames?: number): void;
  /** Ejecuta las tareas programadas (y las que éstas programen). */
  flush(): void;
  reg(r: "a" | "b" | "c" | "d" | "e" | "h"): number;
}

async function harness(): Promise<Harness> {
  const x = (await instantiate("core")).exports as CoreExports;
  x.gb_init();
  new Uint8Array(x.memory.buffer, x.gb_rom(), asm.rom.length).set(asm.rom);
  expect(x.gb_insert(asm.rom.length)).toBe(0);
  const t = wasmTarget(x);
  const host = { running: false, starts: 0, tasks: [] as Array<() => void> };
  const ctl = new DebugController(t, {
    start: () => { host.running = true; host.starts++; },
    stop: () => { host.running = false; },
    schedule: (cb) => { host.tasks.push(cb); },
  });
  const off = { a: 1, b: 3, c: 2, d: 5, e: 4, h: 7 } as const;
  const h: Harness = {
    x, t, ctl, host,
    pump(frames = 20) {
      for (let i = 0; i < frames && host.running; i++) {
        const r = x.gb_run_frame() as number;
        if (r !== 0) { host.running = false; ctl.notifyStop(r); h.flush(); }
      }
    },
    flush() { while (host.tasks.length) host.tasks.shift()!(); },
    reg: (r) => new DataView(x.memory.buffer).getUint8((x.gb_regs() as number) + off[r]),
  };
  return h;
}

/** Corre hasta `addr` con un breakpoint de usuario y lo quita. */
function runToBp(h: Harness, addr: number, bank = -1): void {
  h.ctl.setBreakpoint({ bank, addr }, true);
  expect(h.ctl.continue()).toBe(true);
  h.pump();
  expect(h.ctl.state).toBe("paused");
  expect(h.t.pc()).toBe(addr);
  h.ctl.setBreakpoint({ bank, addr }, false);
}

beforeEach(() => {
  asm = assemble(SRC, { romBanks: 4 });
  expect(asm.errors).toEqual([]);
  asm.rom[0x147] = 0x19; // MBC5
  asm.rom[0x148] = 0x01; // 64 KB (4 bancos)
});

describe("D1 controlador: paso, paso por encima, salir", () => {
  it("paso ejecuta exactamente una instrucción", async () => {
    const h = await harness();
    expect(h.t.pc()).toBe(0x100);
    expect(h.ctl.step()).toBe(true);
    expect(h.t.pc()).toBe(0x101);
    expect(h.ctl.lastStop?.kind).toBe("step");
    h.ctl.step();
    expect(h.t.pc()).toBe(sym("Main"));
  });

  it("paso por encima de CALL vuelve a la instrucción siguiente con la función ejecutada", async () => {
    const h = await harness();
    runToBp(h, sym("CallFunc"));
    const c = h.reg("c"), d = h.reg("d"), sp = h.t.sp();
    expect(h.ctl.stepOver()).toBe(true);
    expect(h.ctl.state).toBe("stepping");
    h.pump();
    expect(h.ctl.state).toBe("paused");
    expect(h.ctl.lastStop?.kind).toBe("over");
    expect(h.t.pc()).toBe(sym("AfterFunc"));
    expect(h.t.sp()).toBe(sp);
    expect([h.reg("c"), h.reg("d")]).toEqual([(c + 1) & 0xff, (d + 1) & 0xff]);
  });

  it("paso por encima de CALL cc que no salta es un paso", async () => {
    const h = await harness();
    runToBp(h, sym("CallNotTaken"));
    const starts = h.host.starts;
    h.ctl.stepOver();
    expect(h.ctl.state).toBe("paused");
    expect(h.host.starts).toBe(starts); // no hizo falta arrancar el bucle
    expect(h.t.pc()).toBe(sym("AfterNotTaken"));
  });

  it("paso por encima en recursión para en la misma profundidad (SP), no en la más interna", async () => {
    const h = await harness();
    runToBp(h, sym("RecCall")); // primera entrada en Rec: E = 2
    const sp = h.t.sp();
    expect(h.reg("e")).toBe(2);
    h.ctl.stepOver();
    h.pump();
    expect(h.ctl.lastStop?.kind).toBe("over");
    expect(h.t.pc()).toBe(sym("RecAfter"));
    expect(h.t.sp()).toBe(sp);
    expect(h.reg("e")).toBe(0);
  });

  it("paso por encima de RST/llamada con breakpoint de usuario dentro para en el breakpoint", async () => {
    const h = await harness();
    runToBp(h, sym("CallFunc"));
    h.ctl.setBreakpoint({ bank: -1, addr: sym("Inner") }, true);
    h.ctl.stepOver();
    h.pump();
    expect(h.ctl.lastStop?.kind).toBe("breakpoint");
    expect(h.t.pc()).toBe(sym("Inner"));
    expect(h.ctl.goal).toBeNull();
    // El temporal de AfterFunc ya no está: continuar no para allí.
    h.ctl.setBreakpoint({ bank: -1, addr: sym("Inner") }, false);
    h.ctl.continue();
    h.pump(3);
    expect(h.ctl.state).toBe("running");
  });

  it("salir de la función vuelve al llamador, también desde una función anidada", async () => {
    const h = await harness();
    runToBp(h, sym("InnerRet") - 1); // dentro de Inner (en INC D)
    expect(h.ctl.stepOut()).toBe(true);
    expect(h.ctl.state).toBe("stepping");
    h.flush();
    expect(h.ctl.lastStop?.kind).toBe("out");
    expect(h.t.pc()).toBe(sym("AfterInner"));

    // Desde Func (tras volver de Inner, con PUSH/POP por medio) hasta Main.
    h.ctl.stepOut();
    h.flush();
    expect(h.t.pc()).toBe(sym("AfterFunc"));
  });

  it("salir sin llamador se rinde al llegar al límite", async () => {
    const h = await harness();
    runToBp(h, sym("Loop"));
    h.ctl.outLimit = 5000;
    h.ctl.stepOut();
    h.flush();
    expect(h.ctl.lastStop?.kind).toBe("limit");
    expect(h.ctl.state).toBe("paused");
  });

  it("pausa durante salir cancela las tandas pendientes", async () => {
    const h = await harness();
    runToBp(h, sym("Loop"));
    h.ctl.stepOut();
    expect(h.ctl.pause()).toBe(true);
    const pc = h.t.pc();
    h.flush();
    expect(h.t.pc()).toBe(pc);
    expect(h.ctl.lastStop?.kind).toBe("pause");
  });
});

describe("D1 controlador: hasta el cursor y la carrera de runTo", () => {
  it("runTo para en el destino y quita el temporal sólo al observar la parada", async () => {
    const h = await harness();
    h.ctl.step(); h.ctl.step();
    expect(h.ctl.runTo(-1, sym("CallRec"))).toBe(true);
    // Lo que en zxemuIAtor quitaba el breakpoint antes de tiempo: tareas programadas que
    // se ejecutan con el bucle aún en marcha. Aquí no hay ninguna que lo toque.
    h.flush();
    expect(h.ctl.state).toBe("stepping");
    h.pump();
    expect(h.ctl.lastStop?.kind).toBe("runTo");
    expect(h.t.pc()).toBe(sym("CallRec"));
    // El temporal ya no existe en el núcleo: continuar da vueltas al bucle sin parar.
    h.ctl.continue();
    h.pump(5);
    expect(h.ctl.state).toBe("running");
  });

  it("un breakpoint de usuario en el camino gana y cancela el runTo", async () => {
    const h = await harness();
    h.ctl.setBreakpoint({ bank: -1, addr: sym("Inner") }, true);
    h.ctl.runTo(-1, sym("CallRec"));
    h.pump();
    expect(h.ctl.lastStop?.kind).toBe("breakpoint");
    expect(h.t.pc()).toBe(sym("Inner"));
    h.ctl.setBreakpoint({ bank: -1, addr: sym("Inner") }, false);
    h.ctl.continue();
    h.pump(5);
    expect(h.ctl.state).toBe("running"); // el temporal de CallRec tampoco quedó
  });

  it("pausar durante runTo quita el temporal", async () => {
    const h = await harness();
    h.ctl.runTo(-1, 0x3000); // nunca se alcanza
    h.pump(2);
    expect(h.ctl.state).toBe("stepping");
    h.ctl.pause();
    expect(h.host.running).toBe(false);
    expect(h.ctl.goal).toBeNull();
    expect(h.ctl.state).toBe("paused");
  });

  it("órdenes fuera de estado se ignoran", async () => {
    const h = await harness();
    h.ctl.continue();
    expect(h.ctl.state).toBe("running");
    expect(h.ctl.step()).toBe(false);
    expect(h.ctl.stepOver()).toBe(false);
    expect(h.ctl.stepOut()).toBe(false);
    expect(h.ctl.runTo(-1, 0x150)).toBe(false);
    expect(h.ctl.continue()).toBe(false);
    expect(h.ctl.pause()).toBe(true);
    expect(h.ctl.pause()).toBe(false);
    // Paradas viejas tras la pausa no cambian nada.
    h.ctl.notifyStop(1);
    expect(h.ctl.state).toBe("paused");
  });

  it("syncRunning refleja arranques y paradas del host y cancela objetivos", async () => {
    const h = await harness();
    h.ctl.runTo(-1, 0x3000);
    h.ctl.syncRunning(true); // eco del propio host.start(): se ignora
    expect(h.ctl.state).toBe("stepping");
    h.ctl.syncRunning(false); // el host paró por su cuenta (p. ej. su botón de pausa)
    expect(h.ctl.state).toBe("paused");
    expect(h.ctl.goal).toBeNull();
    h.ctl.syncRunning(true); // cargó una ROM y arrancó
    expect(h.ctl.state).toBe("running");
  });
});

describe("D1 controlador: breakpoints por banco", () => {
  it("un breakpoint en 3:4000 sólo para con el banco 3 mapeado", async () => {
    const h = await harness();
    h.ctl.setBreakpoint({ bank: 3, addr: 0x4000 }, true);
    h.ctl.continue();
    h.pump();
    expect(h.t.pc()).toBe(0x4000);
    expect(h.t.romBank()).toBe(3);
    h.ctl.step();
    expect(h.reg("h")).toBe(3);
  });

  it("la misma dirección en dos bancos: para en ambos (el núcleo recibe banco -1)", async () => {
    const h = await harness();
    h.ctl.setBreakpoint({ bank: 2, addr: 0x4000 }, true);
    h.ctl.setBreakpoint({ bank: 3, addr: 0x4000 }, true);
    h.ctl.continue(); h.pump();
    expect([h.t.pc(), h.t.romBank()]).toEqual([0x4000, 2]);
    h.ctl.continue(); h.pump();
    expect([h.t.pc(), h.t.romBank()]).toEqual([0x4000, 3]);
  });

  it("con un banco puesto y otro no, la parada del otro banco se descarta y se reanuda", async () => {
    const h = await harness();
    // Temporal en 2:4000 (runTo) y de usuario en 3:4000: el núcleo recibe -1 y para en los
    // dos; el controlador reclama la de banco 2 como runTo y la de 3 como breakpoint.
    h.ctl.setBreakpoint({ bank: 3, addr: 0x4000 }, true);
    h.ctl.runTo(2, 0x4000);
    h.pump();
    expect(h.ctl.lastStop?.kind).toBe("runTo");
    expect(h.t.romBank()).toBe(2);
    h.ctl.continue(); h.pump();
    expect(h.ctl.lastStop?.kind).toBe("breakpoint");
    expect(h.t.romBank()).toBe(3);
    // Quitado el de usuario, sólo queda... nada: el bucle no para.
    h.ctl.setBreakpoint({ bank: 3, addr: 0x4000 }, false);
    h.ctl.continue(); h.pump(5);
    expect(h.ctl.state).toBe("running");
  });

  it("toggle devuelve el estado y normaliza el banco fuera de ROMX", async () => {
    const h = await harness();
    expect(h.ctl.toggleBreakpoint({ bank: 5, addr: 0x150 })).toBe(true);
    expect(h.ctl.hasBreakpoint(0, 0x150)).toBe(true);
    expect(h.ctl.breakpoints()).toEqual([{ bank: -1, addr: 0x150 }]);
    expect(h.ctl.toggleBreakpoint({ bank: -1, addr: 0x150 })).toBe(false);
    expect(h.ctl.breakpoints()).toEqual([]);
  });
});

describe("D1 mapa de fuente (lineMap)", () => {
  const lines = SRC.split("\n");
  const lineOf = (label: string): number => lines.findIndex((l) => l.startsWith(label + ":")) + 1;

  it("línea → banco:dirección; una línea sin código va a la siguiente con código", () => {
    const sm = new SourceMap(asm.lineMap);
    const l = lineOf("CallFunc"); // la etiqueta sola no emite bytes
    expect(sm.lineToAddr("main.asm", l)).toEqual({ bank: -1, addr: sym("CallFunc"), line: l + 1 });
    expect(sm.lineToAddr("main.asm", l + 1)).toEqual({ bank: -1, addr: sym("CallFunc"), line: l + 1 });
    const b3 = lineOf("Bank3Code") + 1;
    expect(sm.lineToAddr("main.asm", b3)).toEqual({ bank: 3, addr: 0x4000, line: b3 });
    expect(sm.lineToAddr("otro.asm", 1)).toBeUndefined();
  });

  it("dirección → línea, distinguiendo bancos de ROMX y dentro de una instrucción", () => {
    const sm = new SourceMap(asm.lineMap);
    expect(sm.addrToLine(2, 0x4000)).toEqual({ file: "main.asm", line: lineOf("Bank2Code") + 1 });
    expect(sm.addrToLine(3, 0x4000)).toEqual({ file: "main.asm", line: lineOf("Bank3Code") + 1 });
    expect(sm.addrToLine(-1, sym("CallFunc") + 2)).toEqual({ file: "main.asm", line: lineOf("CallFunc") + 1 });
    expect(sm.addrToLine(-1, 0x3000)).toBeUndefined();
  });

  it("breakpoint por línea de fuente para en esa línea", async () => {
    const h = await harness();
    const sm = new SourceMap(asm.lineMap);
    const loc = sm.lineToAddr("main.asm", lineOf("Bank3Code") + 1)!;
    h.ctl.setBreakpoint({ ...loc, file: "main.asm" }, true);
    h.ctl.continue(); h.pump();
    expect(sm.addrToLine(h.t.romBank(), h.t.pc())?.line).toBe(loc.line);
  });
});
