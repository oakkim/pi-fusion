/** Incremental session entries shared by worker and inquiry histories. */
import type { Message } from "@earendil-works/pi-ai/compat";

type HistoryRecord = { id: string; history: Message[] };
type Turn = { id: string; generation: number };
export type AppendJournalEntry = (customType: string, data: unknown) => void;
type Cursor = { revision: string; metadata: string; history: string[]; turns: Map<string, string> };

/** A synchronous successful append is the only commit point for this cursor. */
export class JournalWriter<R extends HistoryRecord, T extends Turn> {
  private readonly cursors = new Map<string, Cursor>();

  constructor(private readonly customType: string, private readonly recordKey: "worker" | "thread") {}

  reset(): void { this.cursors.clear(); }

  write(record: R, turns: T[], appendEntry: AppendJournalEntry): boolean {
    const { history, ...metadata } = record;
    const current = {
      metadata: JSON.stringify(metadata),
      history: history.map((message) => JSON.stringify(message)),
      turns: new Map(turns.map((turn) => [turn.id, JSON.stringify(turn)])),
    };
    const previous = this.cursors.get(record.id);
    const prefix = previous && current.history.length >= previous.history.length
      && previous.history.every((message, index) => message === current.history[index]);
    const changedTurns = turns.filter((turn) => current.turns.get(turn.id) !== previous?.turns.get(turn.id));
    const removedTurn = previous && [...previous.turns.keys()].some((id) => !current.turns.has(id));
    if (previous && !removedTurn && prefix && current.history.length === previous.history.length
      && current.metadata === previous.metadata && !changedTurns.length) return false;
    const revision = crypto.randomUUID();
    const full = !previous || removedTurn;
    const data = full
      ? { [this.recordKey]: record, turns, journal: { version: 1, revision } }
      : {
        version: 1, id: record.id, base: previous.revision, revision, record: metadata,
        ...(prefix && history.length === previous.history.length ? {} : {
          history: prefix
            ? { type: "append", offset: previous.history.length, messages: history.slice(previous.history.length) }
            : { type: "replace", messages: history },
        }),
        turns: changedTurns,
      };
    try {
      // The SDK retains in-memory entry objects; never hand it live runtime data.
      appendEntry(full ? this.customType : `${this.customType}-delta`, structuredClone(data));
      this.cursors.set(record.id, { revision, ...current });
    } catch (error) {
      // Native append may change its in-memory branch before a disk error. A
      // retry must re-anchor fully, regardless of which write reached storage.
      this.cursors.delete(record.id);
      throw error;
    }
    return true;
  }
}

export const journalObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const journalId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export const journalGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const journalHistory = (value: unknown): value is Message[] => Array.isArray(value) && value.every((message) => journalObject(message)
  && ["user", "assistant", "toolResult"].includes(String(message.role)) && (typeof message.content === "string"
    || (Array.isArray(message.content) && message.content.every((block) => journalObject(block) && typeof block.type === "string"))));

/** Replay raw history first. Repair interrupted execution only after the branch is complete. */
export function replayJournal<R extends HistoryRecord, T extends Turn>(
  entries: unknown[], customType: string, recordKey: "worker" | "thread",
  validRecord: (value: unknown) => value is R,
  validTurn: (value: unknown, record: R) => value is T,
): Map<string, { record: R; turns: T[] }> {
  const records = new Map<string, { record: R; turns: Map<string, T>; revision?: string }>();
  for (const entry of entries) {
    if (!journalObject(entry) || entry.type !== "custom" || !journalObject(entry.data)) continue;
    const data = entry.data;
    if (entry.customType === customType) {
      const record = data[recordKey];
      if (!validRecord(record) || (data.turns !== undefined && !Array.isArray(data.turns))) continue;
      const journal = data.journal;
      if (journal !== undefined && (!journalObject(journal) || journal.version !== 1 || !journalId(journal.revision))) continue;
      // Legacy full entries historically merged turns; new full entries are
      // self-contained anchors, including after an uncertain append failure.
      const turns = journal === undefined ? new Map(records.get(record.id)?.turns) : new Map<string, T>();
      for (const turn of (data.turns ?? []) as unknown[]) {
        if (!validTurn(turn, record)) continue;
        const previous = turns.get(turn.id);
        if (!previous || turn.generation >= previous.generation) turns.set(turn.id, structuredClone(turn));
      }
      records.set(record.id, { record: structuredClone(record), turns, ...(journalObject(journal) ? { revision: journal.revision as string } : {}) });
    } else if (entry.customType === `${customType}-delta`) {
      if (data.version !== 1 || !journalId(data.id) || !journalId(data.base) || !journalId(data.revision)
        || data.base === data.revision || !journalObject(data.record) || data.record.id !== data.id || "history" in data.record
        || !Array.isArray(data.turns)) continue;
      const previous = records.get(data.id);
      if (!previous || previous.revision !== data.base) continue;
      let history = previous.record.history;
      let append: Message[] | undefined;
      if (data.history !== undefined) {
        const change = data.history;
        if (!journalObject(change) || !journalHistory(change.messages)) continue;
        if (change.type === "replace") history = structuredClone(change.messages);
        else if (change.type === "append" && Number.isSafeInteger(change.offset) && change.offset === history.length) append = change.messages;
        else continue;
      }
      const record = { ...data.record, history };
      if (!validRecord(record) || !data.turns.every((turn) => validTurn(turn, record))) continue;
      const turns = previous.turns;
      if (data.turns.some((turn: T) => turns.has(turn.id) && turn.generation < turns.get(turn.id)!.generation)) continue;
      if (append) history.push(...structuredClone(append));
      for (const turn of data.turns as T[]) turns.set(turn.id, structuredClone(turn));
      records.set(data.id, { record: { ...structuredClone(data.record), history } as R, turns, revision: data.revision });
    }
  }
  return new Map([...records].map(([id, value]) => [id, { record: value.record, turns: [...value.turns.values()] }]));
}
