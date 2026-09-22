/**
 * Persistent worker runtime. opencode-agent's wrk_/trn_ protocol,
 * adapted to pi: no daemon/SQLite in v0 — workers live in the extension
 * instance and are journaled to the session (pi.appendEntry) so they
 * survive follow-ups and session restore.
 */

import type { Message } from "@earendil-works/pi-ai/compat";
import { addUsage, usageSummary, zeroUsage, type UsageLike, type UsageSummary } from "./cost.ts";
import type { WorkerStatus, TurnRecord, WorktreeInfo } from "./types.ts";

export interface WorkerContextTelemetry {
  /** Context tokens are absent/unknown until a successful provider response. */
  tokens?: number;
  window?: number;
  known: boolean;
}

export interface WorkerTelemetry {
  /** Cumulative successful-turn total. */
  cumulative: UsageSummary;
  /** Usage from the most recent successful assistant response, for CH. */
  latest?: UsageSummary;
  /** Actual model used by the latest successful executor turn. */
  latestExecutor?: string;
  context?: WorkerContextTelemetry;
  /** Fusion history compaction is automatic and is shown as (auto) in the footer. */
  automaticCompaction: boolean;
}

function latestAssistantUsage(history: Message[]): UsageSummary | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index] as Message & { usage?: UsageLike; stopReason?: string };
    if (message.role !== "assistant" || !message.usage || message.stopReason === "error" || message.stopReason === "aborted") continue;
    const summary = usageSummary(message.usage);
    if (summary.input || summary.output || summary.cacheRead || summary.cacheWrite || summary.totalTokens || summary.cost) return summary;
  }
  return undefined;
}

export interface WorkerRecord {
  id: string; // wrk_...
  label?: string;
  executorModelId: string; // "provider/id" snapshot at spawn
  history: Message[]; // persistent sidekick context (independent of lead)
  generation: number; // handoff count, mirrors fusion-ref
  status: WorkerStatus;
  activeTurnId: string | null;
  failures: number; // consecutive sidekick failures (for routing escalation)
  worktree?: WorktreeInfo; // isolated checkout (executor cwd); absent = shared project cwd
  createdAt: number;
  /** Optional for journal compatibility with workers written before monitor telemetry. */
  telemetry?: WorkerTelemetry;
}

export class WorkerRuntime {
  readonly #workers = new Map<string, WorkerRecord>();
  readonly #turns = new Map<string, TurnRecord>();
  readonly #controllers = new Map<string, AbortController>(); // turnId -> controller

  list(): WorkerRecord[] {
    return [...this.#workers.values()];
  }

  getWorker(id: string): WorkerRecord | undefined {
    return this.#workers.get(id);
  }

  getTurn(id: string): TurnRecord | undefined {
    return this.#turns.get(id);
  }

  spawn(input: { label: string | undefined; executorModelId: string; firstMessage: Message; worktree?: WorktreeInfo }): { worker: WorkerRecord; turn: TurnRecord } {
    const { label, executorModelId, firstMessage, worktree } = input;
    const worker: WorkerRecord = {
      id: `wrk_${crypto.randomUUID()}`,
      label,
      executorModelId,
      worktree,
      history: [firstMessage],
      generation: 1,
      status: "running",
      activeTurnId: null,
      failures: 0,
      createdAt: Date.now(),
      telemetry: {
        cumulative: zeroUsage(),
        automaticCompaction: true,
      },
    };
    const turn: TurnRecord = {
      id: `trn_${crypto.randomUUID()}`,
      workerId: worker.id,
      status: "running",
      generation: 1,
    };
    worker.activeTurnId = turn.id;
    this.#workers.set(worker.id, worker);
    this.#turns.set(turn.id, turn);
    return { worker, turn };
  }

  /** Queue a follow-up on the SAME worker (persistent context). Returns the new turn. */
  followup(workerId: string, message: Message): TurnRecord {
    const worker = this.#workers.get(workerId);
    if (!worker) throw new Error(`Worker ${workerId} was not found.`);
    if (worker.status === "closed") throw new Error(`Worker ${workerId} is closed.`);
    if (worker.activeTurnId) throw new Error(`Worker ${workerId} is busy (turn ${worker.activeTurnId}).`);
    worker.history.push(message);
    worker.generation += 1;
    const turn: TurnRecord = {
      id: `trn_${crypto.randomUUID()}`,
      workerId,
      status: "running",
      generation: worker.generation,
    };
    worker.activeTurnId = turn.id;
    worker.status = "running";
    this.#turns.set(turn.id, turn);
    return turn;
  }

  finishTurn(
    turnId: string,
    text: string,
    assistantMessages: Message[],
    telemetry?: { usage?: UsageLike; latestUsage?: UsageLike; latestExecutor?: string; context?: WorkerContextTelemetry },
  ): boolean {
    const turn = this.#turns.get(turnId);
    const worker = turn ? this.#workers.get(turn.workerId) : undefined;
    if (!turn || !worker || turn.status !== "running" || worker.activeTurnId !== turnId) return false;
    turn.status = "completed";
    turn.text = text;
    worker.history.push(...assistantMessages);
    worker.activeTurnId = null;
    worker.status = "idle";
    worker.failures = 0;
    if (telemetry?.usage) {
      const previous = worker.telemetry?.cumulative ?? zeroUsage();
      worker.telemetry = {
        cumulative: addUsage(previous, telemetry.usage),
        latest: usageSummary(telemetry.latestUsage ?? telemetry.usage),
        latestExecutor: telemetry.latestExecutor ?? worker.telemetry?.latestExecutor,
        context: telemetry.context ?? worker.telemetry?.context,
        automaticCompaction: worker.telemetry?.automaticCompaction ?? true,
      };
    } else if (telemetry?.latestExecutor || telemetry?.context) {
      worker.telemetry = {
        cumulative: worker.telemetry?.cumulative ?? zeroUsage(),
        latest: worker.telemetry?.latest,
        latestExecutor: telemetry.latestExecutor ?? worker.telemetry?.latestExecutor,
        context: telemetry.context ?? worker.telemetry?.context,
        automaticCompaction: worker.telemetry?.automaticCompaction ?? true,
      };
    }
    this.#controllers.delete(turnId);
    return true;
  }

  failTurn(turnId: string, error: string): void {
    const turn = this.#turns.get(turnId);
    const worker = turn ? this.#workers.get(turn.workerId) : undefined;
    if (!turn || !worker || turn.status !== "running" || worker.activeTurnId !== turnId) return;
    turn.status = "failed";
    turn.error = error;
    worker.activeTurnId = null;
    worker.status = "idle";
    worker.failures += 1;
    this.#controllers.delete(turnId);
  }

  interrupt(workerId: string): string | undefined {
    const worker = this.#workers.get(workerId);
    if (!worker || !worker.activeTurnId) return undefined;
    const turnId = worker.activeTurnId;
    this.#controllers.get(turnId)?.abort();
    const turn = this.#turns.get(turnId);
    if (turn && turn.status === "running") {
      turn.status = "interrupted";
      turn.error = "Interrupted by lead.";
    }
    worker.activeTurnId = null;
    worker.status = "idle";
    return turnId;
  }

  /** Interrupt every active worker, e.g. before session replacement or shutdown. */
  interruptAll(): string[] {
    const interrupted: string[] = [];
    for (const worker of this.#workers.values()) {
      const turnId = this.interrupt(worker.id);
      if (turnId) interrupted.push(turnId);
    }
    return interrupted;
  }

  close(workerId: string): void {
    this.interrupt(workerId);
    const worker = this.#workers.get(workerId);
    if (worker) worker.status = "closed";
  }

  trackController(turnId: string, controller: AbortController): void {
    this.#controllers.set(turnId, controller);
  }

  untrackController(turnId: string): void {
    this.#controllers.delete(turnId);
  }

  /** Independent compaction: keep history bounded per worker. */
  compactHistory(worker: WorkerRecord, maxMessages: number): boolean {
    if (worker.history.length <= maxMessages) return false;
    // Keep the original task, then prefer a complete handoff over a protocol fragment.
    let start = worker.history.length - (maxMessages - 1);
    const handoff = worker.history.findIndex((message, index) => index >= start && message.role === "user");
    if (handoff >= 0) start = handoff;
    else while (worker.history[start]?.role === "toolResult") start++;
    const keep = worker.history.slice(start);
    worker.history = [worker.history[0]!, ...keep];
    // The prior usage describes the pre-compaction context and must not be
    // presented as live context until a provider responds again.
    if (worker.telemetry) {
      worker.telemetry = {
        ...worker.telemetry,
        context: {
          known: false,
          ...(worker.telemetry.context?.window ? { window: worker.telemetry.context.window } : {}),
        },
      };
    }
    return true;
  }

  // ---- session journal (durable across /resume) ----

  snapshot(): Array<{ worker: WorkerRecord; turns: TurnRecord[] }> {
    return [...this.#workers.values()].map((w) => ({
      worker: { ...w, history: [...w.history] },
      turns: [...this.#turns.values()].filter((t) => t.workerId === w.id).map((t) => ({ ...t })),
    }));
  }

  restore(entries: unknown[]): void {
    for (const controller of this.#controllers.values()) controller.abort();
    this.#workers.clear();
    this.#turns.clear();
    this.#controllers.clear();

    // Older journals have no worker telemetry. Keep cumulative fusion-cost
    // usage by worker; latest CH comes only from restored assistant history.
    const legacyUsage = new Map<string, { cumulative: UsageSummary; executor?: string }>();
    for (const entry of entries) {
      const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
      if (e?.type !== "custom" || e?.customType !== "fusion-cost" || !e.data || typeof e.data !== "object") continue;
      const data = e.data as { worker_id?: unknown; usage?: UsageLike; executor?: unknown };
      if (typeof data.worker_id !== "string") continue;
      const previous = legacyUsage.get(data.worker_id) ?? { cumulative: zeroUsage() };
      previous.cumulative = addUsage(previous.cumulative, data.usage);
      if (typeof data.executor === "string" && data.executor) previous.executor = data.executor;
      legacyUsage.set(data.worker_id, previous);
    }

    // Scan session branch for fusion-worker snapshots, last wins per worker id.
    for (const entry of entries) {
      const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
      if (e?.type !== "custom" || e?.customType !== "fusion-worker" || !("data" in (e as object))) continue;
      const data = (e as { data: { worker?: WorkerRecord; turns?: TurnRecord[] } }).data;
      if (!data?.worker?.id) continue;
      const restored = { ...data.worker };
      if (!restored.telemetry) {
        const legacy = legacyUsage.get(restored.id);
        restored.telemetry = {
          cumulative: legacy?.cumulative ?? zeroUsage(),
          latest: latestAssistantUsage(restored.history),
          latestExecutor: legacy?.executor,
          automaticCompaction: true,
        };
      } else {
        restored.telemetry = {
          cumulative: restored.telemetry.cumulative ?? zeroUsage(),
          latest: restored.telemetry.latest,
          latestExecutor: restored.telemetry.latestExecutor,
          context: restored.telemetry.context,
          automaticCompaction: restored.telemetry.automaticCompaction ?? true,
        };
      }
      this.#workers.set(restored.id, {
        ...restored,
        activeTurnId: null,
        status: restored.status === "closed" ? "closed" : "idle",
      });
      for (const t of data.turns ?? []) {
        const existing = this.#turns.get(t.id);
        if (!existing || t.generation >= existing.generation) {
          this.#turns.set(t.id, { ...t, status: t.status === "running" ? "interrupted" : t.status });
        }
      }
    }
  }
}
