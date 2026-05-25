// In-canvas image editor overlay.
// Opens a floating canvas over the canvas-host where the user can paint out
// regions (logos, backgrounds) with a circular destination-out brush.
// "done" exports the result; "cancel" discards without saving.

const DEFAULT_BRUSH_PX = 20;
const MAX_HISTORY = 20;

export function openEditor(layerId, dataUrl, { onDone, onCancel }) {
  const img = new Image();
  img.onload = () => _mount(img, { onDone, onCancel });
  img.onerror = () => {
    console.error("editor: failed to load image for editing");
    onCancel();
  };
  img.src = dataUrl;
}

function _mount(img, { onDone, onCancel }) {
  const host = document.getElementById("canvas-host");
  if (!host) return;
  const rect = host.getBoundingClientRect();

  // ---- overlay container (fixed, covers the canvas-host) ----
  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed",
    `left:${rect.left}px`,
    `top:${rect.top}px`,
    `width:${rect.width}px`,
    `height:${rect.height}px`,
    "z-index:200",
    "display:flex",
    "flex-direction:column",
    "background:rgba(1,4,9,0.9)",
    "font-family:var(--font-mono)",
    // pinch-zoom: let the browser handle 2-finger pinch natively for zoom;
    // single-finger touch events are ignored in drawing handlers below.
    "touch-action:pinch-zoom",
    "user-select:none",
  ].join(";");

  // ---- editable canvas ----
  const canvas = document.createElement("canvas");
  canvas.width  = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const padding = 48; // reserve for toolbar
  const sf = Math.min(
    (rect.width  - 16) / img.naturalWidth,
    (rect.height - padding - 16) / img.naturalHeight,
    1,
  );
  const dw = Math.round(img.naturalWidth  * sf);
  const dh = Math.round(img.naturalHeight * sf);
  canvas.style.cssText = [
    "flex:0 0 auto",
    `width:${dw}px`,
    `height:${dh}px`,
    "margin:auto auto 0",
    // Hide the native cursor — the brush ring (with its own centre dot) IS the
    // cursor, so there's no second crosshair to drift out of alignment with it.
    "cursor:none",
    // checkerboard backdrop so transparency is visible
    "background:repeating-conic-gradient(#444 0% 25%,#222 0% 50%) 0 0/16px 16px",
    "box-shadow:0 0 0 1px #30363d",
    "touch-action:pinch-zoom",
  ].join(";");

  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  // ---- toolbar ----
  const bar = document.createElement("div");
  bar.style.cssText = [
    "flex:0 0 auto",
    "display:flex",
    "align-items:center",
    "gap:10px",
    "padding:8px 12px",
    "background:rgba(13,17,23,0.95)",
    "border-top:1px solid #21262d",
    "font-size:12px",
    "color:#8b949e",
  ].join(";");
  bar.innerHTML = `
    <span>brush</span>
    <input type="range" id="_eb_sz" min="4" max="100" value="${DEFAULT_BRUSH_PX}"
           style="width:80px;accent-color:#3fb950">
    <span id="_eb_v" style="min-width:24px">${DEFAULT_BRUSH_PX}</span><span>px</span>
    <span style="flex:1"></span>
    <button id="_eb_undo" disabled
      style="font-family:var(--font-mono);font-size:12px;padding:4px 10px">
      undo
    </button>
    <button id="_eb_cancel"
      style="font-family:var(--font-mono);font-size:12px;padding:4px 10px">
      cancel
    </button>
    <button id="_eb_done"
      style="font-family:var(--font-mono);font-size:12px;padding:4px 10px;
             background:#238636;border:1px solid #2ea043;color:#fff;border-radius:4px">
      done
    </button>
  `;

  // Ring cursor showing the current brush radius. Lives above the canvas and
  // never intercepts pointer events itself.
  const ring = document.createElement("div");
  ring.style.cssText = [
    "position:fixed",
    "box-sizing:border-box",
    "border:1.5px solid #3fb950",
    "box-shadow:0 0 0 1px rgba(1,4,9,0.6)",
    "border-radius:50%",
    "pointer-events:none",
    "transform:translate(-50%,-50%)",
    // A 3px dot marks the exact centre = where the erase actually lands.
    "background:radial-gradient(circle at center,#3fb950 0 1.5px,transparent 1.6px)",
    "display:none",
    "z-index:201",
  ].join(";");

  overlay.appendChild(canvas);
  overlay.appendChild(bar);
  document.body.appendChild(overlay);
  document.body.appendChild(ring);

  // ---- brush state ----
  let brushR     = DEFAULT_BRUSH_PX;
  let isPainting = false;

  // ---- undo history ----
  const history = [];
  const undoBtn = bar.querySelector("#_eb_undo");

  const pushHistory = () => {
    history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (history.length > MAX_HISTORY) history.shift();
    undoBtn.disabled = false;
  };

  const undo = () => {
    if (!history.length) return;
    ctx.putImageData(history.pop(), 0, 0);
    undoBtn.disabled = history.length === 0;
  };

  undoBtn.addEventListener("click", undo);

  bar.querySelector("#_eb_sz").addEventListener("input", (e) => {
    brushR = parseInt(e.target.value, 10);
    bar.querySelector("#_eb_v").textContent = brushR;
  });

  const toCanvas = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width)  * canvas.width,
      y: ((clientY - r.top)  / r.height) * canvas.height,
    };
  };

  const erase = (clientX, clientY, radius) => {
    const { x, y } = toCanvas(clientX, clientY);
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // Move the ring to the pointer and size it to the on-screen brush radius.
  const showRing = (clientX, clientY, radius) => {
    const r = canvas.getBoundingClientRect();
    const dispScale = r.width / canvas.width; // canvas px → screen px
    const d = 2 * radius * dispScale;
    ring.style.left = clientX + "px";
    ring.style.top = clientY + "px";
    ring.style.width = d + "px";
    ring.style.height = d + "px";
    ring.style.display = "block";
  };

  // ---- pointer input (unifies mouse, touch, and pen) ----
  overlay.addEventListener("selectstart", (e) => e.preventDefault());

  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return; // fingers zoom, not draw
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    pushHistory();
    isPainting = true;
    erase(e.clientX, e.clientY, brushR);
    showRing(e.clientX, e.clientY, brushR);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    e.preventDefault();
    showRing(e.clientX, e.clientY, brushR);
    if (isPainting) erase(e.clientX, e.clientY, brushR);
  });
  const endStroke = () => { isPainting = false; };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  // Hide ring on leave but keep isPainting — on iPad, pointerleave can fire
  // mid-stroke when Pencil briefly hovers; ending the stroke here breaks continuity.
  canvas.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "touch") return; // ignore touch leave events
    ring.style.display = "none";
  });
  // Restore ring when Pencil/mouse re-enters after a pinch-zoom gesture.
  canvas.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "touch") return;
    showRing(e.clientX, e.clientY, brushR);
  });
  // Releasing the pointer outside the canvas still ends the stroke.
  window.addEventListener("pointerup", endStroke);

  // ---- button actions ----
  const cleanup = () => {
    window.removeEventListener("pointerup", endStroke);
    document.removeEventListener("keydown", onKey);
    ring.remove();
    overlay.remove();
  };

  bar.querySelector("#_eb_done").addEventListener("click", () => {
    const newDataUrl = canvas.toDataURL("image/png");
    cleanup();
    onDone(newDataUrl);
  });
  bar.querySelector("#_eb_cancel").addEventListener("click", () => {
    cleanup();
    onCancel();
  });

  const onKey = (e) => {
    if (e.key === "Escape") { cleanup(); onCancel(); return; }
    if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      undo();
    }
  };
  document.addEventListener("keydown", onKey);
}
