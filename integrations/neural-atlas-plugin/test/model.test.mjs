import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  FULL_DECORATIVE_PARTICLE_COUNT,
  FULL_SYNTHETIC_FIBER_COUNT,
  LOW_POWER_DECORATIVE_PARTICLE_COUNT,
  LOW_POWER_SYNTHETIC_FIBER_COUNT,
  SYNTHETIC_CLUSTER_NAMES,
  buildAmbientFibers,
  buildAmbientParticles,
  buildLiveGraph,
  buildSyntheticGraph,
  composeGraphForViewport,
  fitTransform,
  graphBounds,
  summarizeGraph,
  zoomAround,
} from "./.model.mjs";

test("the recording-safe graph is deterministic and contains only the six named sample clusters", () => {
  const first = buildSyntheticGraph();
  const second = buildSyntheticGraph();

  assert.deepEqual(first, second);
  assert.equal(first.mode, "synthetic");
  assert.deepEqual(
    first.clusters.map((cluster) => cluster.label),
    [...SYNTHETIC_CLUSTER_NAMES],
  );
  assert.equal(first.nodes.length, 36);
  assert.equal(new Set(first.nodes.map((node) => node.id)).size, 36);
  assert.ok(first.nodes.every((node) => node.kind === "note-node"));
  assert.ok(first.nodes.every((node) => !Object.hasOwn(node, "path")));
});

test("a seed changes positions, not the synthetic identities or truthful counts", () => {
  const first = buildSyntheticGraph("seed-one");
  const second = buildSyntheticGraph("seed-two");

  assert.deepEqual(
    first.nodes.map((node) => node.id),
    second.nodes.map((node) => node.id),
  );
  assert.notDeepEqual(
    first.nodes.map((node) => [node.x, node.y]),
    second.nodes.map((node) => [node.x, node.y]),
  );
  assert.deepEqual(summarizeGraph(first), {
    primaryCount: 36,
    primaryLabel: "sample anchors",
    relationCount: first.edges.length,
    clusterCount: 6,
    linkCount: 0,
    tagRelationCount: 0,
  });
});

test("ambient cloud particles are dense, separate, deterministic, and never counted as notes", () => {
  const graph = buildSyntheticGraph();
  const before = summarizeGraph(graph);
  const full = buildAmbientParticles(graph, false);
  const low = buildAmbientParticles(graph, true);

  assert.equal(full.length, FULL_DECORATIVE_PARTICLE_COUNT);
  assert.equal(low.length, LOW_POWER_DECORATIVE_PARTICLE_COUNT);
  assert.ok(full.length >= 1200 && full.length <= 2000);
  assert.ok(low.length < full.length * 0.35);
  assert.deepEqual(full, buildAmbientParticles(graph, false));
  assert.ok(full.every((particle) => particle.kind === "ambient-particle"));
  assert.ok(full.every((particle) => particle.radius > 0 && particle.radius <= 2));
  assert.ok(full.every((particle) => particle.alpha > 0 && particle.alpha <= 0.94));
  assert.ok(full.every((particle) => Number.isFinite(particle.x) && Number.isFinite(particle.y)));
  const owned = full.filter((particle) => particle.clusterId !== null);
  assert.ok(owned.length >= full.length * 0.96 && owned.length <= full.length * 0.98);
  assert.deepEqual(new Set(owned.map((particle) => particle.tier)), new Set(["core", "halo", "filament"]));
  const clusterIds = new Set(graph.clusters.map((cluster) => cluster.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  assert.ok(owned.every((particle) => clusterIds.has(particle.clusterId)));
  assert.ok(
    owned
      .filter((particle) => particle.tier === "filament")
      .every((particle) => particle.edgeId && edgeIds.has(particle.edgeId)),
    "every filament particle must decorate a real semantic edge",
  );
  for (const cluster of graph.clusters) {
    const local = owned.filter((particle) => particle.clusterId === cluster.id);
    const core = local.filter((particle) => particle.tier === "core");
    assert.ok(
      Math.abs(local.length - owned.length / graph.clusters.length) <= 1,
      `${cluster.label} should receive an equal decorative quota`,
    );
    assert.ok(
      core.filter((particle) => Math.hypot(particle.x - cluster.x, particle.y - cluster.y) <= 88)
        .length >= core.length * 0.3,
      `${cluster.label} should have a filled luminous center`,
    );
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  assert.ok(full.every((particle) => !nodeIds.has(particle.id)));
  assert.deepEqual(summarizeGraph(graph), before);
});

test("fiber layers are deterministic renderings of real semantic edges, never invented topology", () => {
  const graph = buildSyntheticGraph();
  const full = buildAmbientFibers(graph, false);
  const low = buildAmbientFibers(graph, true);
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));

  assert.equal(full.length, FULL_SYNTHETIC_FIBER_COUNT);
  assert.equal(low.length, LOW_POWER_SYNTHETIC_FIBER_COUNT);
  assert.deepEqual(full, buildAmbientFibers(graph, false));
  assert.deepEqual(new Set(full.map((fiber) => fiber.edgeId)), edgeIds);
  assert.deepEqual(new Set(low.map((fiber) => fiber.edgeId)), edgeIds);
  assert.ok(full.every((fiber) => fiber.kind === "ambient-fiber"));
  assert.ok(full.every((fiber) => edgeIds.has(fiber.edgeId)));
  assert.ok(full.every((fiber) => fiber.width >= 0.36 && fiber.width <= 0.78));
  assert.ok(
    full.every((fiber) =>
      [
        fiber.startX,
        fiber.startY,
        fiber.controlX,
        fiber.controlY,
        fiber.endX,
        fiber.endY,
      ].every(Number.isFinite),
    ),
  );
  for (const fiber of full) {
    const edge = edgeById.get(fiber.edgeId);
    const source = edge && nodeById.get(edge.source);
    const target = edge && nodeById.get(edge.target);
    assert.ok(source && target);
    assert.ok(Math.hypot(fiber.startX - source.x, fiber.startY - source.y) < 8);
    assert.ok(Math.hypot(fiber.endX - target.x, fiber.endY - target.y) < 8);
  }
  for (const cluster of graph.clusters) {
    const localEdges = graph.edges.filter((edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      return source?.clusterId === cluster.id && target?.clusterId === cluster.id;
    });
    const localDegrees = new Map(cluster.nodeIds.map((id) => [id, 0]));
    for (const edge of localEdges) {
      localDegrees.set(edge.source, (localDegrees.get(edge.source) ?? 0) + 1);
      localDegrees.set(edge.target, (localDegrees.get(edge.target) ?? 0) + 1);
    }
    assert.equal(localEdges.length, 5);
    assert.ok(
      [...localDegrees.values()].every((degree) => degree <= 2),
      `${cluster.label} should remain a winding path, not a radial starburst`,
    );
  }
  assert.deepEqual(summarizeGraph(graph), {
    primaryCount: 36,
    primaryLabel: "sample anchors",
    relationCount: 36,
    clusterCount: 6,
    linkCount: 0,
    tagRelationCount: 0,
  });
});

const LIVE_INPUT = [
  {
    path: "Root.md",
    basename: "Root",
    folder: "",
    links: [],
    tags: ["#home"],
    frontmatter: { type: "index" },
  },
  {
    path: "Research/Alpha.md",
    basename: "Alpha",
    folder: "Research",
    links: ["Research/Beta.md", "Missing.md"],
    tags: ["#research", "#shared"],
    frontmatter: { title: "Alpha evidence", type: "paper" },
  },
  {
    path: "Research/Beta.md",
    basename: "Beta",
    folder: "Research",
    links: ["Research/Alpha.md"],
    tags: ["shared", "#research"],
    frontmatter: {},
  },
  {
    path: "Journal/Today.md",
    basename: "Today",
    folder: "Journal",
    links: [],
    tags: ["#daily"],
    frontmatter: { tags: "signal, current" },
  },
  // A duplicate cache entry cannot inflate the live note count.
  {
    path: "Research/Alpha.md",
    basename: "Duplicate",
    folder: "Other",
    links: [],
  },
];

test("live graph uses only supplied metadata, deduplicates notes, and ignores unresolved links", () => {
  const graph = buildLiveGraph(LIVE_INPUT);
  const summary = summarizeGraph(graph);

  assert.equal(graph.mode, "live");
  assert.equal(graph.nodes.length, 4);
  assert.equal(summary.primaryCount, 4);
  assert.equal(summary.primaryLabel, "notes");
  assert.equal(summary.linkCount, 1, "reciprocal cached links are one visible link");
  assert.equal(summary.tagRelationCount, 1, "the shared tag adds one semantic relation");
  assert.equal(summary.relationCount, 1, "literal links are not relabeled as other relations");
  assert.equal(graph.nodes.some((node) => node.path === "Missing.md"), false);
  assert.deepEqual(
    graph.clusters.map((cluster) => cluster.label).sort(),
    ["Journal", "Research", "Vault root"],
  );

  const alpha = graph.nodes.find((node) => node.path === "Research/Alpha.md");
  const today = graph.nodes.find((node) => node.path === "Journal/Today.md");
  assert.equal(alpha?.title, "Alpha evidence");
  assert.equal(alpha?.accent, "cyan");
  assert.deepEqual(alpha?.tags, ["research", "shared"]);
  assert.equal(today?.accent, "amber");
  assert.deepEqual(today?.tags, ["current", "daily", "signal"]);
});

test("live construction is order-independent and label selection stays sparse", () => {
  const forward = buildLiveGraph(LIVE_INPUT);
  const reverse = buildLiveGraph([...LIVE_INPUT].reverse());
  assert.deepEqual(forward, reverse);
  assert.ok(forward.nodes.filter((node) => node.labelVisible).length <= 24);
  assert.ok(
    forward.clusters.every((cluster) =>
      cluster.nodeIds.some(
        (id) => forward.nodes.find((node) => node.id === id)?.labelVisible,
      ),
    ),
  );
});

test("portrait composition is a deterministic reflow rather than a scaled desktop field", () => {
  const graph = buildSyntheticGraph();
  assert.equal(composeGraphForViewport(graph, 1200, 760), graph);

  const portrait = composeGraphForViewport(graph, 520, 900);
  const portraitAgain = composeGraphForViewport(graph, 520, 900);
  assert.notEqual(portrait, graph);
  assert.deepEqual(portrait, portraitAgain);
  assert.deepEqual(
    portrait.nodes.map((node) => node.id),
    graph.nodes.map((node) => node.id),
  );
  assert.equal(summarizeGraph(portrait).primaryCount, 36);
  assert.deepEqual(
    portrait.clusters.map((cluster) => [cluster.x, cluster.y]),
    [
      [-100, -300],
      [100, -220],
      [-105, -60],
      [105, 20],
      [-90, 180],
      [90, 260],
    ],
  );
  assert.ok(graph.clusters.some((cluster, index) => cluster.y !== portrait.clusters[index].y));

  const narrow = composeGraphForViewport(graph, 390, 840);
  assert.deepEqual(
    narrow.clusters.map((cluster) => [cluster.x, cluster.y]),
    [
      [-100, -300],
      [100, -220],
      [-105, -60],
      [105, 20],
      [-90, 180],
      [90, 260],
    ],
  );
  assert.deepEqual(graph, buildSyntheticGraph(), "portrait composition mutated the source graph");
});

test("fit math honors asymmetric HUD insets in desktop and portrait viewports", () => {
  const desktopGraph = buildSyntheticGraph();
  const desktopBounds = graphBounds(desktopGraph);
  const desktopInsets = { top: 88, right: 48, bottom: 58, left: 48 };
  const desktop = fitTransform(desktopBounds, 1280, 760, desktopInsets);

  assert.ok(desktop.zoom > 0);
  assert.ok(desktopBounds.minX * desktop.zoom + desktop.x >= desktopInsets.left - 0.001);
  assert.ok(desktopBounds.maxX * desktop.zoom + desktop.x <= 1280 - desktopInsets.right + 0.001);
  assert.ok(desktopBounds.minY * desktop.zoom + desktop.y >= desktopInsets.top - 0.001);
  assert.ok(desktopBounds.maxY * desktop.zoom + desktop.y <= 760 - desktopInsets.bottom + 0.001);

  const portraitGraph = composeGraphForViewport(desktopGraph, 390, 840);
  const portraitBounds = graphBounds(portraitGraph);
  const portraitInsets = { top: 116, right: 26, bottom: 78, left: 26 };
  const portrait = fitTransform(portraitBounds, 390, 840, portraitInsets);
  assert.ok(portraitBounds.minY * portrait.zoom + portrait.y >= portraitInsets.top - 0.001);
  assert.ok(portraitBounds.maxY * portrait.zoom + portrait.y <= 840 - portraitInsets.bottom + 0.001);
});

test("zoomAround preserves the world point under the cursor and clamps extremes", () => {
  const initial = { x: 100, y: 80, zoom: 1 };
  const cursor = { x: 360, y: 280 };
  const worldBefore = {
    x: (cursor.x - initial.x) / initial.zoom,
    y: (cursor.y - initial.y) / initial.zoom,
  };
  const zoomed = zoomAround(initial, cursor.x, cursor.y, 1.8);
  assert.ok(Math.abs((cursor.x - zoomed.x) / zoomed.zoom - worldBefore.x) < 1e-9);
  assert.ok(Math.abs((cursor.y - zoomed.y) / zoomed.zoom - worldBefore.y) < 1e-9);
  assert.equal(zoomAround(initial, 0, 0, 1e9).zoom, 3.2);
  assert.equal(zoomAround(initial, 0, 0, 1e-9).zoom, 0.22);
});

test("empty live metadata produces an honest zero-state", () => {
  assert.deepEqual(summarizeGraph(buildLiveGraph([])), {
    primaryCount: 0,
    primaryLabel: "notes",
    relationCount: 0,
    clusterCount: 0,
    linkCount: 0,
    tagRelationCount: 0,
  });
});

test("the shipped host stays metadata-only and the UI has no runtime network or external assets", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../src/renderer.ts", import.meta.url), "utf8");
  const model = readFileSync(new URL("../src/model.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

  assert.doesNotMatch(main, /\.vault\.(?:read|cachedRead|modify|create|delete|process)\s*\(/);
  assert.doesNotMatch(`${main}\n${renderer}`, /\b(?:fetch|XMLHttpRequest|WebSocket|requestUrl)\s*\(/);
  assert.doesNotMatch(styles, /@import|url\s*\(/i);
  assert.doesNotMatch(model, /from\s+["']obsidian["']/);
  assert.match(main, /getMarkdownFiles\(\)/);
  assert.match(main, /metadataCache\.resolvedLinks/);
  assert.match(main, /metadataCache\.getFileCache/);
});

test("recording-safe mode is applied before a view can reveal or persist", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../src/renderer.ts", import.meta.url), "utf8");

  assert.match(main, /const SAFE_INITIAL_MODE: AtlasMode = "synthetic"/);
  assert.match(main, /this\.mode = SAFE_INITIAL_MODE/);
  assert.match(
    main,
    /id: "toggle-recording-safe",[\s\S]*?callback: \(\) => void this\.openAtlas\("synthetic"\)/,
  );

  const openAtlas = main.slice(
    main.indexOf("  async openAtlas("),
    main.indexOf("  private async withAtlas("),
  );
  assert.ok(
    openAtlas.indexOf("await leaf.view.setMode(mode)") <
      openAtlas.indexOf("await workspace.revealLeaf(leaf)"),
    "the requested mode must be applied before the leaf is revealed",
  );

  const setMode = main.slice(
    main.indexOf("  async setMode("),
    main.indexOf("  async toggleMode("),
  );
  assert.ok(
    setMode.indexOf("this.renderer?.setGraph(this.buildGraph())") <
      setMode.indexOf("await this.plugin.setLastMode(mode)"),
    "the visible graph must be scrubbed before mode persistence",
  );

  const replaceGraph = renderer.slice(
    renderer.indexOf("  setGraph("),
    renderer.indexOf("  setPreferences("),
  );
  assert.match(
    replaceGraph,
    /this\.canvas\.setAttribute\("aria-label", DEFAULT_CANVAS_ARIA_LABEL\)/,
    "graph replacement must synchronously clear any live title/path from the ARIA label",
  );
  assert.ok(
    replaceGraph.indexOf('this.canvas.setAttribute("aria-label", DEFAULT_CANVAS_ARIA_LABEL)') <
      replaceGraph.indexOf("this.updateHud()"),
    "ARIA state must be generic before replacement HUD state is exposed",
  );
  assert.match(
    replaceGraph,
    /if \(graph\.mode === "synthetic"\) \{[\s\S]*?this\.paint\(performance\.now\(\)\)/,
    "recording-safe replacement must synchronously overwrite live canvas pixels",
  );
  assert.doesNotMatch(
    replaceGraph,
    /node\.(?:title|path)/,
    "safe graph replacement must not derive any visible or ARIA text from a prior live node",
  );
});
