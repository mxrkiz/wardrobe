// Layer list (right pane, bottom): one row per canvas layer, top→bottom in
// descending z. Click to select (shift/ctrl to multi-select), toggle/remove,
// or drag a row to reorder z.

import { CATEGORIES } from "../categories.js";
import {
  getState,
  subscribe,
  update,
  updateLayer,
  removeLayer,
  toggleSelection,
  reorderLayersByZ,
} from "../state.js";
import { escapeHtml, thumbImg } from "./dom.js";

export function initLayerList() {
  const root = document.getElementById("layer-list");
  const countEl = document.getElementById("layer-count");

  root.addEventListener("click", (e) => {
    const row = e.target.closest("[data-layer-id]");
    if (!row) return;
    const id = row.dataset.layerId;
    if (e.target.closest("[data-toggle]")) {
      const layer = getState().layers.find((l) => l.id === id);
      if (layer) updateLayer(id, { hidden: !layer.hidden });
      e.stopPropagation();
      return;
    }
    if (e.target.closest("[data-remove]")) {
      removeLayer(id);
      e.stopPropagation();
      return;
    }
    if (e.shiftKey || e.metaKey || e.ctrlKey) toggleSelection(id);
    else update({ selectedLayerIds: [id] });
  });

  // ---- drag-to-reorder (z-order) -----------------------------------------
  let dragId = null;
  const clearDropMarks = () =>
    root
      .querySelectorAll(".drop-above, .drop-below")
      .forEach((el) => el.classList.remove("drop-above", "drop-below"));

  root.addEventListener("dragstart", (e) => {
    const row = e.target.closest("[data-layer-id]");
    if (!row) return;
    dragId = row.dataset.layerId;
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", dragId);
    } catch {
      // setData can throw in some Firefox/Safari dragstart edge cases; the drag
      // still works via our own `dragId`, so this is safe to ignore.
    }
    row.classList.add("dragging");
  });
  root.addEventListener("dragend", () => {
    root.querySelector(".layer-row.dragging")?.classList.remove("dragging");
    clearDropMarks();
    dragId = null;
  });
  root.addEventListener("dragover", (e) => {
    if (!dragId) return;
    const row = e.target.closest("[data-layer-id]");
    if (!row || row.dataset.layerId === dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = row.getBoundingClientRect();
    const below = e.clientY - r.top > r.height / 2;
    clearDropMarks();
    row.classList.add(below ? "drop-below" : "drop-above");
  });
  root.addEventListener("drop", (e) => {
    if (!dragId) return;
    const row = e.target.closest("[data-layer-id]");
    if (!row) return;
    e.preventDefault();
    const targetId = row.dataset.layerId;
    const r = row.getBoundingClientRect();
    const below = e.clientY - r.top > r.height / 2;
    const id = dragId;
    dragId = null;
    clearDropMarks();
    if (targetId === id) return;
    // Visible order is top→bottom = descending z. Reorder, then hand
    // reorderLayersByZ the low→high list (front of stack last).
    const order = [...getState().layers]
      .sort((a, b) => b.zIndex - a.zIndex)
      .map((l) => l.id);
    const from = order.indexOf(id);
    if (from < 0) return;
    order.splice(from, 1);
    let to = order.indexOf(targetId);
    if (to < 0) return;
    if (below) to += 1;
    order.splice(to, 0, id);
    reorderLayersByZ(order.reverse());
  });

  // Signature of everything the list actually displays. Excludes per-layer
  // geometry (scale/rotation/opacity/x/y) so dragging a slider on a
  // selected layer doesn't rebuild every row's DOM (which reloads each thumb
  // image and makes the slider feel laggy).
  let lastSig = null;
  const listSignature = (st) => {
    const layerPart = [...st.layers]
      .sort((a, b) => b.zIndex - a.zIndex)
      .map((l) => `${l.id}:${l.zIndex}:${l.hidden ? 1 : 0}:${l.itemId}`)
      .join("|");
    const itemPart = st.items
      .map((i) => `${i.id}:${i.name}:${i.category}:${i.subcategory || ""}:${i.cutoutDataUrl.length}`)
      .join("|");
    const selPart = (st.selectedLayerIds || []).join(",");
    return `${layerPart}#${itemPart}#${selPart}`;
  };

  function render(st) {
    const sig = listSignature(st);
    if (sig === lastSig) return;
    lastSig = sig;
    countEl.textContent = String(st.layers.length);
    const itemsById = new Map(st.items.map((i) => [i.id, i]));
    const rows = [...st.layers]
      .sort((a, b) => b.zIndex - a.zIndex)
      .map((l) => {
        const it = itemsById.get(l.itemId);
        if (!it) return "";
        const sel = (st.selectedLayerIds || []).includes(l.id) ? "sel" : "";
        const hidden = l.hidden ? "hidden" : "";
        return `
          <div class="layer-row ${sel} ${hidden}" data-layer-id="${escapeHtml(l.id)}" draggable="true">
            ${thumbImg(it.cutoutDataUrl, "", 'draggable="false"')}
            <span class="name">
              <span>${escapeHtml(it.name)}</span>
              <span class="sub">${escapeHtml(CATEGORIES[it.category].label)}${
                it.subcategory ? " · " + escapeHtml(it.subcategory) : ""
              }</span>
            </span>
            <button data-toggle="1" title="${l.hidden ? "show" : "hide"}">${l.hidden ? "○" : "●"}</button>
            <button data-remove="1" title="remove" class="danger">x</button>
          </div>
        `;
      })
      .join("");
    root.innerHTML =
      rows || `<p class="muted small" style="padding: 8px 6px;">// canvas empty</p>`;
  }

  subscribe(render);
}
