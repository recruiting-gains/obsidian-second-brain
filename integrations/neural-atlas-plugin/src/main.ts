/**
 * Neural Atlas host integration.
 *
 * Privacy boundary: recording-safe mode does not query the vault at all. Live
 * mode uses getMarkdownFiles() and MetadataCache only. No read(), cachedRead(),
 * request, fetch, telemetry, filesystem API, or note mutation appears here.
 */

import {
  App,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

import {
  buildLiveGraph,
  buildSyntheticGraph,
  type AtlasGraph,
  type AtlasMode,
  type AtlasNode,
  type LiveNoteInput,
} from "./model";
import {
  AtlasRenderer,
  type AtlasRendererPreferences,
} from "./renderer";

export const NEURAL_ATLAS_VIEW = "neural-atlas-view";
const SAFE_INITIAL_MODE: AtlasMode = "synthetic";

type StartupBehavior = "never" | "recording-safe" | "live";
type RenderQuality = "auto" | "low" | "full";

interface NeuralAtlasSettings {
  startupBehavior: StartupBehavior;
  lastMode: AtlasMode;
  motionEnabled: boolean;
  labelsEnabled: boolean;
  renderQuality: RenderQuality;
}

const DEFAULT_SETTINGS: NeuralAtlasSettings = {
  // Never replace or cover the user's normal note when the workspace opens.
  startupBehavior: "never",
  lastMode: "synthetic",
  motionEnabled: true,
  labelsEnabled: true,
  renderQuality: "auto",
};

function isMode(value: unknown): value is AtlasMode {
  return value === "synthetic" || value === "live";
}

function isStartupBehavior(value: unknown): value is StartupBehavior {
  return value === "never" || value === "recording-safe" || value === "live";
}

function isRenderQuality(value: unknown): value is RenderQuality {
  return value === "auto" || value === "low" || value === "full";
}

export default class NeuralAtlasPlugin extends Plugin {
  override settings: NeuralAtlasSettings = DEFAULT_SETTINGS;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(NEURAL_ATLAS_VIEW, (leaf) => new NeuralAtlasView(leaf, this));

    this.addRibbonIcon("network", "Open Neural Atlas", () => void this.openAtlas());
    this.addCommand({
      id: "open-neural-atlas",
      name: "Open Neural Atlas",
      callback: () => void this.openAtlas(),
    });
    this.addCommand({
      id: "toggle-recording-safe",
      name: "Open recording-safe showcase",
      // This command is intentionally one-way. If no view exists—or a live
      // view is hidden—it can never expose live labels before becoming safe.
      callback: () => void this.openAtlas("synthetic"),
    });
    this.addCommand({
      id: "toggle-motion",
      name: "Toggle motion",
      callback: () => void this.withAtlas((view) => view.toggleMotion()),
    });
    this.addCommand({
      id: "fit-graph",
      name: "Fit graph to view",
      callback: () => void this.withAtlas((view) => view.fit()),
    });
    this.addCommand({
      id: "reset-view",
      name: "Reset graph view",
      callback: () => void this.withAtlas((view) => view.reset()),
    });
    this.addCommand({
      id: "toggle-labels",
      name: "Toggle graph labels",
      callback: () => void this.withAtlas((view) => view.toggleLabels()),
    });
    this.addSettingTab(new NeuralAtlasSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.startupBehavior === "recording-safe") {
        void this.openAtlas("synthetic");
      } else if (this.settings.startupBehavior === "live") {
        void this.openAtlas("live");
      }
    });
  }

  override onunload(): void {
    this.app.workspace.detachLeavesOfType(NEURAL_ATLAS_VIEW);
  }

  private async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<NeuralAtlasSettings> | null;
    this.settings = {
      startupBehavior: isStartupBehavior(loaded?.startupBehavior)
        ? loaded.startupBehavior
        : DEFAULT_SETTINGS.startupBehavior,
      lastMode: isMode(loaded?.lastMode) ? loaded.lastMode : DEFAULT_SETTINGS.lastMode,
      motionEnabled:
        typeof loaded?.motionEnabled === "boolean"
          ? loaded.motionEnabled
          : DEFAULT_SETTINGS.motionEnabled,
      labelsEnabled:
        typeof loaded?.labelsEnabled === "boolean"
          ? loaded.labelsEnabled
          : DEFAULT_SETTINGS.labelsEnabled,
      renderQuality: isRenderQuality(loaded?.renderQuality)
        ? loaded.renderQuality
        : DEFAULT_SETTINGS.renderQuality,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async setLastMode(mode: AtlasMode): Promise<void> {
    this.settings.lastMode = mode;
    await this.saveSettings();
  }

  async setMotion(enabled: boolean): Promise<void> {
    this.settings.motionEnabled = enabled;
    await this.saveSettings();
    this.updateOpenViews();
  }

  async setLabels(enabled: boolean): Promise<void> {
    this.settings.labelsEnabled = enabled;
    await this.saveSettings();
    this.updateOpenViews();
  }

  updateOpenViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(NEURAL_ATLAS_VIEW)) {
      if (leaf.view instanceof NeuralAtlasView) leaf.view.applySettings();
    }
  }

  rendererPreferences(systemReducedMotion: boolean): AtlasRendererPreferences {
    const lowPower = this.isLowPower();
    const qualityState: AtlasRendererPreferences["qualityState"] =
      this.settings.renderQuality === "auto"
        ? lowPower
          ? "auto-low-power"
          : "auto-full"
        : lowPower
          ? "low-power"
          : "full";
    return {
      motionEnabled: this.settings.motionEnabled,
      labelsEnabled: this.settings.labelsEnabled,
      lowPower,
      systemReducedMotion,
      qualityState,
    };
  }

  private isLowPower(): boolean {
    if (this.settings.renderQuality === "low") return true;
    if (this.settings.renderQuality === "full") return false;
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    return navigator.hardwareConcurrency <= 4 || (deviceMemory !== undefined && deviceMemory <= 4);
  }

  async openAtlas(mode = this.settings.lastMode): Promise<NeuralAtlasView | null> {
    const workspace = this.app.workspace;
    let leaf = workspace.getLeavesOfType(NEURAL_ATLAS_VIEW)[0];
    if (!leaf) {
      // A tab leaf is a center workspace view. Existing Markdown leaves stay intact.
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: NEURAL_ATLAS_VIEW, active: true });
    }
    if (!(leaf.view instanceof NeuralAtlasView)) {
      new Notice("Neural Atlas could not finish opening.");
      return null;
    }
    // Apply the requested privacy state before the leaf is shown. New views
    // always render synthetic data first; existing live views are scrubbed
    // synchronously before reveal when recording-safe mode is requested.
    await leaf.view.setMode(mode);
    await workspace.revealLeaf(leaf);
    return leaf.view;
  }

  private async withAtlas(action: (view: NeuralAtlasView) => void | Promise<void>): Promise<void> {
    const view = await this.openAtlas();
    if (view) await action(view);
  }
}

export class NeuralAtlasView extends ItemView {
  private mode: AtlasMode;
  private renderer: AtlasRenderer | null = null;
  private refreshTimer: number | null = null;
  private readonly reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly reducedMotionListener = (): void => this.applySettings();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: NeuralAtlasPlugin) {
    super(leaf);
    // A restored or newly-created view must never query live vault metadata
    // until an explicit mode request has been applied by openAtlas().
    this.mode = SAFE_INITIAL_MODE;
  }

  getViewType(): string {
    return NEURAL_ATLAS_VIEW;
  }

  getDisplayText(): string {
    return "Neural Atlas";
  }

  override getIcon(): string {
    return "network";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.replaceChildren();
    this.contentEl.addClass("neural-atlas-view");
    this.renderer = new AtlasRenderer(this.contentEl, this.buildGraph(), {
      onToggleMode: () => void this.toggleMode(),
      onToggleMotion: () => void this.toggleMotion(),
      onToggleLabels: () => void this.toggleLabels(),
      onFit: () => this.fit(),
      onReset: () => this.reset(),
      onOpenNode: (node) => this.openNode(node),
    });
    this.applySettings();
    this.reducedMotionQuery.addEventListener("change", this.reducedMotionListener);

    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleLiveRefresh()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleLiveRefresh()));
    this.registerEvent(this.app.vault.on("create", () => this.scheduleLiveRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleLiveRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleLiveRefresh()));
  }

  override async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.reducedMotionQuery.removeEventListener("change", this.reducedMotionListener);
    this.renderer?.destroy();
    this.renderer = null;
    this.contentEl.removeClass("neural-atlas-view");
  }

  async setMode(mode: AtlasMode): Promise<void> {
    if (this.mode === mode && this.renderer) return;
    this.mode = mode;
    this.renderer?.setGraph(this.buildGraph());
    // Persist only after the visible graph has entered the requested state.
    // In particular, live -> synthetic cannot leave private labels on-screen
    // while waiting for a settings write.
    await this.plugin.setLastMode(mode);
  }

  async toggleMode(): Promise<void> {
    await this.setMode(this.mode === "synthetic" ? "live" : "synthetic");
  }

  async toggleMotion(): Promise<void> {
    await this.plugin.setMotion(!this.plugin.settings.motionEnabled);
  }

  async toggleLabels(): Promise<void> {
    await this.plugin.setLabels(!this.plugin.settings.labelsEnabled);
  }

  fit(): void {
    this.renderer?.fit();
  }

  reset(): void {
    this.renderer?.reset();
  }

  applySettings(): void {
    this.renderer?.setPreferences(
      this.plugin.rendererPreferences(this.reducedMotionQuery.matches),
    );
  }

  private scheduleLiveRefresh(): void {
    if (this.mode !== "live") return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      if (this.mode === "live") this.renderer?.setGraph(this.buildGraph(), true);
    }, 240);
  }

  private buildGraph(): AtlasGraph {
    // This branch is the hard recording-safe boundary: it performs no vault query.
    return this.mode === "synthetic"
      ? buildSyntheticGraph()
      : buildLiveGraph(this.metadataSnapshot());
  }

  private metadataSnapshot(): LiveNoteInput[] {
    return this.app.vault.getMarkdownFiles().map((file) => {
      const cache = this.app.metadataCache.getFileCache(file);
      const resolvedLinks = this.app.metadataCache.resolvedLinks[file.path] ?? {};
      return {
        path: file.path,
        basename: file.basename,
        folder: file.parent?.path ?? "",
        links: Object.keys(resolvedLinks),
        tags: cache?.tags?.map((tag) => tag.tag) ?? [],
        frontmatter: cache?.frontmatter ?? {},
      };
    });
  }

  private openNode(node: AtlasNode): void {
    if (this.mode !== "live" || !node.path) return;
    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file);
  }
}

class NeuralAtlasSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: NeuralAtlasPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Neural Atlas" });

    new Setting(containerEl)
      .setName("Opening behavior")
      .setDesc("Default is never: Neural Atlas opens only when requested and does not replace a normal note.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("never", "Never open automatically")
          .addOption("recording-safe", "Open recording-safe showcase")
          .addOption("live", "Open live metadata map")
          .setValue(this.plugin.settings.startupBehavior)
          .onChange(async (value) => {
            if (!isStartupBehavior(value)) return;
            this.plugin.settings.startupBehavior = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Default mode")
      .setDesc("Recording-safe uses a fixed synthetic graph. Live uses local cached metadata, never note bodies.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("synthetic", "Synthetic recording-safe")
          .addOption("live", "Live metadata")
          .setValue(this.plugin.settings.lastMode)
          .onChange(async (value) => {
            if (!isMode(value)) return;
            await this.plugin.setLastMode(value);
          }),
      );

    new Setting(containerEl)
      .setName("Motion")
      .setDesc("Slow ambient drift and pulse. The operating-system reduced-motion preference always wins.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.motionEnabled).onChange(async (value) => {
          await this.plugin.setMotion(value);
        }),
      );

    new Setting(containerEl)
      .setName("Labels")
      .setDesc("Show a sparse set of node and cluster labels. Hover focus remains available when hidden.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.labelsEnabled).onChange(async (value) => {
          await this.plugin.setLabels(value);
        }),
      );

    new Setting(containerEl)
      .setName("Rendering quality")
      .setDesc("Auto reduces particles, glow work, pixel density, and frame rate on lower-power devices.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", "Auto")
          .addOption("low", "Low power")
          .addOption("full", "Full")
          .setValue(this.plugin.settings.renderQuality)
          .onChange(async (value) => {
            if (!isRenderQuality(value)) return;
            this.plugin.settings.renderQuality = value;
            await this.plugin.saveSettings();
            this.plugin.updateOpenViews();
          }),
      );
  }
}
