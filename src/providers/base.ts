import type {
  CaptureCandidate,
  CaptureContext,
  LearningItem,
  LLMChatMessage,
  LLMProvider,
  ProviderKind,
  ProviderRequestContext,
  ThreadSummaryContext,
  ThreadSummaryResult,
  ReviewExercise,
  ReviewExerciseType,
  SendChatOptions
} from "../types";
import {
  buildCaptureUserPrompt,
  buildReviewUserPrompt,
  buildThreadSummaryUserPrompt,
  normalizeCaptureCandidate,
  normalizeThreadSummaryResult
} from "../prompts";
import { deriveReviewItemType, extractContrastOptions } from "../utils/itemTypes";
import { parseJsonObject } from "../utils/json";

interface ReviewExerciseShape {
  type?: ReviewExerciseType;
  prompt?: string;
  expectedAnswer?: string;
  hints?: string[];
  clozeSentence?: string | null;
  choices?: string[];
  explanation?: string;
}

export abstract class AbstractProvider implements LLMProvider {
  abstract readonly kind: ProviderKind;

  async sendChat(messages: LLMChatMessage[], options?: SendChatOptions): Promise<string> {
    const text = await this.complete(messages, options);
    if (options?.onChunk) {
      await options.onChunk(text, text);
    }
    return text;
  }

  async extractCandidate(context: CaptureContext, request: ProviderRequestContext): Promise<CaptureCandidate> {
    try {
      const response = await this.complete(
        [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: buildCaptureUserPrompt(context) }
        ],
        { maxTokens: 1200 }
      );
      const candidate = normalizeCaptureCandidate(parseJsonObject<Partial<CaptureCandidate>>(response));
      if (!candidate.primaryExpression) {
        return { ...candidate, shouldSave: false, confidence: 0 };
      }
      return candidate;
    } catch {
      return normalizeCaptureCandidate({
        shouldSave: false,
        confidence: 0,
        primaryExpression: "",
        sourceLanguage: "Unknown",
        targetLanguage: "Unknown",
        itemType: "expression",
        chineseMeaning: "",
        sourceSnippet: context.userMessage
      });
    }
  }

  async generateReviewExercise(
    item: LearningItem,
    mode: ReviewExerciseType,
    request: ProviderRequestContext
  ): Promise<ReviewExercise> {
    if (mode === "standard") {
      const itemType = deriveReviewItemType(item);
      return {
        type: "standard",
        prompt: buildFallbackPrompt(item, itemType, mode),
        expectedAnswer: item.naturalTranslation || item.meaning,
        hints: [item.chineseMeaning, item.pronunciation, item.partOfSpeech].filter(Boolean),
        clozeSentence: null,
        choices: [],
        explanation: item.nuance || item.grammarNotes || ""
      };
    }

    try {
      const response = await this.complete(
        [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: buildReviewUserPrompt(item, mode) }
        ],
        { maxTokens: 1000 }
      );
      return normalizeReviewExercise(parseJsonObject<ReviewExerciseShape>(response), item, mode);
    } catch {
      return buildFallbackReviewExercise(item, mode);
    }
  }

  async generateThreadSummary(
    context: ThreadSummaryContext,
    request: ProviderRequestContext
  ): Promise<ThreadSummaryResult> {
    const response = await this.complete(
      [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: buildThreadSummaryUserPrompt(context) }
      ],
      { maxTokens: 2200 }
    );

    return normalizeThreadSummaryResult(parseJsonObject<Partial<ThreadSummaryResult>>(response));
  }

  protected sanitizeText(text: string): string {
    return text
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
  }

  protected abstract complete(messages: LLMChatMessage[], options?: SendChatOptions): Promise<string>;
}

function normalizeReviewExercise(
  parsed: ReviewExerciseShape,
  item: LearningItem,
  mode: ReviewExerciseType
): ReviewExercise {
  const type = parsed.type ?? mode;
  const hints = Array.isArray(parsed.hints) ? parsed.hints.map(String).map((value) => value.trim()).filter(Boolean) : [];
  const clozeChoices = Array.isArray(parsed.choices) ? parsed.choices.map(String).map((value) => value.trim()).filter(Boolean) : [];
  const clozeSentence = typeof parsed.clozeSentence === "string" ? parsed.clozeSentence.trim() : "";
  if (type === "cloze" && (!clozeSentence || uniqueStrings(clozeChoices).length < 2)) {
    return buildFallbackReviewExercise(item, "cloze");
  }

  return {
    type,
    prompt: parsed.prompt?.trim() || defaultPromptFor(type, item),
    expectedAnswer: parsed.expectedAnswer?.trim() || item.naturalTranslation || item.meaning,
    hints,
    clozeSentence: type === "cloze" ? clozeSentence || null : null,
    choices: type === "cloze" ? uniqueStrings(clozeChoices) : [],
    explanation: parsed.explanation?.trim() || item.nuance || item.grammarNotes || ""
  };
}

function buildFallbackReviewExercise(item: LearningItem, mode: ReviewExerciseType): ReviewExercise {
  const itemType = deriveReviewItemType(item);
  if (mode === "cloze") {
    return buildFallbackClozeExercise(item);
  }

  return {
    type: "standard",
    prompt: buildFallbackPrompt(item, itemType, mode),
    expectedAnswer: item.naturalTranslation || item.meaning,
    hints: [item.chineseMeaning, item.pronunciation, item.partOfSpeech].filter(Boolean),
    clozeSentence: null,
    choices: [],
    explanation: item.nuance || item.grammarNotes || ""
  };
}

function buildFallbackClozeExercise(item: LearningItem): ReviewExercise {
  const itemType = deriveReviewItemType(item);
  const contrastOptions = itemType === "contrast" ? extractContrastOptions(item.term) : [];
  const example = item.examples.find((value) => value.toLowerCase().includes(item.term.toLowerCase())) ?? item.examples[0] ?? "";
  if (itemType === "contrast" && contrastOptions.length >= 2) {
    const clozeExample =
      item.examples.find((value) => contrastOptions.some((option) => value.toLowerCase().includes(option.toLowerCase()))) ?? "";
    if (clozeExample) {
      const answer = contrastOptions.find((option) => clozeExample.toLowerCase().includes(option.toLowerCase())) ?? contrastOptions[0]!;
      const clozeSentence = clozeExample.replace(new RegExp(escapeRegExp(answer), "i"), "____");
      return {
        type: "cloze",
        prompt: "Type the better word for this sentence.",
        expectedAnswer: answer,
        hints: [item.chineseMeaning, item.meaning].filter(Boolean),
        clozeSentence,
        choices: contrastOptions.slice(0, 4),
        explanation: item.nuance || item.grammarNotes || ""
      };
    }
  }

  if (!example) {
    return buildFallbackReviewExercise(item, "standard");
  }

  const escaped = escapeRegExp(item.term);
  const clozeSentence = example.replace(new RegExp(escaped, "i"), "____");
  if (clozeSentence === example) {
    return buildFallbackReviewExercise(item, "standard");
  }

  const distractors = uniqueStrings(
    [...item.relatedExpressions, ...item.commonMistakes]
      .map((value) => value.split(/[;,/]/)[0]?.trim() ?? "")
      .filter(Boolean)
  )
    .filter((value) => value.toLowerCase() !== item.term.toLowerCase())
    .slice(0, 3);
  const choices = uniqueStrings([item.term, ...distractors]).slice(0, 4);
  if (choices.length < 2) {
    return buildFallbackReviewExercise(item, "standard");
  }

  return {
    type: "cloze",
    prompt: `Type the best expression to complete the sentence.`,
    expectedAnswer: item.term,
    hints: [item.chineseMeaning, item.meaning].filter(Boolean),
    clozeSentence,
    choices,
    explanation: item.nuance || item.grammarNotes || ""
  };
}

function defaultPromptFor(type: ReviewExerciseType, item: LearningItem): string {
  const itemType = deriveReviewItemType(item);
  switch (type) {
    case "cloze":
      return itemType === "contrast"
        ? "Type the better expression to complete the sentence."
        : "Type the best expression to complete the sentence.";
    case "fix-sentence":
      return itemType === "contrast"
        ? `Fix the sentence by choosing the better contrast term.`
        : `Fix the sentence so "${item.term}" sounds natural.`;
    case "use-in-reply":
      return itemType === "contrast"
        ? `Write one or two short sentences that show the difference in use.`
        : `Write a short reply that uses "${item.term}" naturally.`;
    case "standard":
      return buildFallbackPrompt(item, itemType, type);
  }
}

function buildFallbackPrompt(item: LearningItem, itemType: ReturnType<typeof deriveReviewItemType>, mode: ReviewExerciseType): string {
  switch (itemType) {
    case "contrast":
      if (mode === "use-in-reply") {
        return `Write one short sentence for each side of "${item.term}".`;
      }
      return `What is the main difference in "${item.term}"?`;
    case "grammar-rule":
      return `What rule does "${item.term}" capture, and when do you use it?`;
    case "correction-pattern":
      return `What should you remember from the correction "${item.term}"?`;
    case "register-note":
      return `What register or tone point should you remember about "${item.term}"?`;
    case "usage-note":
      return `When is "${item.term}" appropriate to use?`;
    case "word":
    case "phrase":
    case "expression":
    case "grammar":
    case "correction":
      return `Explain or translate "${item.term}".`;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
