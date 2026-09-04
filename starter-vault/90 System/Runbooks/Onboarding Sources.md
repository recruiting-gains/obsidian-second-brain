---
date: 2026-09-04
type: runbook
tags:
  - onboarding
  - sources
ai-first: true
classification: private-local
---

# Onboarding Sources

## For future agent

Use the smallest explicit boundary that satisfies the source goal. New adapters begin disabled and
must prove idempotency, provenance, containment, and safe failure before scheduled use.

## Common setup

Run commands from the public foundation repository, not from inside raw archives:

```text
python3 -m scripts.local_brain doctor --vault vault
python3 -m scripts.local_brain sync --vault vault --source <name> --dry-run
python3 -m scripts.local_brain sync --vault vault --source <name>
```

Review the local vault's Git diff and `90 System/Ledger/events.jsonl` after the first live run.

## GitHub

The adapter uses the already authenticated GitHub CLI. It reads repository metadata from the one
account in `.brain/config.json`, including private repositories only when `include_private` is true.
It does not clone repositories, read source files, create issues, modify settings, or push.

## ChatGPT

1. Request a ChatGPT data export through the account's privacy/data controls.
2. Review and extract `conversations.json` locally.
3. Place it in `00 Inbox/ChatGPT/`.
4. Change only `sources.chatgpt.enabled` to `true` in `.brain/config.json`.
5. Dry-run, then sync. The adapter preserves raw conversation JSON and renders the active branch.

There is no assumed private ChatGPT API or browser scraping. A new export creates new immutable
versions; unchanged conversations deduplicate by content hash.

## Daily AI-news automation

Configure the existing approved automation to write one artifact into `00 Inbox/AI News/`. A safe
handoff includes canonical URLs, publisher, publication date, retrieval date, and concise original
summaries. The ingestion adapter never publishes, messages, or follows links on its own.

## Prometheus

Set the exact repository path and enable the source only after confirming it. The adapter calls
read-only Git commands and fingerprints a small allowlist of root documents. It does not modify,
stage, commit, copy, execute, install, or send project files.

## Images and usage history

Copy only deliberately selected files into the corresponding inbox. Unsupported and oversized
files are reported and left alone. Image understanding is a later review action, not a background
scan.

## Adapter acceptance checklist

- [ ] Exact read boundary documented
- [ ] Write destinations contained inside the vault
- [ ] Raw bytes archived before derivation
- [ ] Stable item identity and SHA-256 deduplication
- [ ] Source time and observation time preserved
- [ ] Dry-run produces no writes
- [ ] Retry produces no duplicate notes
- [ ] User-owned text survives refresh byte-for-byte
- [ ] Malformed input fails without partial promotion
- [ ] Secrets absent from config, logs, raw notes, and errors
- [ ] Retention and deletion path documented
- [ ] Cloud transmission disabled or explicitly approved
