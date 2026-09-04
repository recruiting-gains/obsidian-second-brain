---
date: 2026-09-04
type: system
tags:
  - ledger
  - provenance
ai-first: true
classification: restricted
---

# Sync Ledger

## For future agent

`sync-state.json` is the atomic current cursor. `events.jsonl` is the append-only audit trail. Both
may contain private source identifiers and should remain local. Never hand-edit state during a run;
restore a prior local Git commit or use the recovery runbook.
