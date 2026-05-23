// Entry point — wires DOM, state, canvas, and IO together.

import { initCanvas, exportPng, CANVAS_W, CANVAS_H, SPINE_X } from "./canvas.js";
import { CATEGORIES } from "./categories.js";
import { probeBgRemoval } from "./bg.js";
import { processFile, uid } from "./imageOps.js";
import {
  getState,
  update,
  addItem,
  addLayer,
  loadInitial,
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
  DRAG_MIME,
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

  // 3. Wire IO.
  initFileInput();
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
  const targetH = spec.targetH * CANVAS_H;
  const scale = targetH / item.height;
  addLayer({
    id: uid(),
    itemId: item.id,
    x: SPINE_X,
    y: spec.relY * CANVAS_H,
    scale,
    rotation: 0,
    zIndex: spec.z,
    clip: "full",
    opacity: 1,
    hidden: false,
  });
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
  const input = document.getElementById("upload-input");
  const drop = document.getElementById("upload-drop");
  drop.addEventListener("click", (e) => {
    // The drop area itself triggers the file picker. Without this, the
    // hidden <input> isn't reachable.
    if (e.target.tagName !== "INPUT") {
      input.click();
    }
  });
  input.addEventListener("change", async (e) => {
    if (e.target.files?.length) {
      await handleFiles(Array.from(e.target.files));
      e.target.value = "";
    }
  });
}

function initDragDrop() {
  // Prevent the browser from navigating to the dropped item.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;

    // Internal wardrobe-tree drag (recategorize). The tree's own drop handler
    // takes care of it; we just bail so we don't try to "upload" the item.
    if (dt.types && Array.from(dt.types).includes(DRAG_MIME)) {
      return;
    }

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
            "Не удалось загрузить картинку по URL — почти всегда это CORS.",
            "",
            "Решения:",
            "1) Правой кнопкой по картинке → «Save image as…» → перетащи файл сюда.",
            "2) Правой кнопкой → «Copy image» → Ctrl+V в этом окне.",
            "",
            "Ошибка: " + (err.message || err),
          ].join("\n"),
        );
        return;
      }
    }

    alert(
      "В дропе нет ни файла, ни URL картинки. Попробуй Ctrl+V (вставка из буфера).",
    );
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

    const st = getState();
    if ((e.key === "Delete" || e.key === "Backspace") && st.selectedLayerId) {
      // remove selected layer
      import("./state.js").then(({ removeLayer }) =>
        removeLayer(st.selectedLayerId),
      );
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
      const item = {
        id: uid(),
        name: f.name.replace(/\.[^.]+$/, "") || "image",
        category: getState().uploadCategory,
        subcategory: "",
        tags: [],
        color: r.color,
        cutoutDataUrl: r.dataUrl,
        width: r.width,
        height: r.height,
        hasBgRemoved: r.hasBgRemoved,
        bgMethod: r.bgMethod,   // "mono" | "ml" | "none"
        createdAt: Date.now(),
      };
      await addItem(item);
      placeOnCanvas(item.id);
    }
  } catch (e) {
    console.error("handleFiles failed:", e);
    alert("Не удалось обработать файл: " + (e.message || e));
  } finally {
    update({ processing: false, progress: "" });
  }
}

// Expose for ad-hoc devtools poking.
window.wardrobe = { getState };

// Suppress unused-warning for the imported W constant.
void CANVAS_W;
