import { ItemView, MarkdownRenderer, type EventRef, type WorkspaceLeaf } from "obsidian";
import type { LingoNestPlugin } from "../main";
import type { LearningItemIndexEntry } from "../types";
import { capitalizeLabel } from "../utils/strings";
import { renderSectionNav } from "./sectionNav";

export const ITEM_BROWSER_VIEW_TYPE = "lingonest-item-browser-view";

export class ItemBrowserView extends ItemView {
  plugin: LingoNestPlugin;
  private selectedItemId: string | null = null;
  private browserScrollTop = 0;
  private stateRef: EventRef | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LingoNestPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return ITEM_BROWSER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "LingoNest Items";
  }

  getIcon(): string {
    return "list-tree";
  }

  async onOpen(): Promise<void> {
    this.stateRef = this.plugin.onStateChange(() => {
      void this.refresh();
    });
    if (this.stateRef) {
      this.registerEvent(this.stateRef);
    }
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.containerEl.empty();
  }

  async selectItem(itemId: string | null): Promise<void> {
    if (itemId) {
      this.selectedItemId = itemId;
    }
    await this.refresh();
  }

  private getAlphabeticalItems(): LearningItemIndexEntry[] {
    return [...this.plugin.itemStorage.getItems()].sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
    );
  }

  private async refresh(): Promise<void> {
    const { containerEl } = this;
    const previousList = containerEl.querySelector<HTMLElement>(".lingonest-item-browser-list");
    if (previousList) {
      this.browserScrollTop = previousList.scrollTop;
    }
    containerEl.empty();
    containerEl.addClass("lingonest-view");
    containerEl.style.setProperty("--lingonest-ui-font-size", `${this.plugin.store.settings.uiFontSize}px`);
    containerEl.style.setProperty("--lingonest-ui-scale", String(this.plugin.store.settings.uiFontSize / 14));

    const wrapper = containerEl.createDiv({ cls: "lingonest-review-layout lingonest-item-browser-layout" });
    renderSectionNav(wrapper, this.plugin, "items");

    const items = this.getAlphabeticalItems();
    if (!items.length) {
      wrapper.createDiv({ cls: "lingonest-empty-state", text: "No saved items yet" });
      return;
    }

    if (!this.selectedItemId || !items.some((item) => item.id === this.selectedItemId)) {
      this.selectedItemId = items[0]?.id ?? null;
    }

    const grid = wrapper.createDiv({ cls: "lingonest-item-browser-grid" });
    const listColumn = grid.createDiv({ cls: "lingonest-item-browser-sidebar" });
    const previewColumn = grid.createDiv({ cls: "lingonest-item-browser-main" });

    const list = listColumn.createDiv({ cls: "lingonest-item-browser-list" });
    for (const item of items) {
      const entry = list.createDiv({
        cls: `lingonest-item-browser-item${item.id === this.selectedItemId ? " is-active" : ""}`
      });
      entry.setAttr("role", "button");
      entry.setAttr("tabindex", "0");
      entry.createDiv({ cls: "lingonest-item-browser-term", text: capitalizeLabel(item.label) });
      entry.createDiv({ cls: "lingonest-item-browser-snippet", text: this.buildItemPreview(item) });

      const activate = async () => {
        this.browserScrollTop = list.scrollTop;
        this.selectedItemId = item.id;
        await this.refresh();
      };

      entry.addEventListener("click", () => {
        void activate();
      });
      entry.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void activate();
        }
      });
    }
    const restoreScrollTop = this.browserScrollTop;
    requestAnimationFrame(() => {
      list.scrollTop = restoreScrollTop;
    });

    const selectedItem = this.selectedItemId ? this.plugin.itemStorage.getItem(this.selectedItemId) : null;
    if (!selectedItem) {
      return;
    }

    const previewCard = previewColumn.createDiv({ cls: "lingonest-review-browser-preview" });
    const previewHeader = previewCard.createDiv({ cls: "lingonest-review-meta" });
    previewHeader.createSpan({ text: capitalizeLabel(selectedItem.label) });
    const actionGroup = previewHeader.createDiv({ cls: "lingonest-review-browser-actions" });
    const openButton = actionGroup.createEl("button", {
      cls: "lingonest-review-preview-button",
      text: "Open note"
    });
    openButton.addEventListener("click", async () => {
      await this.plugin.openNotePath(selectedItem.notePath);
    });
    const deleteButton = actionGroup.createEl("button", {
      cls: "lingonest-review-preview-button is-danger",
      text: "Delete item"
    });
    deleteButton.addEventListener("click", async () => {
      const confirmed = window.confirm(
        `Delete "${selectedItem.label}" from LingoNest? This removes it from saved items, review data, and the item note.`
      );
      if (!confirmed) {
        return;
      }

      await this.plugin.itemStorage.deleteItem(selectedItem.id);
      this.selectedItemId = null;
      this.plugin.notifyStateChanged();
      await this.refresh();
    });

    const originalResponse = this.plugin.itemStorage.getOriginalAssistantResponse(selectedItem.id);
    if (!originalResponse) {
      const empty = previewColumn.createDiv({ cls: "lingonest-review-browser-preview" });
      empty.createDiv({ cls: "lingonest-empty-state", text: "Original response unavailable" });
      empty.createEl("p", {
        text: "This older item does not have a cached tutor reply yet. Open the note for the structured version, or regenerate it from chat to refresh the original tutor response format."
      });
      return;
    }

    const assistantCard = previewColumn.createDiv({ cls: "lingonest-message lingonest-message-assistant lingonest-item-browser-response" });
    const assistantMeta = assistantCard.createDiv({ cls: "lingonest-message-meta" });
    assistantMeta.createSpan({ text: "Tutor" });
    assistantMeta.createSpan({ text: "Saved response" });
    const previewBody = assistantCard.createDiv({ cls: "lingonest-message-body" });
    await MarkdownRenderer.render(this.app, originalResponse, previewBody, "", this);
  }

  private buildItemPreview(item: LearningItemIndexEntry): string {
    const preview = [item.chineseMeaning, item.meaning, item.naturalTranslation, item.nuance]
      .map((value) => value.trim())
      .find(Boolean);
    if (!preview) {
      return item.itemType;
    }
    return preview.length <= 96 ? preview : `${preview.slice(0, 93).trim()}...`;
  }
}
