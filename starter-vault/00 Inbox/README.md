---
date: 2026-09-04
type: runbook
tags:
  - inbox
  - privacy
ai-first: true
classification: private-local
---

# Deliberate Inbox

## For future agent

This is the sole automatic intake boundary. A file appearing elsewhere on the computer is not
authorization to ingest it.

## Inboxes

- `AI News/`: Markdown, text, JSON, or HTML emitted by the approved daily AI-news workflow.
- `AI Usage/`: user-provided exports or logs of AI learning and tool usage.
- `ChatGPT/`: the `conversations.json` file from a user-requested ChatGPT data export.
- `Images/`: screenshots or photos deliberately copied here for review.
- `Manual Capture/`: notes Cruz intentionally wants triaged.

Ingestion copies bytes into the immutable archive, records a hash, and leaves the original inbox
file in place. Removing an inbox file later does not remove the archived evidence.
