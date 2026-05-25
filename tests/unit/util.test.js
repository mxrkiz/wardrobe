import { describe, it, expect } from "vitest";
import { rectsIntersect, isDarkColor } from "../../js/util.js";

describe("rectsIntersect", () => {
  it("returns true for overlapping rects", () => {
    expect(rectsIntersect(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 },
    )).toBe(true);
  });

  it("returns true for fully contained rect", () => {
    expect(rectsIntersect(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 10, y: 10, width: 20, height: 20 },
    )).toBe(true);
  });

  it("returns true when rects share exactly one edge (touching counts as overlap)", () => {
    // a.x + a.width == b.x → the impl uses strict < so touching = intersecting
    expect(rectsIntersect(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 10, y: 0, width: 10, height: 10 },
    )).toBe(true);
  });

  it("returns false when rects are horizontally separated", () => {
    expect(rectsIntersect(
      { x: 0, y: 0, width: 5, height: 10 },
      { x: 20, y: 0, width: 5, height: 10 },
    )).toBe(false);
  });

  it("returns false when rects are vertically separated", () => {
    expect(rectsIntersect(
      { x: 0, y: 0, width: 10, height: 5 },
      { x: 0, y: 20, width: 10, height: 5 },
    )).toBe(false);
  });

  it("returns true for identical rects", () => {
    const r = { x: 5, y: 5, width: 10, height: 10 };
    expect(rectsIntersect(r, { ...r })).toBe(true);
  });
});

describe("isDarkColor", () => {
  it("returns true for black", () => {
    expect(isDarkColor("#000000")).toBe(true);
  });

  it("returns false for white", () => {
    expect(isDarkColor("#ffffff")).toBe(false);
  });

  it("returns true for dark navy", () => {
    expect(isDarkColor("#0d1117")).toBe(true);
  });

  it("returns false for light grey", () => {
    expect(isDarkColor("#eceff3")).toBe(false);
  });

  it("returns false for null/empty input", () => {
    expect(isDarkColor("")).toBe(false);
    expect(isDarkColor(null)).toBe(false);
  });

  it("handles hex without #", () => {
    expect(isDarkColor("000000")).toBe(true);
    expect(isDarkColor("ffffff")).toBe(false);
  });
});
