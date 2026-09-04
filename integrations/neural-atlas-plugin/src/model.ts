/**
 * Deterministic graph construction for Neural Atlas.
 *
 * This module has no Obsidian or DOM imports. Live inputs are already-extracted
 * file metadata; it never receives or reads note bodies. The renderer also gets
 * ambient particles from a separate type and collection so decoration cannot
 * silently inflate note counts.
 */

export type AtlasMode = "synthetic" | "live";
export type AtlasAccent = "violet" | "lavender" | "cyan" | "amber";
export type AtlasEdgeKind = "link" | "shared-tag" | "synthetic-thread";

export interface AtlasNode {
  readonly kind: "note-node";
  readonly id: string;
  readonly title: string;
  readonly clusterId: string;
  readonly path?: string;
  readonly tags: readonly string[];
  readonly accent: AtlasAccent;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly phase: number;
  degree: number;
  labelVisible: boolean;
}

export interface AtlasEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: AtlasEdgeKind;
}

export interface AtlasCluster {
  readonly id: string;
  readonly label: string;
  readonly accent: AtlasAccent;
  readonly x: number;
  readonly y: number;
  readonly nodeIds: readonly string[];
}

export interface AtlasGraph {
  readonly mode: AtlasMode;
  readonly seed: string;
  readonly nodes: readonly AtlasNode[];
  readonly edges: readonly AtlasEdge[];
  readonly clusters: readonly AtlasCluster[];
}

export interface AmbientParticle {
  readonly kind: "ambient-particle";
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly alpha: number;
  readonly phase: number;
}

export interface LiveNoteInput {
  /** Vault-relative Markdown path. */
  readonly path: string;
  readonly basename?: string;
  readonly folder?: string;
  /** Resolved vault-relative Markdown destinations from MetadataCache. */
  readonly links?: readonly string[];
  /** Cached inline and frontmatter tags, without note-body text. */
  readonly tags?: readonly string[];
  /** Cached frontmatter only. The graph reads title/type/status-like scalars. */
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}

export interface GraphSummary {
  readonly primaryCount: number;
  readonly primaryLabel: "sample nodes" | "notes";
  /** Semantic edges other than literal resolved note links. */
  readonly relationCount: number;
  readonly clusterCount: number;
  readonly linkCount: number;
  readonly tagRelationCount: number;
}

export interface GraphBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface ViewTransform {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface FitInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const SYNTHETIC_CLUSTER_NAMES = [
  "AI Projects",
  "Learning Path",
  "Research Memory",
  "GitHub Work",
  "Daily Signals",
  "Creator Studio",
] as const;

const TAU = Math.PI * 2;
const MIN_ZOOM = 0.22;
const MAX_ZOOM = 3.2;

const SYNTHETIC_DEFINITIONS: readonly {
  readonly name: (typeof SYNTHETIC_CLUSTER_NAMES)[number];
  readonly accent: AtlasAccent;
  readonly titles: readonly string[];
}[] = [
  {
    name: "AI Projects",
    accent: "violet",
    titles: ["Prototype map", "Evaluation pass", "Prompt study", "Local agent", "Model notes", "Build trace"],
  },
  {
    name: "Learning Path",
    accent: "lavender",
    titles: ["Current module", "Practice loop", "Concept map", "Lab notes", "Review queue", "Next milestone"],
  },
  {
    name: "Research Memory",
    accent: "cyan",
    titles: ["Source index", "Open question", "Synthesis", "Evidence map", "Reading trail", "Key finding"],
  },
  {
    name: "GitHub Work",
    accent: "violet",
    titles: ["Active branch", "Repository map", "Release check", "Issue thread", "Change set", "Build notes"],
  },
  {
    name: "Daily Signals",
    accent: "amber",
    titles: ["Today pulse", "Inbox signal", "Decision cue", "Review marker", "Fresh input", "Follow-up"],
  },
  {
    name: "Creator Studio",
    accent: "lavender",
    titles: ["Draft orbit", "Story seed", "Visual study", "Edit pass", "Format test", "Publish queue"],
  },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Stable 32-bit hash; suitable for layout seeds, not security. */
export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "cluster";
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function basenameFromPath(path: string): string {
  const file = normalizePath(path).split("/").pop() ?? path;
  return file.replace(/\.md$/i, "");
}

function topFolder(path: string, explicit?: string): string {
  if (explicit?.trim()) return normalizePath(explicit).replace(/^\/+|\/+$/g, "") || "Vault root";
  const parts = normalizePath(path).split("/");
  return parts.length > 1 ? parts[0] || "Vault root" : "Vault root";
}

function normalizeTags(tags: readonly string[] | undefined, frontmatter: Readonly<Record<string, unknown>> | undefined): string[] {
  const values: unknown[] = [...(tags ?? [])];
  const frontmatterTags = frontmatter?.tags ?? frontmatter?.tag;
  if (Array.isArray(frontmatterTags)) values.push(...frontmatterTags);
  else if (typeof frontmatterTags === "string") values.push(...frontmatterTags.split(/[\s,]+/));
  const normalized = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().replace(/^#/, "").toLowerCase())
    .filter(Boolean);
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function scalar(frontmatter: Readonly<Record<string, unknown>> | undefined, key: string): string {
  const value = frontmatter?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function noteTitle(note: LiveNoteInput): string {
  const frontmatterTitle = scalar(note.frontmatter, "title");
  return frontmatterTitle || note.basename?.trim() || basenameFromPath(note.path);
}

function noteAccent(tags: readonly string[], frontmatter: Readonly<Record<string, unknown>> | undefined): AtlasAccent {
  const cues = [
    ...tags,
    scalar(frontmatter, "type").toLowerCase(),
    scalar(frontmatter, "status").toLowerCase(),
  ].join(" ");
  if (/\b(daily|journal|signal|inbox|urgent|today)\b/.test(cues)) return "amber";
  if (/\b(research|source|reference|paper|evidence)\b/.test(cues)) return "cyan";
  if (/\b(learn|learning|study|course|lesson)\b/.test(cues)) return "lavender";
  return "violet";
}

function liveInputRank(note: LiveNoteInput): string {
  const links = [...(note.links ?? [])].sort();
  const tags = [...(note.tags ?? [])].sort();
  const frontmatter = Object.entries(note.frontmatter ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${JSON.stringify(value)}`);
  const richness = links.length * 5 + tags.length * 3 + frontmatter.length * 2;
  return [
    String(richness).padStart(8, "0"),
    note.folder ?? "",
    note.basename ?? "",
    links.join("\u0001"),
    tags.join("\u0001"),
    frontmatter.join("\u0001"),
  ].join("\u0000");
}

function clusterCenters(count: number): { x: number; y: number }[] {
  if (count <= 0) return [];
  if (count === 1) return [{ x: 0, y: 0 }];
  const centers: { x: number; y: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const ring = Math.floor(index / 8);
    const indexOnRing = index - ring * 8;
    const itemsOnRing = Math.min(8, count - ring * 8);
    const angle = -Math.PI / 2 + (indexOnRing / itemsOnRing) * TAU + ring * 0.31;
    const radiusX = 430 + ring * 480;
    const radiusY = 280 + ring * 330;
    centers.push({ x: Math.cos(angle) * radiusX, y: Math.sin(angle) * radiusY });
  }
  return centers;
}

function connect(
  edges: AtlasEdge[],
  edgeKeys: Set<string>,
  source: string,
  target: string,
  kind: AtlasEdgeKind,
): void {
  if (source === target) return;
  const ordered = source < target ? [source, target] : [target, source];
  const key = `${ordered[0]}\u0000${ordered[1]}\u0000${kind}`;
  if (edgeKeys.has(key)) return;
  edgeKeys.add(key);
  edges.push({ id: `${kind}:${hashString(key).toString(36)}`, source, target, kind });
}

function finalizeGraph(graph: AtlasGraph): AtlasGraph {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (source) source.degree += 1;
    if (target) target.degree += 1;
  }

  const labelBudget = Math.min(24, Math.max(graph.clusters.length, Math.ceil(graph.nodes.length * 0.16)));
  const selected = new Set<string>();
  for (const cluster of graph.clusters) {
    const anchor = cluster.nodeIds
      .map((id) => nodeById.get(id))
      .filter((node): node is AtlasNode => node !== undefined)
      .sort((left, right) => right.degree - left.degree || left.id.localeCompare(right.id))[0];
    if (anchor && selected.size < labelBudget) selected.add(anchor.id);
  }
  for (const node of [...graph.nodes].sort((left, right) => right.degree - left.degree || left.id.localeCompare(right.id))) {
    if (selected.size >= labelBudget) break;
    selected.add(node.id);
  }
  for (const node of graph.nodes) node.labelVisible = selected.has(node.id);
  return graph;
}

/** A fixed, deterministic showcase that contains no vault-derived data. */
export function buildSyntheticGraph(seed = "neural-atlas-recording-safe-v1"): AtlasGraph {
  const centers = [
    { x: -470, y: -260 },
    { x: 0, y: -345 },
    { x: 470, y: -235 },
    { x: -455, y: 270 },
    { x: 15, y: 350 },
    { x: 480, y: 245 },
  ];
  const nodes: AtlasNode[] = [];
  const clusters: AtlasCluster[] = [];
  const edges: AtlasEdge[] = [];
  const edgeKeys = new Set<string>();

  for (let clusterIndex = 0; clusterIndex < SYNTHETIC_DEFINITIONS.length; clusterIndex += 1) {
    const definition = SYNTHETIC_DEFINITIONS[clusterIndex];
    const center = centers[clusterIndex];
    const clusterId = `sample-cluster:${slug(definition.name)}`;
    const random = seededRandom(hashString(`${seed}:${clusterId}`));
    const nodeIds: string[] = [];
    for (let nodeIndex = 0; nodeIndex < definition.titles.length; nodeIndex += 1) {
      const id = `sample:${slug(definition.name)}:${nodeIndex + 1}`;
      nodeIds.push(id);
      const angle = (nodeIndex / definition.titles.length) * TAU + random() * 0.72;
      const orbit = nodeIndex === 0 ? 18 : 68 + random() * 96;
      nodes.push({
        kind: "note-node",
        id,
        title: definition.titles[nodeIndex],
        clusterId,
        tags: [],
        accent: definition.accent,
        x: center.x + Math.cos(angle) * orbit,
        y: center.y + Math.sin(angle) * orbit * 0.72,
        radius: nodeIndex === 0 ? 6.2 : 3.1 + random() * 2.1,
        phase: random() * TAU,
        degree: 0,
        labelVisible: false,
      });
      if (nodeIndex > 0) connect(edges, edgeKeys, nodeIds[0], id, "synthetic-thread");
    }
    clusters.push({
      id: clusterId,
      label: definition.name,
      accent: definition.accent,
      x: center.x,
      y: center.y,
      nodeIds,
    });
  }

  for (let index = 0; index < clusters.length; index += 1) {
    const next = (index + 1) % clusters.length;
    connect(edges, edgeKeys, clusters[index].nodeIds[0], clusters[next].nodeIds[0], "synthetic-thread");
  }

  return finalizeGraph({ mode: "synthetic", seed, nodes, edges, clusters });
}

/**
 * Build a graph exclusively from already-cached file metadata.
 * Unresolved links never create phantom note nodes.
 */
export function buildLiveGraph(input: readonly LiveNoteInput[], seed = "neural-atlas-live-v1"): AtlasGraph {
  const unique = new Map<string, LiveNoteInput>();
  for (const note of input) {
    const path = normalizePath(note.path.trim());
    if (!path || !/\.md$/i.test(path)) continue;
    const candidate = { ...note, path };
    const existing = unique.get(path);
    if (!existing || liveInputRank(candidate) > liveInputRank(existing)) {
      unique.set(path, candidate);
    }
  }
  const notes = [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
  const folderNames = [...new Set(notes.map((note) => topFolder(note.path, note.folder)))].sort((left, right) => left.localeCompare(right));
  const centers = clusterCenters(folderNames.length);
  const clusterByLabel = new Map(folderNames.map((label, index) => [label, { id: `folder:${slug(label)}:${hashString(label).toString(36)}`, center: centers[index] }]));
  const nodes: AtlasNode[] = [];
  const nodeByPath = new Map<string, AtlasNode>();

  for (const note of notes) {
    const folderLabel = topFolder(note.path, note.folder);
    const cluster = clusterByLabel.get(folderLabel);
    if (!cluster) continue;
    const random = seededRandom(hashString(`${seed}:${note.path}`));
    const angle = random() * TAU;
    const orbit = 42 + Math.sqrt(random()) * 176;
    const tags = normalizeTags(note.tags, note.frontmatter);
    const node: AtlasNode = {
      kind: "note-node",
      id: `note:${note.path}`,
      title: noteTitle(note),
      clusterId: cluster.id,
      path: note.path,
      tags,
      accent: noteAccent(tags, note.frontmatter),
      x: cluster.center.x + Math.cos(angle) * orbit,
      y: cluster.center.y + Math.sin(angle) * orbit * 0.7,
      radius: 3.1 + random() * 2.2,
      phase: random() * TAU,
      degree: 0,
      labelVisible: false,
    };
    nodes.push(node);
    nodeByPath.set(note.path, node);
  }

  const edges: AtlasEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const note of notes) {
    const source = nodeByPath.get(note.path);
    if (!source) continue;
    for (const rawTarget of note.links ?? []) {
      const target = nodeByPath.get(normalizePath(rawTarget));
      if (target) connect(edges, edgeKeys, source.id, target.id, "link");
    }
  }

  // One chain per tag exposes semantic neighborhoods without an O(n^2) web.
  const tagBuckets = new Map<string, AtlasNode[]>();
  for (const node of nodes) {
    for (const tag of node.tags) {
      const bucket = tagBuckets.get(tag) ?? [];
      bucket.push(node);
      tagBuckets.set(tag, bucket);
    }
  }
  for (const bucket of tagBuckets.values()) {
    const ordered = [...bucket].sort((left, right) => left.id.localeCompare(right.id));
    for (let index = 1; index < ordered.length; index += 1) {
      connect(edges, edgeKeys, ordered[index - 1].id, ordered[index].id, "shared-tag");
    }
  }

  const clusters: AtlasCluster[] = folderNames.map((label) => {
    const cluster = clusterByLabel.get(label);
    if (!cluster) throw new Error(`Missing deterministic cluster for ${label}`);
    const members = nodes.filter((node) => node.clusterId === cluster.id);
    const counts: Record<AtlasAccent, number> = { violet: 0, lavender: 0, cyan: 0, amber: 0 };
    for (const node of members) counts[node.accent] += 1;
    const accent = (Object.entries(counts) as [AtlasAccent, number][]).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? "violet";
    return {
      id: cluster.id,
      label,
      accent,
      x: cluster.center.x,
      y: cluster.center.y,
      nodeIds: members.map((node) => node.id),
    };
  });

  return finalizeGraph({ mode: "live", seed, nodes, edges, clusters });
}

export function summarizeGraph(graph: AtlasGraph): GraphSummary {
  const linkCount = graph.edges.filter((edge) => edge.kind === "link").length;
  const tagRelationCount = graph.edges.filter((edge) => edge.kind === "shared-tag").length;
  return {
    primaryCount: graph.nodes.length,
    primaryLabel: graph.mode === "synthetic" ? "sample nodes" : "notes",
    relationCount: graph.edges.length - linkCount,
    clusterCount: graph.clusters.length,
    linkCount,
    tagRelationCount,
  };
}

/** Decorative particles are never graph nodes and never enter graph summaries. */
export function buildAmbientParticles(graph: AtlasGraph, lowPower: boolean): AmbientParticle[] {
  const random = seededRandom(
    hashString(`${graph.seed}:ambient:${lowPower ? "low" : "full"}`),
  );
  const count = lowPower ? 420 : 1280;
  const localCount = graph.clusters.length ? Math.floor(count * 0.84) : 0;
  const bounds = graphBounds(graph);
  const width = Math.max(900, bounds.maxX - bounds.minX + 420);
  const height = Math.max(620, bounds.maxY - bounds.minY + 360);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return Array.from({ length: count }, (_, index) => {
    let x: number;
    let y: number;
    if (index < localCount) {
      const cluster = graph.clusters[index % graph.clusters.length];
      const angle = random() * TAU;
      // A broad, transparent corona: dense near the cluster, never node-like.
      const distance = 24 + Math.pow(random(), 0.68) * 285;
      x = cluster.x + Math.cos(angle) * distance;
      y = cluster.y + Math.sin(angle) * distance * (0.56 + random() * 0.24);
    } else {
      x = centerX + (random() - 0.5) * width;
      y = centerY + (random() - 0.5) * height;
    }
    return {
      kind: "ambient-particle" as const,
      id: `ambient:${index + 1}`,
      x,
      y,
      radius: 0.34 + random() * 0.78,
      alpha: 0.025 + random() * 0.105,
      phase: random() * TAU,
    };
  });
}

export function graphBounds(graph: AtlasGraph): GraphBounds {
  if (graph.nodes.length === 0 && graph.clusters.length === 0) {
    return { minX: -320, minY: -220, maxX: 320, maxY: 220 };
  }
  const xs = [...graph.nodes.map((node) => node.x), ...graph.clusters.map((cluster) => cluster.x)];
  const ys = [...graph.nodes.map((node) => node.y), ...graph.clusters.map((cluster) => cluster.y)];
  return {
    minX: Math.min(...xs) - 135,
    minY: Math.min(...ys) - 110,
    maxX: Math.max(...xs) + 135,
    maxY: Math.max(...ys) + 110,
  };
}

/**
 * Recompose cluster centers for a narrow portrait viewport. This is not a
 * scale-down of the desktop map: clusters become a tall two-column field and
 * each local constellation follows its new center. Counts and identities stay
 * unchanged. Wider or landscape viewports return the original graph.
 */
export function composeGraphForViewport(
  graph: AtlasGraph,
  viewportWidth: number,
  viewportHeight: number,
): AtlasGraph {
  const portrait = viewportWidth < 680 && viewportHeight > viewportWidth * 1.08;
  if (!portrait || graph.clusters.length < 2) return graph;

  const columns = viewportWidth < 410 ? 1 : 2;
  const columnGap = columns === 1 ? 0 : 370;
  const rowGap = columns === 1 ? 390 : 470;
  const rows = Math.ceil(graph.clusters.length / columns);
  const newCenters = new Map<string, { x: number; y: number }>();
  graph.clusters.forEach((cluster, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    newCenters.set(cluster.id, {
      x: (column - (columns - 1) / 2) * columnGap,
      y: (row - (rows - 1) / 2) * rowGap,
    });
  });

  const oldCenters = new Map(graph.clusters.map((cluster) => [cluster.id, cluster]));
  const clusters = graph.clusters.map((cluster) => {
    const center = newCenters.get(cluster.id) ?? cluster;
    return { ...cluster, x: center.x, y: center.y };
  });
  const nodes = graph.nodes.map((node) => {
    const oldCenter = oldCenters.get(node.clusterId);
    const newCenter = newCenters.get(node.clusterId);
    if (!oldCenter || !newCenter) return { ...node };
    return {
      ...node,
      x: newCenter.x + (node.x - oldCenter.x) * (columns === 1 ? 0.72 : 0.78),
      y: newCenter.y + (node.y - oldCenter.y) * 0.82,
    };
  });
  return { ...graph, nodes, clusters };
}

export function fitTransform(
  bounds: GraphBounds,
  viewportWidth: number,
  viewportHeight: number,
  padding: number | FitInsets = 84,
): ViewTransform {
  const insets: FitInsets =
    typeof padding === "number"
      ? { top: padding, right: padding, bottom: padding, left: padding }
      : padding;
  const usableWidth = Math.max(1, viewportWidth - insets.left - insets.right);
  const usableHeight = Math.max(1, viewportHeight - insets.top - insets.bottom);
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const zoom = clamp(Math.min(usableWidth / width, usableHeight / height), MIN_ZOOM, MAX_ZOOM);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return {
    x: insets.left + usableWidth / 2 - centerX * zoom,
    y: insets.top + usableHeight / 2 - centerY * zoom,
    zoom,
  };
}

export function zoomAround(
  transform: ViewTransform,
  screenX: number,
  screenY: number,
  factor: number,
): ViewTransform {
  const zoom = clamp(transform.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const worldX = (screenX - transform.x) / transform.zoom;
  const worldY = (screenY - transform.y) / transform.zoom;
  return {
    x: screenX - worldX * zoom,
    y: screenY - worldY * zoom,
    zoom,
  };
}
