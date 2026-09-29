/** Bridge the host's tool hooks to a worker without creating another Pi session. */
import { AsyncLocalStorage } from "node:async_hooks";
import { AgentSession, ExtensionRunner, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const STATE = Symbol.for("pi-fusion.worker-tool-runtime");
const OWNER = Symbol.for("pi-fusion.context-runner");
const WORKER = Symbol.for("pi-fusion.worker-tool-context");

interface WorkerScope {
  runner: ExtensionRunner;
  cwd: string;
  signal: AbortSignal | undefined;
  abort: () => void;
}
interface BridgeState {
  scope: AsyncLocalStorage<WorkerScope & { consumed: boolean }>;
  sessions: WeakMap<ExtensionRunner, AgentSession>;
}

// Pi exposes the runner but not its owner through ExtensionContext. Its loader
// shares this exported class with extensions (verified on Pi 0.85 and 0.87).
// Keep the shim and ALS shared across reloads of this extension.
const prototype = ExtensionRunner.prototype as ExtensionRunner & { [STATE]?: BridgeState };
if (!prototype[STATE]) {
  const state: BridgeState = { scope: new AsyncLocalStorage(), sessions: new WeakMap() };
  const original = prototype.createContext;
  prototype.createContext = function () {
    const ctx = original.call(this);
    Object.defineProperty(ctx, OWNER, { value: this });
    const worker = state.scope.getStore();
    if (worker?.runner === this && !worker.consumed) {
      // Native tool hooks create one context and share it with all handlers.
      // Consume the scope before invoking extension code so a handler starting
      // a new Lead run cannot pass worker privileges or cwd to that run.
      worker.consumed = true;
      const cwd = Object.getOwnPropertyDescriptor(ctx, "cwd");
      const signal = Object.getOwnPropertyDescriptor(ctx, "signal");
      if (!cwd?.get || !signal?.get) throw new Error("Unsupported Pi worker tool context");
      // Preserve the native getters' stale-session checks, including on retained
      // contexts. Replacing them with plain values would bypass those checks.
      Object.defineProperties(ctx, {
        cwd: { ...cwd, get: () => { cwd.get!.call(ctx); return worker.cwd; } },
        signal: { ...signal, get: () => { signal.get!.call(ctx); return worker.signal; } },
        abort: { value: () => { cwd.get!.call(ctx); worker.abort(); }, enumerable: true },
        [WORKER]: { value: true },
      });
    }
    return ctx;
  };
  // The active-tools runtime action calls this public method. Capture its host
  // so builtin definitions retain configured shell prefixes and SDK overrides.
  const activeToolNames = AgentSession.prototype.getActiveToolNames;
  AgentSession.prototype.getActiveToolNames = function () {
    if (this.extensionRunner) state.sessions.set(this.extensionRunner, this);
    return activeToolNames.call(this);
  };
  Object.defineProperty(prototype, STATE, { value: state });
}
const state = prototype[STATE]!;

export function isWorkerToolContext(ctx: unknown): boolean {
  return !!ctx && typeof ctx === "object" && (ctx as { [WORKER]?: boolean })[WORKER] === true;
}

export function workerToolRunner(ctx: unknown): ExtensionRunner {
  const runner = ctx && typeof ctx === "object" ? (ctx as { [OWNER]?: ExtensionRunner })[OWNER] : undefined;
  if (!(runner instanceof ExtensionRunner)) {
    throw new Error("Fusion worker tools require the current Pi extension context; reload Pi to connect the tool registry");
  }
  runner.getActiveTools(); // Retain Pi's stale-runner guard.
  return runner;
}

export function withWorkerToolContext<T>(scope: WorkerScope, run: () => T): T {
  return state.scope.run({ ...scope, consumed: false }, run);
}

export function workerToolDefinition(runner: ExtensionRunner, name: string): ToolDefinition | undefined {
  runner.getActiveTools(); // Also captures the live host via its runtime action.
  const session = state.sessions.get(runner);
  return session ? session.getToolDefinition(name) : runner.getToolDefinition(name);
}
