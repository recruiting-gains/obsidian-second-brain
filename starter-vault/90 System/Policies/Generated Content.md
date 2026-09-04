---
date: 2026-09-04
type: policy
tags:
  - generated-content
  - safety
ai-first: true
classification: private-local
---

# Generated Content Policy

## For future agent

Machine-maintained notes have one replaceable region delimited by generated sentinels. Everything
outside that region is preserved byte-for-byte. A note without valid sentinels is human-owned and an
adapter must refuse to refresh it.

Generated text must state observation time, source time when known, content hash, and raw source
link. Contradictions are recorded as competing claims until the evidence justifies supersession.
Corrections never rewrite raw evidence.
