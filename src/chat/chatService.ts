import { Notice } from "obsidian";
import type {
  CaptureCandidate,
  CaptureContext,
  CaptureEvent,
  LearningItemIndexEntry,
  StructuredChatResponse,
  Thread,
  ThreadMessage
} from "../types";
import {
  buildStructuredChatUserPrompt,
  getActivePromptProfile,
  normalizeStructuredChatResponse
} from "../prompts";
import type { LingoNestPlugin } from "../main";
import { nowIso } from "../utils/date";
import { canonicalizeItemType, looksLikeContrast } from "../utils/itemTypes";
import {
  capitalizeLabel,
  makeId,
  normalizeExpression,
  titleFromText,
  toSentenceCase,
  uniqueNonEmpty
} from "../utils/strings";
import { canonicalizeLanguage } from "../utils/languages";

const CASUAL_CHITCHAT_MESSAGES = new Set([
  "what's up",
  "whats up",
  "how are you",
  "hello",
  "hi",
  "hey",
  "good morning",
  "good evening",
  "good night",
  "thanks",
  "thank you"
]);
const LOOKUP_CUE_PATTERNS = [
  /\bmeaning\b/i,
  /\bmean\b/i,
  /\btranslate\b/i,
  /\btranslation\b/i,
  /\bdefine\b/i,
  /\bexplain\b/i,
  /\bdifference\b/i,
  /\bcompare\b/i,
  /\bversus\b/i,
  /\bvs\b/i,
  /\bwhen do i use\b/i,
  /\bwhy is\b/i,
  /\bhow natural\b/i,
  /\bwhat does\b/i,
  /\bwhat is\b/i
];

export class ChatService {
  private readonly plugin: LingoNestPlugin;
  private readonly streamingByThread = new Map<string, { assistantMessageId: string; raw: string; content: string; label: string }>();
  private lastStreamNotifyAt = 0;

  constructor(plugin: LingoNestPlugin) {
    this.plugin = plugin;
  }

  getThreads(): Thread[] {
    return [...this.plugin.store.state.threads].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  getThread(threadId: string | null): Thread | null {
    if (!threadId) {
      return null;
    }
    return this.plugin.store.state.threads.find((thread) => thread.id === threadId) ?? null;
  }

  getStreamingState(threadId: string | null): { assistantMessageId: string; content: string; label: string } | null {
    if (!threadId) {
      return null;
    }
    const state = this.streamingByThread.get(threadId);
    if (!state) {
      return null;
    }
    return {
      assistantMessageId: state.assistantMessageId,
      content: state.content,
      label: state.label
    };
  }

  beginStreamingState(threadId: string, assistantMessageId: string, label: string): void {
    this.streamingByThread.set(threadId, {
      assistantMessageId,
      raw: "",
      content: "",
      label: label.trim()
    });
    this.plugin.notifyStateChanged();
  }

  async createThread(title = "New Item", itemId: string | null = null): Promise<Thread> {
    const thread: Thread = {
      id: makeId("thread"),
      title,
      itemId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: []
    };
    await this.plugin.store.updateState((state) => {
      state.threads.unshift(thread);
      state.latestThreadId = thread.id;
    });
    this.plugin.notifyStateChanged();
    return thread;
  }

  async deleteThread(threadId: string): Promise<void> {
    const existing = this.getThread(threadId);
    if (!existing) {
      return;
    }

    await this.plugin.store.updateState((state) => {
      state.threads = state.threads.filter((thread) => thread.id !== threadId);
      delete state.threadSummaries[threadId];
      if (state.latestThreadId === threadId) {
        state.latestThreadId = state.threads[0]?.id ?? null;
      }
    });
    this.plugin.notifyStateChanged();
  }

  async sendMessage(threadId: string | null, userContent: string): Promise<Thread> {
    const trimmed = userContent.trim();
    if (!trimmed) {
      throw new Error("Message is empty.");
    }

    const initialTitle = this.resolveInitialItemTitle(trimmed);
    const existingItem = this.findExistingItemForRequest(trimmed);
    const thread = await this.resolveThreadForMessage(threadId, trimmed, initialTitle, existingItem?.id ?? null);

    if (existingItem && this.shouldUseSavedResult(trimmed, existingItem)) {
      return this.loadSavedResult(thread, trimmed, existingItem);
    }

    const now = nowIso();
    const userMessage: ThreadMessage = {
      id: makeId("message"),
      role: "user",
      content: trimmed,
      createdAt: now,
      captureEventId: null
    };

    await this.plugin.store.updateState((state) => {
      const current = state.threads.find((candidate) => candidate.id === thread.id);
      if (!current) {
        return;
      }
      current.messages = [userMessage];
      current.itemId = existingItem?.id ?? current.itemId;
      if (current.title === "New Thread" || current.title === "New Item" || !current.title.trim()) {
        current.title = initialTitle;
      }
      current.updatedAt = now;
      state.latestThreadId = current.id;
    });
    this.plugin.notifyStateChanged();

    const activeThread = this.getThread(thread.id);
    if (!activeThread) {
      throw new Error("Thread was lost during update.");
    }

    const assistantMessage: ThreadMessage = {
      id: makeId("message"),
      role: "assistant",
      content: "",
      createdAt: nowIso(),
      captureEventId: null
    };

    await this.plugin.store.updateState((state) => {
      const current = state.threads.find((candidate) => candidate.id === thread.id);
      if (!current) {
        return;
      }
      current.messages = [userMessage, assistantMessage];
      current.updatedAt = assistantMessage.createdAt;
      state.latestThreadId = current.id;
    });
    this.beginStreamingState(thread.id, assistantMessage.id, activeThread.title || initialTitle);

    let assistantResponse: StructuredChatResponse;
    try {
      assistantResponse = await this.generateStructuredAssistantResponse(userMessage.content, {
        threadId: thread.id,
        assistantMessageId: assistantMessage.id
      });
    } catch (error) {
      this.clearStreamingState(thread.id, false);
      await this.plugin.store.updateState((state) => {
        const current = state.threads.find((candidate) => candidate.id === thread.id);
        if (!current) {
          return;
        }
        current.messages = [userMessage];
        current.updatedAt = userMessage.createdAt;
        state.latestThreadId = current.id;
      });
      this.plugin.notifyStateChanged();
      throw error;
    }
    const assistantText = assistantResponse.answerMarkdown;
    this.clearStreamingState(thread.id, false);

    await this.plugin.store.updateState((state) => {
      const current = state.threads.find((candidate) => candidate.id === thread.id);
      if (!current) {
        return;
      }
      const currentAssistantMessage = current.messages.find((candidate) => candidate.id === assistantMessage.id);
      if (currentAssistantMessage) {
        currentAssistantMessage.content = assistantText;
      }
      current.title = assistantResponse.itemLabel || current.title;
      current.updatedAt = assistantMessage.createdAt;
      state.latestThreadId = current.id;
    });

    if (this.plugin.store.settings.autoSave) {
      const captureEvent = await this.captureFromExchange(
        thread.id,
        userMessage,
        assistantMessage,
        assistantResponse.itemLabel || activeThread.title,
        assistantResponse
      );
      if (captureEvent) {
        assistantMessage.captureEventId = captureEvent.id;
        await this.plugin.store.updateState((state) => {
          const current = state.threads.find((candidate) => candidate.id === thread.id);
          const message = current?.messages.find((candidate) => candidate.id === assistantMessage.id);
          if (message) {
            message.captureEventId = captureEvent.id;
          }
          if (current && captureEvent.itemId) {
            const item = state.items[captureEvent.itemId];
            if (item) {
              current.itemId = item.id;
              current.title = item.label;
            }
          }
        });
      }
    }

    this.plugin.notifyStateChanged();
    return this.getThread(thread.id) ?? thread;
  }

  async regenerateItem(threadId: string): Promise<Thread> {
    const thread = this.getThread(threadId);
    if (!thread) {
      throw new Error("Item not found.");
    }

    const item = this.resolveSavedItemForThread(thread);
    if (!item) {
      throw new Error("This item has not been saved yet.");
    }

    const sourcePrompt =
      [...thread.messages].reverse().find((message) => message.role === "user")?.content?.trim() || item.term;
    const now = nowIso();
    const userMessage: ThreadMessage = {
      id: makeId("message"),
      role: "user",
      content: sourcePrompt,
      createdAt: now,
      captureEventId: null
    };

    await this.plugin.store.updateState((state) => {
      const current = state.threads.find((candidate) => candidate.id === threadId);
      if (!current) {
        return;
      }
      current.messages = [userMessage];
      current.title = item.label;
      current.itemId = item.id;
      current.updatedAt = now;
      state.latestThreadId = current.id;
    });
    this.plugin.notifyStateChanged();

    const assistantMessage: ThreadMessage = {
      id: makeId("message"),
      role: "assistant",
      content: "",
      createdAt: nowIso(),
      captureEventId: null
    };

    await this.plugin.store.updateState((state) => {
      const current = state.threads.find((candidate) => candidate.id === threadId);
      if (!current) {
        return;
      }
      current.messages = [userMessage, assistantMessage];
      current.title = item.label;
      current.updatedAt = assistantMessage.createdAt;
      state.latestThreadId = current.id;
    });
    this.beginStreamingState(threadId, assistantMessage.id, item.label);

    let assistantResponse: StructuredChatResponse;
    try {
      assistantResponse = await this.generateStructuredAssistantResponse(sourcePrompt, {
        threadId,
        assistantMessageId: assistantMessage.id
      });
    } catch (error) {
      this.clearStreamingState(threadId, false);
      await this.plugin.store.updateState((state) => {
        const current = state.threads.find((candidate) => candidate.id === threadId);
        if (!current) {
          return;
        }
        current.messages = [userMessage];
        current.title = item.label;
        current.updatedAt = userMessage.createdAt;
        state.latestThreadId = current.id;
      });
      this.plugin.notifyStateChanged();
      throw error;
    }
    const assistantText = assistantResponse.answerMarkdown;
    this.clearStreamingState(threadId, false);

    await this.plugin.store.updateState((state) => {
      const current = state.threads.find((candidate) => candidate.id === threadId);
      if (!current) {
        return;
      }
      const currentAssistantMessage = current.messages.find((candidate) => candidate.id === assistantMessage.id);
      if (currentAssistantMessage) {
        currentAssistantMessage.content = assistantText;
      }
      current.title = assistantResponse.itemLabel || item.label;
      current.updatedAt = assistantMessage.createdAt;
      state.latestThreadId = current.id;
    });

    const event = await this.overwriteExchange(threadId, item, userMessage, assistantMessage, assistantResponse);
    assistantMessage.captureEventId = event.id;

    await this.plugin.store.updateState((state) => {
      const current = state.threads.find((candidate) => candidate.id === threadId);
      const message = current?.messages.find((candidate) => candidate.id === assistantMessage.id);
      if (message) {
        message.captureEventId = event.id;
      }
      if (current && event.itemId) {
        const savedItem = state.items[event.itemId];
        if (savedItem) {
          current.itemId = savedItem.id;
          current.title = savedItem.label;
        }
      }
    });

    this.plugin.notifyStateChanged();
    return this.getThread(threadId) ?? thread;
  }

  async saveSelection(selection: string): Promise<void> {
    const trimmed = selection.trim();
    if (!trimmed) {
      throw new Error("Nothing selected.");
    }
    const provider = this.plugin.getProvider();
    const prompt = getActivePromptProfile(
      this.plugin.store.settings.prompts.profiles,
      "capture",
      this.plugin.store.settings.prompts.activeProfileIds.capture
    );
    const context: CaptureContext = {
      threadTitle: "Selection Capture",
      userMessage: trimmed,
      assistantMessage: "",
      explanationLanguage: this.plugin.store.settings.defaultExplanationLanguage,
      conversationExcerpt: trimmed
    };

    const extracted = await provider.extractCandidate(context, { systemPrompt: prompt.systemPrompt });
    const candidate = this.resolveSaveCandidate(trimmed, "", extracted) ?? this.fallbackCandidate(trimmed, "");
    const result = await this.plugin.itemStorage.upsertCandidate(candidate, {
      sourceThreadId: null,
      sourceMessageId: null,
      captureState: "provisional",
      updateSource: "exchange-manual",
      assistantResponse: ""
    });
    new Notice(`Saved ${result.item.label} to ${result.item.notePath}`);
    this.plugin.notifyStateChanged();
  }

  async saveExchange(threadId: string, assistantMessageId: string): Promise<CaptureEvent> {
    const thread = this.getThread(threadId);
    if (!thread) {
      throw new Error("Thread not found.");
    }

    const assistantIndex = thread.messages.findIndex(
      (message) => message.id === assistantMessageId && message.role === "assistant"
    );
    if (assistantIndex === -1) {
      throw new Error("Tutor reply not found.");
    }

    const assistantMessage = thread.messages[assistantIndex];
    const userMessage = [...thread.messages.slice(0, assistantIndex)]
      .reverse()
      .find((message) => message.role === "user");

    if (!assistantMessage || !userMessage) {
      throw new Error("Could not find the matching user question for this reply.");
    }

    const capturePrompt = getActivePromptProfile(
      this.plugin.store.settings.prompts.profiles,
      "capture",
      this.plugin.store.settings.prompts.activeProfileIds.capture
    );
    const provider = this.plugin.getProvider();
    const context: CaptureContext = {
      threadTitle: thread.title,
      userMessage: userMessage.content,
      assistantMessage: assistantMessage.content,
      explanationLanguage: this.plugin.store.settings.defaultExplanationLanguage,
      conversationExcerpt: [userMessage.content, assistantMessage.content].join("\n\n")
    };

    const extracted = await provider.extractCandidate(context, { systemPrompt: capturePrompt.systemPrompt });
    const candidate =
      this.resolveSaveCandidate(userMessage.content, assistantMessage.content, extracted) ??
      this.fallbackCandidate(this.inferLookupExpression(userMessage.content) || userMessage.content, assistantMessage.content);

    const result = await this.plugin.itemStorage.upsertCandidate(candidate, {
      sourceThreadId: threadId,
      sourceMessageId: assistantMessage.id,
      captureState: "provisional",
      updateSource: "exchange-manual",
      assistantResponse: assistantMessage.content
    });
    const event: CaptureEvent = {
      id: makeId("capture"),
      threadId,
      messageId: assistantMessage.id,
      itemId: result.item.id,
      notePath: result.item.notePath,
      status: result.status,
      confidence: candidate.confidence,
      expression: candidate.primaryExpression,
      summary: `${result.status === "saved" ? "Saved" : "Updated"} ${result.item.label}`,
      createdAt: nowIso(),
      error: null
    };

    await this.plugin.store.setCaptureEvent(event);
    await this.plugin.store.updateState((state) => {
      const currentThread = state.threads.find((candidateThread) => candidateThread.id === threadId);
      const message = currentThread?.messages.find((candidateMessage) => candidateMessage.id === assistantMessage.id);
      if (message) {
        message.captureEventId = event.id;
      }
      if (currentThread && result.item.id) {
        currentThread.itemId = result.item.id;
        currentThread.title = result.item.label;
      }
    });
    this.plugin.notifyStateChanged();
    new Notice(`${result.status === "saved" ? "Saved" : "Updated"} ${result.item.label}`);
    return event;
  }

  private async overwriteExchange(
    threadId: string,
    item: LearningItemIndexEntry,
    userMessage: ThreadMessage,
    assistantMessage: ThreadMessage,
    structuredResponse: StructuredChatResponse | null
  ): Promise<CaptureEvent> {
    const capturePrompt = getActivePromptProfile(
      this.plugin.store.settings.prompts.profiles,
      "capture",
      this.plugin.store.settings.prompts.activeProfileIds.capture
    );
    const provider = this.plugin.getProvider();
    const context: CaptureContext = {
      threadTitle: item.label,
      userMessage: userMessage.content,
      assistantMessage: assistantMessage.content,
      explanationLanguage: this.plugin.store.settings.defaultExplanationLanguage,
      conversationExcerpt: [userMessage.content, assistantMessage.content].join("\n\n")
    };

    let extracted: CaptureCandidate | null = null;
    try {
      extracted = await provider.extractCandidate(context, { systemPrompt: capturePrompt.systemPrompt });
    } catch {
      extracted = null;
    }

    const candidate = this.buildOverwriteCandidate(
      item,
      userMessage.content,
      assistantMessage.content,
      extracted,
      structuredResponse
    );
    const result = await this.plugin.itemStorage.overwriteItem(item.id, candidate, {
      sourceThreadId: threadId,
      sourceMessageId: assistantMessage.id,
      captureState: item.captureState,
      updateSource: "exchange-manual",
      assistantResponse: assistantMessage.content
    });

    const event: CaptureEvent = {
      id: makeId("capture"),
      threadId,
      messageId: assistantMessage.id,
      itemId: result.item.id,
      notePath: result.item.notePath,
      status: "regenerated",
      confidence: candidate.confidence,
      expression: result.item.term,
      summary: `Regenerated ${result.item.label}`,
      createdAt: nowIso(),
      error: null
    };

    await this.plugin.store.setCaptureEvent(event);
    return event;
  }

  private async captureFromExchange(
    threadId: string,
    userMessage: ThreadMessage,
    assistantMessage: ThreadMessage,
    threadTitle: string,
    structuredResponse: StructuredChatResponse | null
  ): Promise<CaptureEvent | null> {
    const capturePrompt = getActivePromptProfile(
      this.plugin.store.settings.prompts.profiles,
      "capture",
      this.plugin.store.settings.prompts.activeProfileIds.capture
    );
    const provider = this.plugin.getProvider();
    const excerpt = [userMessage.content, assistantMessage.content].join("\n\n");
    const context: CaptureContext = {
      threadTitle,
      userMessage: userMessage.content,
      assistantMessage: assistantMessage.content,
      explanationLanguage: this.plugin.store.settings.defaultExplanationLanguage,
      conversationExcerpt: excerpt
    };

    let event: CaptureEvent;
    try {
      const extracted = await provider.extractCandidate(context, { systemPrompt: capturePrompt.systemPrompt });
      const candidate = this.resolveSaveCandidate(
        userMessage.content,
        assistantMessage.content,
        extracted,
        structuredResponse
      );
      if (!candidate) {
        event = {
          id: makeId("capture"),
          threadId,
          messageId: assistantMessage.id,
          itemId: null,
          notePath: null,
          status: "skipped",
          confidence: extracted.confidence,
          expression: extracted.primaryExpression,
          summary: "Nothing auto-saved",
          createdAt: nowIso(),
          error: null
        };
      } else {
        const result = await this.plugin.itemStorage.upsertCandidate(candidate, {
          sourceThreadId: threadId,
          sourceMessageId: assistantMessage.id,
          captureState: "provisional",
          updateSource: "exchange-auto",
          assistantResponse: assistantMessage.content
        });
        event = {
          id: makeId("capture"),
          threadId,
          messageId: assistantMessage.id,
          itemId: result.item.id,
          notePath: result.item.notePath,
          status: result.status,
          confidence: candidate.confidence,
          expression: candidate.primaryExpression,
          summary: `${result.status === "saved" ? "Saved" : "Updated"} ${candidate.label}`,
          createdAt: nowIso(),
          error: null
        };
      }
    } catch (error) {
      event = {
        id: makeId("capture"),
        threadId,
        messageId: assistantMessage.id,
        itemId: null,
        notePath: null,
        status: "error",
        confidence: 0,
        expression: "",
        summary: "Capture failed",
        createdAt: nowIso(),
        error: error instanceof Error ? error.message : "Unknown error"
      };
    }

    await this.plugin.store.setCaptureEvent(event);
    return event;
  }

  private resolveSaveCandidate(
    userMessage: string,
    assistantMessage: string,
    candidate: CaptureCandidate,
    structuredResponse: StructuredChatResponse | null = null
  ): CaptureCandidate | null {
    if (this.isCasualChitChatMessage(userMessage)) {
      return null;
    }

    const canonicalExpression = this.resolvePreferredPrimaryExpression(
      userMessage,
      assistantMessage,
      structuredResponse?.primaryExpression || candidate.primaryExpression,
      structuredResponse?.itemType || candidate.itemType
    );
    const relatedExpressions = this.buildRelatedExpressions(
      userMessage,
      canonicalExpression || candidate.primaryExpression,
      uniqueNonEmpty([...(structuredResponse?.relatedExpressions ?? []), ...candidate.relatedExpressions]),
      structuredResponse?.primaryExpression || candidate.primaryExpression
    );
    const label = capitalizeLabel(
      (structuredResponse?.itemLabel || candidate.label || canonicalExpression || candidate.primaryExpression).trim()
    );

    if (this.shouldSaveCandidate(candidate)) {
      return {
        ...candidate,
        label,
        primaryExpression: canonicalExpression || candidate.primaryExpression,
        relatedExpressions
      };
    }

    if (!this.isDirectLookupRequest(userMessage) || !assistantMessage.trim()) {
      return null;
    }

    const inferredExpression = canonicalExpression || candidate.primaryExpression || this.inferLookupExpression(userMessage);
    if (!inferredExpression) {
      return null;
    }

    return {
      shouldSave: true,
      confidence: Math.max(candidate.confidence, 0.25),
      label,
      primaryExpression: inferredExpression,
      sourceLanguage:
        (structuredResponse?.sourceLanguage ?? candidate.sourceLanguage) !== "Unknown"
          ? canonicalizeLanguage(structuredResponse?.sourceLanguage ?? candidate.sourceLanguage)
          : canonicalizeLanguage(this.defaultSourceLanguageFor(inferredExpression)),
      targetLanguage:
        (structuredResponse?.targetLanguage ?? candidate.targetLanguage) !== "Unknown"
          ? canonicalizeLanguage(structuredResponse?.targetLanguage ?? candidate.targetLanguage)
          : canonicalizeLanguage(this.plugin.store.settings.defaultExplanationLanguage),
      itemType: canonicalizeItemType(
        structuredResponse?.itemType ?? candidate.itemType,
        inferredExpression,
        [userMessage, assistantMessage, candidate.grammarNotes, candidate.nuance].filter(Boolean).join("\n")
      ),
      meaning: candidate.meaning,
      chineseMeaning: candidate.chineseMeaning,
      pronunciation: candidate.pronunciation,
      partOfSpeech: candidate.partOfSpeech,
      literalTranslation: candidate.literalTranslation,
      naturalTranslation: candidate.naturalTranslation,
      examples: candidate.examples,
      grammarNotes: candidate.grammarNotes || this.summarizeAssistantAnswer(assistantMessage),
      nuance: candidate.nuance,
      commonMistakes: candidate.commonMistakes,
      tags: candidate.tags,
      difficulty: candidate.difficulty,
      relatedExpressions,
      sourceSnippet: candidate.sourceSnippet || userMessage.trim()
    };
  }

  private shouldSaveCandidate(candidate: CaptureCandidate): boolean {
    return Boolean(candidate.shouldSave && candidate.primaryExpression && candidate.confidence >= 0.35);
  }

  private isDirectLookupRequest(userMessage: string): boolean {
    const trimmed = userMessage.trim();
    if (!trimmed) {
      return false;
    }
    if (this.isCasualChitChatMessage(trimmed)) {
      return false;
    }

    const normalized = trimmed.toLowerCase();
    if (this.extractQuotedExpression(trimmed) && this.hasLookupCue(trimmed)) {
      return true;
    }

    const shortPlainQuery = trimmed.split(/\s+/).length <= 6 && !/[.!?]/.test(trimmed);
    if (shortPlainQuery) {
      return true;
    }

    return [
      /^what does .+ mean\??$/i,
      /^what'?s the difference between .+ and .+\??$/i,
      /^difference between .+ and .+\??$/i,
      /^compare .+ and .+\??$/i,
      /^when do i use .+ and .+\??$/i,
      /^why is .+ wrong\??$/i,
      /^what is .+\??$/i,
      /^meaning of .+$/i,
      /^define .+$/i,
      /^translate .+$/i,
      /^how natural is .+\??$/i,
      /^explain .+$/i,
      /^.+\s+meaning\??$/i,
      /^.+\s+mean\??$/i,
      /^.+\s+translation\??$/i
    ].some((pattern) => pattern.test(normalized));
  }

  private inferLookupExpression(userMessage: string): string {
    const trimmed = userMessage.trim();
    const quoted = this.extractQuotedExpression(trimmed);
    if (quoted) {
      return quoted;
    }

    const patterns = [
      /^what does (.+) mean\??$/i,
      /^what'?s the difference between (.+?) and (.+)\??$/i,
      /^difference between (.+?) and (.+)\??$/i,
      /^compare (.+?) and (.+)\??$/i,
      /^when do i use (.+?) and (.+)\??$/i,
      /^why is (.+?) wrong\??$/i,
      /^what is (.+)\??$/i,
      /^meaning of (.+)$/i,
      /^define (.+)$/i,
      /^translate (.+)$/i,
      /^how natural is (.+)\??$/i,
      /^explain (.+)$/i,
      /^(.+?)\s+meaning\??$/i,
      /^(.+?)\s+mean\??$/i,
      /^(.+?)\s+translation\??$/i
    ];
    const translationPatterns = [
      /^(.+?)(?:用)?英语怎么说[？?]?$/u,
      /^(.+?)(?:用)?英文怎么说[？?]?$/u,
      /^(.+?)(?:用)?中文怎么说[？?]?$/u,
      /^(.+?)(?:用)?汉语怎么说[？?]?$/u
    ];

    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      if (match && match[1] && match[2]) {
        return this.cleanExpression(`${match[1]} vs ${match[2]}`);
      }
      if (match?.[1]) {
        return this.cleanExpression(match[1]);
      }
    }

    for (const pattern of translationPatterns) {
      const match = trimmed.match(pattern);
      if (match?.[1]) {
        return this.cleanExpression(match[1]);
      }
    }

    if (trimmed.split(/\s+/).length <= 6) {
      return this.cleanExpression(trimmed);
    }

    return "";
  }

  private cleanExpression(value: string): string {
    return value
      .trim()
      .replace(/^[\"'“”`*]+|[\"'“”`*?.!]+$/g, "")
      .trim();
  }

  private extractQuotedExpression(value: string): string {
    const quoted = value.match(/["“'`*](.+?)["”'`*]/);
    return quoted?.[1]?.trim() ?? "";
  }

  private summarizeAssistantAnswer(assistantMessage: string): string {
    const plain = assistantMessage
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .replace(/^[-*]\s+/gm, "")
      .trim();
    if (!plain) {
      return "";
    }

    const firstParagraph = plain.split(/\n\s*\n/)[0]?.trim() ?? plain;
    if (firstParagraph.length <= 320) {
      return toSentenceCase(firstParagraph);
    }
    return `${toSentenceCase(firstParagraph.slice(0, 317).trim())}...`;
  }

  private fallbackCandidate(
    selection: string,
    assistantMessage: string,
    structuredResponse: StructuredChatResponse | null = null
  ): CaptureCandidate {
    const canonicalExpression = this.resolvePreferredPrimaryExpression(
      selection,
      assistantMessage,
      structuredResponse?.primaryExpression || selection,
      structuredResponse?.itemType || ""
    );
    return {
      shouldSave: true,
      confidence: 0.2,
      label: capitalizeLabel((structuredResponse?.itemLabel || canonicalExpression || selection).trim()),
      primaryExpression: canonicalExpression || selection,
      sourceLanguage: canonicalizeLanguage(
        structuredResponse?.sourceLanguage || this.defaultSourceLanguageFor(canonicalExpression || selection)
      ),
      targetLanguage: canonicalizeLanguage(this.plugin.store.settings.defaultExplanationLanguage),
      itemType: canonicalizeItemType(structuredResponse?.itemType || "", canonicalExpression || selection, assistantMessage),
      meaning: "",
      chineseMeaning: "",
      pronunciation: "",
      partOfSpeech: "",
      literalTranslation: "",
      naturalTranslation: "",
      examples: [],
      grammarNotes: assistantMessage ? this.summarizeAssistantAnswer(assistantMessage) : "",
      nuance: "",
      commonMistakes: [],
      tags: ["manual-save"],
      difficulty: "unknown",
      relatedExpressions: this.buildRelatedExpressions(
        selection,
        canonicalExpression || selection,
        structuredResponse?.relatedExpressions ?? [],
        structuredResponse?.primaryExpression || selection
      ),
      sourceSnippet: selection
    };
  }

  private resolvePreferredPrimaryExpression(
    userMessage: string,
    assistantMessage: string,
    extractedExpression: string,
    extractedItemType: string
  ): string {
    const canonicalExpression = this.resolveCanonicalLookupExpression(userMessage, assistantMessage, extractedExpression);
    const inferredExpression = this.cleanExpression(this.inferLookupExpression(userMessage));
    const resolvedItemType = canonicalizeItemType(
      extractedItemType,
      canonicalExpression || inferredExpression || extractedExpression,
      [userMessage, assistantMessage].filter(Boolean).join("\n")
    );

    if (inferredExpression && (resolvedItemType === "contrast" || looksLikeContrast(inferredExpression, userMessage))) {
      return inferredExpression;
    }

    return canonicalExpression || inferredExpression;
  }

  private resolveCanonicalLookupExpression(
    userMessage: string,
    assistantMessage: string,
    extractedExpression: string
  ): string {
    const rawExpression = this.cleanExpression(extractedExpression || this.inferLookupExpression(userMessage));
    if (!rawExpression) {
      return "";
    }

    const correctedExpression = this.extractCorrectedExpressionFromAssistant(assistantMessage, rawExpression);
    return correctedExpression || rawExpression;
  }

  private buildRelatedExpressions(
    userMessage: string,
    primaryExpression: string,
    existingRelatedExpressions: string[],
    rawCandidateExpression: string
  ): string[] {
    const normalizedPrimary = normalizeExpression(primaryExpression);
    return uniqueNonEmpty([
      ...existingRelatedExpressions,
      this.inferLookupExpression(userMessage),
      rawCandidateExpression
    ]).filter((value) => normalizeExpression(value) !== normalizedPrimary);
  }

  private extractCorrectedExpressionFromAssistant(assistantMessage: string, rawExpression: string): string {
    const plain = assistantMessage.replace(/\*\*/g, "").replace(/`/g, "").trim();
    if (!plain) {
      return "";
    }

    const explicitHeader = plain.match(/(?:^|\n)Correction:\s*(.+?)(?:\n|$)/i)?.[1] ?? "";
    const explicitCorrected = this.cleanCorrectedExpression(explicitHeader);
    if (explicitCorrected && normalizeExpression(explicitCorrected) !== normalizeExpression(rawExpression)) {
      return explicitCorrected;
    }

    const lines = plain
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const correctionLines = lines.filter((line) =>
      /\b(?:mean(?:t)?|correct spelling|correct word|correct term|typo|misspell|correction)\b/i.test(line)
    );

    for (const line of correctionLines) {
      const quoted = this.cleanExpression(this.extractQuotedExpression(line));
      if (quoted && normalizeExpression(quoted) !== normalizeExpression(rawExpression)) {
        return quoted;
      }

      const correctedFromArrow = this.cleanCorrectedExpression(line.match(/[✅✓]\s*["“'`]?(.+?)(?:["”'`]|$)/)?.[1] ?? "");
      if (correctedFromArrow && normalizeExpression(correctedFromArrow) !== normalizeExpression(rawExpression)) {
        return correctedFromArrow;
      }
    }

    const correctionPatterns = [
      /\byou likely mean(?:t)?\s+(.+?)(?:\s*\(|[.!?\n]|$)/i,
      /\byou probably mean(?:t)?\s+(.+?)(?:\s*\(|[.!?\n]|$)/i,
      /\byou may mean(?:t)?\s+(.+?)(?:\s*\(|[.!?\n]|$)/i,
      /\bi think you mean(?:t)?\s+(.+?)(?:\s*\(|[.!?\n]|$)/i,
      /\bdid you mean(?:t)?\s+(.+?)(?:\?|\s*\(|[.!\n]|$)/i,
      /\bthe correct (?:spelling|word|term) is\s+(.+?)(?:\s*\(|[.!?\n]|$)/i,
      /\bcorrect spelling:\s*(.+?)(?:\s*\(|[.!?\n]|$)/i
    ];

    for (const pattern of correctionPatterns) {
      const match = plain.match(pattern);
      const corrected = this.cleanCorrectedExpression(match?.[1] ?? "");
      if (corrected && normalizeExpression(corrected) !== normalizeExpression(rawExpression)) {
        return corrected;
      }
    }

    if (!/\b(?:misspell|misspelling|spelling|typo)\b/i.test(plain)) {
      return "";
    }

    const firstContentLine = correctionLines[0] ?? lines[0] ?? "";
    const fallback = this.cleanCorrectedExpression(firstContentLine);
    if (fallback && normalizeExpression(fallback) !== normalizeExpression(rawExpression)) {
      return fallback;
    }

    return "";
  }

  private cleanCorrectedExpression(value: string): string {
    const withoutLeadingLabel = value
      .replace(/^typo alert:\s*/i, "")
      .replace(/^correction:\s*/i, "")
      .replace(/^(?:you likely mean(?:t)?|you probably mean(?:t)?|you may mean(?:t)?|i think you mean(?:t)?|did you mean(?:t)?)\s+/i, "");
    const candidate = withoutLeadingLabel
      .replace(/^[*-]\s*/, "")
      .replace(/^[:>\-–]\s*/, "")
      .replace(/\s*\/.*$/, "")
      .replace(/\s*\(.*$/, "")
      .trim();
    const cleaned = this.cleanExpression(candidate);
    if (!cleaned || cleaned.split(/\s+/).length > 6) {
      return "";
    }
    return cleaned;
  }

  private buildOverwriteCandidate(
    item: LearningItemIndexEntry,
    userMessage: string,
    assistantMessage: string,
    extracted: CaptureCandidate | null,
    structuredResponse: StructuredChatResponse | null
  ): CaptureCandidate {
    const resolved = extracted ? this.resolveSaveCandidate(userMessage, assistantMessage, extracted, structuredResponse) : null;
    const fallback = this.fallbackCandidate(item.term, assistantMessage, structuredResponse);

    return {
      ...(resolved ?? fallback),
      shouldSave: true,
      confidence: resolved?.confidence ?? 1,
      label: capitalizeLabel((structuredResponse?.itemLabel || resolved?.label || item.label).trim()),
      primaryExpression: item.term,
      sourceLanguage:
        resolved?.sourceLanguage && resolved.sourceLanguage !== "Unknown" ? resolved.sourceLanguage : item.sourceLanguage,
      targetLanguage:
        resolved?.targetLanguage && resolved.targetLanguage !== "Unknown" ? resolved.targetLanguage : item.targetLanguage,
      itemType: canonicalizeItemType(
        resolved?.itemType ?? item.itemType,
        item.term,
        [userMessage, assistantMessage, item.grammarNotes, item.nuance].filter(Boolean).join("\n")
      ),
      sourceSnippet: userMessage.trim() || item.term
    };
  }

  private defaultSourceLanguageFor(text: string): string {
    if (/\p{Script=Han}/u.test(text)) {
      return "Chinese";
    }
    if (/[A-Za-z]/.test(text)) {
      return "English";
    }
    return "Unknown";
  }

  private isCasualChitChatMessage(userMessage: string): boolean {
    const normalized = normalizeExpression(userMessage);
    return CASUAL_CHITCHAT_MESSAGES.has(normalized);
  }

  private resolveInitialItemTitle(userMessage: string): string {
    return this.inferLookupExpression(userMessage) || titleFromText(userMessage);
  }

  private findExistingItemForRequest(userMessage: string): LearningItemIndexEntry | null {
    const inferredExpression = this.inferLookupExpression(userMessage);
    if (!inferredExpression) {
      return null;
    }

    return this.plugin.itemStorage.findReusableItemMatch(inferredExpression);
  }

  private shouldUseSavedResult(userMessage: string, item: LearningItemIndexEntry): boolean {
    const inferredExpression = this.inferLookupExpression(userMessage);
    if (!inferredExpression) {
      return false;
    }

    const trimmed = userMessage.trim();
    if (!trimmed) {
      return false;
    }

    const normalizedTrimmed = normalizeExpression(trimmed);
    if (normalizedTrimmed === item.dedupeKey) {
      return true;
    }

    const matchedItem = this.plugin.itemStorage.findReusableItemMatch(inferredExpression);
    if (matchedItem?.id === item.id) {
      return true;
    }

    return [
      /^what does .+ mean\??$/i,
      /^what'?s the difference between .+ and .+\??$/i,
      /^difference between .+ and .+\??$/i,
      /^compare .+ and .+\??$/i,
      /^when do i use .+ and .+\??$/i,
      /^why is .+ wrong\??$/i,
      /^what is .+\??$/i,
      /^meaning of .+$/i,
      /^define .+$/i,
      /^translate .+$/i,
      /^how natural is .+\??$/i,
      /^explain .+$/i,
      /^.+\s+meaning\??$/i,
      /^.+\s+mean\??$/i,
      /^.+\s+translation\??$/i
    ].some((pattern) => pattern.test(trimmed));
  }

  private async loadSavedResult(
    thread: Thread,
    userContent: string,
    item: LearningItemIndexEntry
  ): Promise<Thread> {
    const userMessage: ThreadMessage = {
      id: makeId("message"),
      role: "user",
      content: userContent,
      createdAt: nowIso(),
      captureEventId: null
    };
    const assistantMessage: ThreadMessage = {
      id: makeId("message"),
      role: "assistant",
      content: await this.plugin.itemStorage.getDisplayMarkdown(item.id),
      createdAt: nowIso(),
      captureEventId: null
    };
    const event: CaptureEvent = {
      id: makeId("capture"),
      threadId: thread.id,
      messageId: assistantMessage.id,
      itemId: item.id,
      notePath: item.notePath,
      status: "loaded",
      confidence: 1,
      expression: item.term,
      summary: `Loaded saved ${item.label}`,
      createdAt: assistantMessage.createdAt,
      error: null
    };
    assistantMessage.captureEventId = event.id;

    await this.plugin.store.setCaptureEvent(event);
    await this.plugin.store.updateState((state) => {
      const current = state.threads.find((candidate) => candidate.id === thread.id);
      if (!current) {
        return;
      }
      current.title = item.label;
      current.itemId = item.id;
      current.updatedAt = assistantMessage.createdAt;
      current.messages = [userMessage, assistantMessage];
      state.latestThreadId = current.id;
    });
    this.plugin.notifyStateChanged();
    return this.getThread(thread.id) ?? thread;
  }

  private resolveSavedItemForThread(thread: Thread): LearningItemIndexEntry | null {
    if (thread.itemId) {
      const saved = this.plugin.itemStorage.getItem(thread.itemId);
      if (saved) {
        return saved;
      }
    }

    return this.plugin.itemStorage.findReusableItemMatch(thread.title);
  }

  private async resolveThreadForMessage(
    threadId: string | null,
    userMessage: string,
    initialTitle: string,
    itemId: string | null
  ): Promise<Thread> {
    const savedItemThread = itemId ? this.findThreadByItemId(itemId) : null;
    if (savedItemThread) {
      return savedItemThread;
    }

    const currentThread = this.getThread(threadId);
    if (!currentThread) {
      return this.createThread(initialTitle, itemId);
    }

    if (!currentThread.messages.length) {
      return currentThread;
    }

    if (this.shouldStartNewItemThread(currentThread, userMessage, itemId)) {
      return this.createThread(initialTitle, itemId);
    }

    return currentThread;
  }

  private shouldStartNewItemThread(currentThread: Thread, userMessage: string, itemId: string | null): boolean {
    if (itemId && currentThread.itemId && itemId !== currentThread.itemId) {
      return true;
    }

    if (!this.isDirectLookupRequest(userMessage)) {
      return false;
    }

    const inferredExpression = this.inferLookupExpression(userMessage);
    if (!inferredExpression) {
      return false;
    }

    const currentKey = normalizeExpression(currentThread.title || "");
    const nextKey = normalizeExpression(inferredExpression);
    return Boolean(nextKey && currentKey && nextKey !== currentKey);
  }

  private findThreadByItemId(itemId: string): Thread | null {
    return this.plugin.store.state.threads.find((thread) => thread.itemId === itemId) ?? null;
  }

  private hasLookupCue(value: string): boolean {
    return LOOKUP_CUE_PATTERNS.some((pattern) => pattern.test(value));
  }

  private async generateStructuredAssistantResponse(
    userContent: string,
    streamTarget?: { threadId: string; assistantMessageId: string }
  ): Promise<StructuredChatResponse> {
    const provider = this.plugin.getProvider();
    const prompt = getActivePromptProfile(
      this.plugin.store.settings.prompts.profiles,
      "chat",
      this.plugin.store.settings.prompts.activeProfileIds.chat
    );
    const explanationLanguage = this.plugin.store.settings.defaultExplanationLanguage;
    const baseSystemPrompt = `${prompt.systemPrompt}

Return only the tagged envelope described by the user prompt.
Do not use JSON.
Do not wrap the response in markdown fences.`;
    const buildMessages = (retry: boolean, lastRaw = "", lastError = "") => [
      {
        role: "system" as const,
        content: retry
          ? `${baseSystemPrompt}

Your previous response did not match the required tagged format or content requirements. Return the tagged format only.
Ensure REQUEST_KIND, ITEM_LABEL, PRIMARY_EXPRESSION, SOURCE_LANGUAGE, TARGET_LANGUAGE, ITEM_TYPE, RELATED_EXPRESSIONS, and ANSWER are all present.
ANSWER must be a complete tutor answer, not a placeholder like "...".`
          : baseSystemPrompt
      },
      {
        role: "user" as const,
        content: retry && lastRaw.trim()
          ? `${buildStructuredChatUserPrompt(userContent, explanationLanguage)}

Why the previous response was invalid:
${lastError || "It did not satisfy the JSON/content requirements."}

Your previous invalid response was:
${lastRaw}

Return the same content rewritten using the exact tagged format only.`
          : buildStructuredChatUserPrompt(userContent, explanationLanguage)
      }
    ];

    try {
      let lastRaw = "";
      let lastError = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const raw = await provider.sendChat(buildMessages(attempt > 0, lastRaw, lastError), {
          temperature: this.plugin.store.settings.provider.temperature,
          maxTokens: 2400,
          onChunk:
            streamTarget && attempt === 0
              ? (_chunk, fullText) => {
                  this.updateStreamingState(streamTarget.threadId, streamTarget.assistantMessageId, fullText);
                }
              : undefined
        });
        lastRaw = raw;
        let parsed: StructuredChatResponse;
        try {
          parsed = this.parseStructuredAssistantEnvelope(raw);
        } catch (error) {
          lastError = this.describeStructuredParseError(error);
          continue;
        }
        const validationError = this.validateStructuredAssistantResponse(parsed, userContent);
        if (!validationError) {
          return {
            ...parsed,
            primaryExpression: parsed.primaryExpression || parsed.itemLabel
          };
        }
        lastError = validationError;
      }
      throw new Error(
        lastError
          ? `The model kept returning invalid structured output after 3 attempts. ${lastError}`
          : "The model kept returning invalid structured output after 3 attempts."
      );
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Chat request failed.");
      throw error;
    }
  }

  private updateStreamingState(threadId: string, assistantMessageId: string, raw: string): void {
    const partial = this.parseStructuredAssistantEnvelopePartial(raw);
    this.streamingByThread.set(threadId, {
      assistantMessageId,
      raw,
      content: partial.answerMarkdown || "",
      label: partial.itemLabel || this.streamingByThread.get(threadId)?.label || ""
    });
    this.notifyStreamingProgress();
  }

  private clearStreamingState(threadId: string, notify = true): void {
    if (!this.streamingByThread.has(threadId)) {
      return;
    }
    this.streamingByThread.delete(threadId);
    if (notify) {
      this.plugin.notifyStateChanged();
    }
  }

  private notifyStreamingProgress(): void {
    const now = Date.now();
    if (now - this.lastStreamNotifyAt < 80) {
      return;
    }
    this.lastStreamNotifyAt = now;
    this.plugin.notifyStateChanged();
  }

  private parseStructuredAssistantEnvelope(raw: string): StructuredChatResponse {
    const normalized = raw.replace(/\r\n/g, "\n").trim();
    const answerHeader = normalized.match(/(?:^|\n)ANSWER:\s*\n?/i);
    if (!answerHeader || answerHeader.index == null) {
      throw new Error("Missing ANSWER field.");
    }

    const metadataBlock = normalized.slice(0, answerHeader.index).trim();
    const answerMarkdown = normalized.slice(answerHeader.index + answerHeader[0].length).trim();
    if (!metadataBlock) {
      throw new Error("Missing structured metadata fields.");
    }

    const fields = new Map<string, string>();
    for (const line of metadataBlock.split("\n").map((value) => value.trim()).filter(Boolean)) {
      const match = line.match(/^([A-Z_]+):\s*(.*)$/);
      if (!match?.[1]) {
        throw new Error(`Malformed structured line: ${line}`);
      }
      fields.set(match[1], (match[2] ?? "").trim());
    }

    const relatedExpressions = this.parseStructuredListField(fields.get("RELATED_EXPRESSIONS") ?? "");
    return normalizeStructuredChatResponse({
      requestKind: fields.get("REQUEST_KIND") as StructuredChatResponse["requestKind"] | undefined,
      itemLabel: fields.get("ITEM_LABEL"),
      primaryExpression: fields.get("PRIMARY_EXPRESSION"),
      answerMarkdown,
      relatedExpressions,
      sourceLanguage: fields.get("SOURCE_LANGUAGE"),
      targetLanguage: fields.get("TARGET_LANGUAGE"),
      itemType: fields.get("ITEM_TYPE") as StructuredChatResponse["itemType"] | undefined
    });
  }

  private parseStructuredAssistantEnvelopePartial(raw: string): Partial<StructuredChatResponse> {
    const normalized = raw.replace(/\r\n/g, "\n");
    const itemLabel = this.matchStructuredField(normalized, "ITEM_LABEL");
    const primaryExpression = this.matchStructuredField(normalized, "PRIMARY_EXPRESSION");
    const requestKind = this.matchStructuredField(normalized, "REQUEST_KIND");
    const sourceLanguage = this.matchStructuredField(normalized, "SOURCE_LANGUAGE");
    const targetLanguage = this.matchStructuredField(normalized, "TARGET_LANGUAGE");
    const itemType = this.matchStructuredField(normalized, "ITEM_TYPE");
    const relatedExpressions = this.parseStructuredListField(this.matchStructuredField(normalized, "RELATED_EXPRESSIONS"));
    const answerMatch = normalized.match(/(?:^|\n)ANSWER:\s*\n?/i);
    const answerMarkdown =
      answerMatch && answerMatch.index != null
        ? normalized.slice(answerMatch.index + answerMatch[0].length).trimStart()
        : "";

    return normalizeStructuredChatResponse({
      requestKind: requestKind as StructuredChatResponse["requestKind"] | undefined,
      itemLabel,
      primaryExpression,
      answerMarkdown,
      relatedExpressions,
      sourceLanguage,
      targetLanguage,
      itemType: itemType as StructuredChatResponse["itemType"] | undefined
    });
  }

  private matchStructuredField(raw: string, field: string): string {
    const pattern = new RegExp(`(?:^|\\n)${field}:\\s*(.+?)(?=\\n[A-Z_]+:|\\nANSWER:|$)`, "is");
    return raw.match(pattern)?.[1]?.trim() ?? "";
  }

  private parseStructuredListField(value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed || /^none$/i.test(trimmed)) {
      return [];
    }

    return trimmed
      .split(/\s*\|\s*/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private describeStructuredParseError(error: unknown): string {
    if (!(error instanceof Error)) {
      return "The tagged response could not be parsed.";
    }

    const message = error.message.trim();
    if (!message) {
      return "The tagged response could not be parsed.";
    }

    return `The tagged response could not be parsed: ${message}`;
  }

  private validateStructuredAssistantResponse(
    response: StructuredChatResponse,
    userContent: string
  ): string | null {
    if (response.requestKind === "other" && this.isDirectLookupRequest(userContent)) {
      return "requestKind was too vague for a direct lookup-style request.";
    }

    if (!response.itemLabel.trim() && !response.primaryExpression.trim()) {
      return "itemLabel and primaryExpression were both empty.";
    }

    const answerPlain = this.normalizeAssistantAnswerForValidation(response.answerMarkdown);
    if (!answerPlain) {
      return "answerMarkdown was empty.";
    }

    if (/^(?:\.{2,}|…+|n\/a|null|unknown|tbd)$/i.test(answerPlain)) {
      return 'answerMarkdown was only a placeholder like "...".';
    }

    if (!/[A-Za-z\p{Script=Han}]/u.test(answerPlain)) {
      return "answerMarkdown did not contain real language content.";
    }

    if (this.isDirectLookupRequest(userContent) && answerPlain.length < 28) {
      return "answerMarkdown was too short for a real lookup answer.";
    }

    const resolved = response.primaryExpression.trim() || response.itemLabel.trim();
    if (resolved && response.requestKind === "translation") {
      const normalizedResolved = normalizeExpression(resolved);
      const normalizedAnswer = normalizeExpression(answerPlain);
      if (!normalizedAnswer.includes(normalizedResolved)) {
        return "answerMarkdown did not mention the resolved target expression.";
      }
    }

    if (this.shouldRequireIpa(userContent, response) && !this.hasInlineHeadwordWithAnnotations(response.answerMarkdown, resolved)) {
      return 'answerMarkdown did not start with the single-word format "<term> /.../ adj.|vt.|vi.|...".';
    }

    return null;
  }

  private normalizeAssistantAnswerForValidation(markdown: string): string {
    return markdown
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[*_`>#-]+/g, " ")
      .replace(/\[(.*?)\]\(.*?\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  private shouldRequireIpa(userContent: string, response: StructuredChatResponse): boolean {
    if (!["lookup", "translation", "correction"].includes(response.requestKind)) {
      return false;
    }

    const resolved = this.cleanExpression(
      response.primaryExpression.trim() || response.itemLabel.trim() || this.inferLookupExpression(userContent)
    );
    if (!resolved || looksLikeContrast(resolved, userContent)) {
      return false;
    }

    return this.isSingleWordExpression(resolved);
  }

  private isSingleWordExpression(value: string): boolean {
    const normalized = value
      .trim()
      .replace(/[()[\]{}]/g, " ")
      .replace(/\s+/g, " ");
    if (!normalized) {
      return false;
    }

    return normalized.split(" ").length === 1;
  }

  private hasInlineHeadwordWithAnnotations(markdown: string, resolved: string): boolean {
    const firstLine = markdown.replace(/\r\n/g, "\n").split("\n")[0]?.trim() ?? "";
    if (!firstLine || !resolved.trim()) {
      return false;
    }

    const normalizedFirstLine = normalizeExpression(firstLine);
    const normalizedResolved = normalizeExpression(resolved);
    if (!normalizedFirstLine.includes(normalizedResolved)) {
      return false;
    }

    if (!/\/[^/\n]{2,120}\//.test(firstLine)) {
      return false;
    }

    return /\b(?:n|v|vt|vi|adj|adv|prep|pron|conj|interj|det|aux|modal|phr)\./i.test(firstLine);
  }
}
