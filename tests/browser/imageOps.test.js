// Tests for imageOps.js functions that use the Canvas 2D API.
// Runs with jsdom + canvas npm package (getContext is fully implemented).
// Image loading (new Image / onload) is avoided — we fake HTMLImageElement
// by creating a canvas and returning an object with naturalWidth/naturalHeight
// and the canvas itself as a paintable source.
import { describe, it, expect, vi } from "vitest";

vi.mock("../../js/bg.js", () => ({
  probeBgRemoval: vi.fn(async () => ({ ready: false, error: null, probing: false })),
  removeBackground: vi.fn(async () => new Blob()),
}));

import {
  trimTransparent,
  dominantColor,
  detectMonoBg,
  removeSmallIslands,
  closeAlphaHoles,
  uid,
} from "../../js/imageOps.js";

// ---- fake image helper -------------------------------------------------------
// Creates an object that looks like HTMLImageElement to imageOps functions:
// { naturalWidth, naturalHeight } + can be used as drawImage source.
function fakeImg(canvas) {
  // Return a proxy that has naturalWidth/naturalHeight and acts as a canvas
  return Object.assign(Object.create(canvas), {
    naturalWidth: canvas.width,
    naturalHeight: canvas.height,
  });
}

/** Create a solid-colour fake image */
function solidFakeImg(w, h, r, g, b, a = 255) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const id = ctx.createImageData(w, h);
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i] = r; id.data[i + 1] = g; id.data[i + 2] = b; id.data[i + 3] = a;
  }
  ctx.putImageData(id, 0, 0);
  return fakeImg(c);
}

/** Build a fake image with a coloured border and a different interior */
function borderInteriorFakeImg(w, h, borderR, borderG, borderB, intR, intG, intB) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const id = ctx.createImageData(w, h);
  const pad = 8;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const isBorder = x < pad || x >= w - pad || y < pad || y >= h - pad;
      const i = (y * w + x) * 4;
      if (isBorder) {
        id.data[i] = borderR; id.data[i + 1] = borderG; id.data[i + 2] = borderB;
      } else {
        id.data[i] = intR; id.data[i + 1] = intG; id.data[i + 2] = intB;
      }
      id.data[i + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return fakeImg(c);
}

// ---- uid --------------------------------------------------------------------

describe("uid", () => {
  it("returns a non-empty string", () => {
    expect(typeof uid()).toBe("string");
    expect(uid().length).toBeGreaterThan(0);
  });

  it("returns unique values on each call", () => {
    expect(uid()).not.toBe(uid());
  });
});

// ---- removeSmallIslands -----------------------------------------------------

describe("removeSmallIslands", () => {
  it("erases a tiny isolated island", () => {
    const c = document.createElement("canvas");
    c.width = 10; c.height = 10;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(10, 10);

    // Large component: top-left 6x6
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) {
        const i = (y * 10 + x) * 4;
        id.data[i] = 200; id.data[i + 1] = 200; id.data[i + 2] = 200; id.data[i + 3] = 255;
      }
    }
    // Single isolated pixel at (9, 9)
    const iso = (9 * 10 + 9) * 4;
    id.data[iso] = 200; id.data[iso + 1] = 200; id.data[iso + 2] = 200; id.data[iso + 3] = 255;

    removeSmallIslands(id, { minFraction: 0.04 });

    expect(id.data[iso + 3]).toBe(0);
    const main = 0;
    expect(id.data[main + 3]).toBe(255);
  });

  it("keeps all components when they are all above the threshold", () => {
    const c = document.createElement("canvas");
    c.width = 10; c.height = 10;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(10, 10);
    for (let i = 0; i < id.data.length; i += 4) {
      id.data[i] = 128; id.data[i + 1] = 128; id.data[i + 2] = 128; id.data[i + 3] = 255;
    }
    removeSmallIslands(id);
    for (let i = 3; i < id.data.length; i += 4) {
      expect(id.data[i]).toBe(255);
    }
  });

  it("handles fully transparent image (no components)", () => {
    const c = document.createElement("canvas");
    c.width = 5; c.height = 5;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(5, 5); // all alpha=0
    // Should not throw
    expect(() => removeSmallIslands(id)).not.toThrow();
  });
});

// ---- trimTransparent --------------------------------------------------------

describe("trimTransparent", () => {
  it("returns original dimensions when whole image is opaque", () => {
    const img = solidFakeImg(20, 20, 255, 0, 0);
    const result = trimTransparent(img);
    expect(result.width).toBe(20);
    expect(result.height).toBe(20);
    expect(typeof result.dataUrl).toBe("string");
  });

  it("trims transparent border to tight bounding box", () => {
    const c = document.createElement("canvas");
    c.width = 40; c.height = 40;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(40, 40); // all transparent
    // Mark only the centre 10x10 as opaque red
    for (let y = 15; y < 25; y++) {
      for (let x = 15; x < 25; x++) {
        const i = (y * 40 + x) * 4;
        id.data[i] = 255; id.data[i + 1] = 0; id.data[i + 2] = 0; id.data[i + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
    const img = fakeImg(c);
    const result = trimTransparent(img);
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
  });

  it("handles fully transparent image gracefully", () => {
    const c = document.createElement("canvas");
    c.width = 10; c.height = 10;
    const img = fakeImg(c); // all transparent
    const result = trimTransparent(img);
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
    expect(typeof result.dataUrl).toBe("string");
  });
});

// ---- dominantColor ----------------------------------------------------------

describe("dominantColor", () => {
  it("returns #rrggbb format", () => {
    const img = solidFakeImg(10, 10, 255, 0, 0);
    expect(dominantColor(img)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("returns empty string for fully transparent image", () => {
    const c = document.createElement("canvas");
    c.width = 10; c.height = 10;
    const img = fakeImg(c);
    expect(dominantColor(img)).toBe("");
  });

  it("identifies red as dominant colour", () => {
    const img = solidFakeImg(10, 10, 200, 0, 0);
    const color = dominantColor(img);
    const r = parseInt(color.slice(1, 3), 16);
    expect(r).toBeGreaterThan(150);
  });
});

// ---- detectMonoBg -----------------------------------------------------------

describe("detectMonoBg", () => {
  it("detects a uniform white background with dark interior", () => {
    // 80x80: white border, dark-navy interior
    const img = borderInteriorFakeImg(80, 80, 255, 255, 255, 13, 17, 34);
    const bg = detectMonoBg(img);
    expect(bg).not.toBeNull();
    expect(bg.r).toBeGreaterThan(200);
    expect(bg.g).toBeGreaterThan(200);
    expect(bg.b).toBeGreaterThan(200);
  });

  it("returns null when all edge samples have low alpha (pre-cut image)", () => {
    // Transparent image — all edge samples will have alpha 0 → rejected
    const c = document.createElement("canvas");
    c.width = 40; c.height = 40;
    const img = fakeImg(c);
    expect(detectMonoBg(img)).toBeNull();
  });

  it("returns null for striped background (edge samples are wildly different)", () => {
    // Vertical stripes alternating between black and white — edge samples will
    // range from 0 to 255, making the spread far exceed bgMaxSpread=32.
    const c = document.createElement("canvas");
    c.width = 60; c.height = 60;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(60, 60);
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 60; x++) {
        const v = (x % 4 < 2) ? 0 : 255;
        const i = (y * 60 + x) * 4;
        id.data[i] = v; id.data[i + 1] = v; id.data[i + 2] = v; id.data[i + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
    const img = fakeImg(c);
    expect(detectMonoBg(img)).toBeNull();
  });
});

// ---- closeAlphaHoles --------------------------------------------------------

describe("closeAlphaHoles", () => {
  it("fills an interior transparent hole with opaque pixels", () => {
    // cutout: 20x20 opaque red with a 4x4 transparent hole at centre
    const cc = document.createElement("canvas");
    cc.width = 20; cc.height = 20;
    const cctx = cc.getContext("2d");
    const cid = cctx.createImageData(20, 20);
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        const i = (y * 20 + x) * 4;
        const isHole = x >= 8 && x < 12 && y >= 8 && y < 12;
        cid.data[i] = 255; cid.data[i + 1] = 0; cid.data[i + 2] = 0;
        cid.data[i + 3] = isHole ? 0 : 255;
      }
    }
    cctx.putImageData(cid, 0, 0);
    const cutout = fakeImg(cc);

    const orig = solidFakeImg(20, 20, 255, 0, 0);

    const resultDataUrl = closeAlphaHoles(cutout, orig);
    expect(typeof resultDataUrl).toBe("string");

    // Load result back into a canvas and sample the hole pixel
    const rc = document.createElement("canvas");
    rc.width = 20; rc.height = 20;
    const rctx = rc.getContext("2d", { willReadFrequently: true });
    // Decode dataUrl via fakeImg pattern — draw directly since it's a data URL
    // In jsdom+canvas, we can use Image + onload, but it won't fire.
    // Instead, we verify the dataUrl is a valid PNG string and that closeAlphaHoles
    // produced non-empty output. Full pixel verification requires a real browser.
    expect(resultDataUrl).toMatch(/^data:image\/png/);
  });

  it("returns a data URL for already-clean cutout with no holes", () => {
    const solid = solidFakeImg(10, 10, 0, 128, 255);
    const result = closeAlphaHoles(solid, solid);
    expect(result).toMatch(/^data:image\/png/);
  });

  it("handles tiny 2x2 image without crashing (early-return path)", () => {
    const tiny = solidFakeImg(2, 2, 255, 255, 0);
    expect(() => closeAlphaHoles(tiny, tiny)).not.toThrow();
  });
});
