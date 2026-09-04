# Vault Operating Manual

This file exists for compatibility with the upstream obsidian-second-brain skills. The
authoritative operating rules are in `AGENTS.md`; read both before writing.

## Vault Identity

- Owner: {{OWNER}}
- Mode: personal, local-first
- Purpose: durable AI learning, work, projects, decisions, and evidence
- Default classification: private-local
- Timezone: America/Chicago

## Folder Map

| Note type | Folder |
|---|---|
| Deliberate intake | `00 Inbox/` |
| Sensitive/private note | `10 Private/` |
| Immutable raw source | `20 Sources/Raw/` |
| Source manifest | `20 Sources/Manifests/` |
| Concept/synthesis | `30 Knowledge/` |
| Learning/competency/evidence | `40 Learning/` |
| Project/work note | `50 Work/` |
| Daily note | `60 Daily/` |
| Review | `70 Reviews/` |
| Dashboard | `80 Dashboards/` |
| Policy/runbook/ledger | `90 System/` |
| Template | `Templates/` |

## Write Ownership

- Raw archives are append-only and immutable.
- Generated sections may be refreshed only between generated sentinels.
- User sections and unmarked prose are never overwritten.
- Sensitive ingestion waits for an explicit source configuration or deliberate inbox drop.
- Publishing, messaging, deleting, and modifying external projects always require explicit
  authorization.
