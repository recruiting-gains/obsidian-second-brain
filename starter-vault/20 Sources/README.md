---
date: 2026-09-04
type: policy
tags:
  - provenance
  - sources
ai-first: true
classification: private-local
---

# Source Layer

## For future agent

`Raw/` contains immutable content-addressed evidence. Its dated folders hold the first capture and
its `observations/` tree holds one content-addressed provenance record for each distinct
item/classification sighting; exact repeats deduplicate and classification never weakens
automatically. `Manifests/` contains reviewable generated pointers and processing state.
`Attachments/` is for attachments created inside Obsidian.

A synthesized claim without a source link is an observation or hypothesis, not established fact.
Never rewrite a raw capture to make it cleaner; normalization belongs in a separate derived record.
