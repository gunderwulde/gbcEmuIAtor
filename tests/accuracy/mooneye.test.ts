// mooneye (EXT): una prueba por ROM; catálogo en catalog.ts, fallos conocidos en known-failures.ts.
import { mooneyeCases } from "./catalog";
import { suite } from "./driver";

suite("mooneye", mooneyeCases);
