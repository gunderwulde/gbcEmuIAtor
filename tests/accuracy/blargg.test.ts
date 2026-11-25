// Blargg (EXT): una prueba por ROM; catálogo en catalog.ts, fallos conocidos en known-failures.ts.
import { blarggCases } from "./catalog";
import { suite } from "./driver";

suite("Blargg", blarggCases);
