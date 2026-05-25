// Inspector (right pane, top): per-layer controls (scale/rotate/opacity,
// half-clip, z-order, visibility) for a single selection, or a compact
// summary for a multi-selection.

import { CATEGORIES } from "../categories.js";
import {
  getState,
  subscribe,
  addItem,
  updateLayer,
  removeLayer,
  moveLayerZ,
  removeSelected,
} from "../state.js";
import { subscribeLivePreview } from "../canvas.js";
import { uid } from "../imageOps.js";
import { escapeHtml, thumbImg } from "./dom.js";

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
    // and item meta in the header.
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
        ${thumbImg(item.cutoutDataUrl, item.name)}
        <div class="meta">
          <div class="name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
          <div class="sub">${escapeHtml(cat.label)}${sub}</div>
        </div>
        ${
          item.color
            ? `<span class="color-chip" title="${escapeHtml(item.color)}"></span>`
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

      <div class="btn-group" style="grid-template-columns: 60px 1fr;">
        <span>img</span>
        <button data-edit-img="1" title="paint-out logos / regions">edit·img</button>
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

    // Colour chip: set the swatch via the style API rather than interpolating
    // the colour into an inline style string.
    if (item.color) {
      const chip = root.querySelector(".color-chip");
      if (chip) chip.style.background = item.color;
    }

    // Cache DOM references for fast updates from live-preview / state.
    ctl.scale = grabCtl("scale");
    ctl.rotate = grabCtl("rotate");
    ctl.opacity = grabCtl("opacity");
    // Reset numeric sig so the first state-driven render writes initial values.
    currentNumericSig = null;

    wireControls(layer, item);
  }

  // Wire all the event handlers on the freshly-rendered inspector DOM.
  function wireControls(layer, item) {
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
      // Reset to the control's default value. Triggered by the ↺ button or by
      // double-clicking the label. blur() afterwards so the control doesn't sit
      // there focused/highlighted once the value has snapped back.
      const resetTo =
        key === "scale" ? { scale: 1 } : key === "rotate" ? { rotation: 0 } : { opacity: 1 };
      const doReset = (el) => {
        updateLayer(layer.id, resetTo);
        el?.blur();
      };
      c.reset.addEventListener("click", (e) => doReset(e.currentTarget));
      const label = root.querySelector(`.control[data-key="${key}"] > span`);
      label?.addEventListener("dblclick", () => doReset());
    });

    root.querySelectorAll("[data-clip]").forEach((b) => {
      b.addEventListener("click", (e) => {
        updateLayer(layer.id, { clip: b.dataset.clip });
        e.currentTarget.blur();
      });
    });

    const editImgBtn = root.querySelector("[data-edit-img]");
    if (editImgBtn) {
      editImgBtn.addEventListener("click", () => {
        import("../editor.js").then(({ openEditor }) => {
          openEditor(layer.id, item.cutoutDataUrl, {
            onDone: (newDataUrl) => applyEditedImage(layer.id, item, newDataUrl),
            onCancel: () => {},
          });
        });
      });
    }

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

// Create a new item from the edited image data URL and point the layer at it.
async function applyEditedImage(layerId, origItem, newDataUrl) {
  const img = new Image();
  img.src = newDataUrl;
  await new Promise((res) => { img.onload = res; });
  const newItem = {
    ...origItem,
    id: uid(),
    cutoutDataUrl: newDataUrl,
    width: img.naturalWidth,
    height: img.naturalHeight,
    createdAt: Date.now(),
  };
  await addItem(newItem);
  updateLayer(layerId, { itemId: newItem.id });
}
