---
date: 2026-09-04
type: runbook
tags:
  - maintenance
  - upstream
ai-first: true
classification: public
---

# Upstream Updates

## For future agent

The foundation repository keeps `origin` for Cruz's fork and `upstream` for Eugeniu Ghelbur's public
project. Review upstream changes; never pipe an installer from the network or merge updates directly
into the private vault.

## Review flow

1. Fetch `upstream`.
2. Read release notes, security changes, install/update script changes, dependency changes, and tests.
3. Merge or rebase on a review branch in the public foundation repository.
4. Run the full upstream test suite and local-brain tests.
5. Build `agent-skills` from the reviewed commit.
6. Refresh the vault integration with a backup.
7. Run the vault doctor and one dry-run sync.
8. Record the reviewed upstream commit in a decision or maintenance note.

Do not run the classic installer for this setup: it targets Claude's global command directory and
settings. The reviewed Agent Skills build is copied only into this vault's `.agents/skills/` tree.
