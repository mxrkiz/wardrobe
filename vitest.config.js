import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default: node environment for unit tests
    include: ["tests/unit/**/*.test.js"],
    exclude: ["tests/browser/**", "tests/e2e/**", "node_modules/**"],

    coverage: {
      provider: "v8",
      include: [
        "js/util.js",
        "js/state.js",
        "js/categories.js",
        "js/imageOps.js",
      ],
      // Glue code excluded: Konva bindings, IDB wrappers, DOM bootstrap
      exclude: [
        "js/db.js",
        "js/bg.js",
        "js/canvas.js",
        "js/editor.js",
        "js/main.js",
        "js/factory.js",
        "js/ui/**",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      reporter: ["text", "lcov"],
    },
  },
});
