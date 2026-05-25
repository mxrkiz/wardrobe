// Factories for the two core domain objects, so their default shape lives in
// one place instead of being re-typed at every call site.

import { uid } from "./imageOps.js";

/**
 * @typedef {Object} ProcessResult
 * @property {string}  dataUrl       PNG data URL of the (possibly cut-out) image
 * @property {number}  width
 * @property {number}  height
 * @property {string}  color         dominant colour as #rrggbb (or "")
 * @property {boolean} hasBgRemoved
 * @property {"mono"|"ml"|"none"} bgMethod
 */

/**
 * Build a fresh WardrobeItem from a processFile() result.
 * @param {ProcessResult} r
 * @param {{ name?: string, category?: string }} meta
 * @returns {import("./state.js").WardrobeItem}
 */
export function makeItem(r, { name, category } = {}) {
  return {
    id: uid(),
    name: name || "image",
    category: category || "uncategorized",
    subcategory: "",
    tags: [],
    color: r.color,
    cutoutDataUrl: r.dataUrl,
    width: r.width,
    height: r.height,
    hasBgRemoved: r.hasBgRemoved,
    bgMethod: r.bgMethod,
    createdAt: Date.now(),
  };
}

/**
 * Build a CanvasLayer with sane visual defaults. Caller supplies placement.
 * @param {{ itemId: string, x: number, y: number, scale: number, zIndex: number }} placement
 * @returns {import("./state.js").CanvasLayer}
 */
export function makeLayer({ itemId, x, y, scale, zIndex }) {
  return {
    id: uid(),
    itemId,
    x,
    y,
    scale,
    zIndex,
    rotation: 0,
    clip: "full",
    opacity: 1,
    hidden: false,
  };
}
