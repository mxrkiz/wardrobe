// Global app state + tiny pub/sub. No framework — each subscriber re-renders
// its DOM subtree on every state change.

import {
  getAllItems,
  putItem,
  deleteItem,
  getCanvasState,
  setCanvasState,
  getStorageEstimate,
} from "./db.js";
import { CATEGORIES } from "./categories.js";

/**
 * @typedef {Object} WardrobeItem
 * @property {string}   id
 * @property {string}   name
 * @property {string}   category       key into CATEGORIES
 * @property {string}   subcategory
 * @property {string[]} tags
 * @property {string}   color          dominant colour #rrggbb, or ""
 * @property {string}   cutoutDataUrl  PNG data URL drawn on the canvas
 * @property {number}   width
 * @property {number}   height
 * @property {boolean}  hasBgRemoved
 * @property {"mono"|"ml"|"none"} bgMethod
 * @property {number}   createdAt
 */

/**
 * @typedef {Object} CanvasLayer
 * @property {string}  id
 * @property {string}  itemId          the WardrobeItem this layer renders
 * @property {number}  x
 * @property {number}  y
 * @property {number}  scale
 * @property {number}  zIndex          draw order; lower draws first
 * @property {number}  rotation        degrees
 * @property {"full"|"left"|"right"} clip
 * @property {number}  opacity         0..1
 * @property {boolean} hidden
 */

// ---- State shape -----------------------------------------------------------

let state = {
  items: [],            // WardrobeItem[]
  layers: [],           // CanvasLayer[]
  selectedLayerIds: [], // multi-select on the canvas (marquee / shift-click)
  editingItemId: null,
  uploadCategory: "uncategorized",
  bgMode: "auto",        // "auto" | "mono" | "ml" | "off"
  fillHoles: false,      // second flood-fill pass kills isolated bg regions
  showGrid: true,        // canvas guides (spine + slot ticks + dot grid)
  canvasBg: "#ffffff",   // canvas background plate colour (curated swatches)
  processing: false,
  progress: "",
  bgStatus: { ready: false, error: null, probing: true },
  storage: null,
};

// ---- Subscribers -----------------------------------------------------------

const listeners = new Set();

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

// ---- Undo history ----------------------------------------------------------
// Tracks snapshots of `layers` only. Canvas moves, scale, rotation, opacity
// changes are undoable; item add/delete and settings are not.

const MAX_UNDO = 50;
const undoStack = [];

export function pushUndo(layersSnapshot) {
  undoStack.push(layersSnapshot.map((l) => ({ ...l })));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

export function canUndo() {
  return undoStack.length > 0;
}

export function undoLayers() {
  if (!undoStack.length) return;
  const prev = undoStack.pop();
  state = { ...state, layers: prev };
  listeners.forEach((fn) => fn(state));
  // Persist the undone canvas state.
  setCanvasState({
    layers: state.layers,
    canvasBg: state.canvasBg,
    showGrid: state.showGrid,
  }).catch((e) => console.error("persist undo failed:", e));
}

let saveTimer = null;
const SAVE_DEBOUNCE_MS = 250; // coalesce rapid canvas edits into one IDB write

export function update(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn(state));

  if ("layers" in patch || "canvasBg" in patch || "showGrid" in patch) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      setCanvasState({
        layers: state.layers,
        canvasBg: state.canvasBg,
        showGrid: state.showGrid,
      }).catch((e) => console.error("persist canvas failed:", e));
    }, SAVE_DEBOUNCE_MS);
  }
}

// ---- Initial load ----------------------------------------------------------

/**
 * Pure: remap a persisted item's category. "pants"→"bottoms", "scarf"→"neck",
 * and any category no longer in CATEGORIES → "uncategorized". Returns the SAME
 * object reference when nothing changes (so callers can detect a no-op).
 * @param {WardrobeItem} item
 * @returns {WardrobeItem}
 */
export function migrateItemCategory(item) {
  let cat =
    item.category === "pants" ? "bottoms"
    : item.category === "scarf" ? "neck"
    : item.category;
  if (!CATEGORIES[cat]) cat = "uncategorized";
  return cat === item.category ? item : { ...item, category: cat };
}

export async function loadInitial() {
  try {
    const [items, canvas] = await Promise.all([
      getAllItems(),
      getCanvasState(),
    ]);
    // category migration (see migrateItemCategory): renames + unknown guard.
    const remapped = [];
    const sortedItems = items
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((it) => {
        const next = migrateItemCategory(it);
        if (next !== it) remapped.push(next);
        return next;
      });
    // persist remapped items so the rename sticks in IndexedDB
    remapped.forEach((it) =>
      putItem(it).catch((e) =>
        console.error("category migrate persist failed:", e),
      ),
    );

    let layers = canvas?.layers ?? [];
    // schema migration — earlier layers might miss `opacity`. Stale flipX/flipY
    // fields from older builds are simply ignored (flip was removed).
    layers = layers.map((l) => ({
      ...l,
      opacity: typeof l.opacity === "number" ? l.opacity : 1,
    }));
    update({
      items: sortedItems,
      layers,
      ...(canvas && typeof canvas.canvasBg === "string"
        ? { canvasBg: canvas.canvasBg }
        : {}),
      ...(canvas && typeof canvas.showGrid === "boolean"
        ? { showGrid: canvas.showGrid }
        : {}),
    });
  } catch (e) {
    console.error("loadInitial failed:", e);
  }
  refreshStorage();
}

export async function refreshStorage() {
  update({ storage: await getStorageEstimate() });
}

// ---- Item actions ----------------------------------------------------------

/** @param {WardrobeItem} item */
export async function addItem(item) {
  await putItem(item);
  update({ items: [...state.items, item] });
  refreshStorage();
}

export async function saveItem(item) {
  await putItem(item);
  update({ items: state.items.map((i) => (i.id === item.id ? item : i)) });
}

// Move an item to a different category. Layers on the canvas keep their
// current position — recategorize only changes meta. New layers spawned
// from the item afterwards use the new category's spine slot.
export async function recategorizeItem(id, newCategory) {
  const it = state.items.find((i) => i.id === id);
  if (!it || it.category === newCategory) return;
  const next = { ...it, category: newCategory };
  await putItem(next);
  update({ items: state.items.map((i) => (i.id === id ? next : i)) });
}

export async function removeItemFully(id) {
  await deleteItem(id);
  const layers = state.layers.filter((l) => l.itemId !== id);
  const live = new Set(layers.map((l) => l.id));
  update({
    items: state.items.filter((i) => i.id !== id),
    layers,
    selectedLayerIds: state.selectedLayerIds.filter((x) => live.has(x)),
  });
  refreshStorage();
}

// ---- Layer actions ---------------------------------------------------------

/** @param {CanvasLayer} layer */
export function addLayer(layer) {
  update({ layers: [...state.layers, layer], selectedLayerIds: [layer.id] });
}

/** @param {string} id @param {Partial<CanvasLayer>} patch */
export function updateLayer(id, patch) {
  pushUndo(state.layers);
  update({
    layers: state.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
  });
}

// ---- Pure z-order cores (no side effects → unit-testable) ------------------

/**
 * Reassign zIndex from a low→high ordering of layer ids (front of stack last).
 * @param {CanvasLayer[]} layers
 * @param {string[]} orderedIdsLowToHigh
 * @returns {CanvasLayer[]} new array
 */
export function computeZReorder(layers, orderedIdsLowToHigh) {
  const pos = new Map(orderedIdsLowToHigh.map((id, i) => [id, i]));
  return layers.map((l) =>
    pos.has(l.id) ? { ...l, zIndex: pos.get(l.id) } : l,
  );
}

/**
 * Move `id` one step in z-order (dir > 0 forward, < 0 back), swapping with its
 * neighbour and renormalising to 0..N-1. Returns the SAME array on a no-op.
 * @param {CanvasLayer[]} layers
 * @param {string} id
 * @param {number} dir
 * @returns {CanvasLayer[]}
 */
export function computeZMove(layers, id, dir) {
  const sorted = [...layers].sort((a, b) => a.zIndex - b.zIndex);
  const idx = sorted.findIndex((l) => l.id === id);
  if (idx < 0) return layers;
  const swap = idx + (dir > 0 ? 1 : -1);
  if (swap < 0 || swap >= sorted.length) return layers;
  [sorted[idx], sorted[swap]] = [sorted[swap], sorted[idx]];
  return computeZReorder(layers, sorted.map((l) => l.id));
}

export function reorderLayersByZ(orderedIdsLowToHigh) {
  update({ layers: computeZReorder(state.layers, orderedIdsLowToHigh) });
}

export function moveLayerZ(id, dir) {
  const next = computeZMove(state.layers, id, dir);
  if (next !== state.layers) update({ layers: next });
}

export function removeLayer(id) {
  update({
    layers: state.layers.filter((l) => l.id !== id),
    selectedLayerIds: state.selectedLayerIds.filter((x) => x !== id),
  });
}

export function clearLayers() {
  update({ layers: [], selectedLayerIds: [] });
}

// ---- Selection (multi) -----------------------------------------------------

/**
 * Pure: add `id` to the array if absent, remove it if present.
 * @param {string[]} ids @param {string} id @returns {string[]} new array
 */
export function toggleId(ids, id) {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

export function toggleSelection(id) {
  update({ selectedLayerIds: toggleId(state.selectedLayerIds, id) });
}

// Erase everything currently selected (Delete key / inspector button).
export function removeSelected() {
  if (!state.selectedLayerIds.length) return;
  const kill = new Set(state.selectedLayerIds);
  update({
    layers: state.layers.filter((l) => !kill.has(l.id)),
    selectedLayerIds: [],
  });
}
