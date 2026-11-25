// Ejemplos precargados del editor: homebrew propio (tiles dibujados con `dw \``), sin
// material de Nintendo. Las fuentes viven en web/src/asm/examples/.
import hello from "../../asm/examples/hello.asm?raw";
import scroll from "../../asm/examples/scroll.asm?raw";
import sprite from "../../asm/examples/sprite.asm?raw";
import palettes from "../../asm/examples/palettes.asm?raw";

export interface Example {
  id: string;
  title: string;
  source: string;
}

export const EXAMPLES: readonly Example[] = [
  { id: "hello", title: "Hola mundo", source: hello },
  { id: "scroll", title: "Scroll del fondo", source: scroll },
  { id: "sprite", title: "Sprite con la cruceta", source: sprite },
  { id: "palettes", title: "Paletas CGB animadas", source: palettes },
];

export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
