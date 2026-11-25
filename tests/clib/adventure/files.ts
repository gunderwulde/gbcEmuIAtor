// Los ficheros de la aventura, leídos del disco tal como los abre el IDE (una pestaña por
// fichero); la librería la resuelve includeResolver.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../web/src/clib/examples/adventure");

export function adventureFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const f of readdirSync(DIR).sort()) files.set(f, readFileSync(join(DIR, f), "utf8"));
  return files;
}
