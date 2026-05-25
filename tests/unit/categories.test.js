import { describe, it, expect } from "vitest";
import { CATEGORIES, ALL_CATEGORIES } from "../../js/categories.js";

const EXPECTED_KEYS = [
  "uncategorized", "hat", "glasses", "neck", "outerwear",
  "mid", "top", "bottoms", "shoes", "accessory",
];

describe("CATEGORIES", () => {
  it("contains all expected category keys", () => {
    for (const key of EXPECTED_KEYS) {
      expect(CATEGORIES).toHaveProperty(key);
    }
  });

  it("each category has required fields with correct types", () => {
    for (const [key, cat] of Object.entries(CATEGORIES)) {
      expect(typeof cat.label, `${key}.label`).toBe("string");
      expect(typeof cat.relY, `${key}.relY`).toBe("number");
      expect(typeof cat.targetH, `${key}.targetH`).toBe("number");
      expect(typeof cat.z, `${key}.z`).toBe("number");
      expect(typeof cat.order, `${key}.order`).toBe("number");
      expect(Array.isArray(cat.subcategories), `${key}.subcategories`).toBe(true);
    }
  });

  it("relY values are in [0, 1]", () => {
    for (const [key, cat] of Object.entries(CATEGORIES)) {
      expect(cat.relY, `${key}.relY`).toBeGreaterThanOrEqual(0);
      expect(cat.relY, `${key}.relY`).toBeLessThanOrEqual(1);
    }
  });

  it("targetH values are in (0, 1]", () => {
    for (const [key, cat] of Object.entries(CATEGORIES)) {
      expect(cat.targetH, `${key}.targetH`).toBeGreaterThan(0);
      expect(cat.targetH, `${key}.targetH`).toBeLessThanOrEqual(1);
    }
  });

  it("z values are positive integers", () => {
    for (const [key, cat] of Object.entries(CATEGORIES)) {
      expect(Number.isInteger(cat.z), `${key}.z`).toBe(true);
      expect(cat.z, `${key}.z`).toBeGreaterThan(0);
    }
  });

  it("outerwear z > mid z > top z (layering order)", () => {
    expect(CATEGORIES.outerwear.z).toBeGreaterThan(CATEGORIES.mid.z);
    expect(CATEGORIES.mid.z).toBeGreaterThan(CATEGORIES.top.z);
  });

  it("hat z > outerwear z (hat clears collar)", () => {
    expect(CATEGORIES.hat.z).toBeGreaterThan(CATEGORIES.outerwear.z);
  });
});

describe("ALL_CATEGORIES", () => {
  it("contains exactly the same keys as CATEGORIES", () => {
    expect([...ALL_CATEGORIES].sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it("is sorted by category order field (ascending)", () => {
    for (let i = 1; i < ALL_CATEGORIES.length; i++) {
      expect(CATEGORIES[ALL_CATEGORIES[i]].order).toBeGreaterThanOrEqual(
        CATEGORIES[ALL_CATEGORIES[i - 1]].order,
      );
    }
  });
});
