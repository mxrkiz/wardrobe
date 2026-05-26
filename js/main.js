// Entry point — wires DOM, state, canvas, and IO together.

import {
  initCanvas,
  exportPng,
  isLayerDragging,
  CANVAS_W,
  CANVAS_H,
  SPINE_X,
} from "./canvas.js";
import { CATEGORIES } from "./categories.js";
import { probeBgRemoval } from "./bg.js";
import { processFile } from "./imageOps.js";
import { makeItem, makeLayer } from "./factory.js";
import {
  getState,
  update,
  addItem,
  addLayer,
  loadInitial,
  removeSelected,
  undoLayers,
} from "./state.js";
import {
  initUploadCategorySelect,
  initWardrobeTree,
  initInspector,
  initLayerList,
  initStatusBar,
  initEditModal,
  initTopBar,
  initUploadVisuals,
  initGridToggle,
  initCanvasBg,
  initMobileUI,
} from "./ui.js";

// =============================================================================
// BOOT
// =============================================================================

(async function boot() {
  // 1. Canvas first — other components depend on the stage existing.
  initCanvas(document.getElementById("canvas-host"));

  // 2. UI shells.
  initUploadCategorySelect();
  const modal = initEditModal();
  initWardrobeTree({
    onPlace: (itemId) => placeOnCanvas(itemId),
    onEdit: (itemId) => modal.open(itemId),
  });
  initInspector({ onEditItem: (itemId) => modal.open(itemId) });
  initLayerList();
  initStatusBar();
  initTopBar({ onExport: handleExport });
  initUploadVisuals();
  initGridToggle();
  initCanvasBg();
  initMobileUI();

  // 3. Wire IO.
  initFileInput();
  initImport();
  initDragDrop();
  initClipboardPaste();
  initKeyboard();

  // 4. Load saved data from IndexedDB.
  await loadInitial();

  // 5. Probe background-removal in the background.
  update({ bgStatus: { ready: false, error: null, probing: true } });
  const probe = await probeBgRemoval();
  update({
    bgStatus: { ready: probe.ready, error: probe.error ?? null, probing: false },
  });

  console.info(
    "%c~/wardrobe ready",
    "color:#3fb950;font-family:monospace;",
    "· bg:",
    probe.ready ? "ok" : "off",
  );
})();

// =============================================================================
// PLACEMENT (auto-position along the spine)
// =============================================================================

function placeOnCanvas(itemId) {
  const st = getState();
  const item = st.items.find((i) => i.id === itemId);
  if (!item) return;
  const spec = CATEGORIES[item.category];
  const scale = (spec.targetH * CANVAS_H) / item.height;
  addLayer(
    makeLayer({
      itemId: item.id,
      x: SPINE_X,
      y: spec.relY * CANVAS_H,
      scale,
      zIndex: spec.z,
    }),
  );
}

// =============================================================================
// EXPORT
// =============================================================================

function handleExport() {
  const url = exportPng();
  if (!url) return;
  const a = document.createElement("a");
  a.download = `outfit-${Date.now()}.png`;
  a.href = url;
  a.click();
}

// =============================================================================
// FILE / URL / CLIPBOARD INPUT
// =============================================================================

function initFileInput() {
  // Both inputs (gallery picker + camera) sit inside <label for=""> wrappers,
  // so a tap on the label natively triggers the picker on every platform —
  // including iOS Safari, where programmatic .click() on a [hidden] input is
  // unreliable. We just listen for `change` here.
  const wire = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", async (e) => {
      if (e.target.files?.length) {
        await handleFiles(Array.from(e.target.files));
        e.target.value = "";
      }
    });
  };
  wire("upload-input");
}

// =============================================================================
// IMPORT ($ import.png) — drop a PNG/JPG onto the canvas as-is (no bg removal),
// centered and scaled to fit, sitting behind wardrobe items as a backdrop.
// =============================================================================

function initImport() {
  const btn = document.getElementById("btn-import");
  if (!btn) return;
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/png,image/jpeg,image/webp";
  inp.addEventListener("change", async () => {
    const file = inp.files?.[0];
    inp.value = "";
    if (file) await importBackdrop(file);
  });
  btn.addEventListener("click", () => inp.click());
}

async function importBackdrop(file) {
  if (!file.type.startsWith("image/")) {
    alert("import.png ждёт картинку (png / jpg / webp).");
    return;
  }
  update({ processing: true, progress: `importing · ${file.name}` });
  try {
    const r = await processFile(file, { bgMode: "off" });
    const item = makeItem(r, {
      name: file.name.replace(/\.[^.]+$/, "") || "import",
      category: "uncategorized",
    });
    await addItem(item);
    const fit = Math.min(CANVAS_W / r.width, CANVAS_H / r.height);
    addLayer(
      makeLayer({
        itemId: item.id,
        x: SPINE_X,
        y: CANVAS_H / 2,
        scale: fit,
        zIndex: 0, // behind wardrobe layers
      }),
    );
    update({ showGrid: false });
  } catch (e) {
    console.error("import failed:", e);
    alert("Import error: " + (e.message || e));
  } finally {
    update({ processing: false, progress: "" });
  }
}

function initDragDrop() {
  // Prevent the browser from navigating to the dropped item.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;

    // A canvas layer being dragged must never be read as a file upload.
    if (isLayerDragging()) return;

    e.preventDefault();

    // Case 1 — real files. The happy path.
    if (dt.files && dt.files.length > 0) {
      await handleFiles(Array.from(dt.files));
      return;
    }

    // Case 2 — URL drag from another browser tab. Try to fetch it; will most
    // likely fail with a CORS error because random websites don't whitelist
    // localhost as an allowed origin. Show a clear message in that case.
    const urlItem = Array.from(dt.items ?? []).find(
      (i) => i.kind === "string" && i.type === "text/uri-list",
    );
    if (urlItem) {
      const url = await new Promise((res) => urlItem.getAsString(res));
      try {
        const blob = await fetchRemoteImage(url);
        const filename = url.split("/").pop()?.split("?")[0] || "remote.png";
        await handleFiles([
          new File([blob], filename, { type: blob.type || "image/png" }),
        ]);
        return;
      } catch (err) {
        alert(
          [
            "Failed to load image from URL — almost always a CORS issue.",
            "",
            "Solutions:",
            "1) Right-click the image → «Save image as…» → drag the file here.",
            "2) Right-click → «Copy image» → Ctrl+V in this window.",
            "",
            "Error: " + (err.message || err),
          ].join("\n"),
        );
        return;
      }
    }

    // Nothing droppable (e.g. a stray drag that ended over the window). This
    // is a no-op, not an error — stay silent rather than alarming the user.
  });
}

async function fetchRemoteImage(url) {
  const resp = await fetch(url, { mode: "cors" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error(`not an image: ${blob.type}`);
  }
  return blob;
}

function initClipboardPaste() {
  window.addEventListener("paste", async (e) => {
    if (isLayerDragging()) return;
    const items = Array.from(e.clipboardData?.items ?? []);
    const blobs = [];
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) blobs.push(f);
      }
    }
    if (blobs.length === 0) return;
    e.preventDefault();
    await handleFiles(blobs);
  });
}

function initKeyboard() {
  window.addEventListener("keydown", (e) => {
    // Don't grab keys while the user is typing in an input/textarea.
    const target = e.target;
    const inField =
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable);

    if (inField) return;

    // Global undo: Ctrl+Z / Cmd+Z (no shift = not redo).
    // e.code is layout-independent — fires on the physical Z key regardless of
    // the OS keyboard language (Russian, etc.), unlike e.key which gives "я".
    if (e.code === "KeyZ" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      undoLayers();
      return;
    }

    const st = getState();
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      (st.selectedLayerIds || []).length
    ) {
      removeSelected(); // erase all selected layers
      e.preventDefault();
    }
  });
}

// =============================================================================
// HANDLE FILES → PIPELINE → STATE
// =============================================================================

async function handleFiles(files) {
  files = files.filter((f) => f.type.startsWith("image/"));
  if (files.length === 0) return;

  update({ processing: true, progress: "" });
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      update({
        processing: true,
        progress: `processing ${i + 1}/${files.length} · ${f.name}`,
      });
      const r = await processFile(f, {
        bgMode: getState().bgMode,
        fillHoles: getState().fillHoles,
      });
      const item = makeItem(r, {
        name: f.name.replace(/\.[^.]+$/, ""),
        category: getState().uploadCategory,
      });
      await addItem(item);
      placeOnCanvas(item.id);
    }
  } catch (e) {
    console.error("handleFiles failed:", e);
    alert("Failed to process file: " + (e.message || e));
  } finally {
    update({ processing: false, progress: "" });
  }
}

// Expose for ad-hoc devtools poking.
window.wardrobe = { getState };
