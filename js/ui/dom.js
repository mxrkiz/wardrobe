// Shared DOM helper for the UI modules.

/**
 * Escape a value for safe interpolation into innerHTML.
 * @param {unknown} v
 * @returns {string}
 */
export function escapeHtml(v) {
  if (v == null) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build a thumbnail <img> tag, but only when `src` is a real value. An item
 * with a missing/empty image yields an empty string (no <img>) instead of an
 * `<img src="">` that the browser would log as a failed load. `onerror` also
 * hides the element if the data URL turns out to be undecodable.
 * @param {string} src
 * @param {string} [alt]
 * @param {string} [attrs] extra raw attributes (already trusted/escaped)
 * @returns {string}
 */
export function thumbImg(src, alt = "", attrs = "") {
  if (!src) return "";
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" ${attrs} onerror="this.style.visibility='hidden'" />`;
}
