import {
  buildAmbientFibers,
  buildAmbientParticles,
  composeGraphForViewport,
  fitTransform,
  graphBounds,
  summarizeGraph,
  zoomAround,
  type AmbientFiber,
  type AmbientParticle,
  type AtlasAccent,
  type AtlasEdge,
  type AtlasGraph,
  type AtlasNode,
  type ViewTransform,
} from "./model";

export interface AtlasRendererPreferences {
  readonly motionEnabled: boolean;
  readonly labelsEnabled: boolean;
  readonly lowPower: boolean;
  readonly systemReducedMotion: boolean;
  readonly qualityState: "auto-full" | "auto-low-power" | "full" | "low-power";
}

export interface AtlasRendererCallbacks {
  readonly onToggleMode: () => void;
  readonly onToggleMotion: () => void;
  readonly onToggleLabels: () => void;
  readonly onFit: () => void;
  readonly onReset: () => void;
  readonly onOpenNode: (node: AtlasNode) => void;
}

const ACCENTS: Record<
  AtlasAccent,
  { solid: string; soft: string; faint: string; channels: string }
> = {
  violet: {
    solid: "rgb(161, 105, 255)",
    soft: "rgba(161, 105, 255, 0.5)",
    faint: "rgba(137, 82, 235, 0.11)",
    channels: "161, 105, 255",
  },
  lavender: {
    solid: "rgb(214, 190, 255)",
    soft: "rgba(205, 178, 255, 0.5)",
    faint: "rgba(185, 153, 246, 0.1)",
    channels: "214, 190, 255",
  },
  cyan: {
    solid: "rgb(91, 222, 231)",
    soft: "rgba(81, 211, 226, 0.52)",
    faint: "rgba(69, 205, 220, 0.09)",
    channels: "91, 222, 231",
  },
  amber: {
    solid: "rgb(242, 180, 86)",
    soft: "rgba(242, 176, 72, 0.54)",
    faint: "rgba(237, 163, 60, 0.09)",
    channels: "242, 180, 86",
  },
};

function accentRgba(accent: AtlasAccent, alpha: number): string {
  return `rgba(${ACCENTS[accent].channels}, ${alpha})`;
}

function quadraticPoint(
  startX: number,
  startY: number,
  controlX: number,
  controlY: number,
  endX: number,
  endY: number,
  progress: number,
): { x: number; y: number } {
  const inverse = 1 - progress;
  return {
    x: inverse * inverse * startX + 2 * inverse * progress * controlX + progress * progress * endX,
    y: inverse * inverse * startY + 2 * inverse * progress * controlY + progress * progress * endY,
  };
}

const DEFAULT_PREFERENCES: AtlasRendererPreferences = {
  motionEnabled: true,
  labelsEnabled: true,
  lowPower: false,
  systemReducedMotion: false,
  qualityState: "auto-full",
};

const DEFAULT_CANVAS_ARIA_LABEL =
  "Interactive Neural Atlas. Drag to pan, scroll to zoom, and hover a node to focus it.";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? singular : plural}`;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + width, y, x + width, y + height, safeRadius);
  context.arcTo(x + width, y + height, x, y + height, safeRadius);
  context.arcTo(x, y + height, x, y, safeRadius);
  context.arcTo(x, y, x + width, y, safeRadius);
  context.closePath();
}

/** DOM and Canvas 2D renderer. It owns no vault access and performs no I/O. */
export class AtlasRenderer {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly topHud: HTMLElement;
  private readonly bottomHud: HTMLElement;
  private readonly modeBadge: HTMLElement;
  private readonly disclosure: HTMLElement;
  private readonly topSummary: HTMLElement;
  private readonly countStatus: HTMLElement;
  private readonly focusStatus: HTMLElement;
  private readonly runtimeStatus: HTMLElement;
  private readonly modeButton: HTMLButtonElement;
  private readonly motionButton: HTMLButtonElement;
  private readonly labelsButton: HTMLButtonElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver;
  private readonly cleanup: (() => void)[] = [];
  private baseGraph: AtlasGraph;
  private graph: AtlasGraph;
  private particles: AmbientParticle[] = [];
  private fibers: AmbientFiber[] = [];
  private preferences: AtlasRendererPreferences = DEFAULT_PREFERENCES;
  private transform: ViewTransform = { x: 0, y: 0, zoom: 1 };
  private nodeById = new Map<string, AtlasNode>();
  private spatialIndex = new Map<string, AtlasNode[]>();
  private majorGlowIds = new Set<string>();
  private neighbors = new Map<string, Set<string>>();
  private hovered: AtlasNode | null = null;
  private focusedClusterId: string | null = null;
  private pointerId: number | null = null;
  private pointerPosition: { x: number; y: number } | null = null;
  private pointerMoved = false;
  private parallaxTarget = { x: 0, y: 0 };
  private parallaxCurrent = { x: 0, y: 0 };
  private frameId: number | null = null;
  private resizeTimer: number | null = null;
  private lastPaint = 0;
  private width = 1;
  private height = 1;
  private hasUserTransform = false;
  private compositionKey: "wide" | "portrait-one" | "portrait-two" = "wide";
  private isVisible = false;
  private destroyed = false;

  constructor(host: HTMLElement, graph: AtlasGraph, private readonly callbacks: AtlasRendererCallbacks) {
    this.baseGraph = graph;
    this.graph = graph;
    this.root = element("div", "neural-atlas-root");
    host.replaceChildren(this.root);

    this.canvas = element("canvas", "neural-atlas-canvas");
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label", DEFAULT_CANVAS_ARIA_LABEL);
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Neural Atlas requires Canvas 2D support.");
    this.context = context;
    this.root.append(this.canvas);

    this.topHud = element("header", "neural-atlas-hud neural-atlas-hud--top");
    const identity = element("div", "neural-atlas-identity");
    identity.append(element("span", "neural-atlas-kicker", "LOCAL MEMORY CONSTELLATION"));
    const titleLine = element("div", "neural-atlas-title-line");
    titleLine.append(element("strong", "neural-atlas-title", "Cruz AI Neural Atlas"));
    this.modeBadge = element("span", "neural-atlas-mode-badge");
    titleLine.append(this.modeBadge);
    identity.append(titleLine);
    this.disclosure = element("div", "neural-atlas-disclosure");
    identity.append(this.disclosure);
    this.topSummary = element("div", "neural-atlas-top-summary");
    identity.append(this.topSummary);
    this.topHud.append(identity);

    const controls = element("nav", "neural-atlas-controls");
    controls.setAttribute("aria-label", "Neural Atlas controls");
    this.modeButton = this.control("Mode", () => this.callbacks.onToggleMode());
    this.motionButton = this.control("Motion", () => this.callbacks.onToggleMotion());
    this.labelsButton = this.control("Labels", () => this.callbacks.onToggleLabels());
    controls.append(
      this.modeButton,
      this.motionButton,
      this.labelsButton,
      this.control("Fit", () => this.callbacks.onFit()),
      this.control("Reset", () => this.callbacks.onReset()),
    );
    this.topHud.append(controls);
    this.root.append(this.topHud);

    this.bottomHud = element("footer", "neural-atlas-hud neural-atlas-hud--bottom");
    this.countStatus = element("div", "neural-atlas-counts");
    this.focusStatus = element("div", "neural-atlas-focus", "All clusters in focus");
    this.focusStatus.setAttribute("role", "status");
    this.focusStatus.setAttribute("aria-live", "polite");
    this.runtimeStatus = element("div", "neural-atlas-runtime");
    this.bottomHud.append(this.countStatus, this.focusStatus, this.runtimeStatus);
    this.root.append(this.bottomHud);

    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.root);
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        const visible = Boolean(entry?.isIntersecting && entry.intersectionRatio > 0);
        if (visible !== this.isVisible) {
          this.isVisible = visible;
          this.updateAnimation();
        }
      },
      { threshold: 0.01 },
    );
    this.intersectionObserver.observe(this.root);
    this.setGraph(graph);
  }

  private control(label: string, callback: () => void): HTMLButtonElement {
    const button = element("button", "neural-atlas-control", label);
    button.type = "button";
    button.addEventListener("click", callback);
    this.cleanup.push(() => button.removeEventListener("click", callback));
    return button;
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener as EventListener, options);
    this.cleanup.push(() => target.removeEventListener(type, listener as EventListener, options));
  }

  private bindEvents(): void {
    this.listen(this.canvas, "pointerdown", (event) => this.onPointerDown(event));
    this.listen(this.canvas, "pointermove", (event) => this.onPointerMove(event));
    this.listen(this.canvas, "pointerup", (event) => this.onPointerUp(event));
    this.listen(this.canvas, "pointercancel", (event) => this.onPointerUp(event));
    this.listen(this.canvas, "pointerleave", () => {
      this.parallaxTarget = { x: 0, y: 0 };
      if (this.pointerId === null) this.setHovered(null);
    });
    this.listen(this.canvas, "wheel", (event) => this.onWheel(event), { passive: false });
    this.listen(this.canvas, "dblclick", (event) => {
      const node = this.hitTest(event.clientX, event.clientY);
      if (node?.path) this.callbacks.onOpenNode(node);
    });
    this.listen(this.canvas, "keydown", (event) => this.onKeyDown(event));

    const visibilityListener = (): void => this.updateAnimation();
    document.addEventListener("visibilitychange", visibilityListener);
    this.cleanup.push(() => document.removeEventListener("visibilitychange", visibilityListener));

    // Electron normally delivers ResizeObserver updates, but a window-level
    // fallback keeps portrait/wide recomposition reliable during live capture.
    const windowResizeListener = (): void => {
      this.resize();
      if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        this.resizeTimer = null;
        if (!this.destroyed) this.resize();
      }, 120);
    };
    window.addEventListener("resize", windowResizeListener);
    this.cleanup.push(() => window.removeEventListener("resize", windowResizeListener));
  }

  setGraph(graph: AtlasGraph, preserveTransform = false): void {
    this.baseGraph = graph;
    this.graph = composeGraphForViewport(graph, this.width, this.height);
    this.compositionKey = this.getCompositionKey();
    // Scrub interaction-derived text synchronously. A live node title or path
    // must never survive a live -> recording-safe graph replacement in ARIA.
    this.canvas.setAttribute("aria-label", DEFAULT_CANVAS_ARIA_LABEL);
    this.rebuildGraphIndexes();
    this.hovered = null;
    this.focusedClusterId = null;
    this.particles = buildAmbientParticles(this.graph, this.preferences.lowPower);
    this.fibers = buildAmbientFibers(this.graph, this.preferences.lowPower);
    this.updateHud();
    if (!preserveTransform || !this.hasUserTransform) {
      this.hasUserTransform = false;
      this.fit();
    }
    if (graph.mode === "synthetic") {
      // Paint immediately so stale live pixels cannot persist until the next RAF.
      this.paint(performance.now());
    } else {
      this.requestPaint();
    }
  }

  setPreferences(preferences: AtlasRendererPreferences): void {
    const qualityChanged = preferences.lowPower !== this.preferences.lowPower;
    this.preferences = preferences;
    if (qualityChanged) {
      this.particles = buildAmbientParticles(this.graph, preferences.lowPower);
      this.fibers = buildAmbientFibers(this.graph, preferences.lowPower);
      // Device-pixel ratio is quality-dependent; resize even when CSS size did not change.
      this.resize();
    }
    this.updateHud();
    this.updateAnimation();
  }

  fit(): void {
    this.transform = fitTransform(
      graphBounds(this.graph),
      this.width,
      this.height,
      this.fitInsets(),
    );
    // Fit remains responsive: future resizes recompute it against real HUD rails.
    this.hasUserTransform = false;
    this.updateRuntimeStatus();
    this.requestPaint();
  }

  reset(): void {
    const bounds = graphBounds(this.graph);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const insets = this.fitInsets();
    const fit = fitTransform(bounds, this.width, this.height, insets);
    const zoom = Math.min(fit.zoom, this.width < 620 ? 0.58 : 0.86);
    const viewportCenterX = insets.left + (this.width - insets.left - insets.right) / 2;
    const viewportCenterY = insets.top + (this.height - insets.top - insets.bottom) / 2;
    this.transform = {
      x: viewportCenterX - centerX * zoom,
      y: viewportCenterY - centerY * zoom,
      zoom,
    };
    this.hasUserTransform = true;
    this.updateRuntimeStatus();
    this.requestPaint();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.root.remove();
  }

  private updateHud(): void {
    const summary = summarizeGraph(this.graph);
    const synthetic = this.graph.mode === "synthetic";
    this.root.classList.toggle("is-recording-safe", synthetic);
    this.root.classList.toggle("is-low-power", this.preferences.lowPower);
    this.root.classList.toggle("is-reduced-motion", this.preferences.systemReducedMotion);
    this.root.classList.toggle("is-portrait-composed", this.compositionKey !== "wide");
    this.modeBadge.textContent = synthetic ? "SYNTHETIC · RECORDING-SAFE" : "LIVE · METADATA ONLY";
    this.disclosure.textContent = synthetic
      ? "Deterministic sample graph · zero vault records queried"
      : "Built locally from paths, folders, cached links, tags, and frontmatter · note bodies are not read";
    this.topSummary.textContent = synthetic
      ? [
          formatCount(summary.primaryCount, "sample anchor"),
          formatCount(summary.linkCount, "note link"),
          formatCount(summary.relationCount, "synthetic relation"),
          formatCount(this.particles.length, "decorative particle"),
          formatCount(summary.clusterCount, "cluster"),
        ].join("  ·  ")
      : [
          formatCount(summary.primaryCount, "note"),
          formatCount(summary.linkCount, "link"),
          formatCount(summary.tagRelationCount, "tag relation"),
          formatCount(this.particles.length, "decorative particle"),
          formatCount(summary.clusterCount, "cluster"),
        ].join("  ·  ");
    this.modeButton.textContent = synthetic ? "Mode: safe" : "Mode: live";
    this.modeButton.setAttribute(
      "aria-label",
      synthetic ? "Switch to live metadata mode" : "Switch to synthetic recording-safe mode",
    );
    this.modeButton.setAttribute("aria-pressed", String(synthetic));
    const reduced = this.preferences.systemReducedMotion;
    this.motionButton.textContent = reduced
      ? "Motion: reduced"
      : `Motion: ${this.preferences.motionEnabled ? "on" : "off"}`;
    this.motionButton.setAttribute(
      "aria-label",
      reduced
        ? "Motion is reduced by the operating system preference"
        : `Turn motion ${this.preferences.motionEnabled ? "off" : "on"}`,
    );
    this.motionButton.setAttribute(
      "aria-pressed",
      String(this.preferences.motionEnabled && !this.preferences.systemReducedMotion),
    );
    this.labelsButton.textContent = `Labels: ${this.preferences.labelsEnabled ? "on" : "off"}`;
    this.labelsButton.setAttribute("aria-pressed", String(this.preferences.labelsEnabled));
    this.updateFocusStatus();
    this.updateRuntimeStatus();
  }

  private getCompositionKey(): "wide" | "portrait-one" | "portrait-two" {
    const portrait = this.width < 680 && this.height > this.width * 1.08;
    if (!portrait) return "wide";
    return this.width < 410 ? "portrait-one" : "portrait-two";
  }

  private fitInsets(): { top: number; right: number; bottom: number; left: number } {
    const rootBounds = this.root.getBoundingClientRect();
    const topBounds = this.topHud.getBoundingClientRect();
    const bottomBounds = this.bottomHud.getBoundingClientRect();
    const narrow = this.compositionKey !== "wide";
    const topRail =
      rootBounds.height > 1 && topBounds.height > 0
        ? topBounds.bottom - rootBounds.top + 16
        : narrow
          ? 116
          : 88;
    const bottomRail =
      rootBounds.height > 1 && bottomBounds.height > 0
        ? rootBounds.bottom - bottomBounds.top + 16
        : narrow
          ? 78
          : 58;
    return {
      top: Math.max(narrow ? 92 : 68, topRail),
      right: narrow ? 26 : 48,
      bottom: Math.max(narrow ? 64 : 48, bottomRail),
      left: narrow ? 26 : 48,
    };
  }

  private spatialKey(x: number, y: number): string {
    const size = 96;
    return `${Math.floor(x / size)}:${Math.floor(y / size)}`;
  }

  private rebuildGraphIndexes(): void {
    this.nodeById = new Map(this.graph.nodes.map((node) => [node.id, node]));
    this.neighbors = new Map(this.graph.nodes.map((node) => [node.id, new Set<string>()]));
    for (const edge of this.graph.edges) {
      this.neighbors.get(edge.source)?.add(edge.target);
      this.neighbors.get(edge.target)?.add(edge.source);
    }
    this.spatialIndex = new Map();
    for (const node of this.graph.nodes) {
      const key = this.spatialKey(node.x, node.y);
      const bucket = this.spatialIndex.get(key) ?? [];
      bucket.push(node);
      this.spatialIndex.set(key, bucket);
    }
    const glowBudget = Math.min(
      72,
      Math.max(this.graph.clusters.length * 2, Math.ceil(this.graph.nodes.length * 0.03)),
    );
    this.majorGlowIds = new Set(
      [...this.graph.nodes]
        .sort((left, right) => right.degree - left.degree || right.radius - left.radius)
        .slice(0, glowBudget)
        .map((node) => node.id),
    );
  }

  private resize(): void {
    const bounds = this.root.getBoundingClientRect();
    const previousWidth = this.width;
    const previousHeight = this.height;
    this.width = Math.max(1, Math.floor(bounds.width));
    this.height = Math.max(1, Math.floor(bounds.height));
    const deviceScale = window.devicePixelRatio || 1;
    const maxBackingPixels = this.preferences.lowPower ? 3_500_000 : 8_000_000;
    const pixelBudgetRatio = Math.sqrt(
      maxBackingPixels / Math.max(1, this.width * this.height),
    );
    const ratio = Math.min(
      deviceScale,
      this.preferences.lowPower ? 1.25 : 2,
      pixelBudgetRatio,
    );
    const bitmapWidth = Math.max(1, Math.floor(this.width * ratio));
    const bitmapHeight = Math.max(1, Math.floor(this.height * ratio));
    if (this.canvas.width !== bitmapWidth || this.canvas.height !== bitmapHeight) {
      this.canvas.width = bitmapWidth;
      this.canvas.height = bitmapHeight;
    }
    this.canvas.dataset.pixelRatio = String(ratio);
    const nextComposition = this.getCompositionKey();
    const compositionChanged = nextComposition !== this.compositionKey;
    if (compositionChanged) {
      this.compositionKey = nextComposition;
      this.graph = composeGraphForViewport(this.baseGraph, this.width, this.height);
      this.rebuildGraphIndexes();
      this.particles = buildAmbientParticles(this.graph, this.preferences.lowPower);
      this.fibers = buildAmbientFibers(this.graph, this.preferences.lowPower);
      this.hasUserTransform = false;
    }
    this.root.classList.toggle("is-portrait-composed", this.compositionKey !== "wide");
    if (!this.hasUserTransform || previousWidth <= 1 || previousHeight <= 1 || compositionChanged) {
      this.transform = fitTransform(
        graphBounds(this.graph),
        this.width,
        this.height,
        this.fitInsets(),
      );
    } else {
      this.transform = {
        ...this.transform,
        x: this.transform.x + (this.width - previousWidth) / 2,
        y: this.transform.y + (this.height - previousHeight) / 2,
      };
    }
    this.updateRuntimeStatus();
    this.requestPaint();
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.pointerId = event.pointerId;
    this.pointerPosition = { x: event.clientX, y: event.clientY };
    this.pointerMoved = false;
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.classList.add("is-panning");
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.pointerId === event.pointerId && this.pointerPosition) {
      const dx = event.clientX - this.pointerPosition.x;
      const dy = event.clientY - this.pointerPosition.y;
      if (Math.hypot(dx, dy) > 1.5) this.pointerMoved = true;
      this.pointerPosition = { x: event.clientX, y: event.clientY };
      this.transform = { ...this.transform, x: this.transform.x + dx, y: this.transform.y + dy };
      this.hasUserTransform = true;
      this.requestPaint();
      return;
    }
    const bounds = this.canvas.getBoundingClientRect();
    this.parallaxTarget = {
      x: ((event.clientX - bounds.left) / Math.max(1, bounds.width) - 0.5) * 2,
      y: ((event.clientY - bounds.top) / Math.max(1, bounds.height) - 0.5) * 2,
    };
    this.setHovered(this.hitTest(event.clientX, event.clientY));
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    const clicked = this.pointerMoved ? null : this.hitTest(event.clientX, event.clientY);
    this.pointerId = null;
    this.pointerPosition = null;
    this.pointerMoved = false;
    this.canvas.classList.remove("is-panning");
    if (clicked) {
      this.setHovered(clicked);
      if (this.focusedClusterId === clicked.clusterId) this.clearClusterFocus();
      else this.focusCluster(clicked.clusterId);
    } else {
      this.setHovered(this.hitTest(event.clientX, event.clientY));
    }
    this.requestPaint();
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const bounds = this.canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    this.transform = zoomAround(this.transform, x, y, Math.exp(-event.deltaY * 0.00115));
    this.hasUserTransform = true;
    this.updateRuntimeStatus();
    this.requestPaint();
  }

  private onKeyDown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    if (key === "f") this.callbacks.onFit();
    else if (key === "r") this.callbacks.onReset();
    else if (key === "l") this.callbacks.onToggleLabels();
    else if (key === "m") this.callbacks.onToggleMotion();
    else if (key === "s") this.callbacks.onToggleMode();
    else if (key === "c" || key === "arrowright") this.cycleCluster(1);
    else if (key === "arrowleft") this.cycleCluster(-1);
    else if (key === "escape") this.clearClusterFocus();
    else if (key === "enter" && this.hovered?.path) this.callbacks.onOpenNode(this.hovered);
    else return;
    event.preventDefault();
  }

  private setHovered(node: AtlasNode | null): void {
    if (node?.id === this.hovered?.id) return;
    this.hovered = node;
    if (node) {
      this.canvas.setAttribute("aria-label", `Focused ${node.title}. ${node.degree} relations.`);
    } else {
      this.canvas.setAttribute("aria-label", DEFAULT_CANVAS_ARIA_LABEL);
    }
    this.updateFocusStatus();
    this.requestPaint();
  }

  private cycleCluster(direction: 1 | -1): void {
    if (!this.graph.clusters.length) return;
    const current = this.graph.clusters.findIndex(
      (cluster) => cluster.id === this.focusedClusterId,
    );
    const next =
      current < 0
        ? direction > 0
          ? 0
          : this.graph.clusters.length - 1
        : (current + direction + this.graph.clusters.length) % this.graph.clusters.length;
    this.hovered = null;
    this.focusCluster(this.graph.clusters[next].id);
  }

  private focusCluster(clusterId: string): void {
    const cluster = this.graph.clusters.find((candidate) => candidate.id === clusterId);
    if (!cluster) return;
    const nodes = cluster.nodeIds
      .map((id) => this.nodeById.get(id))
      .filter((node): node is AtlasNode => node !== undefined);
    this.focusedClusterId = clusterId;
    if (nodes.length) {
      const bounds = {
        minX: Math.min(...nodes.map((node) => node.x)) - 82,
        minY: Math.min(...nodes.map((node) => node.y)) - 82,
        maxX: Math.max(...nodes.map((node) => node.x)) + 82,
        maxY: Math.max(...nodes.map((node) => node.y)) + 82,
      };
      const fitted = fitTransform(bounds, this.width, this.height, this.fitInsets());
      if (fitted.zoom > 1.65) {
        const insets = this.fitInsets();
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        const viewportCenterX = insets.left + (this.width - insets.left - insets.right) / 2;
        const viewportCenterY = insets.top + (this.height - insets.top - insets.bottom) / 2;
        this.transform = {
          x: viewportCenterX - centerX * 1.65,
          y: viewportCenterY - centerY * 1.65,
          zoom: 1.65,
        };
      } else {
        this.transform = fitted;
      }
      this.hasUserTransform = true;
    }
    this.canvas.setAttribute(
      "aria-label",
      `${cluster.label} cluster focused. ${cluster.nodeIds.length} nodes. Press Escape to show all clusters.`,
    );
    this.updateFocusStatus();
    this.updateRuntimeStatus();
    this.requestPaint();
  }

  private clearClusterFocus(): void {
    if (this.focusedClusterId === null && this.hovered === null) return;
    this.focusedClusterId = null;
    this.hovered = null;
    this.fit();
    this.updateFocusStatus();
    this.canvas.setAttribute(
      "aria-label",
      "All clusters visible. Drag to pan, scroll to zoom, and hover a node to focus it.",
    );
    this.requestPaint();
  }

  private updateFocusStatus(): void {
    const cluster = this.graph.clusters.find(
      (candidate) => candidate.id === this.focusedClusterId,
    );
    this.countStatus.textContent = cluster
      ? `FOCUS · ${cluster.label} · AMBIENT VISUAL ONLY`
      : "FOCUS · ALL CLUSTERS · AMBIENT VISUAL ONLY";
    if (this.hovered) {
      this.focusStatus.textContent = this.hovered.path
        ? `${this.hovered.title} · ${this.hovered.path} · ${formatCount(this.hovered.degree, "relation")}`
        : `${this.hovered.title} · ${formatCount(this.hovered.degree, "relation")} · synthetic sample`;
    } else if (cluster) {
      this.focusStatus.textContent = `${formatCount(cluster.nodeIds.length, "node")} · Escape returns to all`;
    } else {
      this.focusStatus.textContent = "Click a node to isolate its cluster · C/←/→ cycles · Esc shows all";
    }
  }

  private updateRuntimeStatus(): void {
    const motion = this.preferences.systemReducedMotion
      ? "REDUCED"
      : this.preferences.motionEnabled
        ? "ON"
        : "OFF";
    const quality = this.preferences.qualityState.replace(/-/g, " ").toLocaleUpperCase();
    this.runtimeStatus.textContent = [
      `ZOOM ${Math.round(this.transform.zoom * 100)}%`,
      `MOTION ${motion}`,
      `LABELS ${this.preferences.labelsEnabled ? "ON" : "OFF"}`,
      `QUALITY ${quality}`,
      this.compositionKey !== "wide" ? "LAYOUT PORTRAIT" : "LAYOUT WIDE",
    ].join(" · ");
  }

  private hitTest(clientX: number, clientY: number): AtlasNode | null {
    const bounds = this.canvas.getBoundingClientRect();
    const x = clientX - bounds.left;
    const y = clientY - bounds.top;
    const worldX = (x - this.transform.x) / this.transform.zoom;
    const worldY = (y - this.transform.y) / this.transform.zoom;
    const cellSize = 96;
    const cellX = Math.floor(worldX / cellSize);
    const cellY = Math.floor(worldY / cellSize);
    const candidates: AtlasNode[] = [];
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        candidates.push(...(this.spatialIndex.get(`${cellX + offsetX}:${cellY + offsetY}`) ?? []));
      }
    }
    const time = performance.now();
    let closest: AtlasNode | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const node of candidates) {
      if (this.focusedClusterId && node.clusterId !== this.focusedClusterId) continue;
      const point = this.nodeScreenPosition(node, time);
      const radius = Math.max(9, node.radius * this.transform.zoom + 5);
      const distance = Math.hypot(x - point.x, y - point.y);
      if (distance <= radius && distance < closestDistance) {
        closest = node;
        closestDistance = distance;
      }
    }
    return closest;
  }

  private shouldAnimate(): boolean {
    return (
      this.preferences.motionEnabled &&
      !this.preferences.systemReducedMotion &&
      !document.hidden &&
      this.isVisible &&
      !this.destroyed
    );
  }

  private updateAnimation(): void {
    if (!this.shouldAnimate() && this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    this.requestPaint();
  }

  private requestPaint(): void {
    if (this.destroyed) return;
    if (this.shouldAnimate()) {
      if (this.frameId === null) this.frameId = requestAnimationFrame((time) => this.animate(time));
      return;
    }
    this.paint(performance.now());
  }

  private animate(time: number): void {
    this.frameId = null;
    const minimumInterval = this.preferences.lowPower ? 33 : 16;
    if (time - this.lastPaint >= minimumInterval) this.paint(time);
    if (this.shouldAnimate()) this.frameId = requestAnimationFrame((next) => this.animate(next));
  }

  private nodeScreenPosition(
    node: AtlasNode,
    time: number,
    animated = this.shouldAnimate(),
  ): { x: number; y: number } {
    const drift = animated ? Math.sin(time * 0.00018 + node.phase) * 3.4 : 0;
    const crossDrift = animated ? Math.cos(time * 0.00013 + node.phase * 1.7) * 2.2 : 0;
    return {
      x: (node.x + drift) * this.transform.zoom + this.transform.x,
      y: (node.y + crossDrift) * this.transform.zoom + this.transform.y,
    };
  }

  private worldToScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: x * this.transform.zoom + this.transform.x,
      y: y * this.transform.zoom + this.transform.y,
    };
  }

  private prioritizedClusters(limit: number): AtlasGraph["clusters"] {
    return [...this.graph.clusters]
      .sort((left, right) => {
        if (left.id === this.focusedClusterId) return -1;
        if (right.id === this.focusedClusterId) return 1;
        return right.nodeIds.length - left.nodeIds.length || left.id.localeCompare(right.id);
      })
      .slice(0, limit);
  }

  private paint(time: number): void {
    this.lastPaint = time;
    const animated = this.shouldAnimate();
    if (animated) {
      this.parallaxCurrent.x += (this.parallaxTarget.x - this.parallaxCurrent.x) * 0.035;
      this.parallaxCurrent.y += (this.parallaxTarget.y - this.parallaxCurrent.y) * 0.035;
    } else {
      this.parallaxCurrent.x = 0;
      this.parallaxCurrent.y = 0;
    }
    const ratio = Number(this.canvas.dataset.pixelRatio ?? "1") || 1;
    const context = this.context;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    this.drawBackground(context);
    this.drawClusterHalos(context, time, animated);
    this.drawAmbientFibers(context, time, animated);
    this.drawAmbient(context, time, animated);

    const positions = new Map(
      this.graph.nodes.map((node) => [node.id, this.nodeScreenPosition(node, time, animated)]),
    );
    this.drawEdges(context, positions);
    this.drawNodes(context, positions, time);
    this.drawClusterLabels(context);
    if (this.graph.nodes.length === 0) this.drawEmptyState(context);
  }

  private drawBackground(context: CanvasRenderingContext2D): void {
    context.fillStyle = "rgb(4, 5, 13)";
    context.fillRect(0, 0, this.width, this.height);
    const wash = context.createRadialGradient(
      this.width * 0.5,
      this.height * 0.42,
      0,
      this.width * 0.5,
      this.height * 0.42,
      Math.max(this.width, this.height) * 0.74,
    );
    wash.addColorStop(0, "rgba(50, 25, 92, 0.2)");
    wash.addColorStop(0.46, "rgba(15, 18, 42, 0.14)");
    wash.addColorStop(1, "rgba(2, 3, 9, 0)");
    context.fillStyle = wash;
    context.fillRect(0, 0, this.width, this.height);

  }

  private drawClusterHalos(
    context: CanvasRenderingContext2D,
    time: number,
    animated: boolean,
  ): void {
    context.save();
    context.globalCompositeOperation = "lighter";
    const haloLimit = this.preferences.lowPower ? 32 : 64;
    for (const cluster of this.prioritizedClusters(haloLimit)) {
      const point = this.worldToScreen(cluster.x, cluster.y);
      point.x += this.parallaxCurrent.x * 2.4;
      point.y += this.parallaxCurrent.y * 2.4;
      const pulse = animated ? 1 + Math.sin(time * 0.00024 + cluster.x * 0.002) * 0.028 : 1;
      const radius = Math.max(92, 380 * this.transform.zoom * pulse);
      if (
        point.x + radius < 0 ||
        point.y + radius < 0 ||
        point.x - radius > this.width ||
        point.y - radius > this.height
      ) {
        continue;
      }
      context.globalAlpha =
        this.focusedClusterId && cluster.id !== this.focusedClusterId ? 0.16 : 1;
      const gradient = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
      // A shared violet envelope lets the six truthful clusters read as one
      // continuous organism. Semantic accents remain in the inner knots.
      gradient.addColorStop(0, accentRgba("violet", this.preferences.lowPower ? 0.1 : 0.22));
      gradient.addColorStop(0.42, accentRgba("violet", this.preferences.lowPower ? 0.042 : 0.09));
      gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();

      if (!this.preferences.lowPower) {
        // An offset secondary lobe breaks the radial badge-like silhouette
        // without adding nodes, relations, or any hit-testable geometry.
        const lobeRadius = radius * 0.66;
        const lobeX =
          point.x + Math.sin(cluster.x * 0.017 + cluster.y * 0.009) * radius * 0.18;
        const lobeY =
          point.y + Math.cos(cluster.x * 0.011 - cluster.y * 0.013) * radius * 0.12;
        const lobe = context.createRadialGradient(
          lobeX,
          lobeY,
          0,
          lobeX,
          lobeY,
          lobeRadius,
        );
        lobe.addColorStop(0, accentRgba("lavender", 0.15));
        lobe.addColorStop(0.5, accentRgba("violet", 0.052));
        lobe.addColorStop(1, "rgba(0, 0, 0, 0)");
        context.fillStyle = lobe;
        context.beginPath();
        context.arc(lobeX, lobeY, lobeRadius, 0, Math.PI * 2);
        context.fill();

        const innerRadius = Math.max(34, 118 * this.transform.zoom * pulse);
        const inner = context.createRadialGradient(
          point.x,
          point.y,
          0,
          point.x,
          point.y,
          innerRadius,
        );
        inner.addColorStop(0, accentRgba(cluster.accent, 0.4));
        inner.addColorStop(0.5, accentRgba(cluster.accent, 0.14));
        inner.addColorStop(1, "rgba(0, 0, 0, 0)");
        context.fillStyle = inner;
        context.beginPath();
        context.arc(point.x, point.y, innerRadius, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.globalAlpha = 1;
    context.restore();
  }

  private drawAmbientFibers(
    context: CanvasRenderingContext2D,
    time: number,
    animated: boolean,
  ): void {
    context.save();
    context.globalCompositeOperation = "lighter";
    for (const fiber of this.fibers) {
      const focusFactor = this.focusedClusterId
        ? fiber.clusterId === this.focusedClusterId
          ? 1
          : fiber.clusterId === null
            ? 0.05
            : 0.035
        : 1;
      const startX = fiber.startX * this.transform.zoom + this.transform.x;
      const startY = fiber.startY * this.transform.zoom + this.transform.y;
      const controlX = fiber.controlX * this.transform.zoom + this.transform.x;
      const controlY = fiber.controlY * this.transform.zoom + this.transform.y;
      const endX = fiber.endX * this.transform.zoom + this.transform.x;
      const endY = fiber.endY * this.transform.zoom + this.transform.y;
      const minX = Math.min(startX, controlX, endX);
      const maxX = Math.max(startX, controlX, endX);
      const minY = Math.min(startY, controlY, endY);
      const maxY = Math.max(startY, controlY, endY);
      if (maxX < -8 || maxY < -8 || minX > this.width + 8 || minY > this.height + 8) continue;
      context.globalAlpha = fiber.alpha * focusFactor;
      context.strokeStyle = ACCENTS[fiber.accent].solid;
      context.lineWidth = Math.max(0.34, fiber.width * Math.sqrt(this.transform.zoom));
      context.beginPath();
      context.moveTo(startX, startY);
      context.quadraticCurveTo(controlX, controlY, endX, endY);
      context.stroke();

      if (fiber.signal && focusFactor > 0.1) {
        const progress = animated ? (fiber.phase + time * 0.000035) % 1 : fiber.phase;
        const signal = quadraticPoint(
          startX,
          startY,
          controlX,
          controlY,
          endX,
          endY,
          progress,
        );
        context.globalAlpha = (animated ? 0.34 : 0.19) * focusFactor;
        context.fillStyle = ACCENTS[fiber.accent].solid;
        context.beginPath();
        context.arc(signal.x, signal.y, this.preferences.lowPower ? 1.45 : 2.2, 0, Math.PI * 2);
        context.fill();
        context.globalAlpha = (animated ? 0.92 : 0.55) * focusFactor;
        context.fillStyle = "rgb(255, 252, 255)";
        context.beginPath();
        context.arc(signal.x, signal.y, 0.65, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.restore();
  }

  private drawAmbient(
    context: CanvasRenderingContext2D,
    time: number,
    animated: boolean,
  ): void {
    context.save();
    for (const additive of [false, true]) {
      context.globalCompositeOperation = additive ? "lighter" : "source-over";
      let lastAccent: AtlasAccent | null = null;
      for (const particle of this.particles) {
        const bright = particle.tier === "core" || particle.tier === "filament";
        if (bright !== additive) continue;
        if (particle.accent !== lastAccent) {
          context.fillStyle = ACCENTS[particle.accent].solid;
          lastAccent = particle.accent;
        }
        this.drawAmbientParticle(context, particle, time, animated);
      }
    }
    context.globalAlpha = 1;
    context.restore();
  }

  private drawAmbientParticle(
    context: CanvasRenderingContext2D,
    particle: AmbientParticle,
    time: number,
    animated: boolean,
  ): void {
    const breath =
      animated && particle.clusterId
        ? 1 + Math.sin(time * 0.00022 + particle.phase * 0.31) * 0.024
        : 1;
    const drift = animated
      ? Math.sin(time * (particle.tier === "field" ? 0.000045 : 0.00007) + particle.phase) *
        (particle.tier === "field" ? 7 : 3.2)
      : 0;
    const worldX =
      particle.anchorX + (particle.x - particle.anchorX) * breath + drift * particle.depth * 0.42;
    const worldY =
      particle.anchorY + (particle.y - particle.anchorY) * breath - drift * particle.depth * 0.18;
    const x =
      worldX * this.transform.zoom +
      this.transform.x +
      this.parallaxCurrent.x * particle.depth * 3.2;
    const y =
      worldY * this.transform.zoom +
      this.transform.y +
      this.parallaxCurrent.y * particle.depth * 3.2;
    if (x < -5 || y < -5 || x > this.width + 5 || y > this.height + 5) return;
    const focusFactor = this.focusedClusterId
      ? particle.clusterId === this.focusedClusterId
        ? 1
        : particle.clusterId === null
          ? 0.15
          : 0.08
      : 1;
    const size = Math.max(
      particle.tier === "core" ? 0.82 : 0.48,
      particle.radius * (0.86 + Math.sqrt(this.transform.zoom) * 0.82),
    );
    if (particle.tier === "core" || particle.tier === "halo") {
      context.globalAlpha = particle.alpha * focusFactor * (particle.tier === "core" ? 0.25 : 0.15);
      const glowSize = size * (particle.tier === "core" ? 3.4 : 2.5);
      context.fillRect(x - glowSize / 2, y - glowSize / 2, glowSize, glowSize);
    }
    context.globalAlpha = particle.alpha * focusFactor;
    context.fillRect(x - size / 2, y - size / 2, size, size);
    if (particle.tier === "core" && particle.alpha > 0.78 && !this.preferences.lowPower) {
      context.globalAlpha = (particle.alpha - 0.58) * focusFactor;
      context.fillRect(x - size * 1.25, y - 0.22, size * 2.5, 0.44);
      context.fillRect(x - 0.22, y - size * 1.25, 0.44, size * 2.5);
    }
  }

  private edgeOpacity(edge: AtlasEdge): number {
    if (this.focusedClusterId) {
      const source = this.nodeById.get(edge.source);
      const target = this.nodeById.get(edge.target);
      if (
        source?.clusterId !== this.focusedClusterId ||
        target?.clusterId !== this.focusedClusterId
      ) {
        return 0.018;
      }
    }
    if (!this.hovered) return edge.kind === "synthetic-thread" ? 0.2 : 0.24;
    if (edge.source === this.hovered.id || edge.target === this.hovered.id) return 0.88;
    const related = this.neighbors.get(this.hovered.id);
    if (related?.has(edge.source) && related.has(edge.target)) return 0.26;
    return 0.035;
  }

  private drawEdges(
    context: CanvasRenderingContext2D,
    positions: ReadonlyMap<string, { x: number; y: number }>,
  ): void {
    context.save();
    for (const edge of this.graph.edges) {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!source || !target) continue;
      const opacity = this.edgeOpacity(edge);
      const color =
        edge.kind === "shared-tag"
          ? "242, 180, 86"
          : edge.kind === "link"
            ? "89, 218, 231"
            : "174, 127, 255";
      const bend = Math.min(34, Math.hypot(target.x - source.x, target.y - source.y) * 0.08);
      const midpointX = (source.x + target.x) / 2 + (target.y - source.y) * 0.035;
      const midpointY = (source.y + target.y) / 2 - (target.x - source.x) * 0.035 - bend * 0.08;

      context.globalCompositeOperation = "lighter";
      context.strokeStyle = `rgba(${color}, ${opacity * 0.22})`;
      context.lineWidth = this.preferences.lowPower ? 1.45 : 2.35;
      context.beginPath();
      context.moveTo(source.x, source.y);
      context.quadraticCurveTo(midpointX, midpointY, target.x, target.y);
      context.stroke();

      context.globalCompositeOperation = "source-over";
      context.strokeStyle = `rgba(${color}, ${opacity})`;
      context.lineWidth = this.preferences.lowPower ? 0.64 : 0.78;
      context.beginPath();
      context.moveTo(source.x, source.y);
      context.quadraticCurveTo(midpointX, midpointY, target.x, target.y);
      context.stroke();
    }
    context.restore();
  }

  private nodeOpacity(node: AtlasNode): number {
    if (this.focusedClusterId && node.clusterId !== this.focusedClusterId) return 0.075;
    if (!this.hovered) return 1;
    if (node.id === this.hovered.id || this.neighbors.get(this.hovered.id)?.has(node.id)) return 1;
    return 0.22;
  }

  private drawNodes(
    context: CanvasRenderingContext2D,
    positions: ReadonlyMap<string, { x: number; y: number }>,
    time: number,
  ): void {
    context.save();
    context.globalCompositeOperation = "lighter";
    for (const node of this.graph.nodes) {
      const point = positions.get(node.id);
      if (!point || point.x < -80 || point.y < -80 || point.x > this.width + 80 || point.y > this.height + 80) continue;
      const selected = node.id === this.hovered?.id;
      const relatedOpacity = this.nodeOpacity(node);
      const pulse = this.shouldAnimate() ? 1 + Math.sin(time * 0.0011 + node.phase) * 0.09 : 1;
      const coreRadius = Math.max(1.8, node.radius * Math.sqrt(this.transform.zoom) * pulse);
      const accent = ACCENTS[node.accent];
      if (
        !this.preferences.lowPower &&
        (selected || this.majorGlowIds.has(node.id))
      ) {
        const haloRadius = coreRadius * (selected ? 5.8 : 4.2);
        const halo = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, haloRadius);
        halo.addColorStop(0, accent.soft);
        halo.addColorStop(0.24, accent.soft.replace(/0\.\d+\)/, `${0.24 * relatedOpacity})`));
        halo.addColorStop(1, "rgba(0, 0, 0, 0)");
        context.fillStyle = halo;
        context.beginPath();
        context.arc(point.x, point.y, haloRadius, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = relatedOpacity;
      context.fillStyle = accent.solid;
      context.beginPath();
      context.arc(point.x, point.y, coreRadius * 1.35, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "rgba(255, 253, 255, 0.97)";
      context.beginPath();
      context.arc(point.x, point.y, Math.max(0.85, coreRadius * 0.48), 0, Math.PI * 2);
      context.fill();
      if (selected) {
        context.strokeStyle = "rgba(230, 210, 255, 0.86)";
        context.lineWidth = 1;
        context.beginPath();
        context.arc(point.x, point.y, coreRadius * 2.65, 0, Math.PI * 2);
        context.stroke();
      }
      context.globalAlpha = 1;
    }
    context.globalCompositeOperation = "source-over";
    if (this.preferences.labelsEnabled) this.drawNodeLabels(context, positions);
    else if (this.hovered) this.drawFocusedLabel(context, this.hovered, positions.get(this.hovered.id));
    context.restore();
  }

  private drawNodeLabels(
    context: CanvasRenderingContext2D,
    positions: ReadonlyMap<string, { x: number; y: number }>,
  ): void {
    context.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    context.textBaseline = "middle";
    for (const node of this.graph.nodes) {
      if (!node.labelVisible && node.id !== this.hovered?.id) continue;
      const point = positions.get(node.id);
      if (!point) continue;
      const emphasized = node.id === this.hovered?.id;
      context.fillStyle = emphasized ? "rgba(250, 247, 255, 0.96)" : "rgba(226, 216, 244, 0.66)";
      context.fillText(node.title.slice(0, 34), point.x + 11, point.y - (emphasized ? 2 : 0));
    }
  }

  private drawFocusedLabel(
    context: CanvasRenderingContext2D,
    node: AtlasNode,
    point: { x: number; y: number } | undefined,
  ): void {
    if (!point) return;
    context.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    context.fillStyle = "rgba(250, 247, 255, 0.96)";
    context.fillText(node.title.slice(0, 34), point.x + 11, point.y);
  }

  private drawClusterLabels(context: CanvasRenderingContext2D): void {
    if (!this.preferences.labelsEnabled) return;
    context.save();
    context.font = "600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (const cluster of this.prioritizedClusters(24)) {
      context.globalAlpha =
        this.focusedClusterId && cluster.id !== this.focusedClusterId ? 0.16 : 1;
      const labelOffset = this.compositionKey === "wide" ? 96 : 84;
      const point = this.worldToScreen(cluster.x, cluster.y - labelOffset);
      const text = cluster.label.toLocaleUpperCase();
      const metrics = context.measureText(text);
      const width = metrics.width + 20;
      context.fillStyle = "rgba(7, 8, 19, 0.74)";
      roundedRect(context, point.x - width / 2, point.y - 12, width, 24, 12);
      context.fill();
      context.strokeStyle = ACCENTS[cluster.accent].soft;
      context.lineWidth = 0.7;
      context.stroke();
      context.fillStyle = ACCENTS[cluster.accent].solid;
      context.fillText(text, point.x, point.y + 0.5);
    }
    context.globalAlpha = 1;
    context.restore();
  }

  private drawEmptyState(context: CanvasRenderingContext2D): void {
    context.save();
    context.textAlign = "center";
    context.fillStyle = "rgba(237, 229, 252, 0.82)";
    context.font = "500 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    context.fillText("NO MARKDOWN NOTE METADATA FOUND", this.width / 2, this.height / 2 - 7);
    context.fillStyle = "rgba(196, 181, 220, 0.5)";
    context.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    context.fillText("Switch to the recording-safe showcase or add a Markdown note.", this.width / 2, this.height / 2 + 18);
    context.restore();
  }
}
