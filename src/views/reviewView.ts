import { ItemView, Notice, type EventRef, type WorkspaceLeaf } from "obsidian";
import type { LingoNestPlugin } from "../main";
import type { ReviewExercise, ReviewGrade, ReviewQueueKind } from "../types";
import { getReviewStepLabel } from "../review/scheduler";
import { formatRelativeDate } from "../utils/date";
import { capitalizeLabel } from "../utils/strings";
import { renderSectionNav } from "./sectionNav";

export const REVIEW_VIEW_TYPE = "lingonest-review-view";

export class ReviewView extends ItemView {
  plugin: LingoNestPlugin;
  private queue: ReviewQueueKind = "due";
  private current:
    | {
        itemId: string;
        exercise: ReviewExercise;
      }
    | null = null;
  private sessionItemIds: string[] = [];
  private sessionStartedCount = 0;
  private repeatedLaterCount = 0;
  private revealed = false;
  private loading = false;
  private answerDraft = "";
  private selectedChoice = "";
  private stateRef: EventRef | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LingoNestPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return REVIEW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "LingoNest Review";
  }

  getIcon(): string {
    return "graduation-cap";
  }

  async onOpen(): Promise<void> {
    this.queue = this.plugin.reviewService.getRecommendedQueue();
    this.stateRef = this.plugin.onStateChange(() => {
      void this.refresh();
    });
    if (this.stateRef) {
      this.registerEvent(this.stateRef);
    }
    await this.startSession();
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.containerEl.empty();
  }

  private async startSession(): Promise<void> {
    const session = this.plugin.reviewService.createSession(this.queue);
    this.sessionItemIds = session.map((item) => item.id);
    this.sessionStartedCount = this.sessionItemIds.length;
    this.repeatedLaterCount = 0;
    this.revealed = false;
    this.answerDraft = "";
    this.selectedChoice = "";
    await this.loadCurrentExercise();
  }

  private async loadCurrentExercise(): Promise<void> {
    if (!this.sessionItemIds.length) {
      this.current = null;
      return;
    }

    this.loading = true;
    try {
      const currentId = this.sessionItemIds[0];
      if (!currentId) {
        this.current = null;
        return;
      }
      const next = await this.plugin.reviewService.buildExerciseForItem(currentId);
      this.current = {
        itemId: next.item.id,
        exercise: next.exercise
      };
      this.revealed = false;
      this.answerDraft = "";
      this.selectedChoice = "";
    } catch {
      this.sessionItemIds.shift();
      if (this.sessionItemIds.length) {
        await this.loadCurrentExercise();
      } else {
        this.current = null;
      }
    } finally {
      this.loading = false;
    }
  }

  private async refresh(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("lingonest-view");
    const wrapper = containerEl.createDiv({ cls: "lingonest-review-layout" });
    renderSectionNav(wrapper, this.plugin, "review");
    wrapper.createEl("h3", { text: "Flashcard Session" });

    wrapper.createDiv({
      cls: "lingonest-review-subtitle",
      text: "Ebbinghaus-style spacing: 10m, 1h, 1d, 3d, 7d, 14d, 30d, 60d."
    });

    const queues = wrapper.createDiv({ cls: "lingonest-review-queues" });
    for (const queue of ["due", "new", "trouble", "recent"] as ReviewQueueKind[]) {
      const count = this.plugin.reviewService.getQueue(queue).length;
      const button = queues.createEl("button", {
        cls: `lingonest-review-queue-button${queue === this.queue ? " is-active" : ""}`,
        attr: { title: describeQueue(queue) }
      });
      button.createSpan({ cls: "lingonest-review-queue-label", text: labelQueue(queue) });
      button.createSpan({ cls: "lingonest-review-queue-count", text: String(count) });
      button.addEventListener("click", async () => {
        this.queue = queue;
        await this.startSession();
        await this.refresh();
      });
    }

    wrapper.createDiv({
      cls: "lingonest-review-help",
      text: "Due now = scheduled to review now. New = recent items. Trouble = frequent misses. Recent misses = things you got wrong lately."
    });

    const sessionMeta = wrapper.createDiv({ cls: "lingonest-review-session-meta" });
    this.renderSessionPill(sessionMeta, `Queue: ${labelQueue(this.queue)}`);
    this.renderSessionPill(sessionMeta, `Remaining: ${this.sessionItemIds.length}`);
    this.renderSessionPill(sessionMeta, `Studied: ${Math.max(0, this.sessionStartedCount - this.sessionItemIds.length)}`);
    if (this.repeatedLaterCount > 0) {
      this.renderSessionPill(sessionMeta, `Repeat later: ${this.repeatedLaterCount}`);
    }

    const mainColumn = wrapper.createDiv({ cls: "lingonest-review-main" });
    if (!this.current) {
      mainColumn.createDiv({ cls: "lingonest-empty-state", text: this.loading ? "Loading flashcards…" : "Session complete" });
      mainColumn.createEl("p", {
        text: this.loading
          ? "Loading the next card…"
          : "No cards are available in this session. Start a new session or switch queues."
      });
      const nextButton = mainColumn.createEl("button", { text: "Start new session" });
      nextButton.addEventListener("click", async () => {
        await this.startSession();
        await this.refresh();
      });
      return;
    }

    const item = this.plugin.itemStorage.getItem(this.current.itemId);
    if (!item) {
      this.sessionItemIds.shift();
      await this.loadCurrentExercise();
      await this.refresh();
      return;
    }

    const card = mainColumn.createDiv({ cls: "lingonest-review-card" });
    const meta = card.createDiv({ cls: "lingonest-review-meta" });
    meta.createSpan({ text: capitalizeLabel(item.label) });
    meta.createSpan({ text: `Step ${item.reviewStep + 1} (${getReviewStepLabel(item.reviewStep)})` });
    meta.createSpan({ text: `Due ${formatRelativeDate(item.nextReview)}` });

    const openButton = meta.createEl("button", { text: "Open note" });
    openButton.addEventListener("click", async () => {
      await this.plugin.openNotePath(item.notePath);
    });

    const previewButton = meta.createEl("button", { text: "Show in A-Z Items" });
    previewButton.addEventListener("click", async () => {
      await this.plugin.activateItemBrowserView(item.id);
    });

    card.createEl("div", { cls: "lingonest-review-type", text: labelExerciseType(this.current.exercise.type) });
    card.createEl("p", { text: this.current.exercise.prompt });

    if (this.current.exercise.type === "cloze" && this.current.exercise.clozeSentence) {
      const sentence = card.createDiv({ cls: "lingonest-review-cloze-sentence" });
      sentence.setText(this.current.exercise.clozeSentence);

      if (this.current.exercise.choices.length) {
        const choiceGrid = card.createDiv({ cls: "lingonest-review-choices" });
        for (const choice of this.current.exercise.choices) {
          const choiceButton = choiceGrid.createEl("button", {
            cls: choice === this.selectedChoice ? "is-active" : "",
            text: choice
          });
          choiceButton.disabled = this.revealed;
          choiceButton.addEventListener("click", () => {
            this.selectedChoice = choice;
            this.answerDraft = choice;
            void this.refresh();
          });
        }
      }
    }

    if (this.current.exercise.type === "fix-sentence" || this.current.exercise.type === "use-in-reply") {
      const answer = card.createEl("textarea", {
        attr: { rows: "4", placeholder: "Type your answer, then reveal and grade yourself." }
      });
      answer.value = this.answerDraft;
      answer.addEventListener("input", () => {
        this.answerDraft = answer.value;
      });
    }

    const controls = card.createDiv({ cls: "lingonest-review-controls" });
    const reveal = controls.createEl("button", { text: this.revealed ? "Answer revealed" : "Reveal answer" });
    reveal.disabled = this.revealed;
    reveal.addEventListener("click", async () => {
      this.revealed = true;
      await this.refresh();
    });
    const skip = controls.createEl("button", { text: "Skip for now" });
    skip.addEventListener("click", async () => {
      await this.deferCurrentCard();
      await this.refresh();
    });

    if (this.revealed) {
      const answerBlock = card.createDiv({ cls: "lingonest-review-answer" });
      answerBlock.createEl("strong", { text: "Answer" });
      answerBlock.createEl("p", { text: this.current.exercise.expectedAnswer });

      if (this.current.exercise.type === "cloze" && this.selectedChoice) {
        answerBlock.createEl("p", {
          cls: "lingonest-review-user-answer",
          text:
            this.selectedChoice === this.current.exercise.expectedAnswer
              ? `Your choice: ${this.selectedChoice} (correct)`
              : `Your choice: ${this.selectedChoice}`
        });
      } else if (this.answerDraft.trim()) {
        answerBlock.createEl("p", {
          cls: "lingonest-review-user-answer",
          text: `Your answer: ${this.answerDraft.trim()}`
        });
      }

      if (this.current.exercise.explanation) {
        answerBlock.createEl("p", { text: this.current.exercise.explanation });
      }

      if (this.current.exercise.hints.length) {
        const hintList = answerBlock.createEl("ul");
        for (const hint of this.current.exercise.hints) {
          hintList.createEl("li", { text: hint });
        }
      }

      const grading = card.createDiv({ cls: "lingonest-review-grading" });
      for (const grade of ["again", "hard", "good", "easy"] as ReviewGrade[]) {
        const gradeButton = grading.createEl("button", {
          cls: "lingonest-review-grade-button",
          attr: { title: describeGrade(grade) }
        });
        gradeButton.createSpan({ cls: "lingonest-review-grade-title", text: labelGrade(grade) });
        gradeButton.createSpan({ cls: "lingonest-review-grade-desc", text: gradeHint(grade) });
        gradeButton.addEventListener("click", async () => {
          try {
            await this.plugin.reviewService.gradeExercise(item.id, this.current!.exercise, grade);
            await this.advanceSession(grade);
            await this.refresh();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Failed to save review result.");
          }
        });
      }

      card.createDiv({
        cls: "lingonest-review-help",
        text: "Again resets the card to the shortest interval. Hard keeps it close. Good moves one step forward. Easy jumps further ahead."
      });
    }
  }

  private renderSessionPill(containerEl: HTMLElement, text: string): void {
    containerEl.createDiv({ cls: "lingonest-empty-state", text });
  }

  private async advanceSession(grade: ReviewGrade): Promise<void> {
    const currentId = this.sessionItemIds.shift();
    if (!currentId) {
      this.current = null;
      return;
    }

    if (grade === "again") {
      this.sessionItemIds.push(currentId);
      this.repeatedLaterCount += 1;
    }

    await this.loadCurrentExercise();
  }

  private async deferCurrentCard(): Promise<void> {
    const currentId = this.sessionItemIds.shift();
    if (!currentId) {
      return;
    }
    this.sessionItemIds.push(currentId);
    await this.loadCurrentExercise();
  }
}

function labelExerciseType(type: ReviewExercise["type"]): string {
  if (type === "standard") {
    return "flashcard";
  }
  return type;
}

function labelQueue(queue: ReviewQueueKind): string {
  switch (queue) {
    case "due":
      return "Due now";
    case "new":
      return "New";
    case "trouble":
      return "Trouble";
    case "recent":
      return "Recent misses";
  }
}

function describeQueue(queue: ReviewQueueKind): string {
  switch (queue) {
    case "due":
      return "Items whose scheduled review time has arrived.";
    case "new":
      return "Recently saved items that are still early in learning.";
    case "trouble":
      return "Items you have missed repeatedly.";
    case "recent":
      return "Items you got wrong recently.";
  }
}

function labelGrade(grade: ReviewGrade): string {
  switch (grade) {
    case "again":
      return "Again";
    case "hard":
      return "Hard";
    case "good":
      return "Good";
    case "easy":
      return "Easy";
  }
}

function gradeHint(grade: ReviewGrade): string {
  switch (grade) {
    case "again":
      return "Forgot it";
    case "hard":
      return "Barely knew it";
    case "good":
      return "Knew it";
    case "easy":
      return "Instant";
  }
}

function describeGrade(grade: ReviewGrade): string {
  switch (grade) {
    case "again":
      return "You missed it. Reset this card to the shortest interval.";
    case "hard":
      return "You got it with difficulty. Review it again fairly soon.";
    case "good":
      return "You got it normally. Move it to the next scheduled step.";
    case "easy":
      return "You knew it instantly. Jump further ahead in the schedule.";
  }
}
