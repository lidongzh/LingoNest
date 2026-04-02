import {
  Events,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf
} from "obsidian";
import { ChatService } from "./chat/chatService";
import { mergePluginData } from "./defaults";
import { ensurePromptProfiles } from "./prompts";
import { createProvider } from "./providers";
import { ReviewService } from "./review/reviewService";
import { LingoNestSettingTab } from "./settings";
import { ItemStorage } from "./storage/itemStorage";
import { StateStore } from "./storage/stateStore";
import { CHAT_VIEW_TYPE, ChatView } from "./views/chatView";
import { ITEM_BROWSER_VIEW_TYPE, ItemBrowserView } from "./views/itemBrowserView";
import { REVIEW_VIEW_TYPE, ReviewView } from "./views/reviewView";
import type { EventRef } from "obsidian";

export class LingoNestPlugin extends Plugin {
  readonly events = new Events();
  store!: StateStore;
  itemStorage!: ItemStorage;
  chatService!: ChatService;
  reviewService!: ReviewService;
  private lastActivatedViewType = CHAT_VIEW_TYPE;

  async onload(): Promise<void> {
    const loaded = mergePluginData(await this.loadData());
    loaded.settings.prompts.profiles = ensurePromptProfiles(loaded.settings.prompts.profiles);
    this.store = new StateStore(loaded, async (data) => {
      await this.saveData(data);
    });
    this.itemStorage = new ItemStorage(this.app, this.store);
    this.chatService = new ChatService(this);
    this.reviewService = new ReviewService(this);

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.registerView(REVIEW_VIEW_TYPE, (leaf) => new ReviewView(leaf, this));
    this.registerView(ITEM_BROWSER_VIEW_TYPE, (leaf) => new ItemBrowserView(leaf, this));
    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        if (file instanceof TFile) {
          await this.store.handleNoteRename(oldPath, file.path);
          this.notifyStateChanged();
        }
      })
    );

    this.addRibbonIcon("languages", "Open LingoNest", async () => {
      await this.activatePrimaryView();
    });

    this.addCommand({
      id: "open-lingonest-chat",
      name: "Open LingoNest Chat",
      callback: async () => {
        await this.activateChatView();
      }
    });
    this.addCommand({
      id: "open-lingonest-review",
      name: "Open LingoNest Review",
      callback: async () => {
        await this.activateReviewView();
      }
    });
    this.addCommand({
      id: "open-lingonest-items",
      name: "Open LingoNest Items",
      callback: async () => {
        await this.activateItemBrowserView();
      }
    });
    this.addCommand({
      id: "save-current-selection-as-learning-item",
      name: "Save Selected Note Text As Learning Item",
      callback: async () => {
        const selection = this.getActiveSelection();
        if (!selection) {
          new Notice("This command only saves text selected in a regular note.");
          return;
        }
        try {
          await this.chatService.saveSelection(selection);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Selection save failed.");
        }
      }
    });
    this.addCommand({
      id: "review-due-items",
      name: "Review Due Items",
      callback: async () => {
        await this.activateReviewView();
      }
    });

    this.addSettingTab(new LingoNestSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    await this.detachLeaves(CHAT_VIEW_TYPE);
    await this.detachLeaves(REVIEW_VIEW_TYPE);
    await this.detachLeaves(ITEM_BROWSER_VIEW_TYPE);
  }

  getProvider() {
    return createProvider(this.store.settings);
  }

  notifyStateChanged(): void {
    this.events.trigger("state-change");
  }

  onStateChange(callback: () => void): EventRef {
    return this.events.on("state-change", callback);
  }

  getActiveSelection(): string {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.editor?.getSelection()?.trim() ?? "";
  }

  async openNotePath(path: string): Promise<void> {
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      const recovered = await this.itemStorage.ensureItemNoteExistsByPath(path);
      if (recovered) {
        file = this.app.vault.getAbstractFileByPath(recovered.notePath);
      }
    }
    if (!(file instanceof TFile)) {
      new Notice(`Could not find ${path}`);
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  async activateChatView(): Promise<void> {
    this.lastActivatedViewType = CHAT_VIEW_TYPE;
    await this.activateWorkspaceView(CHAT_VIEW_TYPE);
  }

  async activateReviewView(): Promise<void> {
    this.lastActivatedViewType = REVIEW_VIEW_TYPE;
    await this.activateWorkspaceView(REVIEW_VIEW_TYPE);
  }

  async activateItemBrowserView(itemId: string | null = null): Promise<void> {
    this.lastActivatedViewType = ITEM_BROWSER_VIEW_TYPE;
    const leaf = await this.activateWorkspaceView(ITEM_BROWSER_VIEW_TYPE);
    const view = leaf.view;
    if (view instanceof ItemBrowserView && itemId) {
      await view.selectItem(itemId);
    }
  }

  async activatePrimaryView(): Promise<void> {
    const existing = this.getMainWorkspaceLeaf(this.lastActivatedViewType);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }

    const fallbackExisting =
      this.getMainWorkspaceLeaf(CHAT_VIEW_TYPE) ??
      this.getMainWorkspaceLeaf(ITEM_BROWSER_VIEW_TYPE) ??
      this.getMainWorkspaceLeaf(REVIEW_VIEW_TYPE);
    if (fallbackExisting) {
      this.app.workspace.revealLeaf(fallbackExisting);
      return;
    }

    await this.activateChatView();
  }

  private async activateWorkspaceView(viewType: string): Promise<WorkspaceLeaf> {
    const existing = this.getMainWorkspaceLeaf(viewType);
    if (existing) {
      await existing.setViewState({
        type: viewType,
        active: true
      });
      this.app.workspace.revealLeaf(existing);
      return existing;
    }

    for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
      await leaf.setViewState({ type: "empty" });
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: viewType,
      active: true
    });
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  private getMainWorkspaceLeaf(viewType: string): WorkspaceLeaf | null {
    return (
      this.app.workspace
        .getLeavesOfType(viewType)
        .find((leaf) => leaf.getRoot() === this.app.workspace.rootSplit) ?? null
    );
  }

  private async detachLeaves(viewType: string): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
      await leaf.setViewState({ type: "empty" });
    }
  }
}

export default LingoNestPlugin;
