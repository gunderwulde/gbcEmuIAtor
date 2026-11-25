// Núcleo real (build/wasm/core.wasm) envuelto en la clase Core de la app, para probar
// run.ts y los ejemplos sin navegador. Core.load usa fetch; aquí se instancia el .wasm
// del disco y se llama al constructor (privado sólo para TypeScript).
import { Core } from "../../../web/src/emu/core";
import { instantiate } from "../../util/wasm";

export async function loadCore(): Promise<Core> {
  const instance = await instantiate("core");
  const C = Core as unknown as new (i: WebAssembly.Instance) => Core;
  const core = new C(instance);
  core.setColorCorrection(false);
  return core;
}

/** Copia del framebuffer como píxeles RGBA de 32 bits. */
export function frame(core: Core): Uint32Array {
  const fb = core.framebuffer();
  return new Uint32Array(fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.byteLength));
}

export function distinctColors(px: Uint32Array): number {
  return new Set(px).size;
}

export function differs(a: Uint32Array, b: Uint32Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

export function runFrames(core: Core, n: number, pad = 0): void {
  for (let i = 0; i < n; i++) {
    core.joypad(pad);
    core.runFrame();
  }
}
