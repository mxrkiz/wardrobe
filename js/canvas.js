// Konva-based outfit canvas. Manages a single Stage with one Layer, plus a
// Transformer that attaches to whichever item is currently selected. Each
// wardrobe layer is wrapped in a Group so it can optionally clip to the
// left/right half of the canvas.

import Konva from "konva";

import { CATEGORIES, ALL_CATEGORIES } from "./categories.js";
import { getState, subscribe, update, updateLayer } from "./state.js";

export const CANVAS_W = 640;
export const CANVAS_H = 960;
export const SPINE_X = CANVAS_W / 2;

let stage = null;
let mainLayer = null;
let transformer = null;
let guideGroup = null;   // spine + slot ticks + dot grid; toggled by state.showGrid
const groupNodes = new Map();   // layerId → Konva.Group
const imageNodes = new Map();   // layerId → Konva.Image
const imageCache = new Map();   // itemId  → HTMLImageElement

// Live-preview channel — fires during drag / transform so the inspector can
// update its slider/number values in real time without going through state
// (state updates during the interaction would race with Konva's transient
// scaleX/scaleY/x/y and cause snapping). State is committed on dragend /
// transformend instead.
const livePreviewSubs = new Set();
export function subscribeLivePreview(fn) {
  livePreviewSubs.add(fn);
  return () => livePreviewSubs.delete(fn);
}
function emitPreview(layerId, props) {
  livePreviewSubs.forEach((fn) => fn(layerId, props));
}

// Track whether a layer is actively being transformed. syncLayers skips
// resetting that node's width/height/offset while a transform is in progress,
// so Konva's transient scaleX/scaleY isn't fought.
const transformingLayers = new Set();

export function initCanvas(hostEl) {
  stage = new Konva.Stage({
    container: hostEl,
    width: CANVAS_W,
    height: CANVAS_H,
  });
  mainLayer = new Konva.Layer();
  stage.add(mainLayer);

  // ---- Responsive scaling ------------------------------------------------
  // Logical coords stay in 640×960; we scale the stage to fit. Konva accounts
  // for stage.scale() in hit-testing, so drag / clicks / Transformer keep
  // working at every zoom level.
  //
  // Width comes from the host (CSS-capped to ≤640 logical px for full quality),
  // height from the center pane's actual content box. Taking the smaller ratio
  // makes the canvas as large as possible while fitting BOTH dimensions — so it
  // fills the space on desktop and never overflows the flex column on mobile.
  const fitToHost = () => {
    const hostW = hostEl.clientWidth;
    if (hostW < 40) return;
    const center = hostEl.parentElement || hostEl;
    const cs = getComputedStyle(center);
    const padY =
      parseFloat(cs.paddingTop || 0) + parseFloat(cs.paddingBottom || 0);
    const availH = Math.max(120, center.clientHeight - padY);
    const scale = Math.min(hostW / CANVAS_W, availH / CANVAS_H);
    stage.width(CANVAS_W * scale);
    stage.height(CANVAS_H * scale);
    stage.scale({ x: scale, y: scale });
    stage.batchDraw();
  };
  fitToHost();
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(fitToHost);
    ro.observe(hostEl);
    if (hostEl.parentElement) ro.observe(hostEl.parentElement);
  }
  window.addEventListener("resize", fitToHost);
  window.addEventListener("orientationchange", fitToHost);

  // White background — gives the export a clean plate.
  mainLayer.add(
    new Konva.Rect({
      name: "bg",
      x: 0,
      y: 0,
      width: CANVAS_W,
      height: CANVAS_H,
      fill: "#ffffff",
      listening: false,
    }),
  );

  // Guides: a faint dot grid + the central spine + per-category slot ticks.
  // All grouped so state.showGrid can toggle them together, and so the export
  // can hide them in one move. listening:false → never intercept clicks.
  guideGroup = new Konva.Group({ name: "guides", listening: false });
  mainLayer.add(guideGroup);

  // Dot grid every 40px — drawn once via a single Shape for performance.
  guideGroup.add(
    new Konva.Shape({
      name: "guide",
      listening: false,
      sceneFunc: (ctx) => {
        const step = 40;
        ctx.fillStyle = "rgba(13, 17, 23, 0.07)";
        for (let x = step; x < CANVAS_W; x += step) {
          for (let y = step; y < CANVAS_H; y += step) {
            ctx.beginPath();
            ctx.arc(x, y, 1.1, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      },
    }),
  );

  // Central spine (dashed).
  guideGroup.add(
    new Konva.Line({
      name: "guide",
      points: [SPINE_X, 0, SPINE_X, CANVAS_H],
      stroke: "#d8dde3",
      strokeWidth: 1,
      dash: [4, 6],
      listening: false,
    }),
  );

  // Slot markers — small ticks at each category's relY.
  ALL_CATEGORIES.forEach((cat) => {
    const y = CATEGORIES[cat].relY * CANVAS_H;
    guideGroup.add(
      new Konva.Line({
        name: "guide",
        points: [SPINE_X - 14, y, SPINE_X + 14, y],
        stroke: "#e2e6ec",
        strokeWidth: 1,
        listening: false,
      }),
    );
  });

  // Transformer for on-canvas resize/rotate.
  transformer = new Konva.Transformer({
    rotateAnchorOffset: 22,
    keepRatio: true,
    enabledAnchors: ["top-left", "top-right", "bottom-left", "bottom-right"],
    anchorSize: 8,
    anchorStroke: "#3fb950",
    anchorFill: "#0d1117",
    anchorCornerRadius: 1,
    borderStroke: "#3fb950",
    borderStrokeWidth: 1,
    borderDash: [3, 3],
    rotateLineVisible: true,
  });
  mainLayer.add(transformer);

  // Click empty area → deselect.
  stage.on("mousedown touchstart", (e) => {
    if (e.target === stage) update({ selectedLayerId: null });
  });

  // Re-render layers whenever state changes.
  subscribe(syncLayers);
}

// ---- Stage handle for export ----------------------------------------------
export function getStage() {
  return stage;
}

// ---- Sync layer state → Konva nodes ---------------------------------------

function ensureImage(item) {
  let img = imageCache.get(item.id);
  if (img) return img;
  img = new Image();
  img.src = item.cutoutDataUrl;
  imageCache.set(item.id, img);
  img.onload = () => {
    // Refresh nodes that referenced this item once the image is ready.
    let touched = false;
    imageNodes.forEach((node, layerId) => {
      const st = getState();
      const layer = st.layers.find((l) => l.id === layerId);
      if (!layer || layer.itemId !== item.id) return;
      node.image(img);
      touched = true;
    });
    if (touched) mainLayer?.batchDraw();
  };
  return img;
}

function syncLayers(st) {
  if (!mainLayer) return;
  const { layers, items, selectedLayerId } = st;
  const itemsById = new Map(items.map((i) => [i.id, i]));

  // 1. Remove nodes whose layers were deleted.
  for (const [id, group] of groupNodes.entries()) {
    if (!layers.find((l) => l.id === id)) {
      group.destroy();
      groupNodes.delete(id);
      imageNodes.delete(id);
    }
  }

  // 2. Sorted by zIndex (lower z draws first).
  const sorted = [...layers].sort((a, b) => a.zIndex - b.zIndex);

  // 3. Create / update.
  sorted.forEach((layer) => {
    const item = itemsById.get(layer.itemId);
    if (!item) return;
    const img = ensureImage(item);

    let group = groupNodes.get(layer.id);
    let imgNode = imageNodes.get(layer.id);

    if (!group || !imgNode) {
      group = new Konva.Group({ name: `layer-${layer.id}` });
      imgNode = new Konva.Image({
        image: img,
        draggable: true,
      });
      group.add(imgNode);
      mainLayer.add(group);

      // events
      imgNode.on("mousedown touchstart", () => {
        update({ selectedLayerId: layer.id });
      });

      // double-click / double-tap → reset this layer's rotation to 0
      imgNode.on("dblclick dbltap", () => {
        updateLayer(layer.id, { rotation: 0 });
      });

      // ---- drag ---------------------------------------------------------
      imgNode.on("dragmove", () => {
        // live: just notify the inspector. Don't write to state — we'd race
        // with syncLayers re-applying x/y on the very same frame.
        emitPreview(layer.id, { x: imgNode.x(), y: imgNode.y() });
      });
      imgNode.on("dragend", () => {
        updateLayer(layer.id, { x: imgNode.x(), y: imgNode.y() });
      });

      // ---- transform (resize + rotate handles) --------------------------
      imgNode.on("transformstart", () => {
        transformingLayers.add(layer.id);
      });
      imgNode.on("transform", () => {
        // Live preview: compute the effective scale (state.scale × Konva's
        // transient scaleX) and current rotation. keepRatio=true → sX === sY.
        const cur = getState().layers.find((l) => l.id === layer.id);
        const baseScale = cur ? cur.scale : layer.scale;
        emitPreview(layer.id, {
          x: imgNode.x(),
          y: imgNode.y(),
          scale: baseScale * imgNode.scaleX(),
          rotation: imgNode.rotation(),
        });
      });
      imgNode.on("transformend", () => {
        transformingLayers.delete(layer.id);
        const sx = imgNode.scaleX();
        const cur = getState().layers.find((l) => l.id === layer.id);
        updateLayer(layer.id, {
          x: imgNode.x(),
          y: imgNode.y(),
          scale: (cur ? cur.scale : layer.scale) * sx,
          rotation: imgNode.rotation(),
        });
        // reset Konva's transient scale — our state owns the truth
        imgNode.scaleX(1);
        imgNode.scaleY(1);
      });

      groupNodes.set(layer.id, group);
      imageNodes.set(layer.id, imgNode);
    }

    // Update visual props. While a transform is in progress we keep our hands
    // off geometry — Konva has a transient scaleX/scaleY in flight, and
    // overwriting width/height/offset/x/y/rotation would tug-of-war with it.
    const w = item.width * layer.scale;
    const h = item.height * layer.scale;
    imgNode.image(img);
    if (!transformingLayers.has(layer.id)) {
      imgNode.x(layer.x);
      imgNode.y(layer.y);
      imgNode.width(w);
      imgNode.height(h);
      imgNode.offsetX(w / 2);
      imgNode.offsetY(h / 2);
      imgNode.rotation(layer.rotation);
    }
    imgNode.opacity(layer.opacity);
    imgNode.visible(!layer.hidden);

    // Half-clip via Group.clipFunc.
    if (layer.clip === "full") {
      group.clipFunc(null);
    } else {
      const isLeft = layer.clip === "left";
      group.clipFunc((ctx) => {
        if (isLeft) ctx.rect(0, 0, SPINE_X, CANVAS_H);
        else ctx.rect(SPINE_X, 0, CANVAS_W - SPINE_X, CANVAS_H);
      });
    }
  });

  // 4. Apply z-order (Konva: setZIndex relative to siblings in same parent).
  //    bg = 0, guides start at 1. Layers start above them.
  const baseZ = 2 + ALL_CATEGORIES.length;
  sorted.forEach((layer, idx) => {
    const g = groupNodes.get(layer.id);
    if (g) g.setZIndex(baseZ + idx);
  });

  // 5. Transformer stays on top.
  transformer.moveToTop();

  // 6. Attach transformer to selected node (or detach).
  if (selectedLayerId) {
    const sel = imageNodes.get(selectedLayerId);
    if (sel) transformer.nodes([sel]);
    else transformer.nodes([]);
  } else {
    transformer.nodes([]);
  }

  // 7. Guides (spine / slots / dot grid) on/off.
  if (guideGroup) guideGroup.visible(st.showGrid !== false);

  mainLayer.batchDraw();
}

// ---- Export ---------------------------------------------------------------
export function exportPng() {
  if (!stage) return null;
  // Hide guides + transformer for the export, then restore prior visibility.
  const prevGuides = guideGroup ? guideGroup.visible() : true;
  if (guideGroup) guideGroup.visible(false);
  transformer.visible(false);
  const dataUrl = stage.toDataURL({ pixelRatio: 2 });
  if (guideGroup) guideGroup.visible(prevGuides);
  transformer.visible(true);
  mainLayer.batchDraw();
  return dataUrl;
}
