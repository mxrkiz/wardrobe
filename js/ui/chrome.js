// App chrome: status bar, top bar (export/clear), grid toggle, canvas-bg
// swatches, and the mobile collapsible-inspector behaviour.

import { subscribe, update, clearLayers } from "../state.js";

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

  // Selection changes do NOT auto-expand the inspector on mobile — the canvas
  // would be covered immediately after tapping an item, which is disruptive.
  // The user opens the inspector manually via the toggle button when needed.

  // Reset to a sane default when crossing the breakpoint.
  mql.addEventListener?.("change", (e) => setCollapsed(e.matches));
}
