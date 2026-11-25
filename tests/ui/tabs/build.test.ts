// U1 · De pestañas a programa en marcha, contra el núcleo real. Lo esperado se ve en el
// framebuffer: el programa pone el color 0 de la paleta de fondo 0 (el de toda la
// pantalla: VRAM a cero tras el reset, todo tile 0) a un color escrito a mano.
import { describe, expect, it } from "vitest";
import { buildTabs } from "../../../web/src/ui/tabs/build";
import { ccCompile, clibFiles, type CcOutput, type CompileFn } from "../../../web/src/ui/tabs/deps";
import { DEFAULT_C_EXAMPLE, ASM_EXAMPLES, C_EXAMPLES } from "../../../web/src/ui/tabs/examples";
import { GEN_NAME, TabsModel, hasMain } from "../../../web/src/ui/tabs/model";
import { distinctColors, frame, loadCore, runFrames } from "../editor/core-helper";
import type { Core } from "../../../web/src/emu/core";

/** Programa que pinta toda la pantalla de RGB555 (r, g, b) usando constantes de un INCLUDE. */
const PROGRAM = (inc: string) => `
INCLUDE "${inc}"
SECTION "Entry", ROM0[$100]
    nop
    jp Main
    ds $150 - @, 0
Main:
.vbl:
    ldh a, [$44]
    cp 144
    jr nz, .vbl
    ld a, $80
    ldh [$68], a
    ld a, LOW(COLOR)
    ldh [$69], a
    ld a, HIGH(COLOR)
    ldh [$69], a
.l: halt
    jr .l
`;
const colorInc = (r: number, g: number, b: number) => `DEF COLOR EQU ${r} | ${g} << 5 | ${b} << 10\n`;

/** Píxel (x, y) del framebuffer como [r, g, b]. */
function px(core: Core, x: number, y: number): [number, number, number] {
  const fb = core.framebuffer();
  const i = (y * 160 + x) * 4;
  return [fb[i]!, fb[i + 1]!, fb[i + 2]!];
}

describe("U1 construir desde pestañas", () => {
  it(".asm con INCLUDE de otra pestaña: arranca y se ve el color", async () => {
    const core = await loadCore();
    const m = new TabsModel();
    const main = m.add("main.asm", PROGRAM("color.inc"));
    m.add("color.inc", colorInc(31, 0, 0));
    const r = buildTabs(m, main, {}, core);
    expect(r.status.level).toBe("ok");
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("asm");
    runFrames(core, 3);
    const [R, G, B] = px(core, 80, 72);
    expect(R).toBeGreaterThan(200);
    expect(G).toBeLessThan(30);
    expect(B).toBeLessThan(30);
  });

  it("errores del .inc van a su pestaña y el núcleo no se toca", async () => {
    const core = await loadCore();
    const m = new TabsModel();
    const main = m.add("main.asm", PROGRAM("color.inc"));
    m.add("color.inc", "\n    frob a\n");
    const before = core.x.gb_cycles_lo() >>> 0;
    const r = buildTabs(m, main, {}, core);
    expect(r.ok).toBe(false);
    expect(r.diags.some((d) => d.tab === "color.inc" && d.line === 2 && d.severity === "error")).toBe(true);
    expect(core.x.gb_cycles_lo() >>> 0).toBe(before);
  });

  it("los .asm de ejemplo se construyen sin errores", () => {
    for (const ex of ASM_EXAMPLES) {
      const m = new TabsModel();
      const t = m.add(ex.main, ex.files.get(ex.main)!);
      expect(buildTabs(m, t).diags.filter((d) => d.severity === "error"), ex.id).toEqual([]);
    }
  });

  // ---- C con un compilador falso: prueba el camino de U1 sin depender de K1 ----

  /** "Compila" main.c a PROGRAM con la marca de la línea 4 de main.c en el código del color. */
  const fakeCompile = (extra = ""): CompileFn & { seen?: Map<string, string> } => {
    const f: CompileFn & { seen?: Map<string, string> } = (files, opts) => {
      f.seen = files;
      const inc = opts.includeResolver?.("color.h", opts.main);
      const asm = [
        `DEF COLOR EQU ${/COLOR\s+(\d+)/.exec(inc ?? "")?.[1] ?? 0}`,
        "SECTION \"Entry\", ROM0[$100]",
        "    nop",
        "    jp Main",
        "    ds $150 - @, 0",
        "Main:",
        "; main.c:4: wait_vbl();",
        ".vbl:",
        "    ldh a, [$44]",
        "    cp 144",
        "    jr nz, .vbl",
        "; main.c:5: set_color(COLOR);",
        "    ld a, $80",
        "    ldh [$68], a",
        "    ld a, LOW(COLOR)",
        "    ldh [$69], a",
        "    ld a, HIGH(COLOR)",
        "    ldh [$69], a",
        extra,
        "",
        ".l: halt",
        "    jr .l",
      ].join("\n");
      const out: CcOutput = { asm, errors: [], cLineMap: [
        { file: "main.c", line: 4, asmLine: 7 },
        { file: "main.c", line: 5, asmLine: 12 },
      ] };
      return out;
    };
    return f;
  };
  const C_SRC = "#include \"color.h\"\n\nvoid main(void) {\n  wait_vbl();\n  set_color(COLOR);\n}\n";

  it("C: compila → ensambla → arranca; lineMap en líneas C; ficheros del programa", async () => {
    const core = await loadCore();
    const m = new TabsModel();
    m.add("main.asm", "; otro programa");
    const c = m.add("main.c", C_SRC, 1);
    m.add("color.h", "#define COLOR 992\n"); // verde puro: 31 << 5
    m.add("util.c", "int f(void) { return 1; }");
    m.add("otro.c", "void main(void) {}");
    const compile = fakeCompile();
    const r = buildTabs(m, c, { compile }, core);
    expect(r.status.level).toBe("ok");
    expect(r.status.text).toMatch(/^Sin errores · C → \d+ líneas/);
    expect([...compile.seen!.keys()].sort()).toEqual(["color.h", "main.c", "util.c"]);
    runFrames(core, 3);
    const [R, G, B] = px(core, 10, 10);
    expect(G).toBeGreaterThan(200);
    expect(R + B).toBeLessThan(60);

    const lines = new Set(r.result!.lineMap.filter((e) => e.file === "main.c").map((e) => e.line));
    expect([...lines].sort()).toEqual([4, 5]);
    // nop/jp de la cabecera y el bucle final (tras la línea vacía) quedan en el generado
    expect(r.result!.lineMap.some((e) => e.file === GEN_NAME && e.addr === 0x100)).toBe(true);
    const halt = r.result!.symbols.get("Main.l") ?? r.result!.symbols.get(".l");
    if (halt) expect(r.result!.lineMap.find((e) => e.addr === halt.addr)?.file).toBe(GEN_NAME);
  });

  it("C: error del ensamblador en el generado → pestaña generada y línea C de origen", () => {
    const m = new TabsModel();
    const c = m.add("main.c", C_SRC);
    m.add("color.h", "#define COLOR 1\n");
    const r = buildTabs(m, c, { compile: fakeCompile("    frob a") });
    expect(r.ok).toBe(false);
    expect(r.status.level).toBe("error");
    expect(r.status.text).toMatch(/\(de main\.c:5\)/);
    expect(r.diags).toContainEqual(expect.objectContaining({ tab: GEN_NAME, line: 19, severity: "error" }));
    expect(r.diags).toContainEqual(expect.objectContaining({ tab: "main.c", line: 5, col: 0, severity: "error" }));
  });

  it("C: errores del compilador a su pestaña; sin compilador, aviso claro", () => {
    const m = new TabsModel();
    const c = m.add("main.c", C_SRC);
    m.add("color.h", "");
    const bad: CompileFn = () => ({ asm: "", cLineMap: [], errors: [
      { file: "color.h", line: 1, col: 3, msg: "se esperaba ';'", severity: "error" },
      { file: "/lib/gbc.h", line: 7, col: 1, msg: "aviso", severity: "warning" },
    ] });
    const r = buildTabs(m, c, { compile: bad });
    expect(r.ok).toBe(false);
    expect(r.status.text).toMatch(/^1 error de C · color\.h:1: se esperaba ';'/);
    // Los de la librería van a su pestaña de sólo lectura "<gbc.h>" (si L1 la tiene).
    expect(r.diags.map((d) => d.tab)).toEqual(["color.h", clibFiles.has("gbc.h") ? "<gbc.h>" : "gbc.h"]);

    if (!ccCompile) {
      const r2 = buildTabs(m, c);
      expect(r2.ok).toBe(false);
      expect(r2.status.text).toMatch(/compilador de C aún no está disponible/);
    }
  });

  it("el ejemplo C por defecto es el 01 de L1, un programa, y está en el menú", () => {
    const d = DEFAULT_C_EXAMPLE!;
    expect(d.id).toBe("c:c01-hola");
    expect(d.lang).toBe("c");
    expect(hasMain(d.files.get(d.main)!)).toBe(true);
    expect(C_EXAMPLES[0]).toBe(d);
    expect(C_EXAMPLES.length).toBe(11);
  });

  // ---- Con el compilador real (K1), cuando exista ----
  it.skipIf(!ccCompile)("C real: cada ejemplo C compila, arranca y pinta algo en pantalla", async () => {
    for (const ex of C_EXAMPLES) {
      const core = await loadCore();
      const m = new TabsModel();
      let main;
      for (const [name, text] of ex.files) { const t = m.add(name, text, m.tabs.length); if (name === ex.main) main = t; }
      const r = buildTabs(m, main!, {}, core);
      expect(r.diags.filter((d) => d.severity === "error"), `${ex.id}: ${r.status.text}`).toEqual([]);
      expect(r.ok, ex.id).toBe(true);
      expect(r.result!.lineMap.some((e) => e.file === ex.main), ex.id).toBe(true);
      runFrames(core, 30);
      expect(distinctColors(frame(core)), ex.id).toBeGreaterThan(1);
    }
  });
});
