export interface PhaseTiming {
  phase: string;
  durationMs: number;
}

export interface TimingSummary {
  totalMs: number;
  phases: PhaseTiming[];
}

type Clock = () => number;

export class PhaseTimer {
  private readonly startedAt: number;
  private readonly phases: PhaseTiming[] = [];

  constructor(private readonly now: Clock = () => performance.now()) {
    this.startedAt = this.now();
  }

  async measure<T>(phase: string, action: () => Promise<T>): Promise<T> {
    const startedAt = this.now();

    try {
      return await action();
    } finally {
      this.phases.push({
        phase,
        durationMs: roundMilliseconds(this.now() - startedAt)
      });
    }
  }

  measureSync<T>(phase: string, action: () => T): T {
    const startedAt = this.now();

    try {
      return action();
    } finally {
      this.phases.push({
        phase,
        durationMs: roundMilliseconds(this.now() - startedAt)
      });
    }
  }

  snapshot(): TimingSummary {
    return {
      totalMs: roundMilliseconds(this.now() - this.startedAt),
      phases: [...this.phases]
    };
  }
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 10) / 10;
}
