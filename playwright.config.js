import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: 0,
  reporter: "list",

  use: {
    baseURL: "http://localhost:2540",
    trace: "on-first-retry",
  },

  // Start Live Server equivalent (npx serve) before E2E tests run.
  webServer: {
    command: "npx serve . -p 2540 --no-clipboard",
    url: "http://localhost:2540",
    reuseExistingServer: true,
    timeout: 15_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
