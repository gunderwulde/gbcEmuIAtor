// AGE test roms (EXT): una prueba por ROM; catálogo en catalog.ts, fallos conocidos en known-failures.ts.
import { ageCases } from "./catalog";
import { suite } from "./driver";

suite("AGE test roms", ageCases);
