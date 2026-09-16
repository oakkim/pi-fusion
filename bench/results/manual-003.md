# Bench run manual-003 (2026-09-13) — lead discipline: enforcement on

Question: does mechanically blocking lead bash/edit/write (opencode-fusion style)
reduce lead cost? Config: leadMutations=delegate. n=1.

| task | arm | pass | total | lead | sidekick | lead turns | deleg | blocked |
|---|---|---|---|---|---|---|---|---|
| rename-api | suggest+enforce | ✅ | $0.01911 | $0.01309 | $0.00602 | 10 | 2 | 16 |
| paginate-bug | suggest+enforce | ✅ | $0.01227 | $0.00859 | $0.00368 | 5 | 1 | 8 |
| rename-api | forced+enforce | ✅ | $0.01677 | $0.01003 | $0.00674 | 5 | 2 | 5 |

Baselines (manual-002): rename suggest $0.016 / forced $0.013; paginate suggest $0.00998 / forced $0.00930.

Findings:
1. Enforcement does NOT cut cost at this scale — it converts exploration into
   block-retry loops. suggest+enforce was the MOST expensive arm on rename
   ($0.019, 10 lead turns fighting the block).
2. Prior explanation helps: forced+enforce cut blocked events 16 -> 5 and turns
   10 -> 5 vs suggest+enforce. The lead flails less when told upfront.
3. Enforcement's value is RELIABILITY, not cost: delegation structurally
   guaranteed (suggest arm skipped delegation entirely on add-export in run 001).
   Where auditability ("lead never touches code") matters, the premium buys it.
4. Best cost so far remains forced alone (no mechanical block). Recommendation:
   default leadMutations=allow; enforce only where the guarantee matters.
