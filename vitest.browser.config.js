import { defineConfig } from "vitest/config";

// Browser-environment tests (canvas, Image, etc.) run with jsdom.
// Run with: npx vitest run --config vitest.browser.config.js
export default defineConfig({
  test: {
    include: ["tests/browser/**/*.test.js"],
    environment: "jsdom",
    coverage: {
      provider: "v8",
      include: ["js/imageOps.js"],
      exclude: ["js/bg.js"],
      reporter: ["text"],
    },
  },
});
