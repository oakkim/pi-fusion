# Bench run manual-001 (2026-09-13)

2 tasks x 3 modes x 1 rep. Lead pro / executor flash. n=1, toy tasks.

| task | mode | pass | total | lead | sidekick | lead max input | lead turns | side turns |
|---|---|---|---|---|---|---|---|---|
| fix-offbyone | cheap | ✅ | $0.00101 | $0.00101 | $0 | 2932 | 5 | 0 |
| fix-offbyone | frontier | ✅ | $0.00407 | $0.00407 | $0 | 2920 | 5 | 0 |
| fix-offbyone | fusion | ✅ | $0.00678 | $0.00582 | $0.00096 | 3978 | 5 | 1 |
| add-export | cheap | ✅ | $0.00064 | $0.00064 | $0 | 2159 | 4 | 0 |
| add-export | frontier | ✅ | $0.00348 | $0.00348 | $0 | 2915 | 5 | 0 |
| add-export | fusion | ✅ | $0.011 | $0.011 | $0 | 3888 | 8 | 0 |

Findings:
1. All 6 passed. Tasks too easy to separate quality; only cost differs.
2. fusion/add-export never delegated (36 bash + 6 edit by lead, 0 fusion_spawn).
   The delegation sentence in the prompt is a suggestion the lead can ignore on
   trivial tasks. Forced mode would be needed for a fair fusion arm.
3. fusion/fix-offbyone delegated once (flash $0.001) but total was HIGHEST:
   pro-lead review chatter (5 turns) dominates on tiny tasks. Fusion overhead
   (guidelines + tool defs + result echo) also raised lead max input vs frontier.
4. Takeaway: the fusion win should appear on LARGER tasks (multi-file, long
   exploration) where the sidekick absorbs context that would otherwise bloat
   the lead. Next: bigger task set + forced-mode arm.
