import {
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  setIcon,
  type WorkspaceLeaf
} from "obsidian";
import type { EventRef } from "obsidian";
import type { LingoNestPlugin } from "../main";
import type { Thread } from "../types";
import { formatRelativeDate, formatThreadDate } from "../utils/date";
import { capitalizeLabel } from "../utils/strings";
import { renderSectionNav } from "./sectionNav";

export const CHAT_VIEW_TYPE = "lingonest-chat-view";

export class ChatView extends ItemView {
  plugin: LingoNestPlugin;
  private draft = "";
  private selectedThreadId: string | null = null;
  private sending = false;
  private stateRef: EventRef | null = null;
  private readonly minSidebarWidth = 220;
  private readonly maxSidebarWidth = 520;

  constructor(leaf: WorkspaceLeaf, plugin: LingoNestPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "LingoNest Chat";
  }

  getIcon(): string {
    return "messages-square";
  }

  async onOpen(): Promise<void> {
    this.selectedThreadId = this.plugin.store.state.latestThreadId ?? this.plugin.chatService.getThreads()[0]?.id ?? null;
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

  private async refresh(): Promise<void> {
    const threads = this.plugin.chatService.getThreads();
    if (this.selectedThreadId && !threads.some((thread) => thread.id === this.selectedThreadId)) {
      this.selectedThreadId = threads[0]?.id ?? null;
    }
    if (!this.selectedThreadId) {
      this.selectedThreadId = threads[0]?.id ?? null;
    }

    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("lingonest-view");

    const root = containerEl.createDiv({ cls: "lingonest-chat-layout" });
    root.style.setProperty("--lingonest-sidebar-width", `${this.getSidebarWidth()}px`);
    const sidebar = root.createDiv({ cls: "lingonest-thread-sidebar" });
    const divider = root.createDiv({ cls: "lingonest-thread-divider" });
    const content = root.createDiv({ cls: "lingonest-chat-content" });

    this.renderSidebar(sidebar, threads);
    this.bindDivider(root, divider);
    await this.renderContent(content);
  }

  private renderSidebar(container: HTMLElement, threads: Thread[]): void {
    const header = container.createDiv({ cls: "lingonest-sidebar-header" });
    header.createEl("h3", { text: "Items" });
    const newButton = header.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "New item" } });
    setIcon(newButton, "plus");
    newButton.addEventListener("click", async () => {
      const thread = await this.plugin.chatService.createThread();
      this.selectedThreadId = thread.id;
      await this.refresh();
    });

    if (!threads.length) {
      container.createEl("p", { text: "Look up a word or phrase to create the first item." });
      return;
    }

    const list = container.createDiv({ cls: "lingonest-thread-list" });
    for (const thread of threads) {
      const item = list.createDiv({
        cls: `lingonest-thread-item${thread.id === this.selectedThreadId ? " is-active" : ""}`
      });
      item.setAttr("role", "button");
      item.setAttr("tabindex", "0");
      item.setAttr("aria-label", `Open item ${this.getThreadLabel(thread)}`);
      item.setAttr("title", "Right-click for more actions");

      item.createDiv({ cls: "lingonest-thread-title", text: this.getThreadLabel(thread) });
      item.createDiv({
        cls: "lingonest-thread-meta",
        text: `${thread.messages.length} messages · ${formatThreadDate(thread.updatedAt)}`
      });

      const openThread = async () => {
        this.selectedThreadId = thread.id;
        await this.refresh();
      };

      item.addEventListener("click", () => {
        void openThread();
      });
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void openThread();
        }
      });

      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const menu = new Menu();
        menu.addItem((menuItem) => {
          menuItem
            .setTitle("Remove from list")
            .setIcon("trash-2")
            .onClick(async () => {
              const shouldDelete = window.confirm(`Remove "${this.getThreadLabel(thread)}" from the list?`);
              if (!shouldDelete) {
                return;
              }

              await this.plugin.chatService.deleteThread(thread.id);
              if (this.selectedThreadId === thread.id) {
                this.selectedThreadId =
                  this.plugin.store.state.latestThreadId ?? this.plugin.chatService.getThreads()[0]?.id ?? null;
              }
              await this.refresh();
            });
        });
        menu.showAtMouseEvent(event);
      });
    }
  }

  private async renderContent(container: HTMLElement): Promise<void> {
    const thread = this.selectedThreadId ? this.plugin.chatService.getThread(this.selectedThreadId) : null;
    renderSectionNav(container, this.plugin, "chat");
    const header = container.createDiv({ cls: "lingonest-pane-header" });
    header.createEl("h3", { text: capitalizeLabel(thread?.title ?? "New Item") });
    const headerActions = header.createDiv({ cls: "lingonest-pane-header-actions" });
    headerActions.createDiv({
      cls: "lingonest-provider-badge",
      text: `${this.plugin.store.settings.provider.activeProvider} · ${this.plugin.store.settings.provider.model}`
    });

    const messagesEl = container.createDiv({ cls: "lingonest-messages" });
    if (!thread?.messages.length) {
      messagesEl.createDiv({ cls: "lingonest-empty-state", text: "Start here" });
      messagesEl.createEl("p", {
        text: "Ask about a word, phrase, sentence, or nuance. LingoNest will answer and save the primary item automatically."
      });
    } else {
      for (const message of thread.messages) {
        const card = messagesEl.createDiv({ cls: `lingonest-message lingonest-message-${message.role}` });
        const meta = card.createDiv({ cls: "lingonest-message-meta" });
        meta.createSpan({ text: message.role === "assistant" ? "Tutor" : "You" });
        meta.createSpan({ text: new Date(message.createdAt).toLocaleString() });
        const body = card.createDiv({ cls: "lingonest-message-body" });
        await MarkdownRenderer.render(this.app, message.content, body, "", this);

        if (thread && message.role === "assistant") {
          await this.renderAssistantActions(card, thread.id, message.id, message.captureEventId);
        }
      }
    }

    const composer = container.createDiv({ cls: "lingonest-composer" });
    const composerRow = composer.createDiv({ cls: "lingonest-composer-row" });
    const textarea = composerRow.createEl("textarea", {
      cls: "lingonest-composer-input",
      attr: {
        rows: "1",
        placeholder: "Ask about a word, phrase, sentence, or grammar point…"
      }
    });
    textarea.value = this.draft;
    textarea.addEventListener("input", () => {
      this.draft = textarea.value;
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.handleSend();
      }
    });

    const actions = composerRow.createDiv({ cls: "lingonest-composer-actions" });
    const sendButton = actions.createEl("button", { text: this.sending ? "Sending…" : "Send" });
    sendButton.disabled = this.sending;
    sendButton.addEventListener("click", async () => {
      await this.handleSend();
    });
  }

  private async handleSend(): Promise<void> {
    if (this.sending || !this.draft.trim()) {
      return;
    }
    this.sending = true;
    try {
      const thread = await this.plugin.chatService.sendMessage(this.selectedThreadId, this.draft);
      this.draft = "";
      this.selectedThreadId = thread.id;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Chat request failed.");
    } finally {
      this.sending = false;
      await this.refresh();
    }
  }

  private getSidebarWidth(): number {
    return Math.max(this.minSidebarWidth, Math.min(this.maxSidebarWidth, this.plugin.store.settings.chatSidebarWidth || 280));
  }

  private getThreadLabel(thread: Thread): string {
    const trimmed = thread.title.trim();
    if (trimmed) {
      return capitalizeLabel(trimmed);
    }
    const firstUserMessage = thread.messages.find((message) => message.role === "user")?.content?.trim();
    if (firstUserMessage) {
      return capitalizeLabel(firstUserMessage.slice(0, 48));
    }
    return "New Thread";
  }

  private async renderAssistantActions(
    card: HTMLElement,
    threadId: string,
    assistantMessageId: string,
    captureEventId: string | null
  ): Promise<void> {
    const event = captureEventId ? this.plugin.store.state.captureEvents[captureEventId] : null;
    const thread = this.plugin.chatService.getThread(threadId);
    const item = thread?.itemId ? this.plugin.itemStorage.getItem(thread.itemId) : null;
    const capture = card.createDiv({ cls: `lingonest-capture-note${event ? ` is-${event.status}` : ""}` });

    if (event) {
      capture.createSpan({ text: event.summary });
    } else {
      capture.createSpan({ text: "Not saved yet" });
    }

    const actions = capture.createDiv({ cls: "lingonest-capture-actions" });

    const notePath = event?.notePath ?? item?.notePath ?? null;
    if (notePath) {
      const openButton = actions.createEl("button", { text: "Open note" });
      openButton.addEventListener("click", async () => {
        await this.plugin.openNotePath(notePath);
      });
    }

    if (item) {
      const regenerateButton = actions.createEl("button", { text: "Regenerate" });
      regenerateButton.addEventListener("click", async () => {
        try {
          regenerateButton.disabled = true;
          regenerateButton.textContent = "Regenerating…";
          await this.plugin.chatService.regenerateItem(threadId);
          await this.refresh();
        } catch (error) {
          regenerateButton.disabled = false;
          regenerateButton.textContent = "Regenerate";
          new Notice(error instanceof Error ? error.message : "Regeneration failed.");
        }
      });
    }

    if (!event || event.status === "skipped" || event.status === "error") {
      const saveButton = actions.createEl("button", { text: "Save This Item" });
      saveButton.addEventListener("click", async () => {
        try {
          saveButton.disabled = true;
          saveButton.textContent = "Saving…";
          await this.plugin.chatService.saveExchange(threadId, assistantMessageId);
          await this.refresh();
        } catch (error) {
          saveButton.disabled = false;
          saveButton.textContent = "Save This Item";
          new Notice(error instanceof Error ? error.message : "Manual save failed.");
        }
      });
    }

    if (event?.error) {
      capture.createDiv({ text: event.error });
    }
  }

  private bindDivider(root: HTMLElement, divider: HTMLElement): void {
    divider.addEventListener("pointerdown", (event: PointerEvent) => {
      event.preventDefault();

      const rootRect = root.getBoundingClientRect();
      const startWidth = this.getSidebarWidth();
      const startX = event.clientX;
      let nextWidth = startWidth;

      divider.setPointerCapture(event.pointerId);
      document.body.classList.add("lingonest-resizing");

      const handleMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        const maxAllowed = Math.min(this.maxSidebarWidth, Math.max(this.minSidebarWidth, rootRect.width - 320));
        nextWidth = Math.max(this.minSidebarWidth, Math.min(maxAllowed, startWidth + delta));
        root.style.setProperty("--lingonest-sidebar-width", `${nextWidth}px`);
      };

      const finish = async () => {
        divider.releasePointerCapture(event.pointerId);
        document.body.classList.remove("lingonest-resizing");
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleCancel);

        if (nextWidth !== this.plugin.store.settings.chatSidebarWidth) {
          await this.plugin.store.updateSettings((settings) => {
            settings.chatSidebarWidth = nextWidth;
          });
          this.plugin.notifyStateChanged();
        }
      };

      const handleUp = () => {
        void finish();
      };

      const handleCancel = () => {
        void finish();
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp, { once: true });
      window.addEventListener("pointercancel", handleCancel, { once: true });
    });
  }
}
