/** Cost, token, and usage accounting helpers shared by the worker and monitor. */

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

/** The provider usage shape used by pi-ai, kept structural for old snapshots. */
export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number } | number;
}

export interface UsageFooterData extends UsageSummary {
  /** The latest successful assistant usage, used only for CH. */
  latest?: UsageLike;
  /** Context is intentionally optional: it is unknown before provider usage and after compaction. */
  contextTokens?: number;
  contextWindow?: number;
  contextKnown?: boolean;
  subscription?: boolean;
  /** Fusion compaction is automatic, so the footer carries Pi's (auto) marker. */
  automaticCompaction?: boolean;
}

export function zeroUsage(): UsageSummary {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageCost(value: UsageLike["cost"]): number {
  if (typeof value === "number") return finiteNonNegative(value);
  return finiteNonNegative(value?.total);
}

export function addUsage(acc: UsageSummary, u: UsageLike | undefined): UsageSummary {
  if (!u) return acc;
  return {
    input: acc.input + finiteNonNegative(u.input),
    output: acc.output + finiteNonNegative(u.output),
    cacheRead: acc.cacheRead + finiteNonNegative(u.cacheRead),
    cacheWrite: acc.cacheWrite + finiteNonNegative(u.cacheWrite),
    totalTokens: acc.totalTokens + finiteNonNegative(u.totalTokens),
    cost: acc.cost + usageCost(u.cost),
  };
}

export function usageSummary(u: UsageLike | undefined): UsageSummary {
  return addUsage(zeroUsage(), u);
}

/** Pi's compact token formatter, used by the regular footer as well as the monitor. */
export function formatCompactTokens(value: number): string {
  const count = Math.max(0, Number.isFinite(value) ? value : 0);
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function latestPromptCacheHitRate(usage: UsageLike | undefined): number | undefined {
  if (!usage) return undefined;
  const promptTokens = finiteNonNegative(usage.input)
    + finiteNonNegative(usage.cacheRead)
    + finiteNonNegative(usage.cacheWrite);
  return promptTokens > 0 ? (finiteNonNegative(usage.cacheRead) / promptTokens) * 100 : undefined;
}

/**
 * Format the fixed worker footer using the same labels and semantics as Pi.
 * Zero-valued token/cost fields follow Pi's omission rules; context remains
 * present so the footer is still useful before the first provider response.
 */
export function formatUsageFooter(data: UsageFooterData): string {
  const parts: string[] = [];
  if (data.input) parts.push(`↑${formatCompactTokens(data.input)}`);
  if (data.output) parts.push(`↓${formatCompactTokens(data.output)}`);
  if (data.cacheRead) parts.push(`R${formatCompactTokens(data.cacheRead)}`);
  if (data.cacheWrite) parts.push(`W${formatCompactTokens(data.cacheWrite)}`);
  const cacheHit = latestPromptCacheHitRate(data.latest);
  if ((data.cacheRead > 0 || data.cacheWrite > 0) && cacheHit !== undefined) {
    parts.push(`CH${cacheHit.toFixed(1)}%`);
  }
  const cost = Math.max(0, Number.isFinite(data.cost) ? data.cost : 0);
  if (cost || data.subscription) parts.push(`$${cost.toFixed(3)}${data.subscription ? " (sub)" : ""}`);

  const hasContext = data.contextKnown === true
    && typeof data.contextTokens === "number"
    && Number.isFinite(data.contextTokens)
    && typeof data.contextWindow === "number"
    && Number.isFinite(data.contextWindow)
    && data.contextWindow > 0;
  const window = typeof data.contextWindow === "number" && Number.isFinite(data.contextWindow) && data.contextWindow > 0
    ? formatCompactTokens(data.contextWindow)
    : "?";
  const context = hasContext
    ? `${((data.contextTokens! / data.contextWindow!) * 100).toFixed(1)}%/${window}`
    : `?/${window}`;
  parts.push(`${context}${data.automaticCompaction === false ? "" : " (auto)"}`);
  return parts.join(" ");
}
