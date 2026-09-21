import type { Message } from "@earendil-works/pi-ai/compat";

export type InquiryTurnStatus = "running" | "completed" | "failed" | "interrupted";

export interface InquiryThread {
  id: string; // inq_...
  workerId: string;
  history: Message[]; // sidecar Q&A only; never merged into worker history
  generation: number;
  activeTurnId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface InquiryTurn {
  id: string; // iqt_...
  inquiryId: string;
  workerId: string;
  question: Message;
  status: InquiryTurnStatus;
  generation: number;
  workerGeneration: number;
  workerTurnId: string | null;
  capturedAt: number;
  answer?: string;
  error?: string;
}

export interface InquirySnapshot {
  thread: InquiryThread;
  turns: InquiryTurn[];
}

export class InquiryRuntime {
  readonly #threads = new Map<string, InquiryThread>();
  readonly #turns = new Map<string, InquiryTurn>();
  readonly #controllers = new Map<string, AbortController>();

  list(): InquiryThread[] {
    return [...this.#threads.values()];
  }

  getThread(id: string): InquiryThread | undefined {
    return this.#threads.get(id);
  }

  getTurn(id: string): InquiryTurn | undefined {
    return this.#turns.get(id);
  }

  create(workerId: string): InquiryThread {
    const now = Date.now();
    const thread: InquiryThread = {
      id: `inq_${crypto.randomUUID()}`,
      workerId,
      history: [],
      generation: 0,
      activeTurnId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#threads.set(thread.id, thread);
    return thread;
  }

  start(
    inquiryId: string,
    question: Message,
    snapshot: { workerGeneration: number; workerTurnId: string | null; capturedAt?: number },
  ): InquiryTurn {
    const thread = this.#threads.get(inquiryId);
    if (!thread) throw new Error(`Inquiry ${inquiryId} was not found.`);
    if (thread.activeTurnId) throw new Error(`Inquiry ${inquiryId} is busy (turn ${thread.activeTurnId}).`);
    thread.generation += 1;
    thread.updatedAt = Date.now();
    const turn: InquiryTurn = {
      id: `iqt_${crypto.randomUUID()}`,
      inquiryId,
      workerId: thread.workerId,
      question,
      status: "running",
      generation: thread.generation,
      workerGeneration: snapshot.workerGeneration,
      workerTurnId: snapshot.workerTurnId,
      capturedAt: snapshot.capturedAt ?? Date.now(),
    };
    thread.activeTurnId = turn.id;
    this.#turns.set(turn.id, turn);
    return turn;
  }

  finish(turnId: string, answer: string, assistantMessage: Message, maxHistoryMessages = 20): boolean {
    const turn = this.#turns.get(turnId);
    const thread = turn ? this.#threads.get(turn.inquiryId) : undefined;
    if (!turn || !thread || turn.status !== "running" || thread.activeTurnId !== turnId) return false;
    turn.status = "completed";
    turn.answer = answer;
    thread.history.push(turn.question, assistantMessage);
    if (thread.history.length > maxHistoryMessages) {
      const keep = Math.max(2, maxHistoryMessages - (maxHistoryMessages % 2));
      thread.history = thread.history.slice(-keep);
    }
    thread.activeTurnId = null;
    thread.updatedAt = Date.now();
    this.#controllers.delete(turnId);
    return true;
  }

  fail(turnId: string, error: string): void {
    const turn = this.#turns.get(turnId);
    const thread = turn ? this.#threads.get(turn.inquiryId) : undefined;
    if (!turn || !thread || turn.status !== "running" || thread.activeTurnId !== turnId) return;
    turn.status = "failed";
    turn.error = error;
    thread.activeTurnId = null;
    thread.updatedAt = Date.now();
    this.#controllers.delete(turnId);
  }

  trackController(turnId: string, controller: AbortController): void {
    this.#controllers.set(turnId, controller);
  }

  untrackController(turnId: string): void {
    this.#controllers.delete(turnId);
  }

  interrupt(inquiryId: string): string | undefined {
    const thread = this.#threads.get(inquiryId);
    if (!thread?.activeTurnId) return undefined;
    const turnId = thread.activeTurnId;
    this.#controllers.get(turnId)?.abort();
    const turn = this.#turns.get(turnId);
    if (turn?.status === "running") {
      turn.status = "interrupted";
      turn.error = "Interrupted by session shutdown.";
    }
    thread.activeTurnId = null;
    thread.updatedAt = Date.now();
    return turnId;
  }

  interruptAll(): string[] {
    const interrupted: string[] = [];
    for (const thread of this.#threads.values()) {
      const turnId = this.interrupt(thread.id);
      if (turnId) interrupted.push(turnId);
    }
    return interrupted;
  }

  snapshot(inquiryId?: string): InquirySnapshot[] {
    const threads = inquiryId
      ? [this.#threads.get(inquiryId)].filter((thread): thread is InquiryThread => thread !== undefined)
      : [...this.#threads.values()];
    return threads.map((thread) => ({
      thread: { ...thread, history: [...thread.history] },
      turns: [...this.#turns.values()].filter((turn) => turn.inquiryId === thread.id).map((turn) => ({ ...turn })),
    }));
  }

  restore(entries: unknown[]): void {
    for (const controller of this.#controllers.values()) controller.abort();
    this.#threads.clear();
    this.#turns.clear();
    this.#controllers.clear();

    for (const entry of entries) {
      const value = entry as { type?: unknown; customType?: unknown; data?: unknown };
      if (value?.type !== "custom" || value.customType !== "fusion-inquiry" || !value.data || typeof value.data !== "object") continue;
      const data = value.data as { thread?: InquiryThread; turns?: InquiryTurn[] };
      if (!data.thread?.id || !data.thread.workerId || !Array.isArray(data.thread.history)) continue;
      this.#threads.set(data.thread.id, { ...data.thread, activeTurnId: null, history: [...data.thread.history] });
      for (const turn of data.turns ?? []) {
        if (!turn?.id || turn.inquiryId !== data.thread.id) continue;
        const existing = this.#turns.get(turn.id);
        if (!existing || turn.generation >= existing.generation) {
          this.#turns.set(turn.id, { ...turn, status: turn.status === "running" ? "interrupted" : turn.status });
        }
      }
    }
  }
}
