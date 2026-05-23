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
const groupNodes = new Map();   // layerId → Konva.Group
const imageNodes = new Map();   // layerId → Konva.Image
const imageCache = new Map();   // itemId  → HTMLImageElement

export function initCanvas(hostEl) {
  stage = new Konva.Stage({
    container: hostEl,
    width: CANVAS_W,
    height: CANVAS_H,
  });
  mainLayer = new Konva.Layer();
  stage.add(mainLayer);

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

  // Central spine (dashed).
  mainLayer.add(
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
    mainLayer.add(
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
      imgNode.on("dragend", () => {
        updateLayer(layer.id, { x: imgNode.x(), y: imgNode.y() });
      });
      imgNode.on("transformend", () => {
        // keepRatio=true means scaleX === scaleY
        const sx = imgNode.scaleX();
        const newScale = (groupNodes.get(layer.id) ? layer.scale : 1) * sx;
        // Read current layer from state (it may have moved between events).
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
        // suppress unused-var warning
        void newScale;
      });

      groupNodes.set(layer.id, group);
      imageNodes.set(layer.id, imgNode);
    }

    // Update visual props.
    const w = item.width * layer.scale;
    const h = item.height * layer.scale;
    imgNode.image(img);
    imgNode.x(layer.x);
    imgNode.y(layer.y);
    imgNode.width(w);
    imgNode.height(h);
    imgNode.offsetX(w / 2);
    imgNode.offsetY(h / 2);
    imgNode.rotation(layer.rotation);
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

  mainLayer.batchDraw();
}

// ---- Export ---------------------------------------------------------------
export function exportPng() {
  if (!stage) return null;
  // Hide guides + transformer for the export.
  const guides = stage.find(".guide");
  guides.forEach((n) => n.visible(false));
  transformer.visible(false);
  const dataUrl = stage.toDataURL({ pixelRatio: 2 });
  guides.forEach((n) => n.visible(true));
  transformer.visible(true);
  mainLayer.batchDraw();
  return dataUrl;
}
