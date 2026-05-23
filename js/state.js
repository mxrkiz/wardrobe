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

// ---- State shape -----------------------------------------------------------

let state = {
  items: [],            // WardrobeItem[]
  layers: [],           // CanvasLayer[]
  selectedLayerId: null,
  editingItemId: null,
  uploadCategory: "top",
  bgMode: "auto",        // "auto" | "mono" | "ml" | "off"
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

  if ("layers" in patch) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      setCanvasState({ layers: state.layers }).catch((e) =>
        console.error("persist canvas failed:", e),
      );
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
    const sortedItems = items.sort((a, b) => a.createdAt - b.createdAt);
    let layers = canvas?.layers ?? [];
    // schema migration — earlier layers might miss `opacity`
    layers = layers.map((l) => ({
      ...l,
      opacity: typeof l.opacity === "number" ? l.opacity : 1,
    }));
    update({ items: sortedItems, layers });
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

export async function removeItemFully(id) {
  await deleteItem(id);
  update({
    items: state.items.filter((i) => i.id !== id),
    layers: state.layers.filter((l) => l.itemId !== id),
    selectedLayerId:
      state.selectedLayerId &&
      !state.layers.find((l) => l.id === state.selectedLayerId)
        ? null
        : state.selectedLayerId,
  });
  refreshStorage();
}

// ---- Layer actions ---------------------------------------------------------

export function addLayer(layer) {
  update({ layers: [...state.layers, layer], selectedLayerId: layer.id });
}

export function updateLayer(id, patch) {
  update({
    layers: state.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
  });
}

export function removeLayer(id) {
  update({
    layers: state.layers.filter((l) => l.id !== id),
    selectedLayerId: state.selectedLayerId === id ? null : state.selectedLayerId,
  });
}

export function clearLayers() {
  update({ layers: [], selectedLayerId: null });
}
