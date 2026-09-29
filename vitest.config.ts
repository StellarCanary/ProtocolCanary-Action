import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      // Measure the shipped source, not the committed dist/ bundle or the
      // test suite itself.
      include: ["src/**/*"],
      reportsDirectory: "coverage",
      reporter: ["text", "html", "lcov"],
    },
  },
});
