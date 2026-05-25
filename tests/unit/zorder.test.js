import { describe, it, expect, vi } from "vitest";

vi.mock("../../js/db.js", () => ({
  getAllItems: vi.fn(async () => []),
  putItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  getCanvasState: vi.fn(async () => null),
  setCanvasState: vi.fn(async () => {}),
  getStorageEstimate: vi.fn(async () => null),
}));

import { computeZReorder, computeZMove } from "../../js/state.js";

// Minimal layer factory
const layer = (id, zIndex) => ({ id, zIndex, itemId: "x", x: 0, y: 0, scale: 1, rotation: 0, clip: "full", opacity: 1, hidden: false });

describe("computeZReorder", () => {
  it("assigns zIndex according to orderedIds position", () => {
    const layers = [layer("a", 0), layer("b", 1), layer("c", 2)];
    const result = computeZReorder(layers, ["c", "a", "b"]);
    const byId = Object.fromEntries(result.map((l) => [l.id, l.zIndex]));
    expect(byId).toEqual({ c: 0, a: 1, b: 2 });
  });

  it("leaves layers not in orderedIds unchanged", () => {
    const layers = [layer("a", 5), layer("b", 10)];
    const result = computeZReorder(layers, ["a"]);
    const b = result.find((l) => l.id === "b");
    expect(b.zIndex).toBe(10);
  });

  it("returns new array (immutable)", () => {
    const layers = [layer("a", 0)];
    const result = computeZReorder(layers, ["a"]);
    expect(result).not.toBe(layers);
    expect(result[0]).not.toBe(layers[0]);
  });

  it("handles empty orderedIds", () => {
    const layers = [layer("a", 7)];
    const result = computeZReorder(layers, []);
    expect(result[0].zIndex).toBe(7);
  });
});

describe("computeZMove", () => {
  it("moves layer forward (dir > 0) by swapping with next higher zIndex", () => {
    const layers = [layer("a", 0), layer("b", 1), layer("c", 2)];
    const result = computeZMove(layers, "a", 1);
    const byId = Object.fromEntries(result.map((l) => [l.id, l.zIndex]));
    // "a" should now be at position 1, "b" at 0
    expect(byId.a).toBe(1);
    expect(byId.b).toBe(0);
    expect(byId.c).toBe(2);
  });

  it("moves layer backward (dir < 0) by swapping with next lower zIndex", () => {
    const layers = [layer("a", 0), layer("b", 1), layer("c", 2)];
    const result = computeZMove(layers, "c", -1);
    const byId = Object.fromEntries(result.map((l) => [l.id, l.zIndex]));
    expect(byId.c).toBe(1);
    expect(byId.b).toBe(2);
    expect(byId.a).toBe(0);
  });

  it("returns same array reference on no-op (already at front)", () => {
    const layers = [layer("a", 0), layer("b", 1)];
    const result = computeZMove(layers, "b", 1);
    expect(result).toBe(layers);
  });

  it("returns same array reference on no-op (already at back)", () => {
    const layers = [layer("a", 0), layer("b", 1)];
    const result = computeZMove(layers, "a", -1);
    expect(result).toBe(layers);
  });

  it("returns same array reference when id not found", () => {
    const layers = [layer("a", 0)];
    expect(computeZMove(layers, "missing", 1)).toBe(layers);
  });

  it("handles a single-layer array", () => {
    const layers = [layer("a", 0)];
    expect(computeZMove(layers, "a", 1)).toBe(layers);
    expect(computeZMove(layers, "a", -1)).toBe(layers);
  });
});
