# Neural Atlas

Neural Atlas is a custom center view for Obsidian that renders a slow, luminous
map with the browser's built-in Canvas 2D API. It has no runtime dependencies,
network requests, telemetry, remote fonts, or external assets.

It deliberately offers two different modes:

- **Synthetic recording-safe** is the default. It uses a fixed seed and six
  clearly labeled sample clusters: AI Projects, Learning Path, Research Memory,
  GitHub Work, Daily Signals, and Creator Studio. It does not query the vault.
- **Live metadata** uses only `Vault.getMarkdownFiles()` and already-cached
  paths, folders, resolved links, tags, and frontmatter from `MetadataCache`.
  It never calls `read()` or `cachedRead()` and never receives note bodies.

The mode disclosure and the bottom counts describe the graph currently on
screen. The particle field is a separate renderer-only type; its layered fibers
trace only existing semantic edges. Neither can be focused or included in note,
sample-anchor, link, or relation counts.

## Interaction

- Drag to pan and scroll to zoom.
- Hover a node to focus its local relationships.
- Double-click a live node to open that existing note in another leaf.
- Use the visible Mode, Motion, Labels, Fit, and Reset controls, or the matching
  command-palette commands.
- Click a node to isolate its cluster. With canvas keyboard focus, `C`/arrow
  keys cycle clusters and Escape restores the full atlas. `S` switches mode,
  `M` motion, `L` labels, `F` fits, and `R` resets. Enter opens a focused live
  note.

The plugin defaults to **not** opening on startup, so it never displaces normal
note work without an explicit choice. Settings can instead open the synthetic
showcase or live view at workspace startup. The system reduced-motion setting
always disables animation. Auto quality reduces particles, glow work, pixel
density, and frame rate on lower-power devices without hiding graph nodes or
changing the truthful counts.

Full quality uses 2,000 deterministic decorative particles and low-power
quality uses 560. Center-heavy Gaussian clouds form the luminous cluster mass,
with a smaller interstitial field. Full quality layers 456 fine visual strands
over the 36 truthful synthetic relations; low-power uses 120 strands. Every
strand resolves to an existing graph edge, so visual richness never invents
topology. Particles and strands remain renderer decoration rather than graph data.

## Architecture

- `src/model.ts` contains deterministic, pure graph construction, layout,
  counts, ambient generation, bounds, fit, and zoom math. It has no Obsidian or
  DOM dependency.
- `src/renderer.ts` owns only the scoped DOM and Canvas 2D presentation. It has
  no vault or network access.
- `src/main.ts` is the thin Obsidian host: custom `ItemView`, commands, settings,
  metadata snapshot, and existing-note open behavior.
- `test/model.test.mjs` tests the built pure-model bundle with Node's built-in
  test runner.

## Build and test

```bash
npm ci
npm test
npm run build
```

The production build creates `main.js`. For local evaluation, copy or symlink
this directory's `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/neural-atlas/`, then enable Neural Atlas. The source
directory name is an integration label; the deployed plugin folder matches the
manifest id, `neural-atlas`.

No install, build, or runtime step writes note content.
