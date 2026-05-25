// Edit-item modal: name, category, subcategory (custom dark-theme combobox),
// tags, and an optional colour.

import { CATEGORIES, ALL_CATEGORIES } from "../categories.js";
import { getState, saveItem, removeItemFully } from "../state.js";
import { escapeHtml } from "./dom.js";

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
