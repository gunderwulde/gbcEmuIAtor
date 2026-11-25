// U1 · Modelo de pestañas (sin DOM): nombres, principal, qué se ejecuta, qué ficheros
// entran en un programa C, cierre y persistencia. Lo esperado son las reglas de la tarea
// U1 de PLAN.md (las mismas que en zxemuIAtor), escritas a mano.
import { describe, expect, it } from "vitest";
import {
  GEN_NAME, LEGACY_SOURCE_KEY, TABS_KEY, TabsModel, hasMain, isRunnable, kindOf, langOf, libTabName, type Prefs,
} from "../../../web/src/ui/tabs/model";

const memPrefs = (init: Record<string, string> = {}): Prefs & { data: Record<string, string> } => {
  const data = { ...init };
  return { data, get: (k) => data[k] ?? null, set: (k, v) => { data[k] = v; } };
};

const C_MAIN = "#include \"util.h\"\nvoid main(void) { for (;;) {} }\n";
const C_MOD = "int twice(int x) { return x * 2; } // main( en comentario no cuenta\n";
const DEFAULTS = { asm: "; asm\n", c: { files: new Map([["hola.c", C_MAIN]]), main: "hola.c" }, start: "c" as const };

describe("U1 modelo de pestañas", () => {
  it("tipos, lenguaje y main()", () => {
    expect(kindOf("a.ASM")).toBe("asm");
    expect(kindOf("x.inc")).toBe("inc");
    expect(kindOf("x.txt")).toBeNull();
    expect(hasMain(C_MAIN)).toBe(true);
    expect(hasMain(C_MOD)).toBe(false);
    expect(hasMain("/* main() */ const char *s = \"main()\";")).toBe(false);
    expect(langOf({ id: 1, name: "a.h", text: "" })).toBe("c");
    expect(langOf({ id: 1, name: libTabName("gbc.h"), text: "", ro: "lib" })).toBe("c");
    expect(langOf({ id: 1, name: GEN_NAME, text: "", ro: "gen" })).toBe("sm83");
    expect(isRunnable({ id: 1, name: "m.c", text: C_MAIN })).toBe(true);
    expect(isRunnable({ id: 1, name: "m.c", text: C_MOD })).toBe(false);
    expect(isRunnable({ id: 1, name: "x.inc", text: "" })).toBe(false);
    expect(isRunnable({ id: 1, name: "g.asm", text: "", ro: "gen" })).toBe(false);
  });

  it("nombres: extensión, caracteres, repetidos (sin distinguir mayúsculas)", () => {
    const m = new TabsModel();
    m.add("main.asm", "");
    expect(m.checkName("otro.c")).toBeNull();
    expect(m.checkName("MAIN.asm")).toMatch(/Ya hay/);
    expect(m.checkName("x.txt")).toMatch(/\.asm, \.inc, \.c o \.h/);
    expect(m.checkName(" a.c")).toMatch(/vacío/);
    expect(m.checkName("a/b.c")).toMatch(/no puede llevar/);
    expect(m.checkName("<gbc.h>")).toMatch(/no puede llevar/); // no chocan con las de la librería
    // Ni con la generada, aunque aún no esté abierta (si no, se confundirían al compilar).
    expect(m.checkName(GEN_NAME)).toMatch(/reservado/);
    expect(m.checkName(GEN_NAME.toUpperCase())).toMatch(/reservado/);
    expect(() => m.add(GEN_NAME, "")).toThrow(/reservado/);
    const u = m.add("u.asm", "");
    expect(m.rename(u.id, GEN_NAME)).toMatch(/reservado/);
    expect(() => m.add("main.asm", "")).toThrow(/Ya hay/);
    expect(m.freeName("main", "asm")).toBe("main2.asm");
    expect(m.freeName("nuevo", "c")).toBe("nuevo.c");
  });

  it("la primera ejecutable es la principal; runTarget = activa si se puede ejecutar, si no la principal", () => {
    const m = new TabsModel();
    const h = m.add("util.h", "");
    expect(m.mainId).toBeNull();
    const c = m.add("hola.c", C_MAIN);
    const a = m.add("demo.asm", "");
    expect(m.mainId).toBe(c.id);
    m.setActive(h.id);
    expect(m.runTarget()).toBe(c); // un .h no se ejecuta
    m.setActive(a.id);
    expect(m.runTarget()).toBe(a);
    m.setMain(a.id);
    m.setActive(h.id);
    expect(m.runTarget()).toBe(a);
    m.setMain(h.id); // no ejecutable: no cambia
    expect(m.mainId).toBe(a.id);
  });

  it("programa C: el .c principal, todos los .h y los .c sin main (no otros programas)", () => {
    const m = new TabsModel();
    m.add("main.asm", "");
    const c = m.add("hola.c", C_MAIN);
    m.add("util.h", "int twice(int);");
    m.add("util.c", C_MOD);
    m.add("otro.c", "void main(void) {}");
    m.add("defs.inc", "DEF X EQU 1");
    expect([...m.cFiles(c).keys()].sort()).toEqual(["hola.c", "util.c", "util.h"]);
    expect([...m.asmFiles().keys()].sort()).toEqual(["defs.inc", "main.asm"]);
    expect(m.userText("sub/UTIL.H")).toBe("int twice(int);");
    m.addReadOnly(libTabName("gbc.h"), "lib", "lib");
    expect(m.userText("<gbc.h>")).toBeUndefined();
  });

  it("cerrar: activa a la derecha, principal a la siguiente ejecutable, la última se vacía", () => {
    const m = new TabsModel();
    const a = m.add("a.asm", "A", 0);
    const b = m.add("b.asm", "B", 1);
    const c = m.add("c.asm", "C", 2);
    m.setActive(b.id);
    m.setMain(b.id);
    m.close(b.id);
    expect(m.activeId).toBe(c.id);
    expect(m.mainId).toBe(a.id);
    m.close(c.id);
    expect(m.activeId).toBe(a.id);
    m.close(a.id);
    expect(m.tabs.length).toBe(1);
    expect(a.text).toBe("");
  });

  it("renombrar: valida, y si deja de ser ejecutable la principal pasa a otra", () => {
    const m = new TabsModel();
    const a = m.add("a.asm", "");
    const c = m.add("p.c", C_MAIN);
    expect(m.mainId).toBe(a.id);
    expect(m.rename(a.id, "p.C")).toMatch(/Ya hay/);
    expect(m.rename(a.id, "a.inc")).toBeNull();
    expect(m.mainId).toBe(c.id);
    const g = m.addReadOnly(GEN_NAME, "x", "gen");
    expect(m.rename(g.id, "g.asm")).toMatch(/no se puede/);
    expect(m.addReadOnly(GEN_NAME, "y", "gen")).toBe(g); // se reutiliza
    expect(g.text).toBe("y");
  });

  it("mover", () => {
    const m = new TabsModel();
    const a = m.add("a.asm", "", 0), b = m.add("b.asm", "", 1), c = m.add("c.asm", "", 2);
    m.move(a.id, 99);
    expect(m.tabs.map((t) => t.id)).toEqual([b.id, c.id, a.id]);
  });

  it("persistencia: sólo pestañas de usuario, activa y principal; JSON corrupto = nada guardado", () => {
    const p = memPrefs();
    const m = TabsModel.load(p, DEFAULTS);
    expect(m.user.map((t) => t.name)).toEqual(["main.asm", "hola.c"]);
    expect(m.active?.name).toBe("hola.c"); // start: "c"
    expect(m.main?.name).toBe("hola.c");
    m.add("util.h", "int x;");
    m.addReadOnly(GEN_NAME, "gen", "gen");
    m.setActive(m.find("main.asm")!.id);
    m.setMain(m.find("main.asm")!.id);
    m.save(p);
    const r = TabsModel.load(p, DEFAULTS);
    expect(r.tabs.map((t) => t.name)).toEqual(["main.asm", "hola.c", "util.h"]); // nueva tras la activa
    expect(r.find(GEN_NAME)).toBeUndefined();
    expect(r.active?.name).toBe("main.asm");
    expect(r.main?.name).toBe("main.asm");
    expect(r.find("util.h")!.text).toBe("int x;");

    p.data[TABS_KEY] = "{roto";
    expect(TabsModel.load(p, DEFAULTS).user.map((t) => t.name)).toEqual(["main.asm", "hola.c"]);
  });

  it("migra el fuente del editor de I1 a main.asm (activa y principal)", () => {
    const p = memPrefs({ [LEGACY_SOURCE_KEY]: "; mío\n" });
    const m = TabsModel.load(p, DEFAULTS);
    expect(m.active?.name).toBe("main.asm");
    expect(m.main?.name).toBe("main.asm");
    expect(m.find("main.asm")!.text).toBe("; mío\n");
    expect(m.find("hola.c")).toBeDefined();
  });

  it("sin compilador (start asm) arranca en main.asm", () => {
    const m = TabsModel.initial({ ...DEFAULTS, start: "asm" });
    expect(m.active?.name).toBe("main.asm");
  });
});
