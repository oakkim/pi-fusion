#!/usr/bin/env node
/**
 * pi-fusion cost harness (llm-fusion style).
 *
 * Same task x 3 modes -> compare cost / success / lead context load:
 *   cheap     : cheap model alone (no extension)
 *   frontier  : strong model alone (no extension)
 *   fusion    : strong lead + cheap persistent sidekick (pi-fusion)
 *
 * Lead cost comes from --mode json stdout (message_end usage).
 * Sidekick cost comes from fusion-cost journal entries in the saved session.
 *
 * Usage: node bench/run.mjs [--tasks fix-offbyone,add-export] [--modes cheap,frontier,fusion] [--reps 1]
 */
import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";

const execAsync = promisify(execFile);
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const EXT = join(ROOT, "src", "index.ts");
const AGENT_DIR = join(homedir(), ".pi", "agent");
const TRUST_PATH = join(AGENT_DIR, "trust.json");
const FUSION_PATH = join(AGENT_DIR, "fusion.json");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");

const CHEAP = "opencode-go/deepseek-v4-flash";
const PRO = "opencode-go/deepseek-v4-pro";

const MODES = {
  cheap: { model: CHEAP, ext: false, extra: "", pre: [] },
  frontier: { model: PRO, ext: false, extra: "", pre: [] },
  fusion: {
    model: PRO,
    ext: true,
    extra: " Delegate all implementation, file edits, and test runs to the sidekick via fusion_spawn (it performs the edits); you plan and review its result before replying.",
    pre: [],
  },
  // Fair fusion arm: no delegation hint in the prompt; /fusion on forces the split mechanically.
  forced: { model: PRO, ext: true, extra: "", pre: ["/fusion on"] },
};

const RUN_TIMEOUT_MS = 180_000;

function args() {
  const out = { tasks: null, modes: ["cheap", "frontier", "fusion", "forced"], reps: 1, retries: 1 };
  const argv = process.argv.slice(2);
  const take = (i, name) => {
    const a = argv[i];
    if (a.startsWith(name + "=")) return [a.slice(name.length + 1), i];
    if (a === name && i + 1 < argv.length) return [argv[i + 1], i + 1];
    return [null, i];
  };
  for (let i = 0; i < argv.length; i++) {
    let v;
    [v, i] = take(i, "--tasks");
    if (v !== null) { out.tasks = v.split(","); continue; }
    [v, i] = take(i, "--modes");
    if (v !== null) { out.modes = v.split(","); continue; }
    [v, i] = take(i, "--reps");
    if (v !== null) { out.reps = Number(v) || 1; continue; }
    [v, i] = take(i, "--retries");
    if (v !== null) { out.retries = Number(v) || 0; continue; }
  }
  return out;
}

function findSessionFile(sessionId) {
  const candidates = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readDir(dir);
    } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      if (e.endsWith(`_${sessionId}.jsonl`)) candidates.push(p);
      else {
        try {
          if (isDir(p)) walk(p);
        } catch { /* ignore */ }
      }
    }
  };
  walk(SESSIONS_DIR);
  candidates.sort();
  return candidates[candidates.length - 1];
}

// Minimal fs helpers without extra imports.
import { readdirSync, statSync } from "node:fs";
function readDir(d) { return readdirSync(d); }
function isDir(p) { return statSync(p).isDirectory(); }

function parseLeadCost(ndjson) {
  let cost = 0;
  let maxInput = 0;
  let turns = 0;
  let delegations = 0;
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "turn_start") turns++;
    if (ev.type === "tool_execution_start" && ev.toolName === "fusion_spawn") delegations++;
    if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message.usage) {
      cost += ev.message.usage.cost?.total ?? 0;
      maxInput = Math.max(maxInput, ev.message.usage.input ?? 0);
    }
  }
  return { cost, maxInput, turns, delegations };
}

function parseSidekickCost(sessionFile) {
  if (!sessionFile || !existsSync(sessionFile)) return { cost: 0, turns: 0, entries: [] };
  let cost = 0;
  let turns = 0;
  const entries = [];
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.includes("fusion-cost")) continue;
    try {
      const e = JSON.parse(line);
      if (e.customType === "fusion-cost" && e.data) {
        cost += e.data.usage?.cost ?? 0;
        turns++;
        entries.push({ executor: e.data.executor, rung: e.data.rung, cost: e.data.usage?.cost ?? 0 });
      }
    } catch { /* ignore */ }
  }
  return { cost, turns, entries };
}

async function runOnce(task, taskDir, mode, rep, workRoot) {
  const cfg = MODES[mode];
  const workdir = join(workRoot, `${task}-${mode}-r${rep}`);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  cpSync(join(taskDir, "fixture"), workdir, { recursive: true });
  const prompt = readFileSync(join(taskDir, "prompt.txt"), "utf8").trim() + cfg.extra;
  const sessionId = `bench-${task}-${mode}-r${rep}-${Date.now().toString(36)}`;
  const logPath = join(workRoot, `${sessionId}.ndjson`);
  const argv = ["--model", cfg.model, "-p", "--mode", "json", "--session-id", sessionId];
  if (cfg.ext) argv.push("-e", EXT);
  for (const pre of cfg.pre ?? []) argv.push(pre);
  argv.push(prompt);
  const started = Date.now();
  let stdout = "";
  let piError = "";
  let timedOut = false;
  try {
    // NOTE: spawning `pi` directly from node hangs silently in this environment
    // (0 bytes, idle); going through bench/spawn.py (python subprocess) works.
    const res = await execAsync(
      "python3",
      [join(ROOT, "bench", "spawn.py"), workdir, String(RUN_TIMEOUT_MS / 1000), "pi", ...argv],
      { cwd: workdir, timeout: RUN_TIMEOUT_MS + 30_000, maxBuffer: 32 * 1024 * 1024 },
    );
    stdout = res.stdout;
  } catch (err) {
    stdout = err.stdout ?? "";
    timedOut = err.code === 2 || /timed out/i.test(err.stderr ?? "");
    piError = timedOut ? "run timed out" : (err.stderr ?? err.message ?? String(err)).split("\n").slice(0, 3).join(" | ");
  }
  writeFileSync(logPath, stdout);
  const wallSec = Math.round((Date.now() - started) / 100) / 10;
  let pass = false;
  let verifyOut = "";
  try {
    execFileSync("sh", [join(taskDir, "verify.sh")], { cwd: workdir, timeout: 60_000, stdio: "pipe" });
    pass = true;
  } catch (err) {
    verifyOut = String(err.message ?? err).split("\n").slice(0, 3).join(" | ");
  }
  const lead = parseLeadCost(stdout);
  const side = parseSidekickCost(findSessionFile(sessionId));
  return {
    task, mode, rep, pass, timedOut,
    leadCost: lead.cost, sidekickCost: side.cost, total: lead.cost + side.cost,
    leadMaxInput: lead.maxInput, leadTurns: lead.turns, sidekickTurns: side.turns,
    delegations: lead.delegations,
    sidekickLadder: side.entries, wallSec, piError, verifyOut,
  };
}

function fmtUSD(x) {
  return `$${x < 0.01 ? x.toFixed(5) : x.toFixed(3)}`;
}

async function main() {
  const { tasks, modes, reps, retries } = args();
  const allTasks = tasks ?? ["fix-offbyone", "add-export"];
  for (const m of modes) if (!MODES[m]) throw new Error(`unknown mode ${m}`);

  const trustBak = existsSync(TRUST_PATH) ? readFileSync(TRUST_PATH, "utf8") : null;
  const fusionBak = existsSync(FUSION_PATH) ? readFileSync(FUSION_PATH, "utf8") : null;
  const workRoot = join(realpathSync(tmpdir()), "fusion-bench");
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });

  const results = [];
  try {
    // Bench environment: trusted scratch root + mutating executor, no escalation (pure fusion).
    // NOTE: pi checks trust per cwd, so every per-run workdir gets its own entry.
    const trust = trustBak ? JSON.parse(trustBak) : {};
    const saveTrust = () => writeFileSync(TRUST_PATH, JSON.stringify(trust, null, 2));
    trust[workRoot] = true;
    saveTrust();
    writeFileSync(FUSION_PATH, JSON.stringify({
      executor: CHEAP, executorTools: "all", maxToolCalls: 12,
      maxExecutorOutputTokens: 2000, temperature: 0.2,
      executorToolsConsent: true, maxHistoryMessages: 40,
      fallbackExecutors: [], maxEscalations: 0,
    }, null, 2));

    for (const task of allTasks) {
      const taskDir = join(ROOT, "bench", "tasks", task);
      for (const mode of modes) {
        for (let rep = 1; rep <= reps; rep++) {
          console.log(`\n### ${task} / ${mode} / rep ${rep}`);
          trust[join(workRoot, `${task}-${mode}-r${rep}`)] = true;
          saveTrust();
          // Retry on provider stalls (timeout / empty run); keep the last attempt.
          let r = await runOnce(task, taskDir, mode, rep, workRoot);
          for (let att = 1; att <= retries && (r.timedOut || (r.leadCost === 0 && r.sidekickTurns === 0)); att++) {
            console.log(`retry ${att}/${retries} (${r.piError || "empty run"})`);
            r = await runOnce(task, taskDir, mode, rep, workRoot);
          }
          results.push(r);
          console.log(`pass=${r.pass} total=${fmtUSD(r.total)} (lead ${fmtUSD(r.leadCost)} + side ${fmtUSD(r.sidekickCost)}) leadMaxInput=${r.leadMaxInput} wall=${r.wallSec}s${r.piError ? " PIERR=" + r.piError : ""}`);
          mkdirSync(join(ROOT, "bench", "results"), { recursive: true });
          writeFileSync(join(ROOT, "bench", "results", "partial.json"), JSON.stringify(results, null, 2));
        }
      }
    }
  } finally {
    if (trustBak === null) rmSync(TRUST_PATH, { force: true });
    else writeFileSync(TRUST_PATH, trustBak);
    if (fusionBak === null) rmSync(FUSION_PATH, { force: true });
    else writeFileSync(FUSION_PATH, fusionBak);
    console.log("\n(restored trust.json + fusion.json)");
  }

  mkdirSync(join(ROOT, "bench", "results"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(ROOT, "bench", "results", `results-${stamp}.json`), JSON.stringify(results, null, 2));

  console.log("\n| task | mode | pass | total | lead | sidekick | lead max input | deleg | wall |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    console.log(`| ${r.task} | ${r.mode} | ${r.pass ? "✅" : "❌"} | ${fmtUSD(r.total)} | ${fmtUSD(r.leadCost)} | ${fmtUSD(r.sidekickCost)} | ${r.leadMaxInput} | ${r.delegations} | ${r.wallSec}s |`);
  }
}

main().catch((err) => {
  console.error("BENCH FAILED:", err.message ?? err);
  process.exit(1);
});
