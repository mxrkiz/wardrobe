// DOM rendering — vanilla. Each section subscribes to state and re-renders its
// own subtree. Event handling uses delegation where possible.

import { CATEGORIES, ALL_CATEGORIES } from "./categories.js";
import {
  getState,
  subscribe,
  update,
  saveItem,
  removeItemFully,
  updateLayer,
  removeLayer,
  clearLayers,
  recategorizeItem,
} from "./state.js";

// Custom mime used by the wardrobe-tree drag-and-drop. The window-level file
// drop handler in main.js checks for this and skips, so internal drags don't
// trigger the file-upload pipeline.
export const DRAG_MIME = "application/x-wardrobe-item-id";

// Quick tagged-template HTML escaper.
export function h(strings, ...values) {
  return strings.reduce((acc, s, i) => {
    const v = values[i] ?? "";
    return acc + s + (i < values.length ? escapeHtml(v) : "");
  }, "");
}

export function escapeHtml(v) {
  if (v == null) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---- Track which tree sections are open ------------------------------------
const openSections = new Set(ALL_CATEGORIES); // open by default

// =============================================================================
// UPLOAD CATEGORY SELECT
// =============================================================================

export function initUploadCategorySelect() {
  const sel = document.getElementById("upload-category");
  sel.innerHTML = ALL_CATEGORIES.map(
    (c) =>
      `<option value="${c}">${escapeHtml(CATEGORIES[c].label)}</option>`,
  ).join("");
  sel.addEventListener("change", (e) => {
    update({ uploadCategory: e.target.value });
  });

  // bg removal mode — options are baked into the HTML, just wire events.
  const bgSel = document.getElementById("upload-bg");
  if (bgSel) {
    bgSel.addEventListener("change", (e) => {
      update({ bgMode: e.target.value });
    });
  }

  // hole-fill toggle (kills isolated bg-coloured regions — bag handles etc).
  const holesSel = document.getElementById("upload-holes");
  if (holesSel) {
    holesSel.addEventListener("change", (e) => {
      update({ fillHoles: e.target.value === "1" });
    });
  }

  subscribe((st) => {
    if (sel.value !== st.uploadCategory) sel.value = st.uploadCategory;
    if (bgSel && bgSel.value !== st.bgMode) bgSel.value = st.bgMode;
    if (holesSel) {
      const v = st.fillHoles ? "1" : "0";
      if (holesSel.value !== v) holesSel.value = v;
    }
  });
}

// =============================================================================
// WARDROBE TREE (left)
// =============================================================================

export function initWardrobeTree({ onPlace, onEdit }) {
  const root = document.getElementById("wardrobe-tree");
  const countEl = document.getElementById("item-count");

  // ---- Click: toggle section, place on canvas, open edit modal -----------
  root.addEventListener("click", (e) => {
    const head = e.target.closest("[data-section]");
    if (head) {
      const cat = head.dataset.section;
      if (openSections.has(cat)) openSections.delete(cat);
      else openSections.add(cat);
      renderTree(getState());
      return;
    }
    const editBtn = e.target.closest("[data-edit-id]");
    if (editBtn) {
      e.stopPropagation();
      onEdit(editBtn.dataset.editId);
      return;
    }
    const thumb = e.target.closest("[data-item-id]");
    if (thumb) {
      onPlace(thumb.dataset.itemId);
    }
  });

  // ---- Drag-and-drop: recategorize ---------------------------------------
  // Source: any .thumb-wrap is draggable; we stash the item id in a custom
  // mime. Target: every .tree-section accepts drops and assigns its category.
  root.addEventListener("dragstart", (e) => {
    const wrap = e.target.closest("[data-drag-item-id]");
    if (!wrap) return;
    const id = wrap.dataset.dragItemId;
    e.dataTransfer.setData(DRAG_MIME, id);
    e.dataTransfer.effectAllowed = "move";
    wrap.classList.add("dragging");
  });
  root.addEventListener("dragend", (e) => {
    const wrap = e.target.closest("[data-drag-item-id]");
    if (wrap) wrap.classList.remove("dragging");
    root.querySelectorAll(".tree-section.drop-target").forEach((el) =>
      el.classList.remove("drop-target"),
    );
  });
  root.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const section = e.target.closest(".tree-section");
    root.querySelectorAll(".tree-section.drop-target").forEach((el) => {
      if (el !== section) el.classList.remove("drop-target");
    });
    if (section) section.classList.add("drop-target");
  });
  root.addEventListener("dragleave", (e) => {
    const section = e.target.closest(".tree-section");
    if (!section) return;
    // only remove when the cursor really left the section
    if (!section.contains(e.relatedTarget)) {
      section.classList.remove("drop-target");
    }
  });
  root.addEventListener("drop", async (e) => {
    const id = e.dataTransfer.getData(DRAG_MIME);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const section = e.target.closest(".tree-section");
    if (!section) return;
    const head = section.querySelector("[data-section]");
    const newCat = head?.dataset.section;
    if (!newCat) return;
    // Make sure the target section is open so the user sees the result.
    openSections.add(newCat);
    await recategorizeItem(id, newCat);
  });

  function renderTree(st) {
    const itemsByCat = new Map(ALL_CATEGORIES.map((c) => [c, []]));
    st.items.forEach((it) => {
      const list = itemsByCat.get(it.category);
      if (list) list.push(it);
    });

    const total = st.items.length;
    countEl.textContent = String(total);

    const parts = [];
    ALL_CATEGORIES.forEach((cat) => {
      const list = itemsByCat.get(cat);
      const count = list.length;
      const isOpen = openSections.has(cat);
      const spec = CATEGORIES[cat];
      parts.push(`
        <div class="tree-section ${isOpen ? "open" : ""}">
          <div class="tree-section-head" data-section="${escapeHtml(cat)}">
            <span class="chev">▶</span>
            <span>${escapeHtml(spec.label)}</span>
            <span class="count">${count}</span>
          </div>
          <div class="tree-items">
            ${
              count > 0
                ? list
                    .map(
                      (it) => `
              <div class="thumb-wrap" draggable="true"
                   data-drag-item-id="${escapeHtml(it.id)}"
                   title="click → place · drag → recategorize">
                <button class="thumb" data-item-id="${escapeHtml(it.id)}"
                        title="${escapeHtml(it.name)}">
                  <img src="${escapeHtml(it.cutoutDataUrl)}" alt="${escapeHtml(it.name)}" draggable="false" />
                  ${
                    it.subcategory
                      ? `<span class="thumb-sub">${escapeHtml(it.subcategory)}</span>`
                      : ""
                  }
                </button>
                <button class="thumb-edit" data-edit-id="${escapeHtml(it.id)}"
                        title="edit (${escapeHtml(it.name)})">e</button>
              </div>
            `,
                    )
                    .join("")
                : ""
            }
          </div>
        </div>
      `);
    });
    root.innerHTML = parts.join("");
  }

  subscribe(renderTree);
}

// =============================================================================
// INSPECTOR (right top)
// =============================================================================

export function initInspector({ onEditItem }) {
  const root = document.getElementById("inspector");

  function render(st) {
    const layer = st.layers.find((l) => l.id === st.selectedLayerId);
    const item = layer ? st.items.find((i) => i.id === layer.itemId) : null;
    if (!layer || !item) {
      root.innerHTML = `<p class="muted small">// select a layer on canvas</p>`;
      return;
    }

    const cat = CATEGORIES[item.category];
    const sub = item.subcategory ? ` · ${escapeHtml(item.subcategory)}` : "";

    root.innerHTML = `
      <div class="inspector-head">
        <img src="${escapeHtml(item.cutoutDataUrl)}" alt="" />
        <div class="meta">
          <div class="name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
          <div class="sub">${escapeHtml(cat.label)}${sub}</div>
        </div>
        ${
          item.color
            ? `<span class="color-chip" style="background:${escapeHtml(item.color)}" title="${escapeHtml(item.color)}"></span>`
            : `<button class="iconbtn" data-edit-item="1" title="edit">e</button>`
        }
      </div>

      ${control("scale", layer.scale, 0.05, 3, 0.01, "×", 1)}
      ${control("rotate", layer.rotation, -180, 180, 1, "°", 0)}
      ${control("opacity", Math.round(layer.opacity * 100), 0, 100, 1, "%", 100)}

      <div class="btn-group">
        <span>half</span>
        <button data-clip="left"  class="${layer.clip === "left"  ? "active" : ""}" title="left half only">◧</button>
        <button data-clip="full"  class="${layer.clip === "full"  ? "active" : ""}" title="whole item">■</button>
        <button data-clip="right" class="${layer.clip === "right" ? "active" : ""}" title="right half only">◨</button>
      </div>

      <div class="btn-group">
        <span>z</span>
        <button data-z="-5" title="send back">▼</button>
        <button data-z="5"  title="bring forward">▲</button>
        <button data-edit-item="1" title="edit item meta">edit·meta</button>
      </div>

      <div class="btn-group" style="grid-template-columns: 60px 1fr 1fr;">
        <span>vis</span>
        <button data-toggle-hidden="1">${layer.hidden ? "show" : "hide"}</button>
        <button class="danger" data-remove="1">remove</button>
      </div>
    `;

    // ---- wire up events on the current render
    root.querySelectorAll(".control").forEach((row) => {
      const key = row.dataset.key;
      const range = row.querySelector('input[type="range"]');
      const num = row.querySelector(".num");
      const reset = row.querySelector(".reset");

      const apply = (raw) => {
        let v = Number(raw);
        if (Number.isNaN(v)) return;
        if (key === "scale") {
          v = clamp(v, 0.05, 3);
          updateLayer(layer.id, { scale: v });
        } else if (key === "rotate") {
          v = clamp(v, -180, 180);
          updateLayer(layer.id, { rotation: v });
        } else {
          v = clamp(v, 0, 100);
          updateLayer(layer.id, { opacity: v / 100 });
        }
      };

      range.addEventListener("input", (e) => apply(e.target.value));
      num.addEventListener("change", (e) => apply(e.target.value));
      num.addEventListener("keydown", (e) => {
        if (e.key === "Enter") apply(e.target.value);
      });
      reset.addEventListener("click", () => {
        if (key === "scale") updateLayer(layer.id, { scale: 1 });
        else if (key === "rotate") updateLayer(layer.id, { rotation: 0 });
        else updateLayer(layer.id, { opacity: 1 });
      });
    });

    root.querySelectorAll("[data-clip]").forEach((b) => {
      b.addEventListener("click", () =>
        updateLayer(layer.id, { clip: b.dataset.clip }),
      );
    });
    root.querySelectorAll("[data-z]").forEach((b) => {
      b.addEventListener("click", () => {
        const delta = parseInt(b.dataset.z, 10);
        updateLayer(layer.id, {
          zIndex: Math.max(0, layer.zIndex + delta),
        });
      });
    });
    const editBtn = root.querySelector("[data-edit-item]");
    if (editBtn) editBtn.addEventListener("click", () => onEditItem(item.id));
    const toggleBtn = root.querySelector("[data-toggle-hidden]");
    if (toggleBtn)
      toggleBtn.addEventListener("click", () =>
        updateLayer(layer.id, { hidden: !layer.hidden }),
      );
    const rmBtn = root.querySelector("[data-remove]");
    if (rmBtn) rmBtn.addEventListener("click", () => removeLayer(layer.id));
  }

  function control(key, value, min, max, step, unit, def) {
    const display =
      key === "opacity"
        ? Math.round(value)
        : key === "rotate"
          ? Math.round(value)
          : value.toFixed(2);
    return `
      <div class="control" data-key="${escapeHtml(key)}">
        <span>${escapeHtml(key)}</span>
        <input type="range"
               min="${min}" max="${max}" step="${step}"
               value="${value}" />
        <input class="num mono" type="number"
               min="${min}" max="${max}" step="${step}"
               value="${display}" />
        <button class="reset" data-reset="${def}" title="reset to ${def}${unit}">↺</button>
      </div>
    `;
  }

  subscribe(render);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// =============================================================================
// LAYER LIST (right bottom)
// =============================================================================

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
    update({ selectedLayerId: id });
  });

  function render(st) {
    countEl.textContent = String(st.layers.length);
    const itemsById = new Map(st.items.map((i) => [i.id, i]));
    const rows = [...st.layers]
      .sort((a, b) => b.zIndex - a.zIndex)
      .map((l) => {
        const it = itemsById.get(l.itemId);
        if (!it) return "";
        const sel = l.id === st.selectedLayerId ? "sel" : "";
        const hidden = l.hidden ? "hidden" : "";
        return `
          <div class="layer-row ${sel} ${hidden}" data-layer-id="${escapeHtml(l.id)}">
            <img src="${escapeHtml(it.cutoutDataUrl)}" alt="" />
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

// =============================================================================
// STATUS BAR (bottom)
// =============================================================================

export function initStatusBar() {
  const bgEl = document.getElementById("status-bg");
  const stEl = document.getElementById("status-storage");
  const itEl = document.getElementById("status-items");

  subscribe((st) => {
    const dot = bgEl.querySelector(".dot");
    const text = bgEl.querySelector(".text");
    if (st.bgStatus.probing) {
      dot.className = "dot loading";
      text.textContent = "bg: probing…";
      bgEl.title = "checking @imgly/background-removal";
    } else if (st.bgStatus.ready) {
      dot.className = "dot ok";
      text.textContent = "bg: ready";
      bgEl.title = "background removal model loaded";
    } else {
      dot.className = "dot warn";
      text.textContent = "bg: off";
      bgEl.title =
        "bg removal unavailable — images will be placed as-is. error: " +
        (st.bgStatus.error || "?");
    }

    if (st.storage) {
      stEl.textContent = `idb: ${st.storage.usedMB} / ${st.storage.quotaMB} MB`;
    } else {
      stEl.textContent = "idb: —";
    }

    itEl.textContent = `items: ${st.items.length}`;
  });
}

// =============================================================================
// EDIT-ITEM MODAL
// =============================================================================

export function initEditModal() {
  const modal = document.getElementById("modal");
  const previewImg = document.getElementById("modal-preview-img");
  const previewMeta = document.getElementById("modal-preview-meta");
  const fName = document.getElementById("modal-name");
  const fCategory = document.getElementById("modal-category");
  const fSub = document.getElementById("modal-subcategory");
  const fSubs = document.getElementById("modal-subs");
  const fTags = document.getElementById("modal-tags");
  const fColorOn = document.getElementById("modal-color-on");
  const fColor = document.getElementById("modal-color");
  const fColorHex = document.getElementById("modal-color-hex");
  const btnDelete = document.getElementById("modal-delete");
  const btnSave = document.getElementById("modal-save");

  // category options
  fCategory.innerHTML = ALL_CATEGORIES.map(
    (c) => `<option value="${c}">${escapeHtml(CATEGORIES[c].label)}</option>`,
  ).join("");

  const refreshSubOptions = () => {
    fSubs.innerHTML = CATEGORIES[fCategory.value].subcategories
      .map((s) => `<option value="${escapeHtml(s)}"></option>`)
      .join("");
  };
  fCategory.addEventListener("change", refreshSubOptions);

  // color sync
  fColor.addEventListener("input", () => {
    fColorHex.value = fColor.value;
  });
  fColorHex.addEventListener("change", () => {
    if (/^#[0-9a-fA-F]{6}$/.test(fColorHex.value)) fColor.value = fColorHex.value;
  });
  fColorOn.addEventListener("change", () => {
    fColor.disabled = !fColorOn.checked;
    fColorHex.disabled = !fColorOn.checked;
  });

  // close handlers
  modal.addEventListener("click", (e) => {
    if (e.target.dataset.close === "1") close();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
  });

  let currentId = null;

  function open(itemId) {
    const st = getState();
    const it = st.items.find((i) => i.id === itemId);
    if (!it) return;
    currentId = itemId;
    previewImg.src = it.cutoutDataUrl;
    const bgLabel =
      it.bgMethod === "mono"
        ? "bg: mono-fill"
        : it.bgMethod === "ml"
          ? "bg: ml"
          : it.hasBgRemoved
            ? "bg: removed"
            : "bg: original";
    previewMeta.textContent = `${it.width}×${it.height} · ${bgLabel}`;
    fName.value = it.name;
    fCategory.value = it.category;
    refreshSubOptions();
    fSub.value = it.subcategory ?? "";
    fTags.value = it.tags.join(", ");
    const hasColor = !!it.color;
    fColorOn.checked = hasColor;
    fColor.disabled = !hasColor;
    fColorHex.disabled = !hasColor;
    const c = hasColor ? it.color : "#000000";
    fColor.value = c;
    fColorHex.value = c;
    modal.classList.remove("hidden");
    setTimeout(() => fName.focus(), 30);
  }

  function close() {
    modal.classList.add("hidden");
    currentId = null;
  }

  btnSave.addEventListener("click", async () => {
    const st = getState();
    const orig = st.items.find((i) => i.id === currentId);
    if (!orig) return close();
    const next = {
      ...orig,
      name: fName.value.trim() || "Без названия",
      category: fCategory.value,
      subcategory: fSub.value.trim(),
      tags: fTags.value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      color: fColorOn.checked ? fColor.value : "",
    };
    await saveItem(next);
    close();
  });

  btnDelete.addEventListener("click", async () => {
    const st = getState();
    const orig = st.items.find((i) => i.id === currentId);
    if (!orig) return close();
    if (!confirm(`Удалить "${orig.name}"?`)) return;
    await removeItemFully(currentId);
    close();
  });

  return { open, close };
}

// =============================================================================
// TOP BAR — clear / export wiring
// =============================================================================

export function initTopBar({ onExport }) {
  const exportBtn = document.getElementById("btn-export");
  const clearBtn = document.getElementById("btn-clear");
  exportBtn.addEventListener("click", onExport);
  clearBtn.addEventListener("click", () => {
    if (!confirm("Очистить холст?")) return;
    clearLayers();
  });
  subscribe((st) => {
    exportBtn.disabled = st.layers.length === 0;
    clearBtn.disabled = st.layers.length === 0;
  });
}

// =============================================================================
// UPLOAD DROPZONE INDICATOR + processing bar
// =============================================================================

export function initUploadVisuals() {
  const drop = document.getElementById("upload-drop");
  let depth = 0;
  const onEnter = () => {
    depth++;
    drop.classList.add("dragging");
  };
  const onLeave = () => {
    depth--;
    if (depth <= 0) {
      depth = 0;
      drop.classList.remove("dragging");
    }
  };
  window.addEventListener("dragenter", onEnter);
  window.addEventListener("dragleave", onLeave);
  window.addEventListener("drop", () => {
    depth = 0;
    drop.classList.remove("dragging");
  });

  // Processing bar
  let bar = null;
  subscribe((st) => {
    if (st.processing) {
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "processing-bar";
        const upload = document.querySelector(".upload");
        upload.insertAdjacentElement("afterend", bar);
      }
      bar.innerHTML = `<div class="spinner"></div><span>${escapeHtml(st.progress || "processing…")}</span>`;
    } else if (bar) {
      bar.remove();
      bar = null;
    }
  });
}
