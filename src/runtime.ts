/**
 * Persistent worker runtime. opencode-agent's wrk_/trn_ protocol,
 * adapted to pi: no daemon/SQLite in v0 — workers live in the extension
 * instance and are journaled to the session (pi.appendEntry) so they
 * survive follow-ups and session restore.
 */

import type { Message } from "@earendil-works/pi-ai/compat";
import type { WorkerStatus, TurnRecord, WorktreeInfo } from "./types.ts";

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

  finishTurn(turnId: string, text: string, assistantMessages: Message[]): boolean {
    const turn = this.#turns.get(turnId);
    const worker = turn ? this.#workers.get(turn.workerId) : undefined;
    if (!turn || !worker || turn.status !== "running" || worker.activeTurnId !== turnId) return false;
    turn.status = "completed";
    turn.text = text;
    worker.history.push(...assistantMessages);
    worker.activeTurnId = null;
    worker.status = "idle";
    worker.failures = 0;
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

    // Scan session branch for fusion-worker snapshots, last wins per worker id.
    for (const entry of entries) {
      const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
      if (e?.type !== "custom" || e?.customType !== "fusion-worker" || !("data" in (e as object))) continue;
      const data = (e as { data: { worker?: WorkerRecord; turns?: TurnRecord[] } }).data;
      if (!data?.worker?.id) continue;
      this.#workers.set(data.worker.id, { ...data.worker, activeTurnId: null, status: data.worker.status === "closed" ? "closed" : "idle" });
      for (const t of data.turns ?? []) {
        const existing = this.#turns.get(t.id);
        if (!existing || t.generation >= existing.generation) {
          this.#turns.set(t.id, { ...t, status: t.status === "running" ? "interrupted" : t.status });
        }
      }
    }
  }
}
