const secondMs = 1_000;
const minuteSeconds = 60;
const hourSeconds = 60 * minuteSeconds;

interface ElapsedTimeStage {
  elapsedMs: number;
  label: string;
}

export interface ElapsedTimeSummary {
  stages: ElapsedTimeStage[];
  totalMs: number;
}

type MonotonicClock = () => number;

export class ElapsedTimeTracker {
  readonly #elapsedByStage = new Map<string, number>();
  readonly #now: MonotonicClock;
  readonly #startedAt: number;
  #currentStage: string;
  #stageStartedAt: number;

  constructor(initialStage: string, now: MonotonicClock = () => performance.now()) {
    this.#now = now;
    this.#startedAt = now();
    this.#stageStartedAt = this.#startedAt;
    this.#currentStage = initialStage;
  }

  switchTo(stage: string): void {
    if (stage === this.#currentStage) {
      return;
    }

    const switchedAt = this.#now();
    this.#recordCurrentStage(switchedAt);
    this.#currentStage = stage;
    this.#stageStartedAt = switchedAt;
  }

  summary(): ElapsedTimeSummary {
    const completedAt = this.#now();
    const elapsedByStage = new Map(this.#elapsedByStage);
    elapsedByStage.set(
      this.#currentStage,
      (elapsedByStage.get(this.#currentStage) ?? 0) +
        Math.max(0, completedAt - this.#stageStartedAt)
    );

    return {
      stages: [...elapsedByStage].map(([label, elapsedMs]) => ({ elapsedMs, label })),
      totalMs: Math.max(0, completedAt - this.#startedAt),
    };
  }

  #recordCurrentStage(completedAt: number): void {
    this.#elapsedByStage.set(
      this.#currentStage,
      (this.#elapsedByStage.get(this.#currentStage) ?? 0) +
        Math.max(0, completedAt - this.#stageStartedAt)
    );
  }
}

export function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / secondMs));
  const hours = Math.floor(totalSeconds / hourSeconds);
  const minutes = Math.floor((totalSeconds % hourSeconds) / minuteSeconds);
  const seconds = totalSeconds % minuteSeconds;

  return `${String(hours)}h ${String(minutes)}m ${String(seconds)}s`;
}

export function formatElapsedTimeSummary(summary: ElapsedTimeSummary): string {
  return [
    'Elapsed time by stage:',
    ...summary.stages.map((stage) => `  ${stage.label}: ${formatElapsedTime(stage.elapsedMs)}`),
    `Total elapsed time: ${formatElapsedTime(summary.totalMs)}`,
  ].join('\n');
}
