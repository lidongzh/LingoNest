import type {
  LearningItemIndexEntry,
  ReviewEvent,
  ReviewExercise,
  ReviewGrade,
  ReviewGradingSource,
  ReviewQueueKind,
  TypedReviewAssessment
} from "../types";
import { getActivePromptProfile } from "../prompts";
import type { LingoNestPlugin } from "../main";
import { isDue, nowIso } from "../utils/date";
import { makeId, normalizeExpression } from "../utils/strings";
import { applyReviewGrade, chooseExerciseType } from "./scheduler";

export class ReviewService {
  private readonly plugin: LingoNestPlugin;

  constructor(plugin: LingoNestPlugin) {
    this.plugin = plugin;
  }

  getQueue(kind: ReviewQueueKind): LearningItemIndexEntry[] {
    const items = Object.values(this.plugin.store.state.items);
    const recentMistakeIds = new Set(
      this.plugin.store.state.review.events
        .filter((event) => event.grade === "again")
        .filter((event) => Date.now() - new Date(event.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000)
        .map((event) => event.itemId)
    );

    switch (kind) {
      case "due":
        return items.filter((item) => isDue(item.nextReview));
      case "new":
        return items.filter((item) => Date.now() - new Date(item.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000);
      case "trouble":
        return items.filter((item) => item.troubleCount > 0).sort((a, b) => b.troubleCount - a.troubleCount);
      case "recent":
        return items.filter((item) => recentMistakeIds.has(item.id));
    }
  }

  getRecommendedQueue(): ReviewQueueKind {
    if (this.getQueue("due").length) {
      return "due";
    }
    if (this.getQueue("new").length) {
      return "new";
    }
    if (this.getQueue("trouble").length) {
      return "trouble";
    }
    return "recent";
  }

  createSession(kind: ReviewQueueKind, limit = 12): LearningItemIndexEntry[] {
    return [...this.getQueue(kind)].sort((left, right) => this.compareQueueItems(left, right, kind)).slice(0, limit);
  }

  async buildExerciseForItem(itemId: string): Promise<{ item: LearningItemIndexEntry; exercise: ReviewExercise }> {
    const item = this.plugin.store.state.items[itemId];
    if (!item) {
      throw new Error("Review item no longer exists.");
    }
    const mode = chooseExerciseType(item);
    const exercise = await this.buildExercise(item, mode);
    return { item, exercise };
  }

  assessTypedClozeAnswer(exercise: ReviewExercise, userAnswer: string): TypedReviewAssessment {
    const typed = userAnswer.trim();
    const normalizedTyped = normalizeExpression(typed);
    const normalizedExpected = normalizeExpression(exercise.expectedAnswer);
    const wrongChoice = exercise.choices.find((choice) => normalizeExpression(choice) === normalizedTyped);

    if (!normalizedTyped) {
      return {
        verdict: "incorrect",
        grade: "again",
        matchedAnswer: exercise.expectedAnswer,
        message: "No answer entered."
      };
    }

    if (normalizedTyped === normalizedExpected) {
      return {
        verdict: "correct",
        grade: "good",
        matchedAnswer: exercise.expectedAnswer,
        message: "Correct."
      };
    }

    if (wrongChoice && normalizeExpression(wrongChoice) !== normalizedExpected) {
      return {
        verdict: "incorrect",
        grade: "again",
        matchedAnswer: wrongChoice,
        message: `You entered another candidate: ${wrongChoice}.`
      };
    }

    const similarity = this.computeSimilarity(normalizedTyped, normalizedExpected);
    if (similarity >= 0.84 || normalizedExpected.startsWith(normalizedTyped) || normalizedTyped.startsWith(normalizedExpected)) {
      return {
        verdict: "close",
        grade: "hard",
        matchedAnswer: exercise.expectedAnswer,
        message: `Close. The best fit was ${exercise.expectedAnswer}.`
      };
    }

    return {
      verdict: "incorrect",
      grade: "again",
      matchedAnswer: exercise.expectedAnswer,
      message: `Not quite. The best fit was ${exercise.expectedAnswer}.`
    };
  }

  async gradeExercise(
    itemId: string,
    exercise: ReviewExercise,
    grade: ReviewGrade,
    options?: { userAnswer?: string | null; gradingSource?: ReviewGradingSource }
  ): Promise<void> {
    const current = this.plugin.store.state.items[itemId];
    if (!current) {
      throw new Error("Review item no longer exists.");
    }

    const updated = applyReviewGrade(current, grade, exercise.type);
    const event: ReviewEvent = {
      id: makeId("review"),
      itemId,
      createdAt: nowIso(),
      grade,
      gradingSource: options?.gradingSource ?? "manual",
      userAnswer: options?.userAnswer?.trim() || null,
      exerciseType: exercise.type,
      prompt: exercise.prompt,
      expectedAnswer: exercise.expectedAnswer
    };

    await this.plugin.store.updateState((state) => {
      state.items[itemId] = updated;
      state.review.events.unshift(event);
      state.review.events = state.review.events.slice(0, 500);
    });

    await this.plugin.itemStorage.syncItemNote(updated);
    this.plugin.notifyStateChanged();
  }

  private async buildExercise(
    item: LearningItemIndexEntry,
    mode: ReviewExercise["type"]
  ): Promise<ReviewExercise> {
    const profile = getActivePromptProfile(
      this.plugin.store.settings.prompts.profiles,
      "review",
      this.plugin.store.settings.prompts.activeProfileIds.review
    );
    const provider = this.plugin.getProvider();
    try {
      return await provider.generateReviewExercise(item, mode, { systemPrompt: profile.systemPrompt });
    } catch {
      return {
        type: "standard",
        prompt: `Explain or translate "${item.term}".`,
        expectedAnswer: item.naturalTranslation || item.meaning,
        hints: [item.chineseMeaning, item.pronunciation, item.nuance].filter(Boolean),
        clozeSentence: null,
        choices: [],
        explanation: item.nuance || item.grammarNotes || ""
      };
    }
  }

  private compareQueueItems(
    left: LearningItemIndexEntry,
    right: LearningItemIndexEntry,
    kind: ReviewQueueKind
  ): number {
    switch (kind) {
      case "due":
        return compareIso(left.nextReview, right.nextReview) || left.reviewStep - right.reviewStep;
      case "new":
        return compareIso(left.createdAt, right.createdAt);
      case "trouble":
        return right.troubleCount - left.troubleCount || compareIso(left.nextReview, right.nextReview);
      case "recent":
        return compareIso(left.updatedAt, right.updatedAt);
    }
  }

  private computeSimilarity(left: string, right: string): number {
    if (!left || !right) {
      return 0;
    }
    if (left === right) {
      return 1;
    }

    const distance = this.levenshtein(left, right);
    return 1 - distance / Math.max(left.length, right.length);
  }

  private levenshtein(left: string, right: string): number {
    const rows = left.length + 1;
    const cols = right.length + 1;
    const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (let i = 0; i < rows; i += 1) {
      matrix[i]![0] = i;
    }
    for (let j = 0; j < cols; j += 1) {
      matrix[0]![j] = j;
    }

    for (let i = 1; i < rows; i += 1) {
      for (let j = 1; j < cols; j += 1) {
        const cost = left[i - 1] === right[j - 1] ? 0 : 1;
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j - 1]! + cost
        );
      }
    }

    return matrix[rows - 1]![cols - 1]!;
  }
}

function compareIso(left: string | null, right: string | null): number {
  const leftValue = left ? new Date(left).getTime() : 0;
  const rightValue = right ? new Date(right).getTime() : 0;
  return leftValue - rightValue;
}
