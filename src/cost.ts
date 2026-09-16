/** Cost accounting for executor turns. Pure helpers (unit-tested). */

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

export function zeroUsage(): UsageSummary {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

export function addUsage(acc: UsageSummary, u: UsageLike | undefined): UsageSummary {
  if (!u) return acc;
  return {
    input: acc.input + (u.input ?? 0),
    output: acc.output + (u.output ?? 0),
    cacheRead: acc.cacheRead + (u.cacheRead ?? 0),
    cacheWrite: acc.cacheWrite + (u.cacheWrite ?? 0),
    totalTokens: acc.totalTokens + (u.totalTokens ?? 0),
    cost: acc.cost + (u.cost?.total ?? 0),
  };
}
