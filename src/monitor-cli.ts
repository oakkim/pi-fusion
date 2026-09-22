#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiAltScreen, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { parseMonitorSnapshot, renderMonitorScreen, shouldTerminateMonitor, type MonitorSnapshot, type MonitorViewState } from "./monitor.ts";

const snapshotPath = process.argv[2];
if (!snapshotPath) {
  process.stderr.write("Usage: monitor-cli.ts <snapshot.json>\n");
  process.exit(2);
}

// Theme initialization belongs to the sidecar process, never the Lead extension.
// Node executes this file directly in strip-only TypeScript mode, so keep the
// control path free of enums/parameter properties and other runtime TS syntax.
initTheme();
let activeThemeName: string | undefined;

function applySnapshotTheme(snapshot: MonitorSnapshot): void {
  const next = snapshot.themeName;
  if (next === activeThemeName) return;
  try {
    initTheme(next);
  } catch {
    // initTheme normally falls back to dark itself; retain a safe fallback for
    // older Pi builds that may throw on an unknown custom theme.
    try { initTheme(); } catch { /* keep the already initialized theme */ }
  }
  activeThemeName = next;
}

const terminal = new ProcessTerminal();
const tui: TUI = new TuiAltScreen(terminal, false, undefined, { mouse: true, wheelScrollLines: 3 });

class MonitorComponent implements Component {
  snapshot?: MonitorSnapshot;
  state: MonitorViewState = { scroll: 0, follow: true };
  maxScroll = 0;
  readonly #requestReload: () => void;
  readonly #quit: () => void;

  constructor(requestReload: () => void, quit: () => void) {
    this.#requestReload = requestReload;
    this.#quit = quit;
  }

  setSnapshot(snapshot: MonitorSnapshot): void {
    applySnapshotTheme(snapshot);
    const previousWorkers = this.snapshot?.workers.map((worker) => worker.id).join("\0");
    this.snapshot = snapshot;
    const currentWorkers = snapshot.workers.map((worker) => worker.id).join("\0");
    if (previousWorkers !== currentWorkers && !snapshot.workers.some((worker) => worker.id === this.state.selectedWorkerId)) {
      this.state.selectedWorkerId = undefined;
      this.state.scroll = 0;
      this.state.follow = true;
    }
    tui.requestRender();
  }

  render(width: number): string[] {
    const snapshot = this.snapshot ?? {
      schemaVersion: 2,
      sessionId: "waiting",
      cwd: "",
      workers: [],
      updatedAt: Date.now(),
      connected: false,
      ownerPid: 0,
    } satisfies MonitorSnapshot;
    const rendered = renderMonitorScreen(snapshot, width, terminal.rows, this.state);
    this.state.selectedWorkerId = rendered.selectedWorkerId;
    this.state.scroll = rendered.scroll;
    this.maxScroll = rendered.maxScroll;
    return rendered.lines;
  }

  handleInput(data: string): void {
    if (data === "q" || data === "Q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.#quit();
      return;
    }
    if (data === "j" || data === "J" || matchesKey(data, "tab")) {
      this.selectWorker(1);
      return;
    }
    if (data === "k" || data === "K" || matchesKey(data, "shift+tab")) {
      this.selectWorker(-1);
      return;
    }
    if (matchesKey(data, "up")) {
      this.state.follow = false;
      this.state.scroll = Math.max(0, this.state.scroll - 1);
      tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.state.scroll = Math.min(this.maxScroll, this.state.scroll + 1);
      this.state.follow = this.state.scroll >= this.maxScroll;
      tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.state.follow = false;
      this.state.scroll = Math.max(0, this.state.scroll - Math.max(1, terminal.rows - 6));
      tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.state.scroll = Math.min(this.maxScroll, this.state.scroll + Math.max(1, terminal.rows - 6));
      this.state.follow = this.state.scroll >= this.maxScroll;
      tui.requestRender();
      return;
    }
    if (data === "f" || data === "F") {
      this.state.follow = true;
      this.state.scroll = this.maxScroll;
      tui.requestRender();
      return;
    }
    if (data === "r" || data === "R") this.#requestReload();
  }

  invalidate(): void {}

  private selectWorker(delta: number): void {
    const workers = this.snapshot?.workers ?? [];
    if (workers.length === 0) return;
    const current = workers.findIndex((worker) => worker.id === this.state.selectedWorkerId);
    const index = current < 0 ? 0 : (current + delta + workers.length) % workers.length;
    this.state.selectedWorkerId = workers[index]!.id;
    this.state.scroll = 0;
    this.state.follow = true;
    tui.requestRender();
  }
}

let stopped = false;
let lastModified = -1;
let lastContents = "";
let pollTimer: ReturnType<typeof setInterval> | undefined;
let elapsedTimer: ReturnType<typeof setInterval> | undefined;
let terminationTimer: ReturnType<typeof setTimeout> | undefined;

const stop = (): void => {
  if (stopped) return;
  stopped = true;
  if (pollTimer) clearInterval(pollTimer);
  if (elapsedTimer) clearInterval(elapsedTimer);
  if (terminationTimer) clearTimeout(terminationTimer);
  tui.stop();
  process.exit(0);
};

const component = new MonitorComponent(() => { void reload(true); }, stop);
tui.addChild(component);
tui.setFocus(component);

function scheduleTermination(snapshot: MonitorSnapshot): void {
  if (!snapshot.closed) {
    component.setSnapshot({
      ...snapshot,
      connected: false,
      closed: true,
      closeReason: "Publisher exited or heartbeat became stale.",
    });
  }
  if (!terminationTimer) terminationTimer = setTimeout(stop, 700);
}

async function reload(force = false): Promise<void> {
  if (stopped) return;
  try {
    const info = await stat(snapshotPath);
    if (!force && info.mtimeMs === lastModified) {
      if (component.snapshot && shouldTerminateMonitor(component.snapshot, Date.now(), undefined, info.mtimeMs)) scheduleTermination(component.snapshot);
      return;
    }
    const contents = await readFile(snapshotPath, "utf8");
    lastModified = info.mtimeMs;
    if (!force && contents === lastContents) {
      if (component.snapshot && shouldTerminateMonitor(component.snapshot, Date.now(), undefined, info.mtimeMs)) scheduleTermination(component.snapshot);
      return;
    }
    const snapshot = parseMonitorSnapshot(contents);
    if (!snapshot) return;
    lastContents = contents;
    component.setSnapshot(snapshot);
    if (shouldTerminateMonitor(snapshot, Date.now(), undefined, info.mtimeMs)) scheduleTermination(snapshot);
  } catch {
    // The publisher may still be starting; an established dead owner is final.
    if (component.snapshot && shouldTerminateMonitor(component.snapshot, Date.now(), undefined, lastModified)) scheduleTermination(component.snapshot);
  }
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("SIGHUP", stop);
process.once("uncaughtException", (error) => {
  tui.stop();
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

await reload(true);
pollTimer = setInterval(() => { void reload(); }, 120);
elapsedTimer = setInterval(() => tui.requestRender(), 1_000);
tui.start();
