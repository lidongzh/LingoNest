import type { CaptureEvent, LingoNestPluginData, LingoNestSettings, PluginState } from "../types";

type PersistFn = (data: LingoNestPluginData) => Promise<void>;

export class StateStore {
  private readonly persist: PersistFn;
  private data: LingoNestPluginData;

  constructor(initialData: LingoNestPluginData, persist: PersistFn) {
    this.data = initialData;
    this.persist = persist;
  }

  get settings(): LingoNestSettings {
    return this.data.settings;
  }

  get state(): PluginState {
    return this.data.state;
  }

  snapshot(): LingoNestPluginData {
    return this.data;
  }

  async updateSettings(mutator: (settings: LingoNestSettings) => void): Promise<void> {
    mutator(this.data.settings);
    await this.persist(this.data);
  }

  async updateState(mutator: (state: PluginState) => void): Promise<void> {
    mutator(this.data.state);
    await this.persist(this.data);
  }

  async setCaptureEvent(event: CaptureEvent): Promise<void> {
    this.data.state.captureEvents[event.id] = event;
    await this.persist(this.data);
  }

  async handleNoteRename(oldPath: string, newPath: string): Promise<void> {
    let didUpdate = false;
    for (const item of Object.values(this.data.state.items)) {
      if (item.notePath === oldPath) {
        item.notePath = newPath;
        item.updatedAt = new Date().toISOString();
        didUpdate = true;
      }
    }
    for (const summary of Object.values(this.data.state.threadSummaries)) {
      if (summary.notePath === oldPath) {
        summary.notePath = newPath;
        summary.updatedAt = new Date().toISOString();
        didUpdate = true;
      }
    }
    if (didUpdate) {
      await this.persist(this.data);
    }
  }
}
