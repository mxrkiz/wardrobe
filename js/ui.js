// UI barrel — re-exports the focused modules under js/ui/. Kept so the rest of
// the app (mainly main.js) can keep importing from "./ui.js" unchanged.

export { escapeHtml } from "./ui/dom.js";
export { initWardrobeTree } from "./ui/tree.js";
export { initUploadCategorySelect, initUploadVisuals } from "./ui/upload.js";
export { initInspector } from "./ui/inspector.js";
export { initLayerList } from "./ui/layers.js";
export { initEditModal } from "./ui/modal.js";
export {
  initStatusBar,
  initTopBar,
  initGridToggle,
  initCanvasBg,
  initMobileUI,
} from "./ui/chrome.js";
