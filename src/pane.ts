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

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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

/** Pure deterministic renderer used by the TUI component and self-tests. */
export function renderWorkerPane(worker: WorkerRecord | undefined, width: number, maxConversationLines = 30): string[] {
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
  const conversation = historyLines(worker.history, Math.max(1, innerWidth - 2));
  const recent = conversation.slice(-Math.max(1, maxConversationLines));
  if (recent.length === 0) lines.push(row(" No visible messages."));
  else for (const line of recent) lines.push(row(` ${line}`));
  lines.push(border);
  return lines;
}

class WorkerPaneComponent implements Component {
  constructor(
    private readonly tui: TUI,
    private readonly getWorker: () => WorkerRecord | undefined,
  ) {}

  render(width: number): string[] {
    const available = Math.max(1, Math.floor(this.tui.terminal.rows * 0.9) - 8);
    return renderWorkerPane(this.getWorker(), width, Math.min(30, available));
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

  constructor(private readonly getWorker: (id: string) => WorkerRecord | undefined) {}

  get state(): PaneState {
    return { ...this.#state };
  }

  restore(state: PaneState): void {
    this.#state = { ...state };
  }

  select(workerId: string): void {
    this.#state = { visible: this.#state.visible, workerId };
    this.refresh();
  }

  open(ctx: ExtensionContext, workerId?: string): boolean {
    if (workerId) this.#state.workerId = workerId;
    if (ctx.mode !== "tui") return false;
    this.#state.visible = true;
    if (this.#finish) {
      this.refresh();
      return true;
    }

    const instance = ++this.#instance;
    void ctx.ui.custom<void>(
      (tui, _theme, _keybindings, done) => {
        this.#tui = tui;
        this.#finish = () => done();
        return new WorkerPaneComponent(tui, () => this.#state.workerId ? this.getWorker(this.#state.workerId) : undefined);
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "right-center",
          width: "42%",
          minWidth: 42,
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
    });
    return true;
  }

  close(): void {
    this.#state.visible = false;
    const finish = this.#finish;
    this.#finish = undefined;
    this.#tui = undefined;
    this.#instance += 1;
    finish?.();
  }

  refresh(): void {
    this.#tui?.requestRender();
  }
}
