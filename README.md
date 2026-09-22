# pi-fusion

Persistent Lead/Sidekick (Devin Fusion pattern) for [pi](https://github.com/earendil-works/pi).

Two models work together: your **lead** plans and reviews, and a cheaper persistent
**sidekick** implements — each with its own session, like
[Cognition's Devin Fusion](https://cognition.ai/blog/devin-fusion).

Lineage (ideas ported, not forked):
- [pi-devin-fusion](https://github.com/khanhdeptraivaicachuong/pi-devin-fusion): pi extension idioms (consent gate, tool allowlist, bounded tool loop)
- [opencode-agent](https://github.com/rink3y/opencode-agent): `wrk_`/`trn_` persistent worker protocol (spawn / followup / status / close / merge)
- [Kylejeong2/fusion](https://github.com/Kylejeong2/fusion): reference implementation of the Fusion pattern (routing at compaction boundary, handoff framing)
- [llm-fusion](https://github.com/przemekzur/llm-fusion): verify-then-escalate + cheap/frontier/fusion cost comparison

## What v0 does

```
Lead (your model, planner/reviewer)
  |-- fusion_spawn "precise spec"  -> wrk_abc, trn_1 immediately (runs in background)
  |-- fusion_followup wrk_abc "..." -> steer active turn (default) or start trn_2, SAME session history
  |-- fusion_spawn worktree=parser ... -> wrk_def (isolated checkout pi-fusion/parser)
  |-- fusion_followup wrk_def ...   -> same worktree
  |-- fusion_merge wrk_def          -> commit + merge branch into project
  |-- fusion_ask wrk_abc "what are you doing?" -> inq_1, iqt_1 (read-only side chat)
  |-- fusion_ask inq_1 "what remains?"         -> same inquiry thread
  |-- fusion_status wrk_abc | trn_1 | inq_1 | iqt_1
  |-- fusion_close wrk_abc [remove]  -> retire; remove=true deletes checkout+branch
  |-- /fusion-fast on|off            -> OpenAI priority tier for sidekick turns
  |-- /fusion-monitor open           -> separate read-only worker TUI
  +-- /fusion-status (list workers)
```

- Sidekick keeps **independent persistent history** per worker (`WorkerRuntime`). Its final visible result is steered into the Lead at the next safe checkpoint after completion; private thinking is never forwarded.
- Spawn and follow-up return IDs immediately, so the Lead and user can keep talking while the worker runs. Idle/queued follow-ups append to the same history with bumped `generation` (`<fusion_handoff generation="N">`); a busy `steer` stays inside the active generation.
- Independent compaction per worker (`maxHistoryMessages`, default 40; keeps first + last N-1) with routing reconsidered at that boundary.
- Mutating tools (bash/edit/write) require trusted project + consent, and mutating runs are serialized — same fail-closed posture as pi-devin-fusion.
- Session journal: worker and inquiry snapshots are appended as `fusion-worker` / `fusion-inquiry` custom entries and restored on `session_start` (best-effort durable across `/resume`).

## Worktrees (v0.2)

Write work goes to an isolated checkout so parallel workers never share a directory:

```
spawn worktree=parser -> ~/.pi/agent/fusion-worktrees/<proj>/parser (branch pi-fusion/parser)
merge wrk_...          -> add -A + commit in worktree, refuse dirty project checkout,
                           merge branch into the project branch. Worker stays alive.
close wrk_... remove=true -> delete checkout + branch.
```

Rules enforced: name must match `[a-zA-Z0-9-_]`; merge only idle workers; merge requires
the project to be on the same branch as at spawn. The worktree is the default directory for
relative tool paths and shell commands, not a filesystem sandbox: absolute paths and shell
commands that leave the directory can still access other locations.

## Escalation (v0.3)

```json
{
  "executor": "opencode-go/deepseek-v4-flash",
  "fallbackExecutors": ["opencode-go/deepseek-v4-pro"],
  "maxEscalations": 1
}
```

Effective ladder = `[executor, ...fallbacks]` (unavailable entries skipped with
a warning, duplicates collapsed, capped at `1 + maxEscalations`). Rung is
`min(consecutive_failures, ladder_top)`: one rung up per provider failure,
auto-de-escalation on the next success. Evaluated every turn on purpose — a
failing cheap model burns more than a cache miss, so waiting for a compaction
boundary (fusion-ref's rule) is the wrong trade here.

Escalation is visible in the result header (`(escalated rung N)`), in
`details` (`rung`, `escalated`, `ladder`), and in `fusion_status`
(`consecutive_failures`). `fusion_interrupt` stops a runaway turn without
recording a failure, so interrupting never causes false escalation.

## Modes (v0.4)

```
/fusion              -> toggle available <-> forced
/fusion on           -> forced: every prompt goes through plan/delegate/review
/fusion available    -> lead decides per task (default)
/fusion off          -> all fusion_* tools mechanically blocked
/fusion <prompt>     -> one-off forced send without changing mode
```

Forced mode hooks `input`: normal prompts are rewritten with the planner
prefix before the lead sees them (commands and already-forced prompts pass
through). Mode persists in the session journal (`fusion-mode` entry) and shows
in the footer (`Fusion forced • executor ...`).

## Executor picker (v0.5)

```
/fusion-model                  -> interactive picker (TUI) or current display (print)
/fusion-model <provider/id>    -> set session override (beats fusion.json)
/fusion-model auto             -> ignore the configured executor for this session
/fusion-model clear            -> drop the override, back to fusion.json
```

Resolution order: `/fusion-model` override > `fusion.json` > auto (first
non-lead authed text model). Override lives in the session journal
(`fusion-executor` entry); `/fusion-status` shows the effective executor.

## Executor thinking (v0.8)

```
/fusion-thinking                  -> interactive picker (TUI) or current display (print)
/fusion-thinking high             -> set a session override for the sidekick
/fusion-thinking off              -> disable sidekick reasoning
/fusion-thinking clear            -> return to fusion.json (default: off)
```

The picker only offers levels supported by the effective executor. The requested
level is clamped again for each escalation rung, so switching to a fallback model
cannot send an unsupported reasoning effort. Calls normally use Pi's
provider-neutral `streamSimple` path, which maps the level to each provider's
native thinking API; OpenAI fast mode uses the full stream with the equivalent
reasoning effort. The override is journaled as a `fusion-thinking` entry and applies to existing
persistent workers on their next turn.

## OpenAI fast mode (v0.15; persistent command in v0.17)

```
/fusion-fast                 -> interactive picker (TUI) or current status
/fusion-fast on              -> persist priority processing for current and future sessions
/fusion-fast off             -> persist the provider's default tier for all sessions
/fusion-fast default         -> remove the persisted preference and use config/built-in default
/fusion-fast status          -> show effective mode, source, and model support
```

Fast mode sends `service_tier: "priority"` through the full provider stream for
direct `openai` Responses and `openai-codex` models, while preserving thinking,
tool streaming, and provider-side cost accounting. It is independent from the
Lead's setting and is re-evaluated for the actual escalation rung: unsupported
fallback providers simply use their normal service tier. A toggle applies when
the next worker or inquiry turn starts; it does not rewrite an already in-flight
request. `on` and `off` atomically update the global `fusion.json` preference
while preserving its other keys, then clear any older session-only override
in the current session. The next Pi session therefore inherits the selected
value automatically.
`default` removes only the global `fastMode` key, allowing a trusted project
config or the built-in `off` default to apply. `"fastMode"` can still be managed
manually in `fusion.json`.

Priority processing is faster but consumes the higher OpenAI priority tier
(pi-ai currently prices it at 2x, or 2.5x for GPT-5.5). Availability and plan
usage still depend on the authenticated OpenAI account.

## Executor tool consent

```
/fusion-consent                 -> choose allow, ask, or config default
/fusion-consent allow           -> skip spawn/followup mutation prompts for this session
/fusion-consent ask             -> require a prompt for every mutating executor turn
/fusion-consent default         -> return to fusion.json (default: ask)
/fusion-consent status          -> show the effective mode and source
```

Session consent is journaled as `fusion-consent` and affects both new workers
and persistent-worker followups. `allow` is rejected for untrusted projects;
config-file consent is also loaded only from trusted projects.

## Asynchronous turns and busy-worker control (v0.14)

`fusion_spawn` and `fusion_followup` complete their tool call as soon as work is
accepted. The sidekick then runs independently from the Lead turn's abort
signal.

A follow-up sent to a busy worker has three deliberately different modes:

- `when_busy: "steer"` (default): fold a related correction or addition into the **same active turn**. The call returns a `str_...` ID. Pending updates are batched and injected after the current model response or complete tool batch, before the next model call; they become part of persistent worker history and final integrated validation.
- `when_busy: "queue"`: preserve the active turn unchanged and dispatch a **distinct sequential turn** FIFO after it settles. Use this when the next task depends on the completed result rather than refining it.
- `when_busy: "interrupt"`: abort the active turn, wait for background cleanup, then dispatch the new instruction at the front of the queue. Use this only when continuing is invalid, unsafe, or wasteful. Filesystem and command side effects are not rolled back, so the sidekick is told to inspect current state first. Accepted steering updates are carried into the replacement instruction instead of being lost.

Rule of thumb: “also add this test/constraint” is `steer`; “after that,
benchmark the finished result” is `queue`; “stop, this is the wrong repo or a
destructive path” is `interrupt`.

Steering is cooperative, not mid-call cancellation: a long-running tool must
return before the sidekick can see an update. If a response has already crossed
its final steering checkpoint, a requested steer safely falls back to the next
queued turn. If a provider failure ends a turn after updates were accepted,
those updates are promoted to a queued retry.

Queued calls return a `qfu_...` ID instead of failing with `worker is busy`.
The completion handoff identifies the automatically started turn so the Lead
does not resend it. `fusion_status` reports `steering_updates` and queued
entries; the status line shows `steer N`, `updates N`, and `queued N`.
Standalone `fusion_interrupt` cancels pending steering updates and queued
follow-ups by default; close, session switch, reload, and shutdown cancel them
as well.

When the worker finishes, pi-fusion shows a TUI notification and hands a small
`fusion-result` custom message with the visible result back to the Lead
(`deliverAs: "steer", triggerTurn: true`). If the Lead is busy, the result is
inserted at the next safe checkpoint after the current tool batch and before the
next model call; it never cancels a running tool. If idle, it starts a Lead turn
immediately. This preserves the brief -> result -> review/feedback loop without
blocking conversation or encouraging status polling. Session switch, reload,
and shutdown interrupt active background workers and inquiries, then wait
briefly for cleanup.

## Read-only worker inquiries (v0.13)

The Lead can ask what a worker is doing without steering or interrupting it:

```text
fusion_ask { worker_id: "wrk_...", question: "What are you doing and what remains?" }
fusion_ask { thread_id: "inq_...", question: "Why did that command fail?" }
/fusion-ask wrk_... What are you doing?
/fusion-ask inq_... What remains?
```

Each `inq_...` is a separate persistent side-chat thread. Every question rebases
that thread over a point-in-time snapshot of the worker's completed history and
bounded public live telemetry (visible response, tool names/arguments/output,
phase, steering updates, and queued follow-ups). Inquiry calls use the worker's executor model
with no tools, run concurrently with the worker, and return asynchronously as a
`fusion-inquiry-result`. Inquiry results use the same safe-checkpoint `steer`
delivery, so a completed answer does not wait behind the rest of an active Lead
turn. `fusion_status` accepts both `inq_...` and `iqt_...`.

**The main worker never sees or remembers inquiry questions or answers.** The
side chat is observational only and is never merged into worker history. If the
answer should change the work, the Lead must send a separate `fusion_followup`.
Private thinking is stripped from the snapshot and never exposed; questions
about unobservable intent are answered as unknown or clearly labeled inference.
The result also reports when the worker advanced after the captured snapshot.

## Live status line (v0.11)

The default TUI view stays unobstructed. While a worker runs, the Pi status line
shows one compact view of its existing live stream:

- tool call: a compact deterministic view such as `▶ bash · npm test`, `▶ read · src/index.ts:40`, or `✓ edit · src/index.ts · 2 edits`
- tool state: `▶` running, `✓` succeeded, `✗` failed
- visible response: the worker's latest visible words, unchanged
- otherwise: `waiting`, `thinking`, or `starting`
- elapsed time as `42s`, `3m 07s`, or `1h 02m 09s`, plus `steer N`, `updates N`, `queued N`, and `+N` when applicable

Tool arguments are formatted locally by tool type; there is no extra model call
or semantic summary. Visible response text is passed through directly, so the
worker's conversation language
naturally appears in the status line. Each handoff includes a bounded copy of
the latest end-user message only as a language cue, so sidekick prose follows
the current conversation while code, paths, commands, and raw output stay
unchanged. Private thinking text is never exposed. Updates are throttled and
the elapsed timer stops when no workers are active.

## Read-only monitor sidecar (v0.16)

```text
/fusion-monitor              -> publish telemetry and open a separate monitor window
/fusion-monitor open         -> open another monitor window
/fusion-monitor status       -> show publisher state and snapshot path
/fusion-monitor close        -> stop publishing and close connected sidecars
```

On macOS, pi-fusion opens a dedicated Ghostty window when available and falls
back to Terminal.app. The sidecar uses `@earendil-works/pi-tui` in an alternate
screen with a full-width worker list and scrollable detail view:

- `j` / `k` or Tab / Shift-Tab selects a worker
- Up / Down and Page Up / Page Down scroll output
- `f` follows the newest live activity, `r` refreshes, and `q` closes
- visible sidekick responses, tool arguments/output, elapsed time, queue/steer
  counts, persistent public history, and worktree metadata are displayed
- private thinking is removed before publication and terminal control sequences
  from model/tool text are stripped before rendering

The bridge is read-only and local: the extension atomically writes a bounded,
owner-only (`0600`) session snapshot under the OS temporary directory, and the
sidecar only reads it. No control socket or network listener is opened. Updates
are throttled and serialized. A lightweight heartbeat lets the sidecar exit if
the owning Pi process dies or stops publishing; normal session shutdown marks
the snapshot closed immediately. The monitor improves observability; it does
not change worker execution speed.

## Optional worker conversation pane (v0.9)

```
/fusion-pane                 -> toggle the detailed worker pane
/fusion-pane open            -> show the latest/running worker
/fusion-pane close           -> close the pane
/fusion-pane wrk_...         -> show a specific worker
```

The non-capturing right-side overlay is now opt-in because it can obscure the
transcript. When explicitly opened, it shows recent LEAD, SIDEKICK, and TOOL
messages plus live phase, elapsed time, visible answer text, tool arguments,
partial built-in tool output, and tool success/error. Live activity is
transient: it is not added to worker history or the session journal, and is
cleared when a turn finishes, fails, is interrupted, or the session shuts down.
Closing the pane only hides it, so reopening during an active turn restores the
current live view. Explicit pane visibility remains journaled; old auto-open
journal entries restore closed. The pane automatically hides below 110 terminal
columns.

This is an overlay, not a true split: Pi's extension API cannot shrink or
reflow the main transcript area. The overlay stays unfocused so the normal
editor remains usable.

## Lead discipline (v0.7)

Two layers, following what others found (opencode-fusion's systemic Main edit
ban beats prompt-only rules, which our bench showed the lead ignores):

1. Planner prompt: delegate broad exploration and implementation, but require
   the Lead to personally inspect the actual diff and relevant code before
   approval. Sidekick reports are evidence, not a substitute for review.
   Corrections use the same worker: steer related refinements, queue distinct
   sequential work, and interrupt only invalid/unsafe/wasteful work. Repeated
   failure or judgment-heavy work can trigger an explicit Lead takeover.
2. `leadMutations: "allow" | "delegate"` (default allow). `"delegate"`
   mechanically blocks lead bash/edit/write at the tool_call hook — reads and
   fusion_* stay open specifically so mandatory Lead review remains possible.
   Bench result: the block guarantees delegation but the lead burns retry loops
   fighting it (suggest+enforce was the priciest arm); telling it upfront
   (forced+enforce) halves the flailing. So: default allow, enforce only where
   the guarantee matters. See `bench/results/manual-003.md`.

## Cost harness (v0.6, `bench/`)

Same task x 3 modes (`cheap` / `frontier` / `fusion`), comparing cost,
success, and lead context load. Lead cost comes from `--mode json` stdout;
sidekick cost comes from `fusion-cost` journal entries the extension writes
per executor turn (see `bench/results/`).

```bash
node bench/run.mjs --tasks fix-offbyone,add-export --modes cheap,frontier,fusion --reps 1
```

Environment quirk: spawning `pi` from node hangs silently (0 bytes, idle),
while python-subprocess or direct shell works — so the runner goes through
`bench/spawn.py`. The runner also backs up/restores `trust.json` +
`fusion.json` and seeds per-run trust + a mutating bench config.

## What v0 does NOT do (deliberate)

- No daemon/SQLite (opencode-agent has it; pi extension keeps in-memory + session journal).
- No independent cache-warming daemon for sidekick sessions.
- No automatic task-complexity classifier; the Lead decides when to delegate.
- Background workers are asynchronous, but Pi does not run two interactive Lead transcripts at once.

## Install

```bash
pi install git:github.com/oakkim/pi-fusion
# or clone for hacking
# git clone https://github.com/oakkim/pi-fusion
# pi install ./pi-fusion        # from a local checkout
# pi -e ./pi-fusion/src/index.ts # ephemeral, no install
```

## Config (`.pi/fusion.json`, trusted projects only)

```json
{
  "executor": "openai/gpt-4.1-mini",
  "executorTools": "all",
  "maxToolCalls": 1024,
  "maxExecutorOutputTokens": 4096,
  "temperature": 0.2,
  "thinkingLevel": "off",
  "fastMode": false,
  "executorToolsConsent": false,
  "maxHistoryMessages": 40
}
```

`executorTools`: `"none" | "readonly" | "all" | ["read","grep","find","ls","bash","edit","write"]`.

`maxToolCalls` defaults to 1024 as an emergency ceiling rather than a normal
working budget. Repeated identical calls and consecutive tool failures still
stop after three attempts, and the lead can interrupt a running worker.

`thinkingLevel`: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.

`fastMode`: OpenAI/OpenAI Codex Responses models only. `true` requests the
priority service tier; other providers ignore it.

`executorToolsConsent`: set `true` to skip per-turn mutating-tool confirmation
for every session in this trusted project, or use `/fusion-consent allow` for a
session-scoped grant.

## Check

```bash
cd pi-fusion && npm install --omit=dev 2>/dev/null; npx tsc --noEmit
```
