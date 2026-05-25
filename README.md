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

MIT
