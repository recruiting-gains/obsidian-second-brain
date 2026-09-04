---
date: 2026-09-04
type: policy
tags:
  - retention
  - privacy
ai-first: true
classification: private-local
---

# Retention Policy

## For future agent

Retention is explicit and source-specific. Raw records are immutable while retained; deletion is a
reviewed lifecycle action, never a side effect of synchronization.

| Class | Default | Review cadence | Deletion rule |
|---|---:|---:|---|
| GitHub metadata | Keep current + changed versions | Quarterly | Manual tombstone after project/account removal review |
| ChatGPT raw export | Keep until Cruz reviews sensitivity | 90 days after import | Manual deletion of raw + derived note + ledger tombstone |
| AI news | Keep cited items; review uncited items | 90 days | Derived-only cleanup allowed after citation check |
| Image drops | Review | 30 days | Delete only after verifying no derived note depends on it |
| AI usage/history | Keep aggregate evidence | Annually | Remove provider-identifying details only with an audit note |
| Prometheus fingerprints | Keep recent changes | Quarterly | Supersede; do not touch source repository |
| Private zone | Keep while useful | Monthly | Cruz decides; never automate |

## Deletion protocol

1. Search the ledger and backlinks for dependents.
2. Record scope, reason, requestor, timestamp, and hashes in a tombstone note.
3. Remove the selected local material only after Cruz confirms the exact scope.
4. Commit the deletion locally so it remains reversible until Git history is intentionally pruned.
5. If a backup exists, record whether and when it will expire. Never claim deletion from backups
   that were not actually inspected.
