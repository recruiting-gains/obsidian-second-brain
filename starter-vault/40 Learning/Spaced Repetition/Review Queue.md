---
date: 2026-09-04
type: review-queue
tags:
  - learning
  - spaced-repetition
ai-first: true
classification: private-local
interval-sequence: [1, 3, 7, 14, 30, 60, 90]
---

# Spaced-Repetition Queue

## For future agent

Create cards primarily from mistakes, failed tests, incorrect predictions, decisions, incidents,
security findings, customer objections, and concepts Cruz used but could not explain. Adjust intervals
from actual recall; the listed sequence is a starting heuristic.

## Seed cards

### Idempotency

- Prompt: What observable property makes an ingestion operation idempotent?
- Answer: Repeating the same logical input produces the same durable state and no duplicate effects.
- Evidence required: demonstrate a second run with zero duplicate raw records or derived notes.
- Next review: after first implementation attempt.

### Provenance

- Prompt: What must accompany a synthesized claim so another agent can audit it?
- Answer: An immutable source pointer, content hash, source/observation time, and uncertainty or conflict
  context.
- Next review: after first synthesis note.

### Authorization

- Prompt: Why does access to content not imply permission to publish or modify an external system?
- Answer: Read scope and side-effect authority are separate capabilities and must be granted explicitly.
- Next review: before any external integration.
