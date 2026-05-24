# wardrobe

Local outfit editor. Plain HTML + ES modules.

![preview](docs/preview.png)

## Run

Open `index.html` with **Live Server** in VS Code (or any static HTTP server).

## Stack

- Vanilla JS, ES modules
- [Konva](https://konvajs.org/) — canvas (via esm.sh)
- [@imgly/background-removal](https://github.com/imgly/background-removal-js) — ML cutout, lazy-loaded (via esm.sh)
- Custom flood-fill — fast cutout for product photos on uniform backgrounds
- IndexedDB — persistence

## Features

- Drop, paste (Ctrl+V) or pick image files
- Cutout cascade: `mono → ml → off` (configurable per-upload)
- Auto-placement along a vertical spine: hat → glasses → scarf → outerwear → top·mid → top·base → bottoms → shoes
- 9 categories, free-text subcategories with autocomplete
- On-canvas resize/rotate handles + precise sliders + numeric inputs
- Half-clip (`◧ ■ ◨`) for layered looks
- Edit item meta: name, category, subcategory, tags, color
- PNG export
- All data lives in your browser's IndexedDB

## Background removal

| Mode | When to use |
|---|---|
| `auto` (default) | Tries `mono` first; falls back to `ml` if the background isn't uniform or the foreground is bg-coloured |
| `mono only` | Force flood-fill — instant, no model download |
| `ml only` | Force @imgly ISNet — for non-uniform backgrounds |
| `off` | Keep original — when you've already cut the BG yourself |

## Structure

```
index.html        # shell + import map
style.css         # terminal-dark theme
js/
  main.js         # entry, file/url/paste IO
  state.js        # pub/sub state + IDB sync
  db.js           # IndexedDB wrapper
  bg.js           # @imgly loader (lazy, with fallback)
  imageOps.js     # mono-bg detect/fill + trim + dominant color
  categories.js   # 9 categories + spine layout + subcategories
  canvas.js       # Konva stage + Transformer + half-clip groups
  ui.js           # tree, inspector, layers, modal
```

## Keyboard

- `Delete` / `Backspace` — remove selected layer
- `Esc` — close edit modal

## Roadmap

- Saved outfits (named, browsable)
- Undo / redo
- Optional RMBG-1.4

## License

MIT
