// IndexedDB persistence — vanilla, no dependencies.
//
// We use two object stores:
//   items  → all wardrobe items (each has a base64 PNG dataUrl)
//   state  → key/value bucket for app state (currently just the canvas layers)
//
// Note: Live Server typically serves at http://127.0.0.1:5500, so the
// IndexedDB origin is "http://127.0.0.1:5500". A previous Vite dev server at
// "http://localhost:5173" was a *different* origin → data does not migrate
// automatically. That's by design: it's a browser security boundary.

const DB_NAME = "wardrobe-db";
const DB_VERSION = 1;
const STORE_ITEMS = "items";
const STORE_STATE = "state";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        db.createObjectStore(STORE_ITEMS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_STATE)) {
        db.createObjectStore(STORE_STATE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("idb open failed"));
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const req = fn(s);
        t.oncomplete = () =>
          resolve(req && "result" in req ? req.result : undefined);
        t.onerror = () => reject(t.error || new Error("idb tx failed"));
        t.onabort = () => reject(t.error || new Error("idb tx aborted"));
      }),
  );
}

// ---- Items ----------------------------------------------------------------
export const getAllItems = () =>
  tx(STORE_ITEMS, "readonly", (s) => s.getAll());

export const putItem = (item) =>
  tx(STORE_ITEMS, "readwrite", (s) => {
    s.put(item);
  });

export const deleteItem = (id) =>
  tx(STORE_ITEMS, "readwrite", (s) => {
    s.delete(id);
  });

// ---- Canvas state ---------------------------------------------------------
const CANVAS_KEY = "canvas";

export const getCanvasState = () =>
  tx(STORE_STATE, "readonly", (s) => s.get(CANVAS_KEY)).then((v) => v ?? null);

export const setCanvasState = (state) =>
  tx(STORE_STATE, "readwrite", (s) => {
    s.put(state, CANVAS_KEY);
  });

// ---- Estimate (footer) ----------------------------------------------------
export async function getStorageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return {
    usedMB: Math.round(((e.usage ?? 0) / 1024 / 1024) * 10) / 10,
    quotaMB: Math.round((e.quota ?? 0) / 1024 / 1024),
  };
}
