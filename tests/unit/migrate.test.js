import { describe, it, expect, vi } from "vitest";

vi.mock("../../js/db.js", () => ({
  getAllItems: vi.fn(async () => []),
  putItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  getCanvasState: vi.fn(async () => null),
  setCanvasState: vi.fn(async () => {}),
  getStorageEstimate: vi.fn(async () => null),
}));

import { migrateItemCategory } from "../../js/state.js";

const item = (category) => ({
  id: "1",
  name: "test",
  category,
  subcategory: "",
  tags: [],
  color: "",
  cutoutDataUrl: "",
  width: 100,
  height: 100,
  hasBgRemoved: false,
  bgMethod: "none",
  createdAt: 0,
});

describe("migrateItemCategory", () => {
  it("maps 'pants' → 'bottoms'", () => {
    const result = migrateItemCategory(item("pants"));
    expect(result.category).toBe("bottoms");
  });

  it("maps 'scarf' → 'neck'", () => {
    const result = migrateItemCategory(item("scarf"));
    expect(result.category).toBe("neck");
  });

  it("maps unknown category → 'uncategorized'", () => {
    const result = migrateItemCategory(item("socks"));
    expect(result.category).toBe("uncategorized");
  });

  it("returns same object reference when category is unchanged", () => {
    const original = item("hat");
    expect(migrateItemCategory(original)).toBe(original);
  });

  it("returns new object (immutable) when category changes", () => {
    const original = item("pants");
    const result = migrateItemCategory(original);
    expect(result).not.toBe(original);
  });

  it("preserves all other fields on migration", () => {
    const original = item("pants");
    const result = migrateItemCategory(original);
    expect(result.id).toBe(original.id);
    expect(result.name).toBe(original.name);
    expect(result.color).toBe(original.color);
  });

  it("valid known categories are returned as-is", () => {
    for (const cat of ["hat", "glasses", "neck", "outerwear", "mid", "top", "bottoms", "shoes", "accessory", "uncategorized"]) {
      const original = item(cat);
      expect(migrateItemCategory(original)).toBe(original);
    }
  });
});
