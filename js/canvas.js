// Konva-based outfit canvas. Manages a single Stage with one Layer, plus a
// Transformer that attaches to whichever item is currently selected. Each
// wardrobe layer is wrapped in a Group so it can optionally clip to the
// left/right half of the canvas.

import Konva from "konva";

import { CATEGORIES, ALL_CATEGORIES } from "./categories.js";
import { getState, subscribe, update, updateLayer } from "./state.js";
import { rectsIntersect, isDarkColor } from "./util.js";

export const CANVAS_W = 640;
export const CANVAS_H = 960;
export const SPINE_X = CANVAS_W / 2;

const GRID_STEP = 40;        // dot-grid spacing (logical px)
const MARQUEE_MIN_PX = 3;    // ignore marquee drags smaller than this
const GRID_DOT_DARK = "rgba(230, 233, 238, 0.12)";  // dots on a dark canvas bg
const GRID_DOT_LIGHT = "rgba(13, 17, 23, 0.07)";    // dots on a light canvas bg

let stage = null;
let mainLayer = null;
let transformer = null;
let guideGroup = null;   // spine + slot ticks + dot grid; toggled by state.showGrid
let bgRect = null;       // canvas background plate; fill comes from state.canvasBg
let gridDotColor = GRID_DOT_LIGHT; // adapts to a light/dark canvasBg

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

// Track layers currently being dragged. syncLayers skips resetting x/y for
// any layer in this set so mid-drag state updates (storage refresh, etc.)
// don't snap the node back to its pre-drag position.
const draggingLayers = new Set();

// True while a canvas layer is being dragged. The window-level file-drop /
// paste handlers consult this so a layer drag is never mistaken for an
// attempt to upload a new item.
let layerDragActive = false;
export function isLayerDragging() {
  return layerDragActive;
}

// Marquee (desktop rubber-band multi-select) + group-drag bookkeeping.
let marqueeRect = null;     // Konva.Rect drawn while dragging on empty canvas
let marqueeStart = null;    // {x,y} in logical coords
let hasMarqueeMoved = false;
let isGroupDragging = false;      // moving a whole multi-selection at once
let dragAnchorStart = null; // dragged node's start pos during a group drag
const groupStart = new Map(); // layerId → {x,y} at group-drag start

export function initCanvas(hostEl) {
  stage = new Konva.Stage({
    container: hostEl,
    width: CANVAS_W,
    height: CANVAS_H,
  });
  mainLayer = new Konva.Layer();
  stage.add(mainLayer);

  // Chrome lets a <canvas> be dragged as a native image. Dragging a layer
  // would then start an OS image-drag that ends in a window "drop" with no
  // files — which the upload handler used to report as "No files detected".
  // Suppress the native drag entirely; Konva's own drag uses mouse events.
  hostEl.addEventListener("dragstart", (e) => e.preventDefault());

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
    const center = hostEl.parentElement || hostEl;
    const cs = getComputedStyle(center);
    const padX =
      parseFloat(cs.paddingLeft || 0) + parseFloat(cs.paddingRight || 0);
    const padY =
      parseFloat(cs.paddingTop || 0) + parseFloat(cs.paddingBottom || 0);
    // Width budget = center pane content box, capped to the logical canvas
    // width (≤640) for full quality. Height budget = the pane's height.
    const availW = Math.max(40, Math.min(CANVAS_W, center.clientWidth - padX));
    const availH = Math.max(120, center.clientHeight - padY);
    const scale = Math.min(availW / CANVAS_W, availH / CANVAS_H);
    const w = Math.round(CANVAS_W * scale);
    const h = Math.round(CANVAS_H * scale);
    // Size the HOST to exactly wrap the stage so its white plate never shows
    // as a rectangle beside a height-bound canvas (#1).
    hostEl.style.width = w + "px";
    hostEl.style.height = h + "px";
    stage.width(w);
    stage.height(h);
    stage.scale({ x: scale, y: scale });
    stage.batchDraw();
  };
  fitToHost();
  if ("ResizeObserver" in window && hostEl.parentElement) {
    // Observe the center pane only — deriving size from it (not the host)
    // avoids a feedback loop now that we set the host's own width/height.
    new ResizeObserver(fitToHost).observe(hostEl.parentElement);
  }
  window.addEventListener("resize", fitToHost);
  window.addEventListener("orientationchange", fitToHost);

  // Background plate — clean backdrop for export; colour from state.canvasBg.
  bgRect = new Konva.Rect({
    name: "bg",
    x: 0,
    y: 0,
    width: CANVAS_W,
    height: CANVAS_H,
    fill: "#ffffff",
    listening: false,
  });
  mainLayer.add(bgRect);

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
        const step = GRID_STEP;
        ctx.fillStyle = gridDotColor;
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
    anchorHitStroke: 35,  // larger hit area without changing visual size
    padding: 4,
    anchorStroke: "#3fb950",
    anchorFill: "#0d1117",
    anchorCornerRadius: 1,
    borderStroke: "#3fb950",
    borderStrokeWidth: 1,
    borderDash: [3, 3],
    rotateLineVisible: true,
  });
  mainLayer.add(transformer);

  // Show a rotation cursor when the mouse enters the rotate handle.
  // Uses mouseover (which bubbles from child anchors) so we can check target.
  transformer.on("mouseover", (e) => {
    if (e.target && typeof e.target.hasName === "function" && e.target.hasName("rotater")) {
      stage.container().style.cursor = "alias";
    }
  });
  transformer.on("mouseout", () => {
    stage.container().style.cursor = "default";
  });

  // ---- Marquee multi-select (desktop) -----------------------------------
  // Drag on the empty canvas to rubber-band a selection box; items inside it
  // get selected. A plain click on empty canvas clears the selection. On touch
  // we skip the marquee and just clear on an empty tap.
  const finishMarquee = () => {
    if (!marqueeStart) return;
    let box = null;
    if (marqueeRect) {
      box = {
        x: marqueeRect.x(),
        y: marqueeRect.y(),
        width: marqueeRect.width(),
        height: marqueeRect.height(),
      };
      marqueeRect.destroy();
      marqueeRect = null;
    }
    if (hasMarqueeMoved && box && (box.width > MARQUEE_MIN_PX || box.height > MARQUEE_MIN_PX)) {
      const hits = [];
      imageNodes.forEach((node, layerId) => {
        const r = node.getClientRect({ relativeTo: mainLayer });
        if (rectsIntersect(r, box)) hits.push(layerId);
      });
      update({ selectedLayerIds: hits });
    } else {
      update({ selectedLayerIds: [] });
    }
    marqueeStart = null;
    hasMarqueeMoved = false;
    mainLayer.batchDraw();
  };

  stage.on("mousedown", (e) => {
    if (e.target !== stage) return; // only when starting on empty canvas
    const pos = stage.getRelativePointerPosition();
    marqueeStart = pos;
    hasMarqueeMoved = false;
    marqueeRect = new Konva.Rect({
      name: "marquee",
      x: pos.x,
      y: pos.y,
      width: 0,
      height: 0,
      fill: "rgba(63, 185, 80, 0.08)",
      stroke: "#3fb950",
      strokeWidth: 1,
      dash: [4, 3],
      listening: false,
    });
    mainLayer.add(marqueeRect);
    marqueeRect.moveToTop();
  });
  stage.on("mousemove", () => {
    if (!marqueeStart || !marqueeRect) return;
    const pos = stage.getRelativePointerPosition();
    const x = Math.min(pos.x, marqueeStart.x);
    const y = Math.min(pos.y, marqueeStart.y);
    const w = Math.abs(pos.x - marqueeStart.x);
    const h = Math.abs(pos.y - marqueeStart.y);
    marqueeRect.setAttrs({ x, y, width: w, height: h });
    if (w > MARQUEE_MIN_PX || h > MARQUEE_MIN_PX) hasMarqueeMoved = true;
    mainLayer.batchDraw();
  });
  stage.on("mouseup", finishMarquee);
  // Release outside the canvas still finalises the marquee.
  window.addEventListener("mouseup", finishMarquee);
  // Touch: tap empty canvas → deselect.
  stage.on("touchstart", (e) => {
    if (e.target === stage) update({ selectedLayerIds: [] });
  });

  // Re-render layers whenever state changes.
  subscribe(syncLayers);
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

  // Canvas background plate + adaptive dot-grid colour.
  if (bgRect) bgRect.fill(st.canvasBg || "#ffffff");
  gridDotColor = isDarkColor(st.canvasBg) ? GRID_DOT_DARK : GRID_DOT_LIGHT;

  const { layers, items, selectedLayerIds } = st;
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
    if (!group || !imgNode) ({ group, imgNode } = createLayerNode(layer, img));
    applyLayerVisual(group, imgNode, layer, item, img);
  });

  // 4. Apply z-order (Konva: setZIndex relative to siblings in same parent).
  //    bg = 0, guideGroup = 1. Layer groups start at 2. Transformer is moved
  //    to top afterwards. With N layers the valid range is [0, N+2]; baseZ=2
  //    gives indices 2..N+1, which is always in range.
  //    (Previously baseZ = 2 + ALL_CATEGORIES.length, but guide slot markers
  //    are children of guideGroup, not mainLayer — so ALL_CATEGORIES.length
  //    was wrong and caused "setZIndex out of range" errors with few layers.)
  const baseZ = 2;
  sorted.forEach((layer, idx) => {
    const g = groupNodes.get(layer.id);
    if (g) g.setZIndex(baseZ + idx);
  });

  // 5. Transformer stays on top.
  transformer.moveToTop();

  // 6. Attach transformer to the selection (single = full handles; multi =
  //    bounding box only — move by drag, erase with Delete).
  attachTransformer(selectedLayerIds);

  // 7. Guides (spine / slots / dot grid) on/off.
  if (guideGroup) guideGroup.visible(st.showGrid !== false);

  mainLayer.batchDraw();
}

// Create the Konva group + image node for a layer and bind all of its
// pointer / drag / transform handlers. Registers into the node maps and
// returns the pair.
function createLayerNode(layer, img) {
  const group = new Konva.Group({ name: `layer-${layer.id}` });
  const imgNode = new Konva.Image({ image: img, draggable: true });
  group.add(imgNode);
  mainLayer.add(group);

  // events — select on press. Shift/Ctrl/Cmd toggles into a multi-select;
  // pressing an already-selected item keeps the group so it can be dragged.
  imgNode.on("mousedown touchstart", (e) => {
    const id = layer.id;
    const ev = e.evt || {};
    const isAdditive = ev.shiftKey || ev.metaKey || ev.ctrlKey;
    const cur = getState().selectedLayerIds || [];
    if (isAdditive) {
      update({
        selectedLayerIds: cur.includes(id)
          ? cur.filter((x) => x !== id)
          : [...cur, id],
      });
    } else if (!cur.includes(id)) {
      update({ selectedLayerIds: [id] });
    }
  });

  // double-click / double-tap → reset this layer's rotation to 0
  imgNode.on("dblclick dbltap", () => {
    updateLayer(layer.id, { rotation: 0 });
  });

  // ---- drag (single, or move the whole multi-selection together) ----
  imgNode.on("dragstart", () => {
    // Add this node to draggingLayers so syncLayers won't reset its x/y
    // if an unrelated state update (e.g. storage refresh) fires mid-drag.
    draggingLayers.add(layer.id);
    layerDragActive = true;
    const sel = getState().selectedLayerIds || [];
    isGroupDragging = sel.length > 1 && sel.includes(layer.id);
    groupStart.clear();
    if (isGroupDragging) {
      sel.forEach((id) => {
        draggingLayers.add(id); // protect all selected nodes
        const n = imageNodes.get(id);
        if (n) groupStart.set(id, { x: n.x(), y: n.y() });
      });
      dragAnchorStart = { x: imgNode.x(), y: imgNode.y() };
    }
  });
  imgNode.on("dragmove", () => {
    if (isGroupDragging && dragAnchorStart) {
      const dx = imgNode.x() - dragAnchorStart.x;
      const dy = imgNode.y() - dragAnchorStart.y;
      groupStart.forEach((p, id) => {
        if (id === layer.id) return;
        const n = imageNodes.get(id);
        if (n) {
          n.x(p.x + dx);
          n.y(p.y + dy);
        }
      });
      transformer.forceUpdate();
      mainLayer.batchDraw();
    }
    // live: notify the inspector. Don't write to state — we'd race with
    // syncLayers re-applying x/y on the very same frame.
    emitPreview(layer.id, { x: imgNode.x(), y: imgNode.y() });
  });
  imgNode.on("dragend", () => {
    // Clear dragging guards BEFORE update so syncLayers can write final
    // positions (update() calls syncLayers synchronously).
    draggingLayers.clear();
    layerDragActive = false;
    if (isGroupDragging && dragAnchorStart) {
      const dx = imgNode.x() - dragAnchorStart.x;
      const dy = imgNode.y() - dragAnchorStart.y;
      const st2 = getState();
      update({
        layers: st2.layers.map((l) => {
          const p = groupStart.get(l.id);
          return p ? { ...l, x: p.x + dx, y: p.y + dy } : l;
        }),
      });
      isGroupDragging = false;
      dragAnchorStart = null;
      groupStart.clear();
    } else {
      updateLayer(layer.id, { x: imgNode.x(), y: imgNode.y() });
    }
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
    // Store only the absolute scale magnitude — Konva's transient scaleX can go
    // negative if an anchor is dragged past the opposite side, but we never
    // mirror items, so the sign is discarded.
    transformingLayers.delete(layer.id);
    const sx = imgNode.scaleX();
    const cur = getState().layers.find((l) => l.id === layer.id);
    updateLayer(layer.id, {
      x: imgNode.x(),
      y: imgNode.y(),
      scale: Math.abs((cur ? cur.scale : layer.scale) * sx),
      rotation: imgNode.rotation(),
    });
    // reset Konva's transient scale — our state owns the truth
    imgNode.scaleX(1);
    imgNode.scaleY(1);
  });

  groupNodes.set(layer.id, group);
  imageNodes.set(layer.id, imgNode);
  return { group, imgNode };
}

// Apply state → node geometry / clip. Skips x/y while dragging, and all
// geometry while transforming, so Konva's transient values aren't fought.
function applyLayerVisual(group, imgNode, layer, item, img) {
  const w = item.width * layer.scale;
  const h = item.height * layer.scale;
  imgNode.image(img);
  if (!transformingLayers.has(layer.id)) {
    if (!draggingLayers.has(layer.id)) {
      imgNode.x(layer.x);
      imgNode.y(layer.y);
    }
    imgNode.width(w);
    imgNode.height(h);
    imgNode.offsetX(w / 2);
    imgNode.offsetY(h / 2);
    imgNode.rotation(layer.rotation);
    imgNode.scaleX(1);
    imgNode.scaleY(1);
  }
  imgNode.opacity(layer.opacity);
  imgNode.visible(!layer.hidden);

  // Half-clip via Group.clipFunc, at the item's own current x so the clip
  // follows the item when moved (imgNode.x() read dynamically each frame).
  if (layer.clip === "full") {
    group.clipFunc(null);
  } else {
    const isLeft = layer.clip === "left";
    group.clipFunc((ctx) => {
      const cx = imgNode.x();
      if (isLeft) ctx.rect(0, 0, cx, CANVAS_H);
      else ctx.rect(cx, 0, CANVAS_W - cx, CANVAS_H);
    });
  }
}

// Attach the transformer to the current selection. Single selection → full
// resize+rotate; multi → bounding box only (move by drag, delete via key).
function attachTransformer(selectedLayerIds) {
  const selNodes = (selectedLayerIds || [])
    .map((id) => imageNodes.get(id))
    .filter(Boolean);
  transformer.nodes(selNodes);
  const multi = selNodes.length > 1;
  transformer.resizeEnabled(!multi);
  transformer.rotateEnabled(!multi);
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
