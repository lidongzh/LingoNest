import { createDefaultPromptProfiles } from "./prompts";
import { estimateReviewStep } from "./review/scheduler";
import type {
  CaptureEvent,
  LingoNestPluginData,
  LingoNestSettings,
  PluginState,
  ProviderKind,
  ProviderSettings,
  ReviewEvent,
  Thread
} from "./types";
import { canonicalizeLanguage } from "./utils/languages";
import { canonicalizeItemType, extractContrastOptions } from "./utils/itemTypes";
import { capitalizeLabel, normalizeExpression, slugify } from "./utils/strings";

export const DEFAULT_SETTINGS: LingoNestSettings = {
  provider: {
    activeProvider: "openai",
    model: "gpt-4.1-mini",
    savedModels: createEmptySavedModels(),
    temperature: 0.2,
    baseUrl: "",
    openAIApiKey: "",
    anthropicApiKey: "",
    groqApiKey: "",
    fireworksApiKey: "",
    openAICompatibleApiKey: "",
    requestTimeoutMs: 120000
  },
  vaultRoot: "LingoNest/Items",
  defaultExplanationLanguage: "English",
  autoSave: true,
  chatSidebarWidth: 280,
  uiFontSize: 14,
  prompts: {
    profiles: createDefaultPromptProfiles(),
    activeProfileIds: {
      chat: "chat-default",
      capture: "capture-default",
      review: "review-default",
      summary: "summary-default"
    }
  }
};

export const DEFAULT_STATE: PluginState = {
  threads: [],
  latestThreadId: null,
  items: {},
  dedupeMap: {},
  captureEvents: {},
  threadSummaries: {},
  review: {
    events: []
  }
};

export function mergePluginData(raw: unknown): LingoNestPluginData {
  const loaded = (raw ?? {}) as Partial<LingoNestPluginData>;
  const loadedSettings = (loaded.settings ?? {}) as Partial<LingoNestSettings>;
  const loadedProvider = (loadedSettings.provider ?? {}) as Partial<LingoNestSettings["provider"]>;
  const loadedPrompts = (loadedSettings.prompts ?? {}) as Partial<LingoNestSettings["prompts"]>;
  const loadedState = (loaded.state ?? {}) as Partial<PluginState>;
  const mergedProvider = {
    ...DEFAULT_SETTINGS.provider,
    ...loadedProvider
  };

  const normalizedVaultRoot =
    typeof loadedSettings.vaultRoot === "string" && loadedSettings.vaultRoot.trim()
      ? loadedSettings.vaultRoot.trim()
      : DEFAULT_SETTINGS.vaultRoot;
  const { items, aliases } = normalizeStoredItems(loadedState.items ?? DEFAULT_STATE.items, normalizedVaultRoot);
  const threads = normalizeThreads(loadedState.threads, items, aliases);
  const hydratedItems = hydrateAssistantResponses(items, threads);
  const dedupeMap = buildDedupeMap(hydratedItems);

  return {
    settings: {
      ...DEFAULT_SETTINGS,
      ...loadedSettings,
      provider: normalizeProviderSettings(mergedProvider),
      prompts: {
        profiles: Array.isArray(loadedPrompts.profiles)
          ? loadedPrompts.profiles
          : DEFAULT_SETTINGS.prompts.profiles,
        activeProfileIds: {
          ...DEFAULT_SETTINGS.prompts.activeProfileIds,
          ...(loadedPrompts.activeProfileIds ?? {})
        }
      }
    },
    state: {
      ...DEFAULT_STATE,
      ...loadedState,
      threads,
      items: hydratedItems,
      dedupeMap,
      captureEvents: normalizeCaptureEvents(loadedState.captureEvents ?? DEFAULT_STATE.captureEvents, aliases),
      threadSummaries: normalizeThreadSummaries(loadedState.threadSummaries ?? DEFAULT_STATE.threadSummaries, aliases),
      review: {
        events: normalizeReviewEvents(Array.isArray(loadedState.review?.events) ? loadedState.review.events : [], aliases)
      }
    }
  };
}

function hydrateAssistantResponses(
  items: PluginState["items"],
  threads: PluginState["threads"]
): PluginState["items"] {
  const assistantByMessageId = new Map<string, string>();
  for (const thread of threads) {
    for (const message of thread.messages) {
      if (message.role === "assistant" && message.content.trim()) {
        assistantByMessageId.set(message.id, message.content);
      }
    }
  }

  const hydrated: PluginState["items"] = {};
  for (const [id, item] of Object.entries(items)) {
    const existingResponse = item.lastAssistantResponse?.trim();
    if (existingResponse) {
      hydrated[id] = item;
      continue;
    }

    const recovered =
      [...item.sourceMessageIds]
        .reverse()
        .map((messageId) => assistantByMessageId.get(messageId)?.trim() ?? "")
        .find(Boolean) ?? "";

    hydrated[id] = {
      ...item,
      lastAssistantResponse: recovered
    };
  }

  return hydrated;
}

function normalizeThreads(
  threads: unknown,
  items: PluginState["items"],
  aliases: Record<string, string>
): PluginState["threads"] {
  if (!Array.isArray(threads)) {
    return DEFAULT_STATE.threads;
  }

  const dedupeMap = buildDedupeMap(items);

  return threads.map((entry) => {
    const thread = entry as Partial<Thread>;
    const initialTitle = typeof thread.title === "string" && thread.title.trim() ? thread.title.trim() : "New Item";
    const itemIdCandidate =
      typeof thread.itemId === "string" && thread.itemId.trim()
        ? aliases[thread.itemId] ?? thread.itemId
        : dedupeMap[buildDedupeKey(initialTitle)] ?? null;
    const linkedItem = itemIdCandidate ? items[itemIdCandidate] : null;
    const title = linkedItem?.label?.trim() || linkedItem?.term?.trim() || initialTitle;

    return {
      id: typeof thread.id === "string" && thread.id.trim() ? thread.id : `thread-${crypto.randomUUID()}`,
      title,
      itemId: itemIdCandidate,
      createdAt: typeof thread.createdAt === "string" ? thread.createdAt : new Date().toISOString(),
      updatedAt: typeof thread.updatedAt === "string" ? thread.updatedAt : new Date().toISOString(),
      messages: Array.isArray(thread.messages) ? thread.messages : []
    };
  });
}

function normalizeStoredItems(
  items: PluginState["items"],
  vaultRoot: string
): { items: PluginState["items"]; aliases: Record<string, string> } {
  const normalized: PluginState["items"] = {};
  const aliases: Record<string, string> = {};
  const dedupeToId: Record<string, string> = {};
  for (const [id, item] of Object.entries(items)) {
    const repairedTerm = repairStoredItemTerm(item);
    const repairedItemType = canonicalizeItemType(
      item.itemType,
      repairedTerm,
      [repairedTerm, item.grammarNotes, item.nuance, ...(item.relatedExpressions ?? []), ...(item.sourceSnippets ?? [])]
        .filter(Boolean)
        .join("\n")
    );
    const normalizedItem = {
      ...item,
      label: normalizeStoredLabel(item.label, repairedTerm),
      term: repairedTerm,
      normalizedTerm: buildDedupeKey(repairedTerm),
      sourceLanguage: canonicalizeLanguage(item.sourceLanguage),
      targetLanguage: canonicalizeLanguage(item.targetLanguage),
      itemType: repairedItemType,
      dedupeKey: buildDedupeKey(repairedTerm),
      chineseMeaning: item.chineseMeaning ?? "",
      lastAssistantResponse: item.lastAssistantResponse ?? "",
      captureState: item.captureState ?? "provisional",
      lastStructuredUpdateAt: item.lastStructuredUpdateAt ?? item.updatedAt ?? null,
      lastStructuredUpdateSource: item.lastStructuredUpdateSource ?? "exchange-auto",
      notePath: buildItemNotePath(repairedTerm, vaultRoot)
    };
    const normalizedReviewStep =
      typeof item.reviewStep === "number" ? item.reviewStep : estimateReviewStep(normalizedItem.intervalDays);
    const normalizedLapseCount = typeof item.lapseCount === "number" ? item.lapseCount : 0;
    const withReviewDefaults = {
      ...normalizedItem,
      reviewStep: normalizedReviewStep,
      lapseCount: normalizedLapseCount
    };
    const existingId = dedupeToId[normalizedItem.dedupeKey];
    if (!existingId) {
      normalized[id] = withReviewDefaults;
      aliases[id] = id;
      dedupeToId[withReviewDefaults.dedupeKey] = id;
      continue;
    }

    const existingItem = normalized[existingId];
    if (!existingItem) {
      normalized[id] = withReviewDefaults;
      aliases[id] = id;
      dedupeToId[withReviewDefaults.dedupeKey] = id;
      continue;
    }

    normalized[existingId] = mergeDuplicateItems(existingItem, withReviewDefaults);
    aliases[id] = existingId;
  }
  return { items: normalized, aliases };
}

function repairStoredItemTerm(item: PluginState["items"][string]): string {
  const sourceTexts = [
    item.term,
    item.grammarNotes,
    item.nuance,
    ...(item.relatedExpressions ?? []),
    ...(item.sourceSnippets ?? [])
  ].filter(Boolean);

  const contrastOptions = sourceTexts
    .map((text) => extractContrastOptions(text))
    .find((options) => options.length >= 2);

  if (contrastOptions?.length) {
    return `${contrastOptions[0]} vs ${contrastOptions[1]}`.trim();
  }

  return item.term;
}

function normalizeStoredLabel(label: unknown, fallbackTerm: string): string {
  const value = typeof label === "string" ? label.trim() : "";
  return capitalizeLabel(value || fallbackTerm);
}

function buildDedupeMap(items: PluginState["items"]): PluginState["dedupeMap"] {
  const dedupeMap: PluginState["dedupeMap"] = {};
  for (const item of Object.values(items)) {
    dedupeMap[item.dedupeKey] = item.id;
  }
  return dedupeMap;
}

function buildDedupeKey(term: string): string {
  return normalizeExpression(term);
}

function buildItemNotePath(term: string, vaultRoot: string): string {
  return `${vaultRoot}/${slugify(term)}.md`;
}

function normalizeThreadSummaries(
  threadSummaries: PluginState["threadSummaries"],
  aliases: Record<string, string>
): PluginState["threadSummaries"] {
  const normalized: PluginState["threadSummaries"] = {};
  for (const [threadId, summary] of Object.entries(threadSummaries ?? {})) {
    normalized[threadId] = {
      ...summary,
      threadId,
      threadTitle: (summary.threadTitle ?? "").trim() || "Thread Summary",
      sourceLanguage: canonicalizeLanguage(summary.sourceLanguage ?? "Unknown"),
      targetLanguage: canonicalizeLanguage(summary.targetLanguage ?? "Unknown"),
      itemIds: normalizeLinkedItemIds(Array.isArray(summary.itemIds) ? summary.itemIds.map(String) : [], aliases),
      createdAt: typeof summary.createdAt === "string" ? summary.createdAt : new Date().toISOString(),
      updatedAt: typeof summary.updatedAt === "string" ? summary.updatedAt : new Date().toISOString(),
      lastRunStatus: summary.lastRunStatus === "updated" ? "updated" : "saved"
    };
  }
  return normalized;
}

function createEmptySavedModels(): Record<ProviderKind, string[]> {
  return {
    openai: [],
    anthropic: [],
    groq: [],
    fireworks: [],
    "openai-compatible": [],
    ollama: []
  };
}

function normalizeProviderSettings(provider: ProviderSettings): ProviderSettings {
  const savedModels = normalizeSavedModels(provider.savedModels);
  const currentModel = provider.model.trim();
  if (currentModel) {
    savedModels[provider.activeProvider] = rememberModel(savedModels[provider.activeProvider], currentModel);
  }

  const preferredModel = currentModel || savedModels[provider.activeProvider][0] || DEFAULT_SETTINGS.provider.model;

  return {
    ...provider,
    model: preferredModel,
    savedModels
  };
}

function normalizeSavedModels(value: unknown): Record<ProviderKind, string[]> {
  const savedModels = createEmptySavedModels();
  const raw = value && typeof value === "object" ? (value as Partial<Record<ProviderKind, unknown>>) : {};

  for (const provider of Object.keys(savedModels) as ProviderKind[]) {
    const models = Array.isArray(raw[provider]) ? raw[provider] : [];
    savedModels[provider] = rememberMany(models);
  }

  return savedModels;
}

function rememberMany(values: unknown[]): string[] {
  let remembered: string[] = [];
  for (const value of values) {
    remembered = rememberModel(remembered, String(value ?? ""));
  }
  return remembered;
}

function rememberModel(existing: string[], candidate: string): string[] {
  const model = candidate.trim();
  if (!model) {
    return existing;
  }

  return [model, ...existing.filter((entry) => entry !== model)].slice(0, 25);
}

function mergeDuplicateItems(
  existing: PluginState["items"][string],
  incoming: PluginState["items"][string]
): PluginState["items"][string] {
  return {
    ...existing,
    label: pickPreferred(existing.label, incoming.label),
    meaning: pickPreferred(existing.meaning, incoming.meaning),
    chineseMeaning: pickPreferred(existing.chineseMeaning, incoming.chineseMeaning),
    pronunciation: pickPreferred(existing.pronunciation, incoming.pronunciation),
    partOfSpeech: pickPreferred(existing.partOfSpeech, incoming.partOfSpeech),
    literalTranslation: pickPreferred(existing.literalTranslation, incoming.literalTranslation),
    naturalTranslation: pickPreferred(existing.naturalTranslation, incoming.naturalTranslation),
    grammarNotes: pickPreferred(existing.grammarNotes, incoming.grammarNotes),
    nuance: pickPreferred(existing.nuance, incoming.nuance),
    examples: uniqueStrings([...existing.examples, ...incoming.examples]),
    commonMistakes: uniqueStrings([...existing.commonMistakes, ...incoming.commonMistakes]),
    relatedExpressions: uniqueStrings([...existing.relatedExpressions, ...incoming.relatedExpressions]),
    sourceSnippets: uniqueStrings([...existing.sourceSnippets, ...incoming.sourceSnippets]),
    lastAssistantResponse: pickPreferred(existing.lastAssistantResponse, incoming.lastAssistantResponse),
    tags: uniqueStrings([...existing.tags, ...incoming.tags]),
    difficulty: existing.difficulty === "unknown" ? incoming.difficulty : existing.difficulty,
    mastery: Math.max(existing.mastery, incoming.mastery),
    recognitionScore: Math.max(existing.recognitionScore, incoming.recognitionScore),
    productionScore: Math.max(existing.productionScore, incoming.productionScore),
    createdAt:
      new Date(existing.createdAt).getTime() <= new Date(incoming.createdAt).getTime()
        ? existing.createdAt
        : incoming.createdAt,
    updatedAt:
      new Date(existing.updatedAt).getTime() >= new Date(incoming.updatedAt).getTime()
        ? existing.updatedAt
        : incoming.updatedAt,
    lastReviewed: latestIso(existing.lastReviewed, incoming.lastReviewed),
    nextReview: earliestIso(existing.nextReview, incoming.nextReview),
    captureState: existing.captureState === "confirmed" || incoming.captureState === "confirmed" ? "confirmed" : "provisional",
    lastStructuredUpdateAt: latestIso(existing.lastStructuredUpdateAt, incoming.lastStructuredUpdateAt),
    lastStructuredUpdateSource: incoming.lastStructuredUpdateAt &&
      (!existing.lastStructuredUpdateAt ||
        new Date(incoming.lastStructuredUpdateAt).getTime() >= new Date(existing.lastStructuredUpdateAt).getTime())
      ? incoming.lastStructuredUpdateSource
      : existing.lastStructuredUpdateSource,
    ease: Math.max(existing.ease, incoming.ease),
    intervalDays: Math.max(existing.intervalDays, incoming.intervalDays),
    reviewStep: Math.max(existing.reviewStep, incoming.reviewStep),
    lapseCount: Math.max(existing.lapseCount, incoming.lapseCount),
    encounterCount: existing.encounterCount + incoming.encounterCount,
    repeatedQueryCount: existing.repeatedQueryCount + incoming.repeatedQueryCount,
    troubleCount: Math.max(existing.troubleCount, incoming.troubleCount),
    sourceThreadIds: uniqueStrings([...existing.sourceThreadIds, ...incoming.sourceThreadIds]),
    sourceMessageIds: uniqueStrings([...existing.sourceMessageIds, ...incoming.sourceMessageIds])
  };
}

function normalizeCaptureEvents(
  events: Record<string, CaptureEvent>,
  aliases: Record<string, string>
): Record<string, CaptureEvent> {
  const normalized: Record<string, CaptureEvent> = {};
  for (const [id, event] of Object.entries(events ?? {})) {
    normalized[id] = {
      ...event,
      itemId: event.itemId ? aliases[event.itemId] ?? event.itemId : null
    };
  }
  return normalized;
}

function normalizeReviewEvents(events: ReviewEvent[], aliases: Record<string, string>): ReviewEvent[] {
  return events.map((event) => ({
    ...event,
    itemId: aliases[event.itemId] ?? event.itemId
  }));
}

function normalizeLinkedItemIds(itemIds: string[], aliases: Record<string, string>): string[] {
  return uniqueStrings(itemIds.map((itemId) => aliases[itemId] ?? itemId));
}

function pickPreferred(existing: string, incoming: string): string {
  const a = existing?.trim() ?? "";
  const b = incoming?.trim() ?? "";
  if (!a) {
    return incoming;
  }
  if (!b) {
    return existing;
  }
  return b.length > a.length ? incoming : existing;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function latestIso(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function earliestIso(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}
