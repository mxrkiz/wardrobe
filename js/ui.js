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
  reorderLayersByZ,
  moveLayerZ,
  toggleSelection,
  removeSelected,
} from "./state.js";
import { subscribeLivePreview } from "./canvas.js";

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
        <div class="tree-section ${isOpen ? "open" : ""} ${count === 0 ? "empty" : ""}">
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

  // Cache for the currently-shown layer's "structural" signature. We only
  // rebuild the DOM when this changes; for plain numeric updates (slider
  // dragged on canvas or in the inspector itself) we just write into the
  // existing input elements. Without this, every slider tick would wipe and
  // re-create the slider DOM, breaking the user's drag.
  let currentLayerId = null;
  let currentSig = null;
  let currentNumericSig = null;

  // Element handles, refreshed after each full render.
  const ctl = { scale: null, rotate: null, opacity: null };

  function render(st) {
    const ids = st.selectedLayerIds || [];

    // Multi-selection → compact summary (no per-layer sliders).
    if (ids.length > 1) {
      const sig = `multi:${ids.length}`;
      if (currentSig !== sig) {
        root.innerHTML = `
          <p class="muted small">${ids.length} items selected</p>
          <div class="btn-group" style="grid-template-columns: 1fr;">
            <button class="danger" data-remove-selected="1">erase selected · Delete</button>
          </div>
          <p class="muted small">// drag any selected item on the canvas to move them together</p>
        `;
        const rm = root.querySelector("[data-remove-selected]");
        if (rm) rm.addEventListener("click", () => removeSelected());
        currentLayerId = "__multi__";
        currentSig = sig;
        currentNumericSig = null;
        ctl.scale = ctl.rotate = ctl.opacity = null;
      }
      return;
    }

    const layer = ids.length === 1 ? st.layers.find((l) => l.id === ids[0]) : null;
    const item = layer ? st.items.find((i) => i.id === layer.itemId) : null;

    if (!layer || !item) {
      if (currentLayerId !== null) {
        root.innerHTML = `<p class="muted small">// select a layer on canvas</p>`;
        currentLayerId = null;
        currentSig = null;
        currentNumericSig = null;
        ctl.scale = ctl.rotate = ctl.opacity = null;
      }
      return;
    }

    // Structural signature: anything that affects rendered DOM other than the
    // 3 slider values. Includes layer.id (selection changed), clip/hidden,
    // and item meta that's mirrored in the header.
    const sig = [
      layer.id,
      layer.clip,
      layer.hidden,
      item.name,
      item.color,
      item.category,
      item.subcategory,
      item.cutoutDataUrl.length, // proxy for "image was reprocessed"
    ].join("|");

    if (sig !== currentSig) {
      fullRender(layer, item);
      currentSig = sig;
      currentLayerId = layer.id;
    }

    // Always update numeric values (with focus guard so we don't fight the
    // user's own input).
    const numSig = `${layer.scale}|${layer.rotation}|${layer.opacity}`;
    if (numSig !== currentNumericSig) {
      writeNumeric("scale", layer.scale);
      writeNumeric("rotate", layer.rotation);
      writeNumeric("opacity", Math.round(layer.opacity * 100));
      currentNumericSig = numSig;
    }
  }

  function fullRender(layer, item) {
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

      ${control("scale", layer.scale, 0.05, 3, 0.001, "×", 1)}
      ${control("rotate", layer.rotation, -180, 180, 0.5, "°", 0)}
      ${control("opacity", Math.round(layer.opacity * 100), 0, 100, 1, "%", 100)}

      <div class="btn-group">
        <span>half</span>
        <button data-clip="left"  class="${layer.clip === "left"  ? "active" : ""}" title="left half only">◧</button>
        <button data-clip="full"  class="${layer.clip === "full"  ? "active" : ""}" title="whole item">■</button>
        <button data-clip="right" class="${layer.clip === "right" ? "active" : ""}" title="right half only">◨</button>
      </div>

      <div class="btn-group">
        <span>z</span>
        <button data-zmove="1"  title="bring forward (one level)">▲</button>
        <button data-zmove="-1" title="send back (one level)">▼</button>
        <button data-edit-item="1" title="edit item meta">edit·meta</button>
      </div>

      <div class="btn-group" style="grid-template-columns: 60px 1fr 1fr;">
        <span>vis</span>
        <button data-toggle-hidden="1">${layer.hidden ? "show" : "hide"}</button>
        <button class="danger" data-remove="1">remove</button>
      </div>
    `;

    // Cache DOM references for fast updates from live-preview / state.
    ctl.scale = grabCtl("scale");
    ctl.rotate = grabCtl("rotate");
    ctl.opacity = grabCtl("opacity");
    // Reset numeric sig so the first state-driven render writes initial values.
    currentNumericSig = null;

    // ---- wire control events on the new DOM
    [
      { key: "scale", min: 0.05, max: 3, fn: (v) => ({ scale: v }) },
      { key: "rotate", min: -180, max: 180, fn: (v) => ({ rotation: v }) },
      { key: "opacity", min: 0, max: 100, fn: (v) => ({ opacity: v / 100 }) },
    ].forEach(({ key, min, max, fn }) => {
      const c = ctl[key];
      if (!c) return;
      const apply = (raw) => {
        let v = Number(raw);
        if (Number.isNaN(v)) return;
        v = clamp(v, min, max);
        updateLayer(layer.id, fn(v));
      };
      c.range.addEventListener("input", (e) => apply(e.target.value));
      c.num.addEventListener("input", (e) => apply(e.target.value));
      c.num.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          apply(e.target.value);
          e.target.blur();
        }
      });
      c.reset.addEventListener("click", () => {
        if (key === "scale") updateLayer(layer.id, { scale: 1 });
        else if (key === "rotate") updateLayer(layer.id, { rotation: 0 });
        else updateLayer(layer.id, { opacity: 1 });
      });
    });

    // Double-click the "rotate" label → snap rotation back to 0.
    const rotateLabel = root.querySelector('.control[data-key="rotate"] > span');
    rotateLabel?.addEventListener("dblclick", () =>
      updateLayer(layer.id, { rotation: 0 }),
    );

    root.querySelectorAll("[data-clip]").forEach((b) => {
      b.addEventListener("click", () =>
        updateLayer(layer.id, { clip: b.dataset.clip }),
      );
    });
    root.querySelectorAll("[data-zmove]").forEach((b) => {
      b.addEventListener("click", () =>
        moveLayerZ(layer.id, parseInt(b.dataset.zmove, 10)),
      );
    });
    const editBtn = root.querySelector("[data-edit-item]");
    if (editBtn) editBtn.addEventListener("click", () => onEditItem(item.id));
    const toggleBtn = root.querySelector("[data-toggle-hidden]");
    if (toggleBtn)
      toggleBtn.addEventListener("click", () => {
        const cur = getState().layers.find((l) => l.id === layer.id);
        if (cur) updateLayer(layer.id, { hidden: !cur.hidden });
      });
    const rmBtn = root.querySelector("[data-remove]");
    if (rmBtn) rmBtn.addEventListener("click", () => removeLayer(layer.id));
  }

  function grabCtl(key) {
    const row = root.querySelector(`.control[data-key="${key}"]`);
    if (!row) return null;
    return {
      range: row.querySelector('input[type="range"]'),
      num: row.querySelector(".num"),
      reset: row.querySelector(".reset"),
    };
  }

  // Write a value into the slider + number input, skipping whichever is
  // currently focused (the user is typing/dragging it).
  function writeNumeric(key, value) {
    const c = ctl[key];
    if (!c) return;
    const display =
      key === "opacity"
        ? String(Math.round(value))
        : key === "rotate"
          ? value.toFixed(1)
          : value.toFixed(3);
    if (document.activeElement !== c.range) c.range.value = String(value);
    if (document.activeElement !== c.num) c.num.value = display;
  }

  function control(key, value, min, max, step, unit, def) {
    const display =
      key === "opacity"
        ? String(Math.round(value))
        : key === "rotate"
          ? value.toFixed(1)
          : value.toFixed(3);
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

  // ---- Live preview from canvas drag/transform --------------------------
  // Canvas fires {scale, rotation, x, y} during drag/transform. We mirror
  // them straight into the input visuals without going through state — the
  // commit to state happens at dragend/transformend.
  subscribeLivePreview((layerId, props) => {
    if (layerId !== currentLayerId) return;
    if (props.scale != null) writeNumeric("scale", props.scale);
    if (props.rotation != null) writeNumeric("rotate", props.rotation);
  });

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
    } catch {}
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

  function render(st) {
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
            <img src="${escapeHtml(it.cutoutDataUrl)}" alt="" draggable="false" />
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
  const fSubCombo = document.getElementById("modal-sub-combo");
  const fSubCaret = document.getElementById("modal-sub-caret");
  const fSubPop = document.getElementById("modal-sub-pop");
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

  // ---- Subcategory combobox ------------------------------------------------
  // Filtered popup of the category's suggestions, plus free-typing of a
  // brand-new value. Replaces the native <datalist> so the popup honours the
  // dark theme on every browser.
  let subOptions = [];
  function renderSubPop() {
    const q = fSub.value.toLowerCase().trim();
    const list = subOptions.filter((o) => o.toLowerCase().includes(q));
    fSubPop.innerHTML = list.length
      ? list
          .map(
            (o) =>
              `<div class="combo-item${
                o.toLowerCase() === q ? " selected" : ""
              }" data-val="${escapeHtml(o)}">${escapeHtml(o)}</div>`,
          )
          .join("")
      : `<div class="combo-empty">// no match — type your own</div>`;
  }
  const openSubPop = () => {
    renderSubPop();
    fSubCombo.classList.add("open");
  };
  const closeSubPop = () => fSubCombo.classList.remove("open");
  const setSubOptions = (opts) => {
    subOptions = opts || [];
    if (fSubCombo.classList.contains("open")) renderSubPop();
  };

  fSub.addEventListener("focus", openSubPop);
  fSub.addEventListener("input", openSubPop);
  fSubCaret.addEventListener("click", () => {
    if (fSubCombo.classList.contains("open")) {
      closeSubPop();
    } else {
      fSub.focus();
      openSubPop();
    }
  });
  fSubPop.addEventListener("click", (e) => {
    const item = e.target.closest(".combo-item");
    if (!item) return;
    fSub.value = item.dataset.val;
    closeSubPop();
  });
  document.addEventListener("click", (e) => {
    if (!fSubCombo.contains(e.target)) closeSubPop();
  });
  fCategory.addEventListener("change", () =>
    setSubOptions(CATEGORIES[fCategory.value].subcategories),
  );

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
    setSubOptions(CATEGORIES[it.category].subcategories);
    closeSubPop();
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

// =============================================================================
// GRID TOGGLE (left pane head switch)
// =============================================================================

export function initGridToggle() {
  const cb = document.getElementById("toggle-grid");
  if (!cb) return;
  cb.addEventListener("change", (e) => update({ showGrid: e.target.checked }));
  subscribe((st) => {
    if (cb.checked !== st.showGrid) cb.checked = st.showGrid;
  });
}

// =============================================================================
// CANVAS BACKGROUND SWATCHES (left pane head)
// =============================================================================

export function initCanvasBg() {
  const wrap = document.getElementById("canvas-bg");
  if (!wrap) return;
  wrap.addEventListener("click", (e) => {
    const sw = e.target.closest("[data-cbg]");
    if (sw) update({ canvasBg: sw.dataset.cbg });
  });
  subscribe((st) => {
    const cur = (st.canvasBg || "").toLowerCase();
    wrap.querySelectorAll(".cbg-sw").forEach((b) => {
      b.classList.toggle("active", b.dataset.cbg.toLowerCase() === cur);
    });
  });
}

// =============================================================================
// MOBILE UI — collapsible bottom inspector
// =============================================================================
// On phones the right pane sits at the bottom of the vertical stack. It starts
// collapsed (just its header) so the canvas owns the screen, auto-expands when
// the user selects a layer, and can be toggled by hand. On desktop the
// `collapsed` class is ignored by the stylesheet, so this is a no-op there.

export function initMobileUI() {
  const right = document.querySelector(".pane.right");
  const toggle = document.getElementById("inspector-toggle");
  if (!right || !toggle) return;

  const mql = window.matchMedia("(max-width: 720px)");
  const setCollapsed = (v) => {
    right.classList.toggle("collapsed", v);
    toggle.setAttribute("aria-expanded", String(!v));
    toggle.textContent = v ? "▴" : "▾";
  };

  if (mql.matches) setCollapsed(true);

  toggle.addEventListener("click", () =>
    setCollapsed(!right.classList.contains("collapsed")),
  );

  // Auto-expand when the selection becomes non-empty on mobile.
  let prevCount = 0;
  subscribe((st) => {
    const count = (st.selectedLayerIds || []).length;
    if (mql.matches && count && count !== prevCount) setCollapsed(false);
    prevCount = count;
  });

  // Reset to a sane default when crossing the breakpoint.
  mql.addEventListener?.("change", (e) => setCollapsed(e.matches));
}
