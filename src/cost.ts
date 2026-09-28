/** Cost, token, and usage accounting helpers shared by the worker and monitor. */

import type { Usage } from "@earendil-works/pi-ai";

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
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } | number;
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

/** Preserve unknown usage instead of presenting an unavailable request as free. */
export function nativeUsage(usage: UsageLike | undefined): (Usage & { cacheWrite1h?: number; reasoning?: number }) | undefined {
  if (!usage) return undefined;
  const costs = typeof usage.cost === "object" && usage.cost ? usage.cost : undefined;
  const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens,
    typeof usage.cost === "number" ? usage.cost : costs?.total];
  if (!values.some((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return undefined;
  const input = finiteNonNegative(usage.input);
  const output = finiteNonNegative(usage.output);
  const cacheRead = finiteNonNegative(usage.cacheRead);
  const cacheWrite = finiteNonNegative(usage.cacheWrite);
  return {
    input, output, cacheRead, cacheWrite,
    totalTokens: typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0
      ? usage.totalTokens : input + output + cacheRead + cacheWrite,
    cost: {
      input: finiteNonNegative(costs?.input), output: finiteNonNegative(costs?.output),
      cacheRead: finiteNonNegative(costs?.cacheRead), cacheWrite: finiteNonNegative(costs?.cacheWrite),
      total: usageCost(usage.cost),
    },
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: finiteNonNegative(usage.cacheWrite1h) } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: finiteNonNegative(usage.reasoning) } : {}),
  };
}

/**
 * Pi 0.87 exposes SessionManager.appendUsage at runtime, although extension
 * contexts still type the manager as read-only. Use that public SDK method only
 * when present; older hosts retain Fusion's existing custom cost journals.
 * A source is one request/worker turn, and cumulative usage must never reset for it.
 */
export function recordNativeUsage(
  ctx: { sessionManager: {
    getEntries(): readonly unknown[];
    appendUsage?: (kind: string, provider: string, model: string, usage: Usage, note?: string) => unknown;
  } },
  sourceId: string,
  model: { provider: string; id: string },
  cumulative: UsageLike | undefined,
  kind = "fusion-worker",
): boolean {
  const current = nativeUsage(cumulative);
  if (!current) return false;
  try {
    const manager = ctx.sessionManager;
    if (typeof manager.appendUsage !== "function") return false;
    const recorded = nativeUsage(zeroUsage())!;
    for (const entry of manager.getEntries()) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as { type?: string; kind?: string; provider?: string; model?: string; note?: string; usage?: UsageLike };
      if (item.type !== "usage" || item.kind !== kind || item.provider !== model.provider || item.model !== model.id || item.note !== sourceId) continue;
      const usage = nativeUsage(item.usage);
      if (!usage) continue;
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) recorded[key] += usage[key];
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) recorded.cost[key] += usage.cost[key];
      for (const key of ["cacheWrite1h", "reasoning"] as const) recorded[key] = (recorded[key] ?? 0) + (usage[key] ?? 0);
    }
    // Ignore rounding dust when replaying cumulative dollar amounts.
    const delta = (next: number, prior: number) => {
      const difference = next - prior;
      return difference > Number.EPSILON * Math.max(1, next, prior) * 8 ? difference : 0;
    };
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) current[key] = delta(current[key], recorded[key]);
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) current.cost[key] = delta(current.cost[key], recorded.cost[key]);
    for (const key of ["cacheWrite1h", "reasoning"] as const) if (current[key] !== undefined) current[key] = delta(current[key]!, recorded[key] ?? 0);
    if (![current.input, current.output, current.cacheRead, current.cacheWrite, current.totalTokens,
      current.cacheWrite1h ?? 0, current.reasoning ?? 0, ...Object.values(current.cost)].some((value) => value > 0)) return false;
    manager.appendUsage(kind, model.provider, model.id, current, sourceId);
    return true;
  } catch {
    // Accounting must not fail a model request, including on stale session ctxs.
    return false;
  }
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
