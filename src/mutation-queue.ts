import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface SerializedRunHooks {
  onQueued?: () => void;
  onStart?: () => void;
}

interface QueueState {
  tail: Promise<void>;
  pending: number;
}

const queues = new Map<string, QueueState>();

function queueKey(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, started: () => boolean): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (!started()) reject(signal.reason ?? new Error("Operation aborted."));
    };
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Serialize mutations within one filesystem root while allowing isolated roots to run concurrently. */
export function runSerialized<T>(path: string, fn: () => Promise<T>, signal?: AbortSignal, hooks?: SerializedRunHooks): Promise<T> {
  const key = queueKey(path);
  let queue = queues.get(key);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0 };
    queues.set(key, queue);
  }

  const state = queue;
  const wasQueued = state.pending > 0;
  state.pending++;

  let started = false;
  const run = state.tail.then(() => {
    signal?.throwIfAborted();
    started = true;
    try { hooks?.onStart?.(); } catch { /* monitoring must not block work */ }
    return fn();
  });
  const settled = run.then(() => undefined, () => undefined);
  state.tail = settled;
  void settled.then(() => {
    state.pending--;
    if (state.pending === 0 && queues.get(key) === state) queues.delete(key);
  });
  if (wasQueued) {
    try { hooks?.onQueued?.(); } catch { /* monitoring must not block work */ }
  }

  // Queued cancellation is immediate. Once started, wait for actual cleanup so
  // follow-ups cannot outrun the final tool result or release mutations early.
  return raceWithAbort(run, signal, () => started);
}
