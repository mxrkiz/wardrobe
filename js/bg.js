// Background removal — wraps @imgly/background-removal loaded via the ESM
// import map (esm.sh). Robust against the package failing to load: if the
// dynamic import or the model download fails, the app still works without
// background removal (original image is used as-is).

let removeFn = null;
let loadPromise = null;
let lastError = null;

export async function probeBgRemoval() {
  try {
    await ensureLoaded();
    return { ready: true };
  } catch (e) {
    return {
      ready: false,
      error: lastError ?? (e instanceof Error ? e.message : String(e)),
    };
  }
}

function ensureLoaded() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const mod = await import("@imgly/background-removal");
      removeFn = mod.removeBackground;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // reset so a retry is possible later
      loadPromise = null;
      throw e;
    }
  })();
  return loadPromise;
}

export async function removeBackground(blob) {
  await ensureLoaded();
  if (!removeFn) throw new Error("bg removal not loaded");
  return await removeFn(blob, {
    // isnet_fp16 = fastest. swap to 'isnet' for higher quality on cluttered
    // backgrounds (≈3× slower)
    model: "isnet_fp16",
    output: { format: "image/png" },
  });
}
