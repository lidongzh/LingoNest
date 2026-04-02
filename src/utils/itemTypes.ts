import type { ItemType, LearningItem } from "../types";

const DIRECT_TYPE_ALIASES: Record<string, ItemType> = {
  word: "word",
  phrase: "phrase",
  grammar: "grammar-rule",
  "grammar-rule": "grammar-rule",
  correction: "correction-pattern",
  "correction-pattern": "correction-pattern",
  expression: "expression",
  contrast: "contrast",
  "register-note": "register-note",
  register: "register-note",
  "usage-note": "usage-note",
  usage: "usage-note"
};

export function canonicalizeItemType(rawType: string | null | undefined, expression = "", sourceText = ""): ItemType {
  const normalized = String(rawType ?? "")
    .trim()
    .toLowerCase();
  if (normalized && DIRECT_TYPE_ALIASES[normalized]) {
    return DIRECT_TYPE_ALIASES[normalized];
  }
  return inferItemType(expression, sourceText);
}

export function inferItemType(expression: string, sourceText = ""): ItemType {
  const combined = `${expression}\n${sourceText}`.trim().toLowerCase();
  const trimmedExpression = expression.trim();

  if (looksLikeContrast(expression, sourceText)) {
    return "contrast";
  }

  if (
    /\b(wrong|incorrect|fix|correction|should be|better to say|mistake|error|not natural|sounds off)\b/i.test(combined)
  ) {
    return "correction-pattern";
  }

  if (
    /\b(grammar|rule|pattern|tense|conjugation|preposition|when do i use|why .* here|structure|form)\b/i.test(combined)
  ) {
    return "grammar-rule";
  }

  if (/\b(register|formal|informal|polite|impolite|tone|natural in this context|too strong|too casual)\b/i.test(combined)) {
    return "register-note";
  }

  if (/\b(can i say|is it okay to say|appropriate|in this situation|how do i use|usage)\b/i.test(combined)) {
    return "usage-note";
  }

  if (trimmedExpression.split(/\s+/).length > 1) {
    return "phrase";
  }

  if (trimmedExpression) {
    return "word";
  }

  return "expression";
}

export function deriveReviewItemType(item: Pick<LearningItem, "itemType" | "term" | "meaning" | "grammarNotes" | "nuance" | "commonMistakes" | "relatedExpressions" | "sourceSnippets">): ItemType {
  const sourceText = [
    item.meaning,
    item.grammarNotes,
    item.nuance,
    ...item.commonMistakes,
    ...item.relatedExpressions,
    ...item.sourceSnippets
  ]
    .filter(Boolean)
    .join("\n");

  return canonicalizeItemType(item.itemType, item.term, sourceText);
}

export function looksLikeContrast(expression: string, sourceText = ""): boolean {
  const combined = `${expression}\n${sourceText}`.toLowerCase();
  if (/\b(vs\.?|versus)\b/i.test(combined)) {
    return true;
  }
  if (/\bdifference between\b/i.test(combined) || /\bcompare\b/i.test(combined) || /\bdistinguish\b/i.test(combined)) {
    return true;
  }
  return false;
}

export function extractContrastOptions(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const vsParts = trimmed
    .replace(/^difference between\s+/i, "")
    .split(/\s+(?:vs\.?|versus)\s+/i)
    .map((value) => value.trim())
    .filter(Boolean);
  if (vsParts.length >= 2) {
    return uniqueStrings(vsParts);
  }

  const betweenMatch = trimmed.match(/difference between (.+?) and (.+)$/i);
  if (betweenMatch?.[1] && betweenMatch?.[2]) {
    return uniqueStrings([betweenMatch[1], betweenMatch[2]]);
  }

  return [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
