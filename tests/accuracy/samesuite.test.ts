// SameSuite (EXT): una prueba por ROM; catálogo en catalog.ts, fallos conocidos en known-failures.ts.
import { sameSuiteCases } from "./catalog";
import { suite } from "./driver";

suite("SameSuite", sameSuiteCases);
