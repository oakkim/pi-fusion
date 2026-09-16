/** Model resolution. Port of pi-devin-fusion's models.ts (single executor). */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export function modelDisplay(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function resolveModelIdentifier(
  registry: ModelRegistry,
  identifier: string,
): Model<Api> | undefined {
  const slash = identifier.indexOf("/");
  if (slash > 0) {
    const provider = identifier.slice(0, slash);
    const id = identifier.slice(slash + 1);
    return registry.getAll().find((m) => m.provider === provider && m.id === id);
  }
  return registry.getAll().find((m) => m.id === identifier);
}

/**
 * Resolve the escalation ladder: [base executor, ...fallbacks].
 * Unavailable fallbacks are skipped with a warning; duplicates collapsed.
 * Only the first `maxEscalations` fallbacks are kept.
 */
export function resolveLadder(
  registry: ModelRegistry,
  currentModel: Model<Api> | undefined,
  configuredExecutor: string | undefined,
  fallbackExecutors: string[],
  maxEscalations: number,
  warnings: string[],
): Model<Api>[] {
  const ladder: Model<Api>[] = [];
  const seen = new Set<string>();
  const base = resolveExecutorModel(registry, currentModel, configuredExecutor, warnings);
  if (base) {
    ladder.push(base);
    seen.add(modelDisplay(base));
  }
  for (const id of fallbackExecutors.slice(0, Math.max(0, maxEscalations))) {
    const m = resolveModelIdentifier(registry, id);
    if (!m || !m.input.includes("text") || !registry.hasConfiguredAuth(m)) {
      warnings.push(`Fallback executor ${id} unavailable; skipping.`);
      continue;
    }
    const key = modelDisplay(m);
    if (!seen.has(key)) {
      seen.add(key);
      ladder.push(m);
    }
  }
  return ladder;
}

/**
 * Ladder rung from consecutive failures: 0 = base executor,
 * climbing one rung per failure, pinned at the top. Success resets
 * failures to 0, so the worker auto-de-escalates. Pure (unit-tested).
 */
export function rungFor(failures: number, ladderLength: number): number {
  if (ladderLength <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(failures), ladderLength - 1));
}

/** Configured executor first, else first non-current authed text model. */
export function resolveExecutorModel(
  registry: ModelRegistry,
  currentModel: Model<Api> | undefined,
  configuredExecutor: string | undefined,
  warnings: string[],
): Model<Api> | undefined {
  if (configuredExecutor) {
    const resolved = resolveModelIdentifier(registry, configuredExecutor);
    if (resolved && resolved.input.includes("text") && registry.hasConfiguredAuth(resolved)) {
      return resolved;
    }
    warnings.push(`Configured executor ${configuredExecutor} unavailable; falling back to auto-selection.`);
  }
  const available = registry.getAvailable().filter((m) => m.input.includes("text"));
  if (available.length === 0) return undefined;
  const nonCurrent = currentModel
    ? available.filter((m) => modelDisplay(m) !== modelDisplay(currentModel))
    : available;
  if (nonCurrent.length > 0) return nonCurrent[0];
  warnings.push("Executor fell back to the current lead model; cost savings are not guaranteed.");
  return available[0];
}
