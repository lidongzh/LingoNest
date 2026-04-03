import type {
  CaptureCandidate,
  CaptureContext,
  LearningItem,
  PromptProfile,
  PromptWorkflow,
  StructuredRequestKind,
  StructuredChatResponse,
  ThreadSummaryContext,
  ThreadSummaryItem,
  ThreadSummaryResult,
  ReviewExerciseType
} from "./types";
import { capitalizeLabel, makeId } from "./utils/strings";
import { canonicalizeItemType, deriveReviewItemType } from "./utils/itemTypes";
import { canonicalizeLanguage } from "./utils/languages";

const builtinProfiles: PromptProfile[] = [
  {
    id: "chat-default",
    workflow: "chat",
    name: "Default",
    isBuiltIn: true,
    systemPrompt: `You are LingoNest, a language-learning tutor inside Obsidian.

Answer language questions directly and clearly. When relevant, include:
- English meaning/explanation
- one short Chinese meaning
- pronunciation
- part of speech
- countability for nouns
- literal translation if it helps
- natural translation
- example sentences
- nuance or register
- common mistakes

Prefer compact, structured explanations. If the user asks for beginner help, simplify without becoming vague.
Explain mainly in English. Include one short Chinese gloss when it helps.

If the user's lookup appears to contain a typo or misspelling and you are confident about the intended expression, begin the answer with exactly these two lines:
Correction: <corrected canonical word or phrase>
Original: <the user's misspelling>

Then continue the explanation for the corrected expression.
Do not use this correction header unless you are confident.
Do not wrap those two header lines in markdown code fences.`
  },
  {
    id: "capture-default",
    workflow: "capture",
    name: "Default",
    isBuiltIn: true,
    systemPrompt: `You extract one primary learnable language item from a conversation.

Return JSON only. Choose the single main word, phrase, grammar pattern, or correction that the user is most likely trying to learn.
Do not return markdown. Do not include commentary outside JSON.
Set shouldSave to false if the conversation is not about a concrete learnable item.
If the user made a typo but the assistant clearly corrected it, set primaryExpression to the corrected canonical form and include the original typo in relatedExpressions.

Required JSON shape:
{
  "shouldSave": boolean,
  "confidence": number,
  "label": string,
  "primaryExpression": string,
  "sourceLanguage": string,
  "targetLanguage": string,
  "itemType": "word" | "phrase" | "expression" | "contrast" | "grammar-rule" | "correction-pattern" | "register-note" | "usage-note",
  "meaning": string,
  "chineseMeaning": string,
  "pronunciation": string,
  "partOfSpeech": string,
  "literalTranslation": string,
  "naturalTranslation": string,
  "examples": string[],
  "grammarNotes": string,
  "nuance": string,
  "commonMistakes": string[],
  "tags": string[],
  "difficulty": string,
  "relatedExpressions": string[],
  "sourceSnippet": string
}`
  },
  {
    id: "review-default",
    workflow: "review",
    name: "Default",
    isBuiltIn: true,
    systemPrompt: `You generate one language-learning review exercise from a saved study item.

Return JSON only with:
{
  "type": "standard" | "cloze" | "fix-sentence" | "use-in-reply",
  "prompt": string,
  "expectedAnswer": string,
  "hints": string[],
  "clozeSentence": string | null,
  "choices": string[],
  "explanation": string
}

Rules:
- For "standard", make it a flashcard-style recall prompt.
- For "cloze", return exactly one sentence with one blank written as "____".
- For "cloze", return 4 candidate words or phrases in "choices", including the correct answer.
- For "cloze", the learner will see the choices as a candidate bank but type the final answer.
- Cloze distractors must be plausible and similar in register/part of speech.
- If the saved item is a contrast item, focus on choosing or explaining the distinction between the contrasted expressions.
- If the saved item is a grammar-rule or correction-pattern item, focus on applying the rule naturally, not dictionary definition recall.
- Keep prompts concise and tied to the saved item's meaning, nuance, and examples.
- Use realistic language, not textbook filler.
- Keep explanations in English with at most one short Chinese gloss when useful.`
  },
  {
    id: "summary-default",
    workflow: "summary",
    name: "Default",
    isBuiltIn: true,
    systemPrompt: `You turn one language-learning conversation into a structured lesson summary.

Return JSON only. Do not return markdown. Do not include commentary outside JSON.
Be conservative: only include learnable items that are concrete enough to study later.
It is valid for items to be an empty array when the conversation does not contain real study material.

Required JSON shape:
{
  "threadTitle": string,
  "sourceLanguage": string,
  "targetLanguage": string,
  "overview": string,
  "questionsAsked": string[],
  "grammarPoints": string[],
  "confusions": string[],
  "notableExamples": string[],
  "reviewPrompts": string[],
  "items": [
    {
      "confidence": number,
      "label": string,
      "primaryExpression": string,
      "sourceLanguage": string,
      "targetLanguage": string,
      "itemType": "word" | "phrase" | "expression" | "contrast" | "grammar-rule" | "correction-pattern" | "register-note" | "usage-note",
      "meaning": string,
      "chineseMeaning": string,
      "pronunciation": string,
      "partOfSpeech": string,
      "literalTranslation": string,
      "naturalTranslation": string,
      "examples": string[],
      "grammarNotes": string,
      "nuance": string,
      "commonMistakes": string[],
      "tags": string[],
      "difficulty": string,
      "relatedExpressions": string[],
      "sourceSnippet": string
    }
  ]
}`
  }
];

export function createDefaultPromptProfiles(): PromptProfile[] {
  return builtinProfiles.map((profile) => ({ ...profile }));
}

export function ensurePromptProfiles(profiles: PromptProfile[]): PromptProfile[] {
  const existingCustomProfiles = profiles.filter((profile) => !profile.isBuiltIn);
  const existing = new Map(existingCustomProfiles.map((profile) => [profile.id, profile]));
  for (const profile of builtinProfiles) {
    existing.set(profile.id, { ...profile });
  }
  return Array.from(existing.values());
}

export function getProfilesForWorkflow(profiles: PromptProfile[], workflow: PromptWorkflow): PromptProfile[] {
  return profiles.filter((profile) => profile.workflow === workflow);
}

export function getActivePromptProfile(
  profiles: PromptProfile[],
  workflow: PromptWorkflow,
  activeId: string | undefined
): PromptProfile {
  return (
    profiles.find((profile) => profile.workflow === workflow && profile.id === activeId) ??
    builtinProfiles.find((profile) => profile.workflow === workflow) ??
    profiles.find((profile) => profile.workflow === workflow)!
  );
}

export function createCustomProfile(workflow: PromptWorkflow, source?: PromptProfile): PromptProfile {
  return {
    id: makeId(`${workflow}-profile`),
    workflow,
    name: source ? `${source.name} Copy` : "Custom",
    systemPrompt: source?.systemPrompt ?? "",
    isBuiltIn: false
  };
}

export function buildCaptureUserPrompt(context: CaptureContext): string {
  return `Thread title: ${context.threadTitle}
Explanation language: ${context.explanationLanguage}
Desired explanation style: English-first with one short Chinese meaning.

User message:
${context.userMessage}

Assistant answer:
${context.assistantMessage}

Conversation excerpt:
${context.conversationExcerpt}`;
}

export function buildStructuredChatUserPrompt(userMessage: string, explanationLanguage: string): string {
  return `User message:
${userMessage}

Explanation language: ${explanationLanguage}
Desired explanation style: English-first with one short Chinese meaning.

Return only this tagged format, with the same uppercase field names and in the same order:
REQUEST_KIND: translation | lookup | contrast | grammar | correction | usage | other
ITEM_LABEL: <short display label>
PRIMARY_EXPRESSION: <canonical saved term or phrase>
SOURCE_LANGUAGE: <language>
TARGET_LANGUAGE: <language>
ITEM_TYPE: word | phrase | expression | contrast | grammar-rule | correction-pattern | register-note | usage-note
RELATED_EXPRESSIONS: <expr 1 | expr 2 | expr 3>

ANSWER:
<natural tutor response shown to the user>

Rules:
- "requestKind" should classify the user's request, not the final item type.
- Use "translation" when the user is asking how to say something in another language.
- Use "lookup" for plain meaning/definition questions about one word or phrase.
- Use "contrast" for difference/compare questions.
- Use "grammar" for grammar-rule questions.
- Use "correction" when the main point is fixing a mistake or typo.
- Use "usage" for naturalness/register/appropriateness questions.
- Use "other" only if none of the above fit.
- "itemLabel" is the short display label the app should show in the sidebar and header.
- "primaryExpression" is the canonical term or phrase to save and dedupe on.
- For translation questions like "漏勺英语怎么说", set both itemLabel and primaryExpression to the target-language answer, not the source-language query.
- For translation questions, include the source-language query in "relatedExpressions" so future lookups can match it.
- For contrast questions, use a label like "annihilate vs obliterate".
- For typo-correction questions, set itemLabel and primaryExpression to the corrected form and include the original typo in "relatedExpressions".
- "answerMarkdown" should contain only the natural tutor response to show the user.
- "answerMarkdown" must be a real answer, never just "..." or a placeholder.
- For direct lookup or translation questions, start "answerMarkdown" with the resolved term or phrase, then include a short Chinese meaning, a concise English explanation, and one example or usage note when useful.
- If the resolved item is a single word, start "answerMarkdown" with exactly this style on the first line: <resolved term> /.../ <part-of-speech abbreviations>
- Use compact part-of-speech abbreviations on that first line such as n., v., vt., vi., adj., adv., prep., pron., conj., interj., phr.
- Example: register /ˈrɛdʒɪstər/ n., vt., vi.
- For one-word lookup, translation, or typo-correction requests, always include IPA inline on that first line even if you also include a simpler respelling later.
- If a single word has multiple parts of speech or clearly distinct senses by part of speech, organize the explanation into separate labeled sections such as "n.", "vt.", "vi.", "adj.", or "adv.".
- Put each part of speech in its own short section with its own meaning, Chinese gloss, and example when useful.
- Do not collapse different parts of speech into one blended explanation when separate sections would be clearer.
- For noun sections, explicitly mark countability as C, U, or C/U when relevant.
- If different noun senses have different countability, show the countability inside the relevant noun section.
- If pronunciation differs by part of speech or sense, show the different IPA in the relevant labeled sections instead of forcing one shared IPA for the whole entry.
- In that case, the first line may still show the main or most common IPA, but each section with a different pronunciation should repeat its own IPA locally.
- Put one field per line before ANSWER.
- After "ANSWER:", you may use multiple paragraphs or bullet points naturally.
- Do not use JSON.
- Do not wrap the response in code fences.`;
}

export function buildThreadSummaryUserPrompt(context: ThreadSummaryContext): string {
  return `Thread ID: ${context.threadId}
Thread title: ${context.threadTitle}
Explanation language: ${context.explanationLanguage}
Desired summary style: English-first with one short Chinese meaning per item.

Conversation:
${context.conversationExcerpt}

Summarize the thread and extract all concrete learnable items.`;
}

export function buildReviewUserPrompt(item: LearningItem, mode: ReviewExerciseType): string {
  const effectiveType = deriveReviewItemType(item);
  return `Exercise type: ${mode}
Item category: ${effectiveType}
Term: ${item.term}
Meaning: ${item.meaning}
Short Chinese meaning: ${item.chineseMeaning}
Pronunciation: ${item.pronunciation}
Literal translation: ${item.literalTranslation}
Natural translation: ${item.naturalTranslation}
Nuance: ${item.nuance}
Grammar notes: ${item.grammarNotes}
Examples:
${item.examples.map((example) => `- ${example}`).join("\n")}
Common mistakes:
${item.commonMistakes.map((value) => `- ${value}`).join("\n")}
Related expressions:
${item.relatedExpressions.map((value) => `- ${value}`).join("\n")}

Category-specific review goal:
${describeReviewGoal(effectiveType, mode)}

If the type is cloze, generate a sentence with exactly one blank and four candidate choices.
Return one exercise only.`;
}

export function normalizeCaptureCandidate(candidate: Partial<CaptureCandidate>): CaptureCandidate {
  return {
    shouldSave: Boolean(candidate.shouldSave),
    confidence: Number.isFinite(candidate.confidence) ? Number(candidate.confidence) : 0,
    label: capitalizeLabel((candidate.label ?? candidate.primaryExpression ?? "").trim()),
    primaryExpression: (candidate.primaryExpression ?? "").trim(),
    sourceLanguage: canonicalizeLanguage((candidate.sourceLanguage ?? "").trim() || "Unknown"),
    targetLanguage: canonicalizeLanguage((candidate.targetLanguage ?? "").trim() || "Unknown"),
    itemType: canonicalizeItemType(candidate.itemType, candidate.primaryExpression ?? ""),
    meaning: (candidate.meaning ?? "").trim(),
    chineseMeaning: (candidate.chineseMeaning ?? "").trim(),
    pronunciation: (candidate.pronunciation ?? "").trim(),
    partOfSpeech: (candidate.partOfSpeech ?? "").trim(),
    literalTranslation: (candidate.literalTranslation ?? "").trim(),
    naturalTranslation: (candidate.naturalTranslation ?? "").trim(),
    examples: Array.isArray(candidate.examples) ? candidate.examples.map(String).map((value) => value.trim()).filter(Boolean) : [],
    grammarNotes: (candidate.grammarNotes ?? "").trim(),
    nuance: (candidate.nuance ?? "").trim(),
    commonMistakes: Array.isArray(candidate.commonMistakes)
      ? candidate.commonMistakes.map(String).map((value) => value.trim()).filter(Boolean)
      : [],
    tags: Array.isArray(candidate.tags) ? candidate.tags.map(String).map((value) => value.trim()).filter(Boolean) : [],
    difficulty: (candidate.difficulty ?? "").trim() || "unknown",
    relatedExpressions: Array.isArray(candidate.relatedExpressions)
      ? candidate.relatedExpressions.map(String).map((value) => value.trim()).filter(Boolean)
      : [],
    sourceSnippet: (candidate.sourceSnippet ?? "").trim()
  };
}

export function normalizeStructuredChatResponse(response: Partial<StructuredChatResponse>): StructuredChatResponse {
  const primaryExpression = (response.primaryExpression ?? response.itemLabel ?? "").trim();
  const itemLabel = capitalizeLabel((response.itemLabel ?? primaryExpression).trim());

  return {
    requestKind: normalizeStructuredRequestKind(response.requestKind),
    itemLabel: itemLabel || capitalizeLabel(primaryExpression),
    primaryExpression: primaryExpression || itemLabel,
    answerMarkdown: (response.answerMarkdown ?? "").trim(),
    relatedExpressions: normalizeStringList(response.relatedExpressions),
    sourceLanguage: canonicalizeLanguage((response.sourceLanguage ?? "").trim() || "Unknown"),
    targetLanguage: canonicalizeLanguage((response.targetLanguage ?? "").trim() || "Unknown"),
    itemType: canonicalizeItemType(response.itemType, primaryExpression)
  };
}

function normalizeStructuredRequestKind(value: unknown): StructuredRequestKind {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "translation":
      return "translation";
    case "lookup":
      return "lookup";
    case "contrast":
      return "contrast";
    case "grammar":
      return "grammar";
    case "correction":
      return "correction";
    case "usage":
      return "usage";
    default:
      return "other";
  }
}

export function normalizeThreadSummaryResult(result: Partial<ThreadSummaryResult>): ThreadSummaryResult {
  return {
    threadTitle: (result.threadTitle ?? "").trim() || "Thread Summary",
    sourceLanguage: canonicalizeLanguage((result.sourceLanguage ?? "").trim() || "Unknown"),
    targetLanguage: canonicalizeLanguage((result.targetLanguage ?? "").trim() || "Unknown"),
    overview: (result.overview ?? "").trim(),
    questionsAsked: normalizeStringList(result.questionsAsked),
    grammarPoints: normalizeStringList(result.grammarPoints),
    confusions: normalizeStringList(result.confusions),
    notableExamples: normalizeStringList(result.notableExamples),
    reviewPrompts: normalizeStringList(result.reviewPrompts),
    items: Array.isArray(result.items) ? result.items.map(normalizeThreadSummaryItem).filter((item) => item.primaryExpression) : []
  };
}

function normalizeThreadSummaryItem(item: Partial<ThreadSummaryItem>): ThreadSummaryItem {
  return {
    confidence: Number.isFinite(item.confidence) ? Number(item.confidence) : 0,
    label: capitalizeLabel((item.label ?? item.primaryExpression ?? "").trim()),
    primaryExpression: (item.primaryExpression ?? "").trim(),
    sourceLanguage: canonicalizeLanguage((item.sourceLanguage ?? "").trim() || "Unknown"),
    targetLanguage: canonicalizeLanguage((item.targetLanguage ?? "").trim() || "Unknown"),
    itemType: canonicalizeItemType(item.itemType, item.primaryExpression ?? ""),
    meaning: (item.meaning ?? "").trim(),
    chineseMeaning: (item.chineseMeaning ?? "").trim(),
    pronunciation: (item.pronunciation ?? "").trim(),
    partOfSpeech: (item.partOfSpeech ?? "").trim(),
    literalTranslation: (item.literalTranslation ?? "").trim(),
    naturalTranslation: (item.naturalTranslation ?? "").trim(),
    examples: normalizeStringList(item.examples),
    grammarNotes: (item.grammarNotes ?? "").trim(),
    nuance: (item.nuance ?? "").trim(),
    commonMistakes: normalizeStringList(item.commonMistakes),
    tags: normalizeStringList(item.tags),
    difficulty: (item.difficulty ?? "").trim() || "unknown",
    relatedExpressions: normalizeStringList(item.relatedExpressions),
    sourceSnippet: (item.sourceSnippet ?? "").trim()
  };
}

function normalizeStringList(values: unknown): string[] {
  return Array.isArray(values) ? values.map(String).map((value) => value.trim()).filter(Boolean) : [];
}

function describeReviewGoal(itemType: ReturnType<typeof deriveReviewItemType>, mode: ReviewExerciseType): string {
  switch (itemType) {
    case "contrast":
      if (mode === "cloze") {
        return "Make the learner choose the better contrasted option for one sentence.";
      }
      if (mode === "use-in-reply") {
        return "Make the learner use both contrasted expressions naturally, or explain when each fits.";
      }
      if (mode === "fix-sentence") {
        return "Use a sentence where the wrong contrasted option was chosen, and ask for a correction.";
      }
      return "Ask for the key difference between the contrasted expressions, briefly and clearly.";
    case "grammar-rule":
      return mode === "cloze"
        ? "Test whether the learner can choose the correct form in context."
        : "Focus on applying the grammar pattern naturally in context.";
    case "correction-pattern":
      return "Focus on recognizing and fixing the original mistake pattern.";
    case "register-note":
      return "Focus on which wording sounds more natural, formal, casual, or appropriate.";
    case "usage-note":
      return "Focus on when the expression is appropriate or not in realistic context.";
    case "word":
    case "phrase":
    case "expression":
    case "grammar":
    case "correction":
      return "Focus on meaning, nuance, and natural usage.";
  }
}
