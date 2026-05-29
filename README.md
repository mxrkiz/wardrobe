# wardrobe

Local outfit editor. Plain HTML + ES modules.

![preview](docs/preview.png)

## Run

Open `index.html` with **Live Server** in VS Code (or any static HTTP server).

## Stack

- Vanilla JS, ES modules, no build step
- [Konva](https://konvajs.org/) — canvas (via esm.sh)
- [@imgly/background-removal](https://github.com/imgly/background-removal-js) — ML cutout, lazy-loaded (via esm.sh)
- Custom flood-fill — fast cutout for product photos on uniform backgrounds
- IndexedDB — persistence

## Features

- Drop, paste (Ctrl+V) or pick image files
- Auto background removal: flood-fill for uniform BG, ML model for everything else
- Auto-placement along a vertical spine: hat → glasses → neck → outerwear → top·mid → top·base → bottoms → shoes
- 9 categories, free-text subcategories with autocomplete
- On-canvas resize/rotate handles + precise sliders + numeric inputs
- Half-clip (`◧ ■ ◨`) for layered looks
- Edit item meta: name, category, subcategory, tags, color
- In-canvas brush editor to manually erase regions
- PNG export
- All data lives in your browser's IndexedDB

## To-do

1. **Cross-session outfit sharing** — send/receive outfits between devices and browsers (file export/import or sync)
2. **GitHub Pages preview** — deploy a live demo via GitHub Pages
3. **Code clean-up** — Phase C tests, dead-code removal, coverage ≥ 80%
4. **Custom domain & hosting** — own domain, production deployment

## Background removal

Background removal runs automatically on upload using a two-stage cascade:

1. **Flood-fill** — instant, for photos on a uniform background (white seamless, grey studio, etc.)
2. **ML** (`@imgly` ISNet `medium`) — for real-world or non-uniform backgrounds

### Known limitations

| Case | Behaviour |
| --- | --- |
| White item on white background | ML cannot reliably distinguish subject from background. Use the brush editor to cut manually after upload. |
| Closed loops with same-colour background (e.g. carpet through a bag handle) | Automatic detection fails for textured backgrounds. Touch up with the brush editor. |

## Engineering decisions

### Vanilla JS, no build step

A bundler adds a mandatory compile step between "edit file" and "see result". For a single-developer tool that doesn't ship to a CDN, that round-trip is pure friction. ES module `import` is supported by every modern browser, esm.sh resolves and serves Konva and `@imgly/background-removal` as real ESM bundles, so there is nothing to bundle locally. The `package.json` exists only for the test runner (Vitest + Playwright); it has no effect on the app itself. Removing the build step also means no Webpack config, no `node_modules` in the runtime path, and no source-map confusion — the file you edit *is* the file the browser runs.

### Flood-fill first, ML second

`@imgly/background-removal` downloads a ~100 MB ONNX model on first use and takes several seconds per image. For the common case — a clothing photo shot on a white seamless or a solid studio background — a corner-seeded flood-fill is instantaneous, free, and produces a cleaner cutout than ISNet (no "halo" fringing). The cascade runs flood-fill first and only falls through to the ML model when the corner pixels disagree, i.e. the background is non-uniform. In practice this means the model is invoked maybe 20-30% of the time, which keeps the app fast for the majority of typical wardrobe photos without sacrificing quality for street shots and flats on real-world backgrounds.

### IndexedDB, no backend

Wardrobe is a personal tool. Sending images to a server would require authentication, storage costs, GDPR handling, and a backend to maintain. IndexedDB keeps everything on-device: images (stored as base64 data-URLs), outfit state, and categories all survive browser restarts without a network request. The trade-off is no cross-device sync, which is an accepted limitation listed in the to-do.

## Structure

```text
index.html        # shell + import map
style.css         # terminal-dark theme
js/
  main.js         # entry, file/url/paste IO
  state.js        # pub/sub state + IDB sync
  db.js           # IndexedDB wrapper
  bg.js           # @imgly loader (lazy, with fallback)
  imageOps.js     # mono-bg detect/fill + ML post-processing + trim
  categories.js   # 9 categories + spine layout + subcategories
  canvas.js       # Konva stage + Transformer + half-clip groups
  editor.js       # in-canvas brush eraser overlay
  ui/             # tree, inspector, layers, modal, chrome
```

## Keyboard

- `Delete` / `Backspace` — remove selected layer
- `Ctrl/Cmd+Z` — undo last brush stroke (in brush editor)
- `Esc` — close edit modal or brush editor

## License

AGPL-3.0
