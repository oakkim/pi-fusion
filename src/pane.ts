import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai/compat";
import { truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { WorkerRecord } from "./runtime.ts";

export interface PaneState {
  visible: boolean;
  workerId?: string;
}

export interface PaneHistoryItem {
  role: "LEAD" | "SIDEKICK" | "TOOL";
  text: string;
}

export type LivePhase = "waiting" | "thinking" | "responding" | "tool";

export interface LiveToolActivity {
  id: string;
  name: string;
  arguments: string;
  output: string;
  status: "running" | "success" | "error";
}

export interface LiveActivity {
  phase: LivePhase;
  startedAt: number;
  text: string;
  tools: LiveToolActivity[];
}

export type LiveProgress =
  | { kind: "phase"; phase: LivePhase; text?: string; replaceText?: boolean }
  | { kind: "tool_start"; toolId: string; name: string; arguments: string }
  | { kind: "tool_update"; toolId: string; output: string }
  | { kind: "tool_end"; toolId: string; ok: boolean; output?: string };

const LIVE_TEXT_MAX = 4000;
const LIVE_ARGUMENTS_MAX = 2000;
const LIVE_OUTPUT_MAX = 4000;
const LIVE_TOOL_MAX = 8;
const LIVE_RENDER_INTERVAL_MS = 60;
const LIVE_ELAPSED_INTERVAL_MS = 1000;
const LIVE_TEXT_LINES = 8;
const LIVE_OUTPUT_LINES = 4;
const LIVE_LINES_MAX = 32;

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function boundText(value: string, max: number): string {
  const normalized = value.replace(/\r/g, "");
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 3))}...` : normalized;
}

/** Streaming text/output should keep the newest bytes, not freeze at the prefix. */
function boundTailText(value: string, max: number): string {
  const normalized = value.replace(/\r/g, "");
  return normalized.length > max ? `...${normalized.slice(-Math.max(0, max - 3))}` : normalized;
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: unknown) => {
    if (!part || typeof part !== "object") return [];
    const block = part as { type?: unknown; text?: unknown };
    return block.type === "text" && typeof block.text === "string" && block.text.trim() ? [block.text] : [];
  });
}

export function extractHandoffTask(text: string): string {
  return /<task>([\s\S]*?)<\/task>/.exec(text)?.[1]?.trim() || text.trim();
}

/** Convert compat messages to user-visible rows. Thinking blocks are deliberately omitted. */
export function formatPaneHistory(history: Message[]): PaneHistoryItem[] {
  const items: PaneHistoryItem[] = [];
  for (const message of history) {
    if (message.role === "user") {
      for (const text of textParts(message.content)) items.push({ role: "LEAD", text: extractHandoffTask(text) });
      continue;
    }
    if (message.role === "assistant") {
      const content: unknown = message.content;
      if (typeof content === "string") {
        if (content.trim()) items.push({ role: "SIDEKICK", text: content });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const block = part as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          items.push({ role: "SIDEKICK", text: block.text });
        } else if (block.type === "toolCall" && typeof block.name === "string") {
          const args = stringify(block.arguments);
          items.push({ role: "TOOL", text: `call ${block.name}${args === "{}" ? "" : ` ${args}`}` });
        }
        // block.type === "thinking" is intentionally not rendered.
      }
      continue;
    }
    if (message.role === "toolResult") {
      const result = textParts(message.content).join("\n") || "(no text output)";
      items.push({ role: "TOOL", text: `${message.toolName} ${message.isError ? "error" : "result"}: ${result}` });
    }
  }
  return items;
}

function fitLine(text: string, width: number): string {
  return truncateToWidth(text, width, "", true);
}

function historyLines(history: Message[], width: number): string[] {
  const lines: string[] = [];
  for (const item of formatPaneHistory(history)) {
    const prefix = `[${item.role}] `;
    const normalized = item.text.replace(/\r/g, "").trim();
    const bounded = truncateToWidth(normalized, 2000, "...");
    lines.push(...wrapTextWithAnsi(`${prefix}${bounded}`, width));
  }
  return lines;
}

function elapsedText(startedAt: number, now = Date.now()): string {
  return `${Math.max(0, Math.floor((now - startedAt) / 1000))}s`;
}

function liveLines(activity: LiveActivity, width: number, now = Date.now()): string[] {
  const statusLine = `[LIVE] ${activity.phase} | ${elapsedText(activity.startedAt, now)}`;
  const detailLines: string[] = [];
  if (activity.text) {
    const text = wrapTextWithAnsi(`[LIVE] ${boundTailText(activity.text, LIVE_TEXT_MAX)}`, width);
    detailLines.push(...text.slice(-LIVE_TEXT_LINES));
  }
  for (const tool of activity.tools) {
    const args = tool.arguments ? ` ${tool.arguments}` : "";
    detailLines.push(...wrapTextWithAnsi(`[TOOL] ${tool.name}${args} | ${tool.status}`, width));
    if (tool.output) {
      const output = wrapTextWithAnsi(`[TOOL] > ${boundTailText(tool.output, LIVE_OUTPUT_MAX)}`, width);
      detailLines.push(...output.slice(-LIVE_OUTPUT_LINES));
    }
  }
  return [statusLine, ...detailLines.slice(-(LIVE_LINES_MAX - 1))];
}

/** Pure deterministic renderer used by the TUI component and self-tests. */
export function renderWorkerPane(
  worker: WorkerRecord | undefined,
  width: number,
  maxConversationLines = Number.MAX_SAFE_INTEGER,
  live?: LiveActivity,
): string[] {
  const paneWidth = Math.max(4, width);
  const innerWidth = paneWidth - 2;
  const row = (text = "") => `|${fitLine(text, innerWidth)}|`;
  const border = `+${"-".repeat(innerWidth)}+`;
  const lines = [border, row(" Fusion worker")];

  if (!worker) {
    lines.push(row(" No worker selected."), border);
    return lines;
  }

  lines.push(
    row(` ${worker.label || "sidekick"} | ${worker.id}`),
    row(` ${worker.status} | generation ${worker.generation}`),
    row(` ${worker.executorModelId}`),
    row(` ${"-".repeat(Math.max(0, innerWidth - 2))}`),
  );
  const availableWidth = Math.max(1, innerWidth - 2);
  const contentLimit = Number.isFinite(maxConversationLines)
    ? Math.max(1, maxConversationLines)
    : maxConversationLines;
  let currentLiveLines = live ? liveLines(live, availableWidth) : [];
  if (Number.isFinite(contentLimit) && currentLiveLines.length > contentLimit) {
    currentLiveLines = contentLimit === 1
      ? [currentLiveLines[0]!]
      : [currentLiveLines[0]!, ...currentLiveLines.slice(-(contentLimit - 1))];
  }
  for (const line of currentLiveLines) lines.push(row(` ${line}`));

  const conversationLimit = Number.isFinite(contentLimit)
    ? Math.max(0, contentLimit - currentLiveLines.length)
    : contentLimit;
  const conversation = historyLines(worker.history, availableWidth);
  const recent = conversationLimit > 0 ? conversation.slice(-conversationLimit) : [];
  if (recent.length === 0 && currentLiveLines.length === 0) lines.push(row(" No visible messages."));
  else for (const line of recent) lines.push(row(` ${line}`));
  lines.push(border);
  return lines;
}

class WorkerPaneComponent implements Component {
  constructor(
    private readonly tui: TUI,
    private readonly getWorker: () => WorkerRecord | undefined,
    private readonly getLive: (workerId: string) => LiveActivity | undefined,
  ) {}

  render(width: number): string[] {
    // The overlay's maxHeight is 90%; reserve only the fixed pane header/borders
    // and let the renderer use the rest instead of capping history at 30 lines.
    const overlayRows = Math.max(8, Math.floor(this.tui.terminal.rows * 0.9));
    const conversationCapacity = Math.max(1, overlayRows - 7);
    const worker = this.getWorker();
    return renderWorkerPane(worker, width, conversationCapacity, worker ? this.getLive(worker.id) : undefined);
  }

  invalidate(): void {}
  dispose(): void {}
}

/** Owns the non-capturing overlay lifecycle; the extension owns journal state. */
export class FusionPaneController {
  #state: PaneState = { visible: false };
  #finish?: () => void;
  #tui?: TUI;
  #instance = 0;
  #live = new Map<string, LiveActivity>();
  #liveTokens = new Map<string, number>();
  #liveSequence = 0;
  #elapsedTimer?: ReturnType<typeof setInterval>;
  #renderTimer?: ReturnType<typeof setTimeout>;
  #renderQueued = false;

  constructor(private readonly getWorker: (id: string) => WorkerRecord | undefined) {}

  get state(): PaneState {
    return { ...this.#state };
  }

  get liveTimerActive(): boolean {
    return this.#elapsedTimer !== undefined;
  }

  get renderTimerActive(): boolean {
    return this.#renderTimer !== undefined;
  }

  getLive(workerId: string): LiveActivity | undefined {
    const activity = this.#live.get(workerId);
    if (!activity) return undefined;
    return {
      ...activity,
      tools: activity.tools.map((tool) => ({ ...tool })),
    };
  }

  restore(state: PaneState): void {
    this.#clearLiveState();
    this.#state = { ...state };
  }

  select(workerId: string): void {
    this.#state = { visible: this.#state.visible, workerId };
    this.refresh();
  }

  beginLive(workerId: string, startedAt = Date.now()): number {
    const token = ++this.#liveSequence;
    this.#liveTokens.set(workerId, token);
    this.#live.set(workerId, { phase: "waiting", startedAt, text: "", tools: [] });
    if (this.#state.visible) this.#ensureElapsedTimer();
    this.refresh();
    return token;
  }

  updateLive(workerId: string, progress: LiveProgress, token?: number): void {
    if (token !== undefined && this.#liveTokens.get(workerId) !== token) return;
    const activity = this.#live.get(workerId);
    if (!activity) return;

    switch (progress.kind) {
      case "phase":
        activity.phase = progress.phase;
        if (progress.replaceText) activity.text = "";
        if (progress.text !== undefined) activity.text = boundTailText(progress.text, LIVE_TEXT_MAX);
        break;
      case "tool_start": {
        const existing = activity.tools.find((tool) => tool.id === progress.toolId);
        if (existing) {
          existing.name = boundText(progress.name, 200);
          existing.arguments = boundText(progress.arguments, LIVE_ARGUMENTS_MAX);
          existing.status = "running";
          existing.output = "";
        } else {
          activity.tools.push({
            id: progress.toolId,
            name: boundText(progress.name, 200),
            arguments: boundText(progress.arguments, LIVE_ARGUMENTS_MAX),
            output: "",
            status: "running",
          });
          if (activity.tools.length > LIVE_TOOL_MAX) activity.tools.splice(0, activity.tools.length - LIVE_TOOL_MAX);
        }
        activity.phase = "tool";
        break;
      }
      case "tool_update": {
        const tool = activity.tools.find((item) => item.id === progress.toolId);
        if (tool) tool.output = boundTailText(progress.output, LIVE_OUTPUT_MAX);
        break;
      }
      case "tool_end": {
        const tool = activity.tools.find((item) => item.id === progress.toolId);
        if (tool) {
          tool.status = progress.ok ? "success" : "error";
          if (progress.output !== undefined) tool.output = boundTailText(progress.output, LIVE_OUTPUT_MAX);
        }
        break;
      }
    }
    this.refresh();
  }

  clearLive(workerId: string, token?: number): void {
    if (token !== undefined && this.#liveTokens.get(workerId) !== token) return;
    this.#liveTokens.delete(workerId);
    this.#live.delete(workerId);
    if (this.#live.size === 0) this.#stopElapsedTimer();
    this.refresh();
  }

  open(ctx: ExtensionContext, workerId?: string): boolean {
    if (workerId) this.#state.workerId = workerId;
    if (ctx.mode !== "tui") return false;
    this.#state.visible = true;
    if (this.#live.size > 0) this.#ensureElapsedTimer();
    if (this.#finish) {
      this.refresh();
      return true;
    }

    const instance = ++this.#instance;
    void ctx.ui.custom<void>(
      (tui, _theme, _keybindings, done) => {
        this.#tui = tui;
        this.#finish = () => done();
        return new WorkerPaneComponent(
          tui,
          () => this.#state.workerId ? this.getWorker(this.#state.workerId) : undefined,
          (id) => this.getLive(id),
        );
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "right-center",
          width: "46%",
          minWidth: 46,
          maxHeight: "90%",
          margin: 1,
          nonCapturing: true,
          visible: (termWidth) => termWidth >= 110,
        },
        onHandle: (handle) => {
          if (handle.isFocused()) handle.unfocus();
        },
      },
    ).catch(() => undefined).finally(() => {
      if (this.#instance !== instance) return;
      this.#finish = undefined;
      this.#tui = undefined;
      this.#state.visible = false;
      this.#stopElapsedTimer();
      this.#clearRenderTimer();
    });
    return true;
  }

  /** Hide the overlay without discarding an in-flight worker's transient state. */
  close(): void {
    this.#state.visible = false;
    const finish = this.#finish;
    this.#finish = undefined;
    this.#tui = undefined;
    this.#instance += 1;
    this.#stopElapsedTimer();
    this.#clearRenderTimer();
    finish?.();
  }

  /** Tear down all transient state when the owning session ends. */
  shutdown(): void {
    this.close();
    this.#clearLiveState();
  }

  refresh(): void {
    if (!this.#tui || this.#renderQueued) return;
    this.#renderQueued = true;
    this.#renderTimer = setTimeout(() => {
      this.#renderTimer = undefined;
      this.#renderQueued = false;
      this.#tui?.requestRender();
    }, LIVE_RENDER_INTERVAL_MS);
  }

  #ensureElapsedTimer(): void {
    if (this.#elapsedTimer) return;
    this.#elapsedTimer = setInterval(() => {
      if (this.#live.size === 0 || !this.#state.visible) {
        this.#stopElapsedTimer();
        return;
      }
      this.refresh();
    }, LIVE_ELAPSED_INTERVAL_MS);
  }

  #stopElapsedTimer(): void {
    if (!this.#elapsedTimer) return;
    clearInterval(this.#elapsedTimer);
    this.#elapsedTimer = undefined;
  }

  #clearLiveState(): void {
    this.#live.clear();
    this.#liveTokens.clear();
    this.#stopElapsedTimer();
  }

  #clearRenderTimer(): void {
    if (this.#renderTimer) clearTimeout(this.#renderTimer);
    this.#renderTimer = undefined;
    this.#renderQueued = false;
  }
}
