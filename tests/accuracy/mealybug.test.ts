// Mealybug Tearoom (EXT): una prueba por ROM; catálogo en catalog.ts, fallos conocidos en known-failures.ts.
import { mealybugCases } from "./catalog";
import { suite } from "./driver";

suite("Mealybug Tearoom", mealybugCases);
