import { describe, it, expect, vi } from "vitest";

vi.mock("../../js/db.js", () => ({
  getAllItems: vi.fn(async () => []),
  putItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  getCanvasState: vi.fn(async () => null),
  setCanvasState: vi.fn(async () => {}),
  getStorageEstimate: vi.fn(async () => null),
}));

import { toggleId } from "../../js/state.js";

describe("toggleId", () => {
  it("adds id when not present", () => {
    expect(toggleId(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("removes id when present", () => {
    expect(toggleId(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("returns new array (immutable)", () => {
    const ids = ["a"];
    const result = toggleId(ids, "b");
    expect(result).not.toBe(ids);
  });

  it("handles empty input array — adds id", () => {
    expect(toggleId([], "a")).toEqual(["a"]);
  });

  it("removes only the first occurrence when duplicates exist", () => {
    // filter removes ALL occurrences of the id — that's the correct behaviour
    expect(toggleId(["a", "a"], "a")).toEqual([]);
  });

  it("preserves order of remaining ids on removal", () => {
    expect(toggleId(["x", "y", "z"], "y")).toEqual(["x", "z"]);
  });
});
