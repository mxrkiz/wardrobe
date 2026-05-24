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

let saveTimer = null;

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
    }, 250);
  }
}

// ---- Initial load ----------------------------------------------------------

export async function loadInitial() {
  try {
    const [items, canvas] = await Promise.all([
      getAllItems(),
      getCanvasState(),
    ]);
    // category migration — "pants" was renamed to "bottoms"; also guard any
    // item whose category no longer exists in CATEGORIES (→ uncategorized).
    const remapped = [];
    const sortedItems = items
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((it) => {
        let cat = it.category === "pants" ? "bottoms" : it.category;
        if (!CATEGORIES[cat]) cat = "uncategorized";
        if (cat === it.category) return it;
        const next = { ...it, category: cat };
        remapped.push(next);
        return next;
      });
    // persist remapped items so the rename sticks in IndexedDB
    remapped.forEach((it) => putItem(it).catch(() => {}));

    let layers = canvas?.layers ?? [];
    // schema migration — earlier layers might miss `opacity`
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

export function addLayer(layer) {
  update({ layers: [...state.layers, layer], selectedLayerIds: [layer.id] });
}

export function updateLayer(id, patch) {
  update({
    layers: state.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
  });
}

// Reassign zIndex from a low→high ordering of layer ids (front of stack last).
export function reorderLayersByZ(orderedIdsLowToHigh) {
  const pos = new Map(orderedIdsLowToHigh.map((id, i) => [id, i]));
  update({
    layers: state.layers.map((l) =>
      pos.has(l.id) ? { ...l, zIndex: pos.get(l.id) } : l,
    ),
  });
}

// Move a layer one step in z-order (dir > 0 = forward/up, < 0 = back/down),
// swapping with its neighbour and renormalising zIndex to 0..N-1.
export function moveLayerZ(id, dir) {
  const sorted = [...state.layers].sort((a, b) => a.zIndex - b.zIndex);
  const idx = sorted.findIndex((l) => l.id === id);
  if (idx < 0) return;
  const swap = idx + (dir > 0 ? 1 : -1);
  if (swap < 0 || swap >= sorted.length) return;
  [sorted[idx], sorted[swap]] = [sorted[swap], sorted[idx]];
  reorderLayersByZ(sorted.map((l) => l.id));
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

export function setSelection(ids) {
  update({ selectedLayerIds: Array.isArray(ids) ? [...new Set(ids)] : [] });
}

export function clearSelection() {
  if (state.selectedLayerIds.length) update({ selectedLayerIds: [] });
}

export function toggleSelection(id) {
  const has = state.selectedLayerIds.includes(id);
  update({
    selectedLayerIds: has
      ? state.selectedLayerIds.filter((x) => x !== id)
      : [...state.selectedLayerIds, id],
  });
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
