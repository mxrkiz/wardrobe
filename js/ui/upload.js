// Upload controls: the category select, and the drop-zone indicator
// + processing bar.

import { CATEGORIES, ALL_CATEGORIES } from "../categories.js";
import { subscribe, update } from "../state.js";
import { escapeHtml } from "./dom.js";

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

  subscribe((st) => {
    if (sel.value !== st.uploadCategory) sel.value = st.uploadCategory;
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
