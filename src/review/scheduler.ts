import type { LearningItemIndexEntry, ReviewExerciseType, ReviewGrade } from "../types";
import { addDays } from "../utils/date";
import { deriveReviewItemType } from "../utils/itemTypes";

interface ReviewStepDefinition {
  label: string;
  minutes: number;
}

const EBBINGHAUS_STEPS: ReviewStepDefinition[] = [
  { label: "10m", minutes: 10 },
  { label: "1h", minutes: 60 },
  { label: "1d", minutes: 24 * 60 },
  { label: "3d", minutes: 3 * 24 * 60 },
  { label: "7d", minutes: 7 * 24 * 60 },
  { label: "14d", minutes: 14 * 24 * 60 },
  { label: "30d", minutes: 30 * 24 * 60 },
  { label: "60d", minutes: 60 * 24 * 60 }
];

export function chooseExerciseType(item: LearningItemIndexEntry): ReviewExerciseType {
  const itemType = deriveReviewItemType(item);

  switch (itemType) {
    case "contrast":
      if (item.examples.length > 0) {
        return Math.random() > 0.35 ? "cloze" : "standard";
      }
      return item.productionScore >= 2 && Math.random() > 0.5 ? "use-in-reply" : "standard";
    case "grammar-rule":
      if (item.examples.length > 0 && Math.random() > 0.4) {
        return "cloze";
      }
      return item.productionScore >= 2 ? "fix-sentence" : "standard";
    case "correction-pattern":
      if (item.examples.length > 0 && Math.random() > 0.45) {
        return "cloze";
      }
      return Math.random() > 0.5 ? "fix-sentence" : "standard";
    case "register-note":
    case "usage-note":
      if (item.examples.length > 0 && Math.random() > 0.35) {
        return "cloze";
      }
      return item.productionScore >= 2 && Math.random() > 0.55 ? "use-in-reply" : "standard";
  }

  if (item.examples.length > 0 && item.reviewStep >= 1) {
    if (item.productionScore < item.recognitionScore - 0.7) {
      return Math.random() > 0.5 ? "cloze" : Math.random() > 0.5 ? "fix-sentence" : "use-in-reply";
    }
    if (Math.random() > 0.45) {
      return "cloze";
    }
  }

  if (item.productionScore < item.recognitionScore - 0.4) {
    return Math.random() > 0.5 ? "fix-sentence" : "use-in-reply";
  }

  return "standard";
}

export function getReviewStepLabel(step: number): string {
  return getStepDefinition(step).label;
}

export function estimateReviewStep(intervalDays: number): number {
  if (!Number.isFinite(intervalDays) || intervalDays <= 0) {
    return 0;
  }
  if (intervalDays <= 1) {
    return 2;
  }
  if (intervalDays <= 3) {
    return 3;
  }
  if (intervalDays <= 7) {
    return 4;
  }
  if (intervalDays <= 14) {
    return 5;
  }
  if (intervalDays <= 30) {
    return 6;
  }
  return 7;
}

export function getIntervalDaysForStep(step: number): number {
  const minutes = getStepDefinition(step).minutes;
  return minutes < 24 * 60 ? 0 : Math.round(minutes / (24 * 60));
}

export function applyReviewGrade(
  item: LearningItemIndexEntry,
  grade: ReviewGrade,
  exerciseType: ReviewExerciseType,
  now = new Date()
): LearningItemIndexEntry {
  const currentStep = normalizeReviewStep(item.reviewStep ?? estimateReviewStep(item.intervalDays));

  let ease = item.ease;
  let nextStep = currentStep;

  switch (grade) {
    case "again":
      ease = Math.max(1.3, ease - 0.15);
      nextStep = 0;
      break;
    case "hard":
      ease = Math.max(1.3, ease - 0.05);
      nextStep = currentStep <= 1 ? 1 : currentStep - 1;
      break;
    case "good":
      nextStep = Math.min(currentStep + 1, EBBINGHAUS_STEPS.length - 1);
      break;
    case "easy":
      ease += 0.05;
      nextStep = Math.min(currentStep + 2, EBBINGHAUS_STEPS.length - 1);
      break;
  }

  const nextReview =
    grade === "again"
      ? addMinutes(now, getStepDefinition(0).minutes)
      : getScheduledReviewAt(nextStep, now);

  const recognitionDelta = gradeToDelta(grade);
  const productionWeight = getProductionWeight(exerciseType);
  const nextRecognition = clamp(item.recognitionScore + recognitionDelta, 0, 5);
  const nextProduction = clamp(item.productionScore + recognitionDelta * productionWeight, 0, 5);
  const mastery = Number(((nextRecognition + nextProduction) / 2).toFixed(2));

  return {
    ...item,
    ease: Number(ease.toFixed(2)),
    intervalDays: getIntervalDaysForStep(nextStep),
    reviewStep: nextStep,
    lapseCount: grade === "again" ? item.lapseCount + 1 : item.lapseCount,
    nextReview,
    lastReviewed: now.toISOString(),
    updatedAt: now.toISOString(),
    recognitionScore: Number(nextRecognition.toFixed(2)),
    productionScore: Number(nextProduction.toFixed(2)),
    mastery,
    status: mastery >= 4 ? "mastered" : mastery >= 2 ? "reviewing" : "learning",
    troubleCount: grade === "again" ? item.troubleCount + 1 : Math.max(0, item.troubleCount - (grade === "easy" ? 1 : 0))
  };
}

function getScheduledReviewAt(step: number, now: Date): string {
  const minutes = getStepDefinition(step).minutes;
  if (minutes < 24 * 60) {
    return addMinutes(now, minutes);
  }
  return addDays(now, Math.round(minutes / (24 * 60)));
}

function getStepDefinition(step: number): ReviewStepDefinition {
  return EBBINGHAUS_STEPS[normalizeReviewStep(step)] ?? EBBINGHAUS_STEPS[0]!;
}

function getProductionWeight(exerciseType: ReviewExerciseType): number {
  switch (exerciseType) {
    case "standard":
      return 0.5;
    case "cloze":
      return 0.75;
    case "fix-sentence":
    case "use-in-reply":
      return 1;
  }
}

function gradeToDelta(grade: ReviewGrade): number {
  switch (grade) {
    case "again":
      return -0.35;
    case "hard":
      return 0.1;
    case "good":
      return 0.3;
    case "easy":
      return 0.45;
  }
}

function normalizeReviewStep(step: number): number {
  if (!Number.isFinite(step)) {
    return 0;
  }
  return Math.max(0, Math.min(EBBINGHAUS_STEPS.length - 1, Math.round(step)));
}

function addMinutes(date: Date, minutes: number): string {
  const next = new Date(date);
  next.setMinutes(next.getMinutes() + minutes);
  return next.toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
