// Wardrobe tree (left pane): category sections of item thumbnails. Click to
// place on the canvas; drag a thumb onto another section to recategorize.

import { CATEGORIES, ALL_CATEGORIES } from "../categories.js";
import { getState, subscribe, recategorizeItem } from "../state.js";
import { escapeHtml, thumbImg } from "./dom.js";

const AUTOSCROLL_ZONE = 40;  // px from a tree edge that triggers auto-scroll
const AUTOSCROLL_SPEED = 6;  // px/frame
const DRAG_THRESHOLD = 6;    // px of movement before a press becomes a drag

// ---- Track which tree sections are open ------------------------------------
const openSections = new Set(ALL_CATEGORIES); // open by default

export function initWardrobeTree({ onPlace, onEdit }) {
  const root = document.getElementById("wardrobe-tree");
  const countEl = document.getElementById("item-count");

  // Set true for one tick after a real drag so the trailing click doesn't also
  // place the dragged item on the canvas. (Assigned by the drag handlers below.)
  let justDragged = false;

  // ---- Click: toggle section, place on canvas, open edit modal -----------
  root.addEventListener("click", (e) => {
    if (justDragged) return; // ignore the click synthesised after a drag
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

  // ---- Drag-and-drop: recategorize (pointer-based) -----------------------
  // Built on Pointer Events instead of native HTML5 drag-and-drop, because
  // browsers suppress `wheel` while a native drag is in progress — and we want
  // the wheel to keep scrolling the tree mid-drag. A press that moves past a
  // small threshold becomes a drag; a press that doesn't is left to the click
  // handler (which places the item on the canvas).
  let dragItemId = null;
  let dragStart = null;
  let pendingWrap = null;
  let isDragging = false;
  let ghost = null;
  let _rafId = null;
  let _dragClientX = 0;
  let _dragClientY = 0;

  // Auto-scroll the tree while a drag hovers its top/bottom edge — but only
  // while the pointer is actually inside the tree's box (its own zone), so a
  // drag passing over the canvas never scrolls the tree.
  const _pointerInTree = (r) =>
    _dragClientX >= r.left && _dragClientX <= r.right &&
    _dragClientY >= r.top && _dragClientY <= r.bottom;
  const _startAutoScroll = () => {
    if (_rafId) return;
    const scroll = () => {
      const r = root.getBoundingClientRect();
      if (_pointerInTree(r)) {
        if (_dragClientY < r.top + AUTOSCROLL_ZONE) root.scrollTop -= AUTOSCROLL_SPEED;
        else if (_dragClientY > r.bottom - AUTOSCROLL_ZONE) root.scrollTop += AUTOSCROLL_SPEED;
      }
      _rafId = requestAnimationFrame(scroll);
    };
    _rafId = requestAnimationFrame(scroll);
  };
  const _stopAutoScroll = () => {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  };

  const sectionUnder = (x, y) =>
    document.elementFromPoint(x, y)?.closest(".tree-section") || null;
  const highlight = (section) => {
    root.querySelectorAll(".tree-section.drop-target").forEach((el) => {
      if (el !== section) el.classList.remove("drop-target");
    });
    if (section) section.classList.add("drop-target");
  };

  const makeGhost = (wrap, x, y) => {
    const img = wrap.querySelector("img");
    ghost = document.createElement("div");
    ghost.style.cssText = [
      "position:fixed",
      "width:48px", "height:48px",
      "border-radius:6px",
      "border:1px solid var(--accent)",
      "background:var(--bg-2) center/contain no-repeat",
      img ? `background-image:url("${img.src}")` : "",
      "pointer-events:none",
      "opacity:0.85",
      "z-index:300",
      "transform:translate(-50%,-50%)",
    ].join(";");
    document.body.appendChild(ghost);
    moveGhost(x, y);
  };
  const moveGhost = (x, y) => {
    if (ghost) { ghost.style.left = x + "px"; ghost.style.top = y + "px"; }
  };

  const endDrag = () => {
    _stopAutoScroll();
    document.body.style.userSelect = "";
    if (ghost) { ghost.remove(); ghost = null; }
    root.querySelectorAll(".thumb-wrap.dragging").forEach((el) =>
      el.classList.remove("dragging"),
    );
    highlight(null);
    isDragging = false;
    dragItemId = null;
    dragStart = null;
    pendingWrap = null;
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerCancel);
  };

  function onPointerMove(e) {
    if (!dragItemId || !dragStart) return;
    _dragClientX = e.clientX;
    _dragClientY = e.clientY;
    if (!isDragging) {
      if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) < DRAG_THRESHOLD) return;
      isDragging = true;
      pendingWrap?.classList.add("dragging");
      document.body.style.userSelect = "none";
      makeGhost(pendingWrap, e.clientX, e.clientY);
      _startAutoScroll();
    }
    e.preventDefault();
    moveGhost(e.clientX, e.clientY);
    highlight(sectionUnder(e.clientX, e.clientY));
  }

  async function onPointerUp(e) {
    const wasDragging = isDragging;
    const id = dragItemId;
    const section = wasDragging ? sectionUnder(e.clientX, e.clientY) : null;
    endDrag();
    if (wasDragging) {
      // Suppress the click that the browser fires after a real drag, so the
      // dragged item isn't also placed on the canvas. Cleared on the next tick.
      justDragged = true;
      setTimeout(() => { justDragged = false; }, 0);
    }
    if (!wasDragging || !id || !section) return;
    const newCat = section.querySelector("[data-section]")?.dataset.section;
    if (!newCat) return;
    openSections.add(newCat); // open the target so the user sees the result
    await recategorizeItem(id, newCat);
  }

  function onPointerCancel() {
    endDrag();
  }

  root.addEventListener("pointerdown", (e) => {
    // Primary button only; leave touch to native tap/scroll (no touch DnD here,
    // same as before — a touch press should still scroll the tree).
    if (e.button !== 0 || e.pointerType === "touch") return;
    const wrap = e.target.closest("[data-drag-item-id]");
    if (!wrap || e.target.closest(".thumb-edit")) return;
    dragItemId = wrap.dataset.dragItemId;
    dragStart = { x: e.clientX, y: e.clientY };
    pendingWrap = wrap;
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
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
              <div class="thumb-wrap" draggable="false"
                   data-drag-item-id="${escapeHtml(it.id)}"
                   title="click → place · drag → recategorize">
                <button class="thumb" data-item-id="${escapeHtml(it.id)}"
                        title="${escapeHtml(it.name)}">
                  ${thumbImg(it.cutoutDataUrl, it.name, 'draggable="false"')}
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
    lastSig = treeSignature(st);
  }

  // The tree only depends on the item set and which sections are open — never
  // on layer geometry. Skip rebuilds (which reload every thumbnail) when none
  // of that changed, so dragging an inspector slider stays smooth.
  let lastSig = null;
  const treeSignature = (st) =>
    st.items
      .map((i) => `${i.id}:${i.category}:${i.name}:${i.subcategory || ""}:${i.cutoutDataUrl.length}`)
      .join("|") +
    "#" +
    [...openSections].sort().join(",");

  subscribe((st) => {
    if (treeSignature(st) === lastSig) return;
    renderTree(st);
  });
}
