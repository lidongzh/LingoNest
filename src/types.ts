export type ProviderKind =
  | "openai"
  | "anthropic"
  | "groq"
  | "fireworks"
  | "openai-compatible"
  | "ollama";

export type PromptWorkflow = "chat" | "capture" | "review" | "summary";
export type ChatRole = "system" | "user" | "assistant";
export type ItemType =
  | "word"
  | "phrase"
  | "grammar"
  | "correction"
  | "expression"
  | "contrast"
  | "grammar-rule"
  | "correction-pattern"
  | "register-note"
  | "usage-note";
export type ReviewExerciseType = "standard" | "cloze" | "fix-sentence" | "use-in-reply";
export type ReviewQueueKind = "due" | "new" | "trouble" | "recent";
export type ReviewGrade = "again" | "hard" | "good" | "easy";
export type CaptureState = "provisional" | "confirmed";
export type StructuredUpdateSource = "exchange-auto" | "exchange-manual" | "thread-summary";

export interface PromptProfile {
  id: string;
  workflow: PromptWorkflow;
  name: string;
  systemPrompt: string;
  isBuiltIn: boolean;
}

export interface ProviderSettings {
  activeProvider: ProviderKind;
  model: string;
  savedModels: Record<ProviderKind, string[]>;
  temperature: number;
  baseUrl: string;
  openAIApiKey: string;
  anthropicApiKey: string;
  groqApiKey: string;
  fireworksApiKey: string;
  openAICompatibleApiKey: string;
  requestTimeoutMs: number;
}

export interface PromptSettings {
  profiles: PromptProfile[];
  activeProfileIds: Record<PromptWorkflow, string>;
}

export interface LingoNestSettings {
  provider: ProviderSettings;
  vaultRoot: string;
  defaultExplanationLanguage: string;
  autoSave: boolean;
  chatSidebarWidth: number;
  prompts: PromptSettings;
}

export interface LLMChatMessage {
  role: ChatRole;
  content: string;
}

export interface SendChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface CaptureContext {
  threadTitle: string;
  userMessage: string;
  assistantMessage: string;
  explanationLanguage: string;
  conversationExcerpt: string;
}

export interface ThreadSummaryContext {
  threadId: string;
  threadTitle: string;
  explanationLanguage: string;
  conversationExcerpt: string;
}

export interface CaptureCandidate {
  shouldSave: boolean;
  confidence: number;
  label: string;
  primaryExpression: string;
  sourceLanguage: string;
  targetLanguage: string;
  itemType: ItemType;
  meaning: string;
  chineseMeaning: string;
  pronunciation: string;
  partOfSpeech: string;
  literalTranslation: string;
  naturalTranslation: string;
  examples: string[];
  grammarNotes: string;
  nuance: string;
  commonMistakes: string[];
  tags: string[];
  difficulty: string;
  relatedExpressions: string[];
  sourceSnippet: string;
}

export interface ThreadSummaryItem {
  confidence: number;
  label: string;
  primaryExpression: string;
  sourceLanguage: string;
  targetLanguage: string;
  itemType: ItemType;
  meaning: string;
  chineseMeaning: string;
  pronunciation: string;
  partOfSpeech: string;
  literalTranslation: string;
  naturalTranslation: string;
  examples: string[];
  grammarNotes: string;
  nuance: string;
  commonMistakes: string[];
  tags: string[];
  difficulty: string;
  relatedExpressions: string[];
  sourceSnippet: string;
}

export interface ThreadSummaryResult {
  threadTitle: string;
  sourceLanguage: string;
  targetLanguage: string;
  overview: string;
  questionsAsked: string[];
  grammarPoints: string[];
  confusions: string[];
  notableExamples: string[];
  reviewPrompts: string[];
  items: ThreadSummaryItem[];
}

export interface LearningItem {
  id: string;
  label: string;
  term: string;
  normalizedTerm: string;
  sourceLanguage: string;
  targetLanguage: string;
  itemType: ItemType;
  meaning: string;
  chineseMeaning: string;
  pronunciation: string;
  partOfSpeech: string;
  literalTranslation: string;
  naturalTranslation: string;
  examples: string[];
  grammarNotes: string;
  nuance: string;
  commonMistakes: string[];
  relatedExpressions: string[];
  sourceSnippets: string[];
  lastAssistantResponse: string;
  tags: string[];
  difficulty: string;
  status: "new" | "learning" | "reviewing" | "mastered";
  mastery: number;
  recognitionScore: number;
  productionScore: number;
  createdAt: string;
  updatedAt: string;
  lastReviewed: string | null;
  nextReview: string | null;
  captureState: CaptureState;
  lastStructuredUpdateAt: string | null;
  lastStructuredUpdateSource: StructuredUpdateSource | null;
}

export interface LearningItemIndexEntry extends LearningItem {
  notePath: string;
  dedupeKey: string;
  ease: number;
  intervalDays: number;
  reviewStep: number;
  lapseCount: number;
  encounterCount: number;
  repeatedQueryCount: number;
  troubleCount: number;
  sourceThreadIds: string[];
  sourceMessageIds: string[];
}

export interface ThreadMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  captureEventId: string | null;
}

export interface Thread {
  id: string;
  title: string;
  itemId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ThreadMessage[];
}

export interface CaptureEvent {
  id: string;
  threadId: string | null;
  messageId: string | null;
  itemId: string | null;
  notePath: string | null;
  status: "saved" | "updated" | "loaded" | "regenerated" | "skipped" | "error";
  confidence: number;
  expression: string;
  summary: string;
  createdAt: string;
  error: string | null;
}

export interface ReviewEvent {
  id: string;
  itemId: string;
  createdAt: string;
  grade: ReviewGrade;
  exerciseType: ReviewExerciseType;
  prompt: string;
  expectedAnswer: string;
}

export interface ReviewState {
  events: ReviewEvent[];
}

export interface ThreadSummaryRecord {
  threadId: string;
  threadTitle: string;
  sourceLanguage: string;
  targetLanguage: string;
  notePath: string;
  itemIds: string[];
  createdAt: string;
  updatedAt: string;
  lastRunStatus: "saved" | "updated";
}

export interface PluginState {
  threads: Thread[];
  latestThreadId: string | null;
  items: Record<string, LearningItemIndexEntry>;
  dedupeMap: Record<string, string>;
  captureEvents: Record<string, CaptureEvent>;
  threadSummaries: Record<string, ThreadSummaryRecord>;
  review: ReviewState;
}

export interface LingoNestPluginData {
  settings: LingoNestSettings;
  state: PluginState;
}

export interface ReviewExercise {
  type: ReviewExerciseType;
  prompt: string;
  expectedAnswer: string;
  hints: string[];
  clozeSentence: string | null;
  choices: string[];
  explanation: string;
}

export interface ReviewExerciseResponse {
  exercise: ReviewExercise;
}

export interface StructuredChatResponse {
  itemLabel: string;
  primaryExpression: string;
  answerMarkdown: string;
  relatedExpressions: string[];
  sourceLanguage: string;
  targetLanguage: string;
  itemType: ItemType;
}

export interface ProviderRequestContext {
  systemPrompt: string;
}

export interface LLMProvider {
  readonly kind: ProviderKind;
  sendChat(messages: LLMChatMessage[], options?: SendChatOptions): Promise<string>;
  extractCandidate(context: CaptureContext, request: ProviderRequestContext): Promise<CaptureCandidate>;
  generateThreadSummary(
    context: ThreadSummaryContext,
    request: ProviderRequestContext
  ): Promise<ThreadSummaryResult>;
  generateReviewExercise(
    item: LearningItem,
    mode: ReviewExerciseType,
    request: ProviderRequestContext
  ): Promise<ReviewExercise>;
}
