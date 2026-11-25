import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    // Los *.bench-test.ts miden tiempos: van en npm run test:perf, nunca en paralelo con la suite.
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
