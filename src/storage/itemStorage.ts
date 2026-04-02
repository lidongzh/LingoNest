import { normalizePath, stringifyYaml, TFile, type App } from "obsidian";
import type {
  CaptureCandidate,
  CaptureState,
  LearningItemIndexEntry,
  StructuredUpdateSource,
  ThreadSummaryItem
} from "../types";
import { nowIso } from "../utils/date";
import { canonicalizeLanguage } from "../utils/languages";
import { capitalizeLabel, normalizeExpression, slugify, uniqueNonEmpty } from "../utils/strings";
import { StateStore } from "./stateStore";

export interface UpsertResult {
  item: LearningItemIndexEntry;
  status: "saved" | "updated";
}

export interface UpsertOptions {
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  captureState: CaptureState;
  updateSource: StructuredUpdateSource;
  assistantResponse?: string | null;
}

type SaveableCandidate = CaptureCandidate | ThreadSummaryItem;
type MatchKind = "exact" | "related" | "prefix" | "contains" | "similar";

interface ItemMatch {
  item: LearningItemIndexEntry;
  kind: MatchKind;
  score: number;
}

export class ItemStorage {
  private readonly app: App;
  private readonly store: StateStore;

  constructor(app: App, store: StateStore) {
    this.app = app;
    this.store = store;
  }

  buildDedupeKey(term: string): string {
    return normalizeExpression(term);
  }

  async upsertCandidate(
    candidate: SaveableCandidate,
    options: UpsertOptions
  ): Promise<UpsertResult> {
    const dedupeKey = this.buildDedupeKey(candidate.primaryExpression);
    const existingId = this.store.state.dedupeMap[dedupeKey];
    const now = nowIso();

    let savedItem: LearningItemIndexEntry | null = null;
    let savedStatus: "saved" | "updated" = "saved";
    await this.store.updateState((state) => {
      const existing = existingId ? state.items[existingId] : undefined;
      const next = existing
        ? this.mergeItem(existing, candidate, now, options)
        : this.createItem(candidate, dedupeKey, now, options);
      state.items[next.id] = next;
      state.dedupeMap[dedupeKey] = next.id;
      savedItem = next;
      savedStatus = existing ? "updated" : "saved";
    });

    if (!savedItem) {
      throw new Error("Failed to save learning item.");
    }

    await this.ensureNoteWritten(savedItem);
    return {
      item: savedItem,
      status: savedStatus
    };
  }

  getItems(): LearningItemIndexEntry[] {
    return Object.values(this.store.state.items);
  }

  getItem(itemId: string): LearningItemIndexEntry | null {
    return this.store.state.items[itemId] ?? null;
  }

  getOriginalAssistantResponse(itemId: string): string | null {
    const item = this.getItem(itemId);
    const response = item?.lastAssistantResponse?.trim() ?? "";
    return response || null;
  }

  getItemByNotePath(notePath: string): LearningItemIndexEntry | null {
    return (
      Object.values(this.store.state.items).find((item) => item.notePath === notePath) ?? null
    );
  }

  findItemByExpression(expression: string): LearningItemIndexEntry | null {
    const dedupeKey = this.buildDedupeKey(expression);
    const itemId = this.store.state.dedupeMap[dedupeKey];
    return itemId ? this.getItem(itemId) : null;
  }

  findBestItemMatch(expression: string): LearningItemIndexEntry | null {
    const normalizedQuery = this.buildDedupeKey(expression);
    if (!normalizedQuery) {
      return null;
    }

    const exact = this.findItemByExpression(expression);
    if (exact) {
      return exact;
    }

    const matches = this.getItems()
      .map((item) => this.scoreItemMatch(item, normalizedQuery))
      .filter((match): match is ItemMatch => Boolean(match))
      .sort((left, right) => right.score - left.score);

    const best = matches[0];
    if (!best) {
      return null;
    }

    return best.score >= this.minimumScoreFor(best.kind, normalizedQuery) ? best.item : null;
  }

  async getDisplayMarkdown(itemId: string): Promise<string> {
    const item = this.getItem(itemId);
    if (!item) {
      throw new Error("Saved item not found.");
    }

    await this.ensureNoteWritten(item);
    if (item.lastAssistantResponse.trim()) {
      return item.lastAssistantResponse.trim();
    }

    const existing = this.app.vault.getAbstractFileByPath(item.notePath);
    if (existing instanceof TFile) {
      return this.stripFrontmatter(await this.app.vault.read(existing));
    }

    return this.stripFrontmatter(this.buildNoteContent(item, ""));
  }

  async ensureItemNoteExistsByPath(notePath: string): Promise<LearningItemIndexEntry | null> {
    const item = this.getItemByNotePath(notePath);
    if (!item) {
      return null;
    }

    await this.ensureNoteWritten(item);
    return item;
  }

  async overwriteItem(
    itemId: string,
    candidate: SaveableCandidate,
    options: UpsertOptions
  ): Promise<UpsertResult> {
    const now = nowIso();
    let savedItem: LearningItemIndexEntry | null = null;

    await this.store.updateState((state) => {
      const existing = state.items[itemId];
      if (!existing) {
        return;
      }

      const next = this.replaceItem(existing, candidate, now, options);
      state.items[itemId] = next;
      state.dedupeMap[next.dedupeKey] = next.id;
      savedItem = next;
    });

    if (!savedItem) {
      throw new Error("Saved item not found.");
    }

    await this.ensureNoteWritten(savedItem);
    return {
      item: savedItem,
      status: "updated"
    };
  }

  async deleteItem(itemId: string): Promise<boolean> {
    const item = this.getItem(itemId);
    if (!item) {
      return false;
    }

    const existing = this.app.vault.getAbstractFileByPath(item.notePath);
    if (existing instanceof TFile) {
      try {
        await this.app.vault.trash(existing, true);
      } catch {
        await this.app.vault.delete(existing, true);
      }
    }

    await this.store.updateState((state) => {
      delete state.items[itemId];

      for (const [key, mappedItemId] of Object.entries(state.dedupeMap)) {
        if (mappedItemId === itemId || key === item.dedupeKey) {
          delete state.dedupeMap[key];
        }
      }

      state.captureEvents = Object.fromEntries(
        Object.entries(state.captureEvents).filter(([, event]) => event.itemId !== itemId)
      );
      state.review.events = state.review.events.filter((event) => event.itemId !== itemId);
      state.threads = state.threads.filter((thread) => thread.itemId !== itemId);
      state.latestThreadId = state.threads[0]?.id ?? null;

      for (const summary of Object.values(state.threadSummaries)) {
        summary.itemIds = summary.itemIds.filter((summaryItemId) => summaryItemId !== itemId);
      }
    });

    return true;
  }

  async syncItemNote(item: LearningItemIndexEntry): Promise<void> {
    await this.ensureNoteWritten(item);
  }

  private createItem(
    candidate: SaveableCandidate,
    dedupeKey: string,
    timestamp: string,
    options: UpsertOptions
  ): LearningItemIndexEntry {
    const id = crypto.randomUUID();
    const term = candidate.primaryExpression.trim();
    const label = capitalizeLabel((candidate.label || term).trim());
    return {
      id,
      label,
      term,
      normalizedTerm: normalizeExpression(term),
      sourceLanguage: canonicalizeLanguage(candidate.sourceLanguage),
      targetLanguage: canonicalizeLanguage(candidate.targetLanguage),
      itemType: candidate.itemType,
      meaning: candidate.meaning,
      chineseMeaning: candidate.chineseMeaning,
      pronunciation: candidate.pronunciation,
      partOfSpeech: candidate.partOfSpeech,
      literalTranslation: candidate.literalTranslation,
      naturalTranslation: candidate.naturalTranslation,
      examples: uniqueNonEmpty(candidate.examples),
      grammarNotes: candidate.grammarNotes,
      nuance: candidate.nuance,
      commonMistakes: uniqueNonEmpty(candidate.commonMistakes),
      relatedExpressions: uniqueNonEmpty(candidate.relatedExpressions),
      sourceSnippets: uniqueNonEmpty([candidate.sourceSnippet]),
      lastAssistantResponse: options.assistantResponse?.trim() ?? "",
      tags: uniqueNonEmpty(candidate.tags),
      difficulty: candidate.difficulty || "unknown",
      status: "learning",
      mastery: 0,
      recognitionScore: 0,
      productionScore: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastReviewed: null,
      nextReview: timestamp,
      captureState: options.captureState,
      lastStructuredUpdateAt: timestamp,
      lastStructuredUpdateSource: options.updateSource,
      notePath: this.buildNotePath(term),
      dedupeKey,
      ease: 2.3,
      intervalDays: 0,
      reviewStep: 0,
      lapseCount: 0,
      encounterCount: 1,
      repeatedQueryCount: 0,
      troubleCount: 0,
      sourceThreadIds: options.sourceThreadId ? [options.sourceThreadId] : [],
      sourceMessageIds: options.sourceMessageId ? [options.sourceMessageId] : []
    };
  }

  private mergeItem(
    existing: LearningItemIndexEntry,
    candidate: SaveableCandidate,
    timestamp: string,
    options: UpsertOptions
  ): LearningItemIndexEntry {
    const nextThreadIds = options.sourceThreadId
      ? uniqueNonEmpty([...existing.sourceThreadIds, options.sourceThreadId])
      : existing.sourceThreadIds;
    const nextMessageIds = options.sourceMessageId
      ? uniqueNonEmpty([...existing.sourceMessageIds, options.sourceMessageId])
      : existing.sourceMessageIds;
    const repeatedMessage = options.sourceMessageId ? existing.sourceMessageIds.includes(options.sourceMessageId) : false;
    const repeatedSummaryThread =
      options.updateSource === "thread-summary" &&
      Boolean(options.sourceThreadId && existing.sourceThreadIds.includes(options.sourceThreadId));
    const shouldIncrementEncounter = !repeatedMessage && !repeatedSummaryThread;
    const shouldIncrementRepeatedQuery = Boolean(options.sourceMessageId && !repeatedMessage);

    return {
      ...existing,
      label: this.mergeLabel(existing.label, candidate.label, existing.term),
      meaning: this.mergeCoreField(existing.meaning, candidate.meaning, existing.captureState, options.updateSource),
      chineseMeaning: this.mergeCoreField(
        existing.chineseMeaning,
        candidate.chineseMeaning,
        existing.captureState,
        options.updateSource
      ),
      pronunciation: this.mergeCoreField(existing.pronunciation, candidate.pronunciation, existing.captureState, options.updateSource),
      partOfSpeech: this.mergeCoreField(existing.partOfSpeech, candidate.partOfSpeech, existing.captureState, options.updateSource),
      literalTranslation: this.mergeCoreField(
        existing.literalTranslation,
        candidate.literalTranslation,
        existing.captureState,
        options.updateSource
      ),
      naturalTranslation: this.mergeCoreField(
        existing.naturalTranslation,
        candidate.naturalTranslation,
        existing.captureState,
        options.updateSource
      ),
      examples: uniqueNonEmpty([...existing.examples, ...candidate.examples]),
      grammarNotes: this.mergeCoreField(existing.grammarNotes, candidate.grammarNotes, existing.captureState, options.updateSource),
      nuance: this.mergeCoreField(existing.nuance, candidate.nuance, existing.captureState, options.updateSource),
      commonMistakes: uniqueNonEmpty([...existing.commonMistakes, ...candidate.commonMistakes]),
      relatedExpressions: uniqueNonEmpty([...existing.relatedExpressions, ...candidate.relatedExpressions]),
      sourceSnippets: uniqueNonEmpty([...existing.sourceSnippets, candidate.sourceSnippet]),
      lastAssistantResponse: options.assistantResponse?.trim() || existing.lastAssistantResponse,
      tags: uniqueNonEmpty([...existing.tags, ...candidate.tags]),
      difficulty: this.mergeDifficulty(existing.difficulty, candidate.difficulty, existing.captureState, options.updateSource),
      updatedAt: timestamp,
      encounterCount: shouldIncrementEncounter ? existing.encounterCount + 1 : existing.encounterCount,
      repeatedQueryCount: shouldIncrementRepeatedQuery
        ? existing.repeatedQueryCount + 1
        : existing.repeatedQueryCount,
      sourceThreadIds: nextThreadIds,
      sourceMessageIds: nextMessageIds,
      captureState: options.captureState === "confirmed" ? "confirmed" : existing.captureState,
      lastStructuredUpdateAt: timestamp,
      lastStructuredUpdateSource: options.updateSource
    };
  }

  private replaceItem(
    existing: LearningItemIndexEntry,
    candidate: SaveableCandidate,
    timestamp: string,
    options: UpsertOptions
  ): LearningItemIndexEntry {
    const nextThreadIds = options.sourceThreadId
      ? uniqueNonEmpty([...existing.sourceThreadIds, options.sourceThreadId])
      : existing.sourceThreadIds;
    const nextMessageIds = options.sourceMessageId
      ? uniqueNonEmpty([...existing.sourceMessageIds, options.sourceMessageId])
      : existing.sourceMessageIds;
    const nextSourceLanguage =
      candidate.sourceLanguage && candidate.sourceLanguage !== "Unknown"
        ? canonicalizeLanguage(candidate.sourceLanguage)
        : existing.sourceLanguage;
    const nextTargetLanguage =
      candidate.targetLanguage && candidate.targetLanguage !== "Unknown"
        ? canonicalizeLanguage(candidate.targetLanguage)
        : existing.targetLanguage;

    return {
      ...existing,
      label: capitalizeLabel((candidate.label || existing.label || existing.term).trim()),
      sourceLanguage: nextSourceLanguage,
      targetLanguage: nextTargetLanguage,
      itemType: candidate.itemType || existing.itemType,
      meaning: candidate.meaning.trim(),
      chineseMeaning: candidate.chineseMeaning.trim(),
      pronunciation: candidate.pronunciation.trim(),
      partOfSpeech: candidate.partOfSpeech.trim(),
      literalTranslation: candidate.literalTranslation.trim(),
      naturalTranslation: candidate.naturalTranslation.trim(),
      examples: uniqueNonEmpty(candidate.examples),
      grammarNotes: candidate.grammarNotes.trim(),
      nuance: candidate.nuance.trim(),
      commonMistakes: uniqueNonEmpty(candidate.commonMistakes),
      relatedExpressions: uniqueNonEmpty(candidate.relatedExpressions),
      sourceSnippets: uniqueNonEmpty([candidate.sourceSnippet]),
      lastAssistantResponse: options.assistantResponse?.trim() || existing.lastAssistantResponse,
      tags: uniqueNonEmpty(candidate.tags),
      difficulty: candidate.difficulty.trim() || existing.difficulty,
      updatedAt: timestamp,
      encounterCount: existing.encounterCount + 1,
      repeatedQueryCount: options.sourceMessageId ? existing.repeatedQueryCount + 1 : existing.repeatedQueryCount,
      sourceThreadIds: nextThreadIds,
      sourceMessageIds: nextMessageIds,
      captureState:
        existing.captureState === "confirmed" || options.captureState === "confirmed" ? "confirmed" : options.captureState,
      lastStructuredUpdateAt: timestamp,
      lastStructuredUpdateSource: options.updateSource
    };
  }

  private buildNotePath(term: string): string {
    const root = this.store.settings.vaultRoot.trim() || "LingoNest/Items";
    return normalizePath(`${root}/${slugify(term)}.md`);
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async ensureNoteWritten(item: LearningItemIndexEntry): Promise<void> {
    const filePath = item.notePath;
    const folder = filePath.split("/").slice(0, -1).join("/");
    await this.ensureFolder(folder);

    const existing = this.app.vault.getAbstractFileByPath(filePath);
    const customNotes = existing instanceof TFile ? await this.readCustomNotes(existing) : "";
    const content = this.buildNoteContent(item, customNotes);

    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(filePath, content);
    }
  }

  private async readCustomNotes(file: TFile): Promise<string> {
    const content = await this.app.vault.read(file);
    const marker = "\n## Custom Notes\n";
    const index = content.indexOf(marker);
    if (index === -1) {
      return "";
    }
    return content.slice(index + marker.length).trim();
  }

  private buildNoteContent(item: LearningItemIndexEntry, customNotes: string): string {
    const frontmatter = stringifyYaml({
      id: item.id,
      label: item.label,
      term: item.term,
      normalized_term: item.normalizedTerm,
      item_type: item.itemType,
      tags: item.tags,
      difficulty: item.difficulty,
      status: item.status,
      mastery: item.mastery,
      recognition_score: item.recognitionScore,
      production_score: item.productionScore,
      review_step: item.reviewStep,
      lapse_count: item.lapseCount,
      chinese_meaning: item.chineseMeaning,
      capture_state: item.captureState,
      last_structured_update_at: item.lastStructuredUpdateAt,
      last_structured_update_source: item.lastStructuredUpdateSource,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
      last_reviewed: item.lastReviewed,
      next_review: item.nextReview
    }).trim();

    const lines = [
      "---",
      frontmatter,
      "---",
      "",
      `# ${item.label}`,
      "",
      "## Meaning",
      item.meaning || "_Not captured yet._",
      "",
      "## Short Meaning (Chinese)",
      item.chineseMeaning || "_Not captured yet._",
      "",
      "## Pronunciation",
      item.pronunciation || "_Not captured yet._",
      "",
      "## Part of Speech",
      item.partOfSpeech || "_Not captured yet._",
      "",
      "## Literal Translation",
      item.literalTranslation || "_Not captured yet._",
      "",
      "## Natural Translation",
      item.naturalTranslation || "_Not captured yet._",
      "",
      "## Nuance and Register",
      item.nuance || "_Not captured yet._",
      "",
      "## Examples",
      ...(item.examples.length ? item.examples.map((value) => `- ${value}`) : ["- _No examples yet._"]),
      "",
      "## Grammar Notes",
      item.grammarNotes || "_Not captured yet._",
      "",
      "## Common Mistakes",
      ...(item.commonMistakes.length
        ? item.commonMistakes.map((value) => `- ${value}`)
        : ["- _No common mistakes yet._"]),
      "",
      "## Related Expressions",
      ...(item.relatedExpressions.length
        ? item.relatedExpressions.map((value) => `- ${value}`)
        : ["- _No related expressions yet._"]),
      "",
      "## Source Snippets",
      ...(item.sourceSnippets.length ? item.sourceSnippets.map((value) => `- ${value}`) : ["- _No source snippets yet._"]),
      "",
      "## Custom Notes",
      customNotes || "_Add your own notes here._",
      ""
    ];

    return lines.join("\n");
  }

  private stripFrontmatter(content: string): string {
    if (!content.startsWith("---\n")) {
      return content.trim();
    }

    const closing = content.indexOf("\n---\n", 4);
    if (closing === -1) {
      return content.trim();
    }

    return content.slice(closing + 5).trim();
  }

  private scoreItemMatch(item: LearningItemIndexEntry, normalizedQuery: string): ItemMatch | null {
    if (!normalizedQuery) {
      return null;
    }

    const normalizedLabel = this.buildDedupeKey(item.label);
    if (item.dedupeKey === normalizedQuery) {
      return { item, kind: "exact", score: 1 };
    }
    if (normalizedLabel && normalizedLabel === normalizedQuery) {
      return { item, kind: "exact", score: 0.995 };
    }

    const related = item.relatedExpressions
      .map((value) => this.buildDedupeKey(value))
      .find((value) => value === normalizedQuery);
    if (related) {
      return { item, kind: "related", score: 0.97 };
    }

    if (normalizedQuery.length >= 4) {
      if (
        item.dedupeKey.startsWith(normalizedQuery) ||
        normalizedQuery.startsWith(item.dedupeKey) ||
        (normalizedLabel && (normalizedLabel.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedLabel)))
      ) {
        const labelPrefixScore = normalizedLabel ? this.prefixScore(normalizedLabel, normalizedQuery) : 0;
        return {
          item,
          kind: "prefix",
          score: Math.max(this.prefixScore(item.dedupeKey, normalizedQuery), labelPrefixScore)
        };
      }

      const relatedPrefix = item.relatedExpressions
        .map((value) => this.buildDedupeKey(value))
        .find((value) => value.startsWith(normalizedQuery) || normalizedQuery.startsWith(value));
      if (relatedPrefix) {
        return { item, kind: "prefix", score: this.prefixScore(relatedPrefix, normalizedQuery) - 0.03 };
      }
    }

    if (normalizedQuery.length >= 5) {
      if (
        item.dedupeKey.includes(normalizedQuery) ||
        normalizedQuery.includes(item.dedupeKey) ||
        (normalizedLabel && (normalizedLabel.includes(normalizedQuery) || normalizedQuery.includes(normalizedLabel)))
      ) {
        const labelContainsScore = normalizedLabel ? this.containsScore(normalizedLabel, normalizedQuery) : 0;
        return {
          item,
          kind: "contains",
          score: Math.max(this.containsScore(item.dedupeKey, normalizedQuery), labelContainsScore)
        };
      }

      const relatedContains = item.relatedExpressions
        .map((value) => this.buildDedupeKey(value))
        .find((value) => value.includes(normalizedQuery) || normalizedQuery.includes(value));
      if (relatedContains) {
        return { item, kind: "contains", score: this.containsScore(relatedContains, normalizedQuery) - 0.04 };
      }
    }

    const similarity = this.computeSimilarity(item.dedupeKey, normalizedQuery);
    const labelSimilarity = normalizedLabel ? this.computeSimilarity(normalizedLabel, normalizedQuery) : 0;
    const bestSimilarity = Math.max(similarity, labelSimilarity);
    if (bestSimilarity >= 0.76) {
      return { item, kind: "similar", score: bestSimilarity };
    }

    const relatedSimilarity = item.relatedExpressions
      .map((value) => this.buildDedupeKey(value))
      .map((value) => this.computeSimilarity(value, normalizedQuery))
      .sort((left, right) => right - left)[0];
    if ((relatedSimilarity ?? 0) >= 0.8) {
      return { item, kind: "similar", score: (relatedSimilarity ?? 0) - 0.04 };
    }

    return null;
  }

  private prefixScore(left: string, right: string): number {
    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length) || 1;
    return 0.9 + shorter / longer * 0.08;
  }

  private containsScore(left: string, right: string): number {
    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length) || 1;
    return 0.82 + shorter / longer * 0.08;
  }

  private minimumScoreFor(kind: MatchKind, normalizedQuery: string): number {
    if (kind === "exact") {
      return 1;
    }
    if (kind === "related") {
      return 0.95;
    }
    if (kind === "prefix") {
      return normalizedQuery.length <= 4 ? 0.96 : 0.92;
    }
    if (kind === "contains") {
      return normalizedQuery.length <= 5 ? 0.88 : 0.84;
    }
    return normalizedQuery.length <= 4 ? 0.9 : 0.78;
  }

  private computeSimilarity(left: string, right: string): number {
    if (!left || !right) {
      return 0;
    }
    if (left === right) {
      return 1;
    }

    const leftTokens = new Set(left.split(" ").filter(Boolean));
    const rightTokens = new Set(right.split(" ").filter(Boolean));
    const tokenOverlap = this.overlapRatio(leftTokens, rightTokens);
    const editSimilarity = 1 - this.editDistance(left, right) / Math.max(left.length, right.length, 1);

    return tokenOverlap * 0.55 + editSimilarity * 0.45;
  }

  private overlapRatio(left: Set<string>, right: Set<string>): number {
    if (!left.size || !right.size) {
      return 0;
    }

    let intersection = 0;
    for (const token of left) {
      if (right.has(token)) {
        intersection += 1;
      }
    }

    return intersection / Math.max(left.size, right.size);
  }

  private editDistance(left: string, right: string): number {
    const rows = left.length + 1;
    const cols = right.length + 1;
    const dp: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

    for (let i = 0; i < rows; i += 1) {
      dp[i]![0] = i;
    }
    for (let j = 0; j < cols; j += 1) {
      dp[0]![j] = j;
    }

    for (let i = 1; i < rows; i += 1) {
      for (let j = 1; j < cols; j += 1) {
        const cost = left[i - 1] === right[j - 1] ? 0 : 1;
        dp[i]![j] = Math.min(
          dp[i - 1]![j]! + 1,
          dp[i]![j - 1]! + 1,
          dp[i - 1]![j - 1]! + cost
        );
      }
    }

    return dp[left.length]![right.length]!;
  }

  private mergeCoreField(
    existingValue: string,
    incomingValue: string,
    existingCaptureState: CaptureState,
    updateSource: StructuredUpdateSource
  ): string {
    const existing = existingValue.trim();
    const incoming = incomingValue.trim();

    if (!incoming) {
      return existingValue;
    }
    if (this.isWeakValue(existing)) {
      return incoming;
    }
    if (
      updateSource === "thread-summary" &&
      existingCaptureState === "provisional" &&
      incoming.length >= existing.length + 12
    ) {
      return incoming;
    }
    return existingValue;
  }

  private mergeLabel(existingLabel: string, incomingLabel: string, fallbackTerm: string): string {
    const existing = capitalizeLabel(existingLabel.trim() || fallbackTerm);
    const incoming = capitalizeLabel(incomingLabel.trim());
    if (!incoming) {
      return existing;
    }
    if (normalizeExpression(existing) === normalizeExpression(fallbackTerm) && normalizeExpression(incoming) !== normalizeExpression(fallbackTerm)) {
      return incoming;
    }
    if (incoming.length >= existing.length + 4) {
      return incoming;
    }
    return existing;
  }

  private mergeDifficulty(
    existingValue: string,
    incomingValue: string,
    existingCaptureState: CaptureState,
    updateSource: StructuredUpdateSource
  ): string {
    const existing = existingValue.trim() || "unknown";
    const incoming = incomingValue.trim() || "unknown";
    if (existing === "unknown" && incoming !== "unknown") {
      return incoming;
    }
    if (updateSource === "thread-summary" && existingCaptureState === "provisional" && incoming !== "unknown") {
      return incoming;
    }
    return existing;
  }

  private isWeakValue(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return !normalized || normalized === "unknown" || normalized === "_not captured yet._";
  }
}
