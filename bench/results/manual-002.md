# Bench run manual-002 (2026-09-13) — bigger tasks + forced arm

4 modes (cheap / frontier / fusion-suggest / forced), n=1.

| task | mode | pass | total | lead | sidekick | lead max input | lead turns | deleg | side turns |
|---|---|---|---|---|---|---|---|---|---|
| rename-api | cheap | ❌ | $0.00049* | $0.00049 | $0 | 2930 | 2 | 0 | 0 |
| rename-api | frontier | ✅ | $0.00654 | $0.00654 | $0 | 2976 | 5 | 0 | 0 |
| rename-api | fusion | ✅ | $0.016 | $0.012 | $0.00399 | 4040 | 9 | 1 | 2 |
| rename-api | forced | ✅ | $0.013 | $0.00882 | $0.00408 | 4274 | 6 | 1 | 1 |
| paginate-bug | cheap | ✅ | $0.00113 | $0.00113 | $0 | 3022 | 5 | 0 | 0 |
| paginate-bug | frontier | ✅ | $0.00400 | $0.00400 | $0 | 3010 | 5 | 0 | 0 |
| paginate-bug | fusion | ✅ | $0.00998 | $0.00874 | $0.00123 | 4068 | 8 | 1 | 1 |
| paginate-bug | forced | ✅ | $0.00930 | $0.00823 | $0.00107 | 4308 | 7 | 1 | 1 |

\* cheap/rename: timed out at 230s with 0 edits (first attempt 401 auth blip, retry stalled after 8 ls/read calls). Partial cost only.

Findings:
1. Quality separation appeared: cheap FAILED the 4-file rename (timeout, 0 edits)
   but PASSED paginate. Cheap is inconsistent on multi-file work.
2. fusion-suggest and forced both delegated exactly once on both tasks.
   Forced mechanism works: no delegation hint in prompt, still delegated.
3. fusion total ~= 2-2.5x frontier. Driver is the PRO LEAD, not the sidekick:
   sidekick cost is $0.001-0.004 while the lead burns 6-9 turns ($0.008-0.012)
   reading/reviewing/chatting. The lead does not stay minimal.
4. Lead max input is HIGHER in fusion arms (4040-4308 vs ~3000). At this scale
   the overhead (guidelines + tool defs + result echo) exceeds the savings.
5. rename/fusion used a followup (2 sidekick turns) — persistence paying off
   inside a single run.
6. Thesis check: the Fusion win needs (a) a disciplined lead that truly takes
   minimal actions, and (b) tasks big enough that sidekick-absorbed exploration
   outweighs the fixed overhead. Next candidates: large-repo recon task, and/or
   a stricter lead prompt (no direct reads after delegation).
