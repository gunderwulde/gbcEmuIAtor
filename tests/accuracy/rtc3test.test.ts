// rtc3test (EXT): una prueba por ROM; catálogo en catalog.ts, fallos conocidos en known-failures.ts.
import { rtc3Cases } from "./catalog";
import { suite } from "./driver";

suite("rtc3test", rtc3Cases);
