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

  // --- 5. Reject if the subject itself is predominantly white --------------
  // White items (white shirt, white sneaker) on a non-white bg would pass
  // checks 3+4, but mono flood-fill from corners would also remove the item
  // because white is within tolerance of… white. Detect this by counting how
  // many of the foreground interior samples are near-white (all channels >215).
  // If >60% are, fall back to ML.
  let nearWhiteSubject = 0;
  for (let yi = 1; yi <= 5; yi++) {
    for (let xi = 1; xi <= 5; xi++) {
      const x = Math.floor((w * xi) / 6);
      const y = Math.floor((h * yi) / 6);
      const s = sample(x, y);
      const dr = s.r - bg.r, dg = s.g - bg.g, db = s.b - bg.b;
      if (Math.sqrt(dr * dr + dg * dg + db * db) > interiorFgMinDist) {
        if (s.r > 215 && s.g > 215 && s.b > 215) nearWhiteSubject++;
      }
    }
  }
  if (fgCount > 0 && nearWhiteSubject / fgCount > 0.6) return null;

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

  // Flood-fill from border pixels, marking bg-connected pixels.
  // Seeds come from (a) the four corners plus (b) every 10th pixel along all
  // four edges — catches bg regions that the corners alone miss (e.g. a
  // background that doesn't quite reach the very corner due to shadow/fringe).
  const bgConnected = new Uint8Array(N);
  const stack = [];
  const reachThreshold = tolerance + feather;

  const seed = (idx) => {
    if (!bgConnected[idx] && dist[idx] < reachThreshold) {
      bgConnected[idx] = 1;
      stack.push(idx);
    }
  };

  // Four corners
  seed(0); seed(w - 1); seed((h - 1) * w); seed(h * w - 1);
  // Top and bottom edges at 10-px intervals
  for (let x = 0; x < w; x += 10) { seed(x); seed((h - 1) * w + x); }
  // Left and right edges at 10-px intervals
  for (let y = 0; y < h; y += 10) { seed(y * w); seed(y * w + w - 1); }

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

  // 1-px morphological erosion of the opaque mask: any opaque pixel that
  // shares an edge with a transparent pixel is also made transparent. This
  // removes the 1-pixel fringe of semi-opaque bg-coloured pixels that
  // commonly forms at the boundary of flood-filled regions (JPEG artefacts,
  // soft shadows). Applied after fillHoles so holes don't errode the subject.
  const eroded = new Uint8Array(N); // 1 = candidate for erasure
  for (let i = 0; i < N; i++) {
    if (data[i * 4 + 3] === 0) continue; // already transparent
    const x = i % w;
    const y = (i - x) / w;
    if (
      (x > 0     && data[(i - 1) * 4 + 3] === 0) ||
      (x < w - 1 && data[(i + 1) * 4 + 3] === 0) ||
      (y > 0     && data[(i - w) * 4 + 3] === 0) ||
      (y < h - 1 && data[(i + w) * 4 + 3] === 0)
    ) {
      eroded[i] = 1;
    }
  }
  for (let i = 0; i < N; i++) {
    if (eroded[i]) data[i * 4 + 3] = 0;
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

// ---- Remove isolated opaque islands ----------------------------------------
// After BG removal a brand logo or stray pixel group can remain as a small
// disconnected opaque island. Strategy: BFS over opaque pixels, find all
// connected components, keep only those whose size is >= minFraction of the
// largest component (default 4%). Smaller components are erased.
// Safe default: 4% is conservative enough that a belt/sleeve that barely
// touches the body still survives, while a corner logo (typically <1%) gets
// removed.
export function removeSmallIslands(imgData, { minFraction = 0.04, alphaThreshold = 16 } = {}) {
  const { data, width: w, height: h } = imgData;
  const N = w * h;
  const visited = new Uint8Array(N);
  const components = []; // [{pixels: [idx, …]}]

  for (let start = 0; start < N; start++) {
    if (visited[start] || data[start * 4 + 3] < alphaThreshold) continue;

    // BFS — collect this component
    const pixels = [];
    const queue = [start];
    visited[start] = 1;
    while (queue.length) {
      const idx = queue.pop();
      pixels.push(idx);
      const x = idx % w;
      const y = (idx - x) / w;
      const neighbors = [
        x > 0     ? idx - 1 : -1,
        x < w - 1 ? idx + 1 : -1,
        y > 0     ? idx - w : -1,
        y < h - 1 ? idx + w : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && !visited[n] && data[n * 4 + 3] >= alphaThreshold) {
          visited[n] = 1;
          queue.push(n);
        }
      }
    }
    components.push(pixels);
  }

  if (components.length === 0) return;

  const maxSize = Math.max(...components.map((c) => c.length));
  const threshold = maxSize * minFraction;

  for (const pixels of components) {
    if (pixels.length < threshold) {
      for (const idx of pixels) data[idx * 4 + 3] = 0;
    }
  }
}

// ---- Fill bg-coloured holes left by ML (e.g. carpet through bag handle) ----
// The ML model sometimes leaves interior regions opaque when they share the
// same colour as the background (carpet through a bag handle). Strategy:
//   1. Detect bg colour from the ORIGINAL image edges (same as detectMonoBg).
//   2. In the ML cutout, flood-fill FROM every border-adjacent transparent
//      pixel inward through opaque pixels that are close to the bg colour.
//      These are genuine bg regions the model missed.
//   3. Make those pixels transparent.
// Only called when detectMonoBg returns a bg colour (i.e. there IS a uniform bg).
export function fillBgHolesInMlCutout(cutoutImg, bgColor, { tolerance = 22, feather = 8, alphaThreshold = 16 } = {}) {
  const w = cutoutImg.naturalWidth, h = cutoutImg.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(cutoutImg, 0, 0);
  const id = ctx.getImageData(0, 0, w, h);
  const data = id.data;
  const N = w * h;

  // Pre-compute distance to bg colour for every pixel.
  const dist = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const j = i * 4;
    const dr = data[j]     - bgColor.r;
    const dg = data[j + 1] - bgColor.g;
    const db = data[j + 2] - bgColor.b;
    dist[i] = Math.sqrt(dr * dr + dg * dg + db * db);
  }

  const reachThreshold = tolerance + feather;
  const bgConnected = new Uint8Array(N);
  const stack = [];

  // Seed from every transparent border pixel's opaque neighbours.
  const tryPush = (idx) => {
    if (!bgConnected[idx] && data[idx * 4 + 3] >= alphaThreshold && dist[idx] < reachThreshold) {
      bgConnected[idx] = 1;
      stack.push(idx);
    }
  };
  // Walk the border looking for transparent pixels, then push their neighbours.
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const i = y * w + x;
      if (data[i * 4 + 3] < alphaThreshold) { if (x > 0) tryPush(i - 1); if (x < w-1) tryPush(i + 1); if (y > 0) tryPush(i - w); if (y < h-1) tryPush(i + w); }
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      const i = y * w + x;
      if (data[i * 4 + 3] < alphaThreshold) { if (x > 0) tryPush(i - 1); if (x < w-1) tryPush(i + 1); if (y > 0) tryPush(i - w); if (y < h-1) tryPush(i + w); }
    }
  }

  while (stack.length) {
    const idx = stack.pop();
    const x = idx % w, y = (idx - x) / w;
    const ns = [x > 0 ? idx-1 : -1, x < w-1 ? idx+1 : -1, y > 0 ? idx-w : -1, y < h-1 ? idx+w : -1];
    for (const n of ns) {
      if (n >= 0 && !bgConnected[n] && data[n * 4 + 3] >= alphaThreshold && dist[n] < reachThreshold) {
        bgConnected[n] = 1;
        stack.push(n);
      }
    }
  }

  // Make bg-connected pixels transparent (with soft feather).
  for (let i = 0; i < N; i++) {
    if (!bgConnected[i]) continue;
    const dd = dist[i];
    if (dd < tolerance) {
      data[i * 4 + 3] = 0;
    } else {
      const t = (dd - tolerance) / feather;
      data[i * 4 + 3] = Math.min(data[i * 4 + 3], Math.round(255 * Math.min(1, Math.max(0, t))));
    }
  }

  ctx.putImageData(id, 0, 0);
  return c.toDataURL("image/png");
}

// ---- Gaussian feather on the alpha channel ---------------------------------
// Applies a separable 1D Gaussian blur (σ=0.8, radius 2) to the alpha channel
// only. Used after ML background removal to smooth jagged mask edges without
// blurring the RGB colour values.
function featherAlpha(img, sigma = 0.8) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, w, h);
  const data = id.data;

  // Build normalised 1D Gaussian kernel (radius = ceil(2σ)).
  const r = Math.ceil(2 * sigma);
  const kernel = [];
  let ksum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

  // Extract alpha into a float buffer.
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3];

  // Horizontal pass → tmp.
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = 0; k < kernel.length; k++) {
        const xi = Math.min(w - 1, Math.max(0, x + k - r));
        v += alpha[y * w + xi] * kernel[k];
      }
      tmp[y * w + x] = v;
    }
  }

  // Vertical pass → write back to data.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = 0; k < kernel.length; k++) {
        const yi = Math.min(h - 1, Math.max(0, y + k - r));
        v += tmp[yi * w + x] * kernel[k];
      }
      data[(y * w + x) * 4 + 3] = Math.round(Math.min(255, Math.max(0, v)));
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
  const tryMl   = bgMode === "auto" || bgMode === "ml";

  // Detect bg colour once — used by both mono and ml paths.
  const detectedBg = (tryMono || tryMl) ? detectMonoBg(img) : null;

  // 2. mono — fast corner flood-fill. Pre-check rejects same-coloured fg/bg.
  if (tryMono) {
    const bg = detectedBg;
    if (bg) {
      try {
        const dataUrl = removeMonoBg(img, bg, { fillHoles });
        const cutout = await loadImage(dataUrl);
        // Erase small disconnected opaque islands (e.g. a brand logo in the corner).
        const monoCanvas = document.createElement("canvas");
        monoCanvas.width = cutout.naturalWidth;
        monoCanvas.height = cutout.naturalHeight;
        const monoCtx = monoCanvas.getContext("2d", { willReadFrequently: true });
        monoCtx.drawImage(cutout, 0, 0);
        const monoId = monoCtx.getImageData(0, 0, monoCanvas.width, monoCanvas.height);
        removeSmallIslands(monoId);
        monoCtx.putImageData(monoId, 0, 0);
        const cleanMono = await loadImage(monoCanvas.toDataURL("image/png"));
        const trimmed = trimTransparent(cleanMono);
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
          // If the background is uniform, flood-fill bg-coloured opaque regions
          // that ML missed (e.g. carpet visible through a bag handle loop).
          const bgPatched = detectedBg
            ? await loadImage(fillBgHolesInMlCutout(cutout, detectedBg))
            : cutout;
          // Recover any interior holes the model punched into a solid subject
          // (e.g. a dark tattoo) before trimming away transparent borders.
          const closed = await loadImage(closeAlphaHoles(bgPatched, img));
          // Feather the alpha channel (1px Gaussian, σ=0.8) to smooth the
          // jagged pixel-level edges the ISNet model sometimes produces.
          const feathered = await loadImage(featherAlpha(closed));
          // Erase small disconnected opaque islands (e.g. a brand logo in the corner).
          const mlCanvas = document.createElement("canvas");
          mlCanvas.width = feathered.naturalWidth;
          mlCanvas.height = feathered.naturalHeight;
          const mlCtx = mlCanvas.getContext("2d", { willReadFrequently: true });
          mlCtx.drawImage(feathered, 0, 0);
          const mlId = mlCtx.getImageData(0, 0, mlCanvas.width, mlCanvas.height);
          removeSmallIslands(mlId);
          mlCtx.putImageData(mlId, 0, 0);
          const cleanMl = await loadImage(mlCanvas.toDataURL("image/png"));
          const trimmed = trimTransparent(cleanMl);
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
