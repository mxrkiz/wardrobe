// Image processing pipeline.
//
// Three background-removal strategies, tried in order:
//   1. mono   — corner-color flood-fill. Free, instant, perfect for product
//               photos on a uniform background (white seamless, light grey…).
//               Picks up its seed from the actual corner pixels so it works
//               for any solid colour, not just white.
//   2. ml     — @imgly/background-removal (ISNet ONNX). Used when the corners
//               disagree, i.e. the photo has a real-world background.
//   3. none   — keep the original. Used when nothing above worked.
//
// Each item carries `bgMethod` so the UI can show how it was cut.

import { probeBgRemoval, removeBackground } from "./bg.js";

// ---- DOM helpers -----------------------------------------------------------

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("FileReader failed"));
    r.readAsDataURL(blob);
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

// ---- Trim transparent borders ----------------------------------------------
// Scans the alpha channel for the tight bounding box, then crops. Necessary
// after BG removal so the cutout doesn't sit inside lots of empty padding —
// our spine-based auto-positioning relies on tight bounds.
export function trimTransparent(img, alphaThreshold = 8) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d ctx unavailable");
  ctx.drawImage(img, 0, 0);

  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let minX = c.width, minY = c.height, maxX = -1, maxY = -1;

  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const a = data[(y * c.width + x) * 4 + 3];
      if (a > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) {
    return {
      dataUrl: c.toDataURL("image/png"),
      width: c.width,
      height: c.height,
    };
  }

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d").drawImage(c, minX, minY, w, h, 0, 0, w, h);
  return { dataUrl: out.toDataURL("image/png"), width: w, height: h };
}

// ---- Dominant color --------------------------------------------------------
// 4-bit-per-channel histogram on a 64x64 downsample. Skips low-alpha pixels so
// the transparent border doesn't dominate.
export function dominantColor(img) {
  const max = 64;
  const ratio = Math.min(max / img.naturalWidth, max / img.naturalHeight, 1);
  const w = Math.max(1, Math.round(img.naturalWidth * ratio));
  const h = Math.max(1, Math.round(img.naturalHeight * ratio));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;

  const buckets = new Map();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const r = d[i] >> 4, g = d[i + 1] >> 4, b = d[i + 2] >> 4;
    const key = (r << 8) | (g << 4) | b;
    const e = buckets.get(key);
    if (e) {
      e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2]; e.n++;
    } else {
      buckets.set(key, { r: d[i], g: d[i + 1], b: d[i + 2], n: 1 });
    }
  }

  let best = { r: 0, g: 0, b: 0, n: 0 };
  for (const e of buckets.values()) if (e.n > best.n) best = e;
  if (best.n === 0) return "";
  const hex = (v) => Math.round(v / best.n).toString(16).padStart(2, "0");
  return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
}

// ---- Mono-background detection ---------------------------------------------
// Two-stage decision:
//   (a) all four corners must agree within `cornerSpread`. Bails on any noisy
//       or partly-transparent corner.
//   (b) the *interior* of the image must be clearly different from the bg
//       (median patch distance from bg ≥ `interiorMinDist`). This rejects
//       the pathological "white shirt on white seamless" case where a naive
//       flood-fill would happily eat the whole foreground.
// Returns the avg corner colour, or null if either check fails.
export function detectMonoBg(
  img,
  { cornerSpread = 20, interiorMinDist = 25 } = {},
) {
  const c = document.createElement("canvas");
  const w = img.naturalWidth, h = img.naturalHeight;
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;

  // 3x3 patch average — less sensitive to single-pixel JPEG noise.
  const sample = (cx, cy) => {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = Math.min(w - 1, Math.max(0, cx + dx));
        const y = Math.min(h - 1, Math.max(0, cy + dy));
        const i = (y * w + x) * 4;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++;
      }
    }
    return { r: r / n, g: g / n, b: b / n, a: a / n };
  };

  // --- (a) corner agreement ---
  const corners = [
    sample(0, 0),
    sample(w - 1, 0),
    sample(0, h - 1),
    sample(w - 1, h - 1),
  ];
  if (corners.some((c) => c.a < 200)) return null; // already cut out

  let maxDist = 0;
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      const dr = corners[i].r - corners[j].r;
      const dg = corners[i].g - corners[j].g;
      const db = corners[i].b - corners[j].b;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist > maxDist) maxDist = dist;
    }
  }
  if (maxDist > cornerSpread) return null;

  const bg = corners.reduce(
    (a, c) => ({ r: a.r + c.r, g: a.g + c.g, b: a.b + c.b }),
    { r: 0, g: 0, b: 0 },
  );
  bg.r /= 4; bg.g /= 4; bg.b /= 4;

  // --- (b) interior must be distinguishable from bg ---
  // 3x3 grid of interior samples (skipping the outer border).
  const dists = [];
  for (let yi = 1; yi <= 3; yi++) {
    for (let xi = 1; xi <= 3; xi++) {
      const x = Math.floor((w * xi) / 4);
      const y = Math.floor((h * yi) / 4);
      const s = sample(x, y);
      const dr = s.r - bg.r, dg = s.g - bg.g, db = s.b - bg.b;
      dists.push(Math.sqrt(dr * dr + dg * dg + db * db));
    }
  }
  dists.sort((a, b) => a - b);
  const median = dists[Math.floor(dists.length / 2)];

  if (median < interiorMinDist) {
    // Interior is bg-coloured (e.g. white shirt on white). Mono-fill would
    // eat the foreground. Refuse — caller will fall back to ML.
    return null;
  }

  return bg;
}

// ---- Mono-background flood-fill --------------------------------------------
// Flood-fills from each corner of the image, marking any pixel reachable
// through neighbours that are within `tolerance + feather` of the seed colour.
// Inside the marked region:
//   distance < tolerance              → alpha 0 (fully transparent)
//   tolerance ≤ distance < + feather  → ramp 0..255 (soft anti-aliased edge)
// Pixels not connected to the corners stay fully opaque, so a white logo
// inside a coloured shirt isn't accidentally erased.
export function removeMonoBg(img, bgColor, opts = {}) {
  const { tolerance = 22, feather = 14, fillHoles = false } = opts;
  const w = img.naturalWidth, h = img.naturalHeight;

  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, w, h);
  const data = id.data;
  const N = w * h;

  // Pre-compute distance to bg colour for every pixel.
  const dist = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const j = i * 4;
    const dr = data[j] - bgColor.r;
    const dg = data[j + 1] - bgColor.g;
    const db = data[j + 2] - bgColor.b;
    dist[i] = Math.sqrt(dr * dr + dg * dg + db * db);
  }

  // Flood-fill from corners, marking bg-connected pixels.
  const bgConnected = new Uint8Array(N);
  const stack = [];
  const cornerIdx = [0, w - 1, (h - 1) * w, h * w - 1];
  const reachThreshold = tolerance + feather;
  for (const ci of cornerIdx) {
    if (dist[ci] < reachThreshold) {
      stack.push(ci);
      bgConnected[ci] = 1;
    }
  }
  while (stack.length) {
    const idx = stack.pop();
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0)     { const n = idx - 1; if (!bgConnected[n] && dist[n] < reachThreshold) { bgConnected[n] = 1; stack.push(n); } }
    if (x < w - 1) { const n = idx + 1; if (!bgConnected[n] && dist[n] < reachThreshold) { bgConnected[n] = 1; stack.push(n); } }
    if (y > 0)     { const n = idx - w; if (!bgConnected[n] && dist[n] < reachThreshold) { bgConnected[n] = 1; stack.push(n); } }
    if (y < h - 1) { const n = idx + w; if (!bgConnected[n] && dist[n] < reachThreshold) { bgConnected[n] = 1; stack.push(n); } }
  }

  // Apply alpha for bg-connected pixels.
  for (let i = 0; i < N; i++) {
    if (!bgConnected[i]) continue;
    const j = i * 4;
    const dd = dist[i];
    if (dd < tolerance) {
      data[j + 3] = 0;
    } else {
      // soft edge ramp
      const t = (dd - tolerance) / feather;
      data[j + 3] = Math.round(255 * Math.min(1, Math.max(0, t)));
    }
  }

  // Optional second pass: kill isolated bg-coloured regions (e.g. the empty
  // space between a bag's handles). Same colour-distance threshold but no
  // connectivity requirement. Will also wipe legitimate light prints/logos —
  // hence opt-in.
  if (fillHoles) {
    for (let i = 0; i < N; i++) {
      if (bgConnected[i]) continue; // already handled above
      const dd = dist[i];
      if (dd < tolerance) {
        data[i * 4 + 3] = 0;
      } else if (dd < tolerance + feather) {
        const t = (dd - tolerance) / feather;
        const cur = data[i * 4 + 3];
        const target = Math.round(255 * Math.min(1, Math.max(0, t)));
        if (target < cur) data[i * 4 + 3] = target;
      }
    }
  }

  ctx.putImageData(id, 0, 0);
  return c.toDataURL("image/png");
}

// ---- Full pipeline ---------------------------------------------------------

export async function processFile(file, opts = {}) {
  const { bgMode = "auto", fillHoles = false } = opts;

  // 1. Decode the file once. We need the HTMLImageElement for the mono-bg
  //    detector regardless of which path we take.
  const objUrl = URL.createObjectURL(file);
  let img;
  try {
    img = await loadImage(objUrl);
  } finally {
    URL.revokeObjectURL(objUrl);
  }

  const tryMono = bgMode === "auto" || bgMode === "mono";
  const tryMl = bgMode === "auto" || bgMode === "ml";

  // 2. mono — fast corner flood-fill. Pre-check rejects same-coloured fg/bg.
  if (tryMono) {
    const bg = detectMonoBg(img);
    if (bg) {
      try {
        const dataUrl = removeMonoBg(img, bg, { fillHoles });
        const cutout = await loadImage(dataUrl);
        const trimmed = trimTransparent(cutout);
        const finalImg = await loadImage(trimmed.dataUrl);
        return {
          ...trimmed,
          color: dominantColor(finalImg),
          hasBgRemoved: true,
          bgMethod: "mono",
        };
      } catch (e) {
        console.warn("[bg] mono-bg removal failed:", e);
      }
    }
  }

  // 3. ml — @imgly ISNet. Slower but handles non-uniform backgrounds.
  if (tryMl) {
    const probe = await probeBgRemoval();
    if (probe.ready) {
      try {
        const cutoutBlob = await removeBackground(file);
        const url = URL.createObjectURL(cutoutBlob);
        try {
          const cutout = await loadImage(url);
          const trimmed = trimTransparent(cutout);
          const finalImg = await loadImage(trimmed.dataUrl);
          return {
            ...trimmed,
            color: dominantColor(finalImg),
            hasBgRemoved: true,
            bgMethod: "ml",
          };
        } finally {
          URL.revokeObjectURL(url);
        }
      } catch (e) {
        console.warn("[bg] ml cutout failed:", e);
      }
    }
  }

  // 4. off / fallback — keep the original.
  const dataUrl = await blobToDataUrl(file);
  return {
    dataUrl,
    width: img.naturalWidth,
    height: img.naturalHeight,
    color: dominantColor(img),
    hasBgRemoved: false,
    bgMethod: "none",
  };
}

// ---- UUID ------------------------------------------------------------------
export const uid = () =>
  crypto.randomUUID?.() ??
  Math.random().toString(36).slice(2) + Date.now().toString(36);
