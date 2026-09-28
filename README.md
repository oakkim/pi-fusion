# pi-fusion

Persistent background workers and an optional Lead advisor for [pi](https://github.com/earendil-works/pi).

Your **Lead** plans the work and reviews the result. **Workers** (also called sidekicks) handle delegated tasks with their own conversation history. An optional **Advisor** gives the Lead a second opinion on difficult decisions.

Workers keep their context across follow-ups, so corrections and related work go back to the same worker. The Lead and user can keep talking while work runs in the background.

## Install and quick start

Requires pi and Node.js 22.19.0 or later. Models use the providers already configured in pi.

```bash
pi install git:github.com/oakkim/pi-fusion
```

In an existing pi session, run `/reload`. Then choose a worker model:

```text
/fusion model
```

The picker searches provider names, model IDs, and display names. It fits the terminal height and supports arrow keys, Page Up/Down, Enter, and Esc. `/advisor model` uses the same picker. RPC sessions use pi's standard selection dialog.

Fusion starts in `available` mode: the Lead decides when to delegate. Ask for work normally, or use `/fusion on` to request the plan, delegate, and review workflow for each prompt. To enable the optional advisor, choose a model with `/advisor model`.

Worker writes require a trusted project and confirmation by default. Use `/fusion consent allow` to allow them for the current session.

## Commands

pi-fusion adds just `/fusion` and `/advisor` to the slash-command menu. Enter either command without arguments to see its current status. Neither changes your settings.

Type a space after the command to see its subcommands. Start typing to filter suggestions, then use the arrow keys and Tab or Enter to select one. Type the next argument to get matching options, model names, or worker IDs. Model suggestions search providers, IDs, and display names; thinking suggestions match the selected model's capabilities.

```text
/fusion model
/fusion thinking high
/fusion fast on
/advisor model
/advisor thinking high
/advisor fast on
/advisor status
```

`/fusion model` and `/advisor model` open the searchable picker when no model is supplied. Add a `provider/model` to select it directly. `/fusion help` and `/advisor help` show the available commands.

| Fusion command | Purpose |
| --- | --- |
| `/fusion` or `/fusion status` | Show the current mode, executor, recorded costs, workers, and inquiry threads. |
| `/fusion on`, `/fusion available`, `/fusion off` | Request delegation for each prompt, let the Lead decide, or block `fusion_*` tools. |
| `/fusion model [provider/model]` | Select the executor. `auto` uses automatic selection; `clear` restores the config default. |
| `/fusion thinking [level]` | Select executor reasoning effort. `clear` restores the config default. |
| `/fusion fast [action]` | Select OpenAI priority processing. `on` and `off` save a global preference; `default` removes it; `status` shows the setting. |
| `/fusion consent [action]` | Select worker write consent. `allow` and `ask` apply to the session; `default` restores config; `status` shows the setting. |
| `/fusion ask <id> <question>` | Ask about a worker using its `wrk_...` ID, or continue an inquiry using its `inq_...` ID. |
| `/fusion monitor [action]` | Open a separate read-only monitor. Accepts `open`, `close`, or `status`. |
| `/fusion pane [target]` | Toggle the optional worker overlay. Accepts `open`, `close`, `toggle`, or a worker ID. |
| `/fusion run <prompt>` | Send one prompt through the delegation workflow while Fusion is enabled. |

| Advisor command | Purpose |
| --- | --- |
| `/advisor` or `/advisor status` | Show the model, thinking, fast mode, and this branch's usage. |
| `/advisor ask [question]` | Ask directly, or omit the question for a general review. |
| `/advisor model [provider/model]` | Select an authenticated advisor model. |
| `/advisor thinking [level]` | Select advisor reasoning effort. `clear` forgets the saved choice and restores config or follows the Lead. |
| `/advisor fast [action]` | Select advisor priority processing. `on` and `off` save a global preference; `default` removes it; `status` shows the setting. |
| `/advisor off` | Disable the advisor and remember that choice. |
| `/advisor clear` | Forget the saved advisor model and restore the project config default. |

Fusion mode, executor, thinking, and consent choices are stored in the session journal. Advisor model and thinking selections are also saved globally, so new sessions start with your last choices; existing branches retain their own selections. The two fast commands save separate global preferences for current and future sessions.

The previous `/fusion-*` and `/advisor-model` commands are replaced by these subcommands. Saved preferences and sessions continue to work. Bare `/fusion` now shows status instead of toggling modes; use `/fusion run <prompt>` for the previous one-off prompt form.

## Working with workers

The Lead uses these tools to delegate and review work. They are model tools, not slash commands.

Workers receive a task brief and a short language cue by default (`context_mode: "none"`). Set `context_mode: "recent"` on `fusion_spawn` to attach bounded recent user and assistant text; `context_turns` defaults to 4 and accepts 1 to 10. Workers do not automatically receive the full Lead conversation.

| Tool | Behavior |
| --- | --- |
| `fusion_spawn` | Start a persistent worker and return `worker_id` and `turn_id` immediately. Supply `task`, an optional `label`, and an optional `worktree` name. |
| `fusion_followup` | Send a `message` to the same `worker_id`, preserving its history. Busy workers support `steer`, `queue`, and `interrupt`. |
| `fusion_status` | Inspect a worker (`wrk_`), turn (`trn_`), inquiry (`inq_`), or inquiry turn (`iqt_`) by `id`. |
| `fusion_ask` | Ask a read-only `question` using `worker_id`, or continue the side conversation using `thread_id`. |
| `fusion_interrupt` | Stop a worker's active turn without retiring it or counting a failure. Pending updates and queued follow-ups are cancelled by default. |
| `fusion_close` | Retire a worker and interrupt its active turn. Its worktree is preserved unless `remove: true` is supplied. |
| `fusion_merge` | Commit a worker's worktree changes and merge its branch into the project. The worker remains available for follow-ups. |

Completion returns the visible result to the Lead automatically. If the Lead is busy, delivery waits for the next safe checkpoint; if idle, it starts a Lead turn. The Lead should inspect the actual changes and verification evidence, then send corrections to the same worker.

### Updating a busy worker

Choose `when_busy` on `fusion_followup` according to the intent:

| Value | Use it for | Effect |
| --- | --- | --- |
| `steer` (default) | “Also cover this edge case.” | Add the instruction to the active turn after the current model response or tool batch finishes. |
| `queue` | “After that, benchmark the result.” | Start a separate turn after the current work settles. |
| `interrupt` | “Stop, this is the wrong repository.” | Abort, wait for cleanup, and start the replacement instruction first. Existing side effects are not rolled back. |

Steering is cooperative: a running tool must finish before it can receive the update. A steer that arrives after the final checkpoint becomes a queued turn. Accepted updates survive a provider failure as a queued retry.

### Worktrees

For independent write tasks, give each worker a separate `worktree` name. Checkouts live under `~/.pi/agent/fusion-worktrees/` by default, with branches named `pi-fusion/<name>`. Names must be 1 to 64 letters, digits, underscores, or hyphens and begin with a letter or digit.

Workers sharing a checkout serialize mutating turns. Workers in separate worktrees can write concurrently. A worktree sets the default working directory; it is not a filesystem sandbox.

`fusion_merge` requires an idle worker, a clean project checkout, and the original project branch. It stages and commits the worktree's changes before attempting the merge. Review those changes first.

**`fusion_close` with `remove: true` forcibly deletes the checkout and branch, including uncommitted or unmerged work.** Omit `remove` to preserve them.

### History and recovery

Completed model responses, tool results, and received usage are checkpointed, including progress from failed or interrupted turns. Unknown tool outcomes are marked so the worker can inspect side effects before retrying. Worker and inquiry snapshots are restored from the session journal when resuming.

Before each worker request, token limits or `maxHistoryMessages` can trigger semantic summarization. It preserves the first handoff, latest instruction, and recent complete tool batches. Summary usage counts toward worker cost. If summarization fails or the context still does not fit, the turn stops and retains the original history.

Session switches, reloads, and shutdown interrupt active workers and inquiries and cancel pending updates. Workers run inside pi; there is no separate worker daemon.

## Lead advisor and worker inquiries

These serve different purposes:

| | Lead advisor | Worker inquiry |
| --- | --- | --- |
| Entry point | `ask_advisor({})`, `ask_advisor({ question })`, or `/advisor ask` after selecting `/advisor model` | `fusion_ask` or `/fusion ask` |
| Context | Current Lead conversation | Snapshot of one worker's history and visible activity |
| Model | Explicitly selected advisor model | Worker's executor, with executor fallback if unavailable |
| Conversation | One stateless opinion per call | Persistent side conversation using `thread_id` |
| Tools | None | None |

The Lead can call `ask_advisor({})` for a general review of the current task, approach, risks, and verification. For a specific decision, supply a short question, for example `ask_advisor({ "question": "Is this migration safe to apply before updating the API?" })`. The call shows `General review` or the supplied question, streams visible advice, and shows the recorded token usage and cost when finished. Missing usage is shown as unavailable. Expand the call to read a longer question.

Consider advice before a consequential design choice, after two similar failed attempts or stalled progress, and before declaring a complex change complete. Routine work does not require it. This is guidance for the Lead, not an automatic execution gate. The Lead checks the advice against evidence and makes the final decision. Workers cannot call the advisor, and `/fusion off` does not disable it.

Use `/advisor ask` for a direct general review, or `/advisor ask <question>` to focus it. In the interactive UI, advice streams in a cancellable dialog; Escape cancels the request. The result is saved in the conversation for the Lead's next turn without starting an extra Lead request.

Advisor requests include the Lead's effective instructions, active compaction summary, current conversation, and full textual tool evidence. Private thinking and signatures are excluded, and images are marked unavailable. Oversized context is rejected without truncation: compact the Lead conversation or choose a larger model. An unavailable advisor never falls back to a different model.

Advisor reasoning follows the Lead unless set with `/advisor thinking` or `advisorThinkingLevel`, and is clamped to the selected model's supported levels. `/advisor fast` controls priority processing independently of Fusion workers and the Lead. Both settings apply to the next advisor call.

Worker inquiries run alongside the worker without changing its instructions. The worker never sees or remembers that side conversation. To act on an inquiry result, send a separate `fusion_followup`.

## Status and monitoring

The idle status line keeps the executor model short and shows advisor state without another model name:

```text
Fusion available • gpt-5.6-luna (max) • fast • Advisor on
Fusion off • Advising…
```

`fast` in the status line refers to the executor and appears only when enabled for a supported model. Active workers show their current tool or visible response, elapsed time, and pending updates. Private thinking is never shown. `/advisor status` reports advisor settings, attempts, tokens, and cost for the current branch.

`/fusion status` shows the current branch's recorded cost total with separate Workers, Inquiries, and Advisor amounts. Worker costs include received usage checkpoints, including failed or interrupted turns, without counting the final cost entry again. Lead costs are not included. These are usage costs recorded by the model SDK, not an account invoice; requests with no recorded usage do not contribute an amount.

Advisor tool calls also return usage to Pi's built-in accounting. On hosts with native usage recording, verified with Pi 0.87, background worker checkpoints and manual advisor calls contribute to Pi's session totals and default footer as well. Repeated checkpoints are not charged twice. Older hosts retain Fusion's own recorded totals. Pi's totals cover the whole session, including the Lead; `/fusion status` covers the current branch's Fusion activity, so the two amounts can differ.

For more detail, open `/fusion monitor`. On macOS it prefers Ghostty and falls back to Terminal.app when Ghostty is not installed. The monitor starts as a command rather than opening its script and snapshot as documents, avoiding duplicate file-open prompts in Ghostty 1.3.1. The separate window shows workers, visible conversation and tool output, steering and queue state, and usage.

| Monitor key | Action |
| --- | --- |
| `j` / `k`, Tab / Shift-Tab | Select a worker |
| Up / Down, Page Up / Page Down | Scroll output |
| `f` | Follow live activity |
| `r` | Refresh |
| `q` | Close the window |

The monitor reads a local snapshot accessible only to the current user. It has no control socket or network listener and exits when the publisher stops. `/fusion monitor close` stops publication and closes connected monitors.

`/fusion pane` provides a smaller, optional overlay inside pi. It keeps the editor usable, can cover part of the transcript, and hides below 110 terminal columns. Closing it does not stop the worker.

## Configuration

Use `.pi/fusion.json` for a trusted project or `~/.pi/agent/fusion.json` for global defaults. If `PI_CODING_AGENT_DIR` is set, the global file is under that directory.

The first valid config file wins: trusted project first, global second. **The files are not merged.** An empty project config therefore uses built-in defaults rather than inheriting the global file's keys, except for saved Advisor choices and the global fast preferences described under [Priority processing](#priority-processing). Session overrides take precedence.

Advisor commands automatically save `advisorModel`, `advisorThinkingLevel`, and `advisorFastMode` in the global file. Saved values take precedence over project defaults. `off` is remembered too. `/advisor clear`, `/advisor thinking clear`, and `/advisor fast default` remove the corresponding saved choice; model and thinking resets also clear the current branch's override.

For example, replace these model IDs with ones available in your pi setup:

```json
{
  "executor": "provider/worker-model",
  "advisorModel": "provider/advisor-model",
  "thinkingLevel": "off",
  "executorTools": "all"
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `executor` | Automatic | First authenticated text model other than the Lead, falling back to the Lead if necessary. An unavailable configured executor also falls back to automatic selection. |
| `advisorModel` | Off | Explicit `provider/model`; `false` disables it. |
| `advisorThinkingLevel` | Follow Lead | Advisor reasoning effort; clamped to the advisor model's supported levels. |
| `advisorFastMode` | `false` | Request priority processing for a supported advisor model. |
| `executorTools` | `"all"` | `"none"`, `"readonly"`, `"all"`, or a list of tool names. |
| `executorToolsConsent` | `false` | Skip worker write confirmations when `true`; the project must still be trusted. |
| `leadMutations` | `"allow"` | `"delegate"` blocks the Lead's `bash`, `edit`, and `write` tools, even with Fusion off. Reads remain available. |
| `thinkingLevel` | `"off"` | Executor reasoning effort; clamped to each model's supported levels. |
| `fastMode` | `false` | Request priority processing for supported OpenAI models. |
| `fallbackExecutors` | `[]` | Ordered executor models used after failures. |
| `maxEscalations` | `2` | Maximum fallback steps, from 0 to 5. |
| `maxToolCalls` | `1024` | Tool-call ceiling per turn, from 1 to 1024. Repeated identical calls or consecutive tool errors also stop the loop after three attempts. |
| `maxExecutorOutputTokens` | `4096` | Output-token limit per worker model request. |
| `temperature` | `0.2` | Sampling temperature, from 0 to 2. |
| `maxHistoryMessages` | `40` | Message-count trigger for compaction, from 4 to 200. Token limits can trigger it earlier. |

Available worker tools are `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`. The `readonly` set contains the first four. A toolset containing `bash`, `edit`, or `write` requires trust and consent when a spawn or follow-up is requested. `/fusion consent allow` skips the confirmation, but cannot bypass trust.

### Model fallback

Each consecutive worker failure selects the next available model in `[executor, ...fallbackExecutors]`, up to `maxEscalations`. Unavailable and duplicate fallback entries are skipped. Success resets selection to the base executor; an explicit interruption does not count as a failure. The chosen fallback applies on the next turn, not as an immediate replay of the failed request.

### Priority processing

`/fusion fast on` and `off` save `fastMode` globally and clear the current session's older fast override. The global boolean takes precedence over a project's `fastMode`. `default` removes that global preference and returns to the selected config's value or the built-in `false` default. Older restored sessions can still carry their own fast override.

`/advisor fast` uses the same actions with its own `advisorFastMode` global preference. It affects subsequent advisor calls without changing worker or Lead settings. `/advisor fast status` shows whether it applies to the selected advisor.

Priority processing applies to direct OpenAI Responses and OpenAI Codex models. Unsupported providers use their normal tier. Priority pricing and availability depend on the provider and account.

## Development

```bash
git clone https://github.com/oakkim/pi-fusion.git
cd pi-fusion
npm install
npm run check
npm test
```

Load the checkout for one session with `pi -e ./src/index.ts`, or install it locally with `pi install .`. pi loads the TypeScript source directly; no build step is required.

The optional [cost harness](bench/run.mjs) compares the same tasks across standalone models and Fusion. It calls configured providers and temporarily changes pi's trust and Fusion config, restoring both when finished. Review the model IDs in the runner before using it.

```bash
node bench/run.mjs --tasks fix-offbyone,add-export --modes cheap,frontier,fusion --reps 1
```

Historical benchmark notes are in [bench/results](bench/results/).

## Credits

Inspired by [Devin Fusion](https://cognition.ai/blog/devin-fusion), with ideas adapted from:

- [pi-devin-fusion](https://github.com/khanhdeptraivaicachuong/pi-devin-fusion): pi extension patterns, consent, and tool limits.
- [opencode-agent](https://github.com/rink3y/opencode-agent): persistent worker lifecycle and worktrees.
- [Kylejeong2/fusion](https://github.com/Kylejeong2/fusion): task handoffs and model routing.
- [llm-fusion](https://github.com/przemekzur/llm-fusion): verification, escalation, and cost comparisons.

[MIT license](LICENSE).
