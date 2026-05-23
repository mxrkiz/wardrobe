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
// Strategy:
//   1. Sample many points along all four edges (a 5px inset, so we ignore any
//      JPEG fringe right at the boundary) using small 3x3 patches.
//   2. Pick the per-channel median across all edge samples as the bg seed.
//      Median is robust to a few outliers — e.g. the soft drop-shadow that
//      most catalog photos have along the bottom doesn't shift the answer.
//   3. Reject if too many edge samples diverge from the median (it's not a
//      uniform background, it's a real scene).
//   4. Reject if the interior is mostly bg-coloured — that's the "white shirt
//      on white seamless" trap where flood-fill would eat the subject. We
//      require at least a few interior samples to clearly differ from bg.
// Returns the bg colour, or null if any check fails.
export function detectMonoBg(
  img,
  {
    edgeSamplesPerSide = 9,    // → 4*9 = 36 edge samples
    edgeInset = 5,             // pixels from the edge to avoid JPEG fringe
    bgMaxSpread = 32,          // max per-sample distance from median seed
    bgRequiredFrac = 0.7,      // ≥70% of edge samples must look like bg
    interiorFgMinCount = 2,    // ≥N interior samples must be clearly fg
    interiorFgMinDist = 28,    // … and "clearly" means this colour distance
  } = {},
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

  // --- 1. collect edge samples --------------------------------------------
  const inset = Math.min(edgeInset, Math.floor(Math.min(w, h) / 8));
  const N = edgeSamplesPerSide;
  const edgeSamples = [];
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;                              // (0..1)
    const x = Math.round(inset + t * (w - 1 - 2 * inset));
    const y = Math.round(inset + t * (h - 1 - 2 * inset));
    edgeSamples.push(sample(x, inset));                   // top
    edgeSamples.push(sample(x, h - 1 - inset));           // bottom
    edgeSamples.push(sample(inset, y));                   // left
    edgeSamples.push(sample(w - 1 - inset, y));           // right
  }

  // Reject if any sample has low alpha — image is already cut out.
  if (edgeSamples.some((s) => s.a < 200)) return null;

  // --- 2. per-channel median = robust bg seed -----------------------------
  const median = (arr) => {
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };
  const bg = {
    r: median(edgeSamples.map((s) => s.r)),
    g: median(edgeSamples.map((s) => s.g)),
    b: median(edgeSamples.map((s) => s.b)),
  };

  // --- 3. uniformity: enough edge samples close to bg? --------------------
  let bgLike = 0;
  for (const s of edgeSamples) {
    const dr = s.r - bg.r, dg = s.g - bg.g, db = s.b - bg.b;
    if (Math.sqrt(dr * dr + dg * dg + db * db) < bgMaxSpread) bgLike++;
  }
  if (bgLike / edgeSamples.length < bgRequiredFrac) return null;

  // --- 4. interior must contain real foreground ---------------------------
  // 5x5 grid of interior samples.
  let fgCount = 0;
  for (let yi = 1; yi <= 5; yi++) {
    for (let xi = 1; xi <= 5; xi++) {
      const x = Math.floor((w * xi) / 6);
      const y = Math.floor((h * yi) / 6);
      const s = sample(x, y);
      const dr = s.r - bg.r, dg = s.g - bg.g, db = s.b - bg.b;
      if (Math.sqrt(dr * dr + dg * dg + db * db) > interiorFgMinDist) fgCount++;
    }
  }
  if (fgCount < interiorFgMinCount) {
    // foreground indistinguishable from bg (e.g. white shirt on white) →
    // mono-fill would eat the subject. Refuse, let ML take over.
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
  // tolerance=14, feather=10: tight enough that a bright-but-not-bg pixel
  // (e.g. a white sneaker sole on light grey seamless) isn't bridged into the
  // bg through a soft drop-shadow — the shadow's distance from bg (~25..40)
  // exceeds tolerance+feather=24, so flood-fill stops at the shadow ring and
  // anything beyond it (the actual subject) stays opaque.
  const { tolerance = 14, feather = 10, fillHoles = false } = opts;
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

// ---- Close interior holes in an ML mask ------------------------------------
// The ISNet model occasionally erases a region in the INTERIOR of a solid
// subject — a dark tattoo on an arm reads as background/shadow and gets punched
// out, so on the white canvas plate it looks "painted white". Real background
// is always connected to the image border, so we flood-fill transparency inward
// from the edges: any transparent pixel reachable from a border is genuine bg
// and stays cut; any transparent pixel NOT reachable is an interior hole and is
// restored to opaque, taking its RGB from the original photo so the recovered
// region keeps its true colour.
export function closeAlphaHoles(cutoutImg, originalImg, { alphaThreshold = 16 } = {}) {
  const w = cutoutImg.naturalWidth, h = cutoutImg.naturalHeight;
  if (w < 3 || h < 3) {
    const c0 = document.createElement("canvas");
    c0.width = w; c0.height = h;
    c0.getContext("2d").drawImage(cutoutImg, 0, 0);
    return c0.toDataURL("image/png");
  }

  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(cutoutImg, 0, 0);
  const id = ctx.getImageData(0, 0, w, h);
  const data = id.data;
  const N = w * h;

  // Original pixels (matched to cutout size) — source for recovered colour.
  const oc = document.createElement("canvas");
  oc.width = w; oc.height = h;
  const octx = oc.getContext("2d", { willReadFrequently: true });
  octx.drawImage(originalImg, 0, 0, w, h);
  const odata = octx.getImageData(0, 0, w, h).data;

  // Flood-fill "outside" from the border through transparent pixels only.
  const outside = new Uint8Array(N);
  const stack = [];
  const pushIf = (i) => {
    if (!outside[i] && data[i * 4 + 3] < alphaThreshold) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) { pushIf(x); pushIf((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { pushIf(y * w); pushIf(y * w + w - 1); }
  while (stack.length) {
    const idx = stack.pop();
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0)     pushIf(idx - 1);
    if (x < w - 1) pushIf(idx + 1);
    if (y > 0)     pushIf(idx - w);
    if (y < h - 1) pushIf(idx + w);
  }

  // Restore interior holes (transparent but not reachable from the border).
  for (let i = 0; i < N; i++) {
    const j = i * 4;
    if (data[j + 3] < alphaThreshold && !outside[i]) {
      data[j]     = odata[j];
      data[j + 1] = odata[j + 1];
      data[j + 2] = odata[j + 2];
      data[j + 3] = 255;
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
          // Recover any interior holes the model punched into a solid subject
          // (e.g. a dark tattoo) before trimming away transparent borders.
          const closed = await loadImage(closeAlphaHoles(cutout, img));
          const trimmed = trimTransparent(closed);
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
