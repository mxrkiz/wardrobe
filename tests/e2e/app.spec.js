// E2E tests — run against a live static server (configured in playwright.config.js).
// These tests exercise the app shell without actually uploading real images
// (which would trigger slow ML inference). They verify UI structure, keyboard
// shortcuts, and canvas-background controls.
import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Page load --------------------------------------------------------------

test("page loads with expected shell elements", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".brand")).toHaveText("~/wardrobe");
  await expect(page.locator("#btn-export")).toBeDisabled();
  await expect(page.locator("#btn-clear")).toBeDisabled();
  await expect(page.locator("#upload-drop")).toBeVisible();
  await expect(page.locator("#wardrobe-tree")).toBeVisible();
  await expect(page.locator("#canvas-host")).toBeVisible();
});

test("status bar shows bg probe result", async ({ page }) => {
  await page.goto("/");
  // Wait up to 10s for the bg status to settle (ready or error)
  await expect(page.locator("#status-bg .text")).not.toHaveText("bg: …", { timeout: 10_000 });
});

// ---- Canvas background swatches --------------------------------------------

test("canvas background swatch changes bg colour", async ({ page }) => {
  await page.goto("/");
  // Click the dark swatch (#0d1117)
  await page.locator('[data-cbg="#0d1117"]').click();
  // The canvas stage background should update — we read it back from state
  // via a page.evaluate since we cannot check Konva directly.
  const bg = await page.evaluate(() => {
    // The wardrobe app exposes nothing on window; check data-cbg active class
    return document.querySelector('[data-cbg="#0d1117"]')?.classList.contains("active");
  });
  expect(bg).toBe(true);
});

test("canvas background reverts to white swatch", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-cbg="#0d1117"]').click();
  await page.locator('[data-cbg="#ffffff"]').click();
  const bg = await page.evaluate(() =>
    document.querySelector('[data-cbg="#ffffff"]')?.classList.contains("active"),
  );
  expect(bg).toBe(true);
});

// ---- Grid toggle ------------------------------------------------------------

test("grid toggle checkbox changes state", async ({ page }) => {
  await page.goto("/");
  const toggle = page.locator("#toggle-grid");
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
});

// ---- Upload and layer flow --------------------------------------------------

test("uploading an image creates a wardrobe item and layer", async ({ page }) => {
  await page.goto("/");

  // Use a small synthetic PNG (1x1 red pixel encoded as base64)
  // We write it to a temp file and set it via the file input.
  const tmpPng = path.resolve(__dirname, "fixtures", "red1x1.png");

  await page.locator("#upload-input").setInputFiles(tmpPng);

  // Wait for the item to appear in the wardrobe tree (bg removal may take a moment)
  await expect(page.locator("#wardrobe-tree .item")).toHaveCount(1, { timeout: 30_000 });

  // Layer count badge should update
  await expect(page.locator("#layer-count")).not.toHaveText("0");

  // Export and clear buttons should now be enabled
  await expect(page.locator("#btn-export")).toBeEnabled({ timeout: 5_000 });
  await expect(page.locator("#btn-clear")).toBeEnabled();
});

test("Delete key removes the selected layer", async ({ page }) => {
  await page.goto("/");
  const tmpPng = path.resolve(__dirname, "fixtures", "red1x1.png");
  await page.locator("#upload-input").setInputFiles(tmpPng);
  await expect(page.locator("#wardrobe-tree .item")).toHaveCount(1, { timeout: 30_000 });

  // Click the layer in the layers panel to select it
  await page.locator("#layer-list .layer-row").first().click();

  await page.keyboard.press("Delete");

  // Layer list should be empty
  await expect(page.locator("#layer-list .layer-row")).toHaveCount(0, { timeout: 5_000 });
  // Item still exists in wardrobe tree (delete only removes the layer, not the item)
  await expect(page.locator("#wardrobe-tree .item")).toHaveCount(1);
});

test("clear button removes all layers", async ({ page }) => {
  await page.goto("/");
  const tmpPng = path.resolve(__dirname, "fixtures", "red1x1.png");
  await page.locator("#upload-input").setInputFiles(tmpPng);
  await expect(page.locator("#layer-list .layer-row")).toHaveCount(1, { timeout: 30_000 });

  await page.locator("#btn-clear").click();
  await expect(page.locator("#layer-list .layer-row")).toHaveCount(0);
  await expect(page.locator("#btn-clear")).toBeDisabled();
});

// ---- PNG export -------------------------------------------------------------

test("export button triggers a file download", async ({ page }) => {
  await page.goto("/");
  const tmpPng = path.resolve(__dirname, "fixtures", "red1x1.png");
  await page.locator("#upload-input").setInputFiles(tmpPng);
  await expect(page.locator("#btn-export")).toBeEnabled({ timeout: 30_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#btn-export").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.png$/i);
});
