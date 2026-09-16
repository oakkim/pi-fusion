/**
 * Adaptive routing ported from fusion-ref's AdaptiveRoutingPolicy.
 * Turn boundary: keep models (cache-friendly). Compaction boundary:
 * cache miss is unavoidable, so reconsider.
 */

export interface ModelSelection {
  main: string;
  sidekick: string;
}

export interface RoutingInput {
  complexity: number; // 0..1, planner-estimated; <0.85 allows main downgrade
  previous?: ModelSelection;
  reason: "compaction" | "turn";
  sidekickFailures?: number;
}

export class AdaptiveRoutingPolicy {
  readonly #main: string[];
  readonly #sidekick: string[];

  constructor(main: string[], sidekick: string[]) {
    if (main.length === 0 || sidekick.length === 0) {
      throw new Error("At least one main and sidekick model are required");
    }
    this.#main = [...main];
    this.#sidekick = [...sidekick];
  }

  select(input: RoutingInput): ModelSelection {
    const initial: ModelSelection = { main: this.#main[0]!, sidekick: this.#sidekick[0]! };
    if (input.reason === "turn") return input.previous ?? initial;

    const previous = input.previous ?? initial;
    const main = input.complexity < 0.85 ? (this.#main[1] ?? previous.main) : previous.main;
    const failures = input.sidekickFailures ?? 0;
    const sidekickIndex = Math.min(failures > 0 ? 1 : 0, this.#sidekick.length - 1);
    return { main, sidekick: this.#sidekick[sidekickIndex] ?? previous.sidekick };
  }
}
