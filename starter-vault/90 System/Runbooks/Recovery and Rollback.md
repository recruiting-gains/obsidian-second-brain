---
date: 2026-09-04
type: runbook
tags:
  - recovery
  - rollback
ai-first: true
classification: private-local
---

# Recovery and Rollback

## For future agent

The public foundation and private vault have separate Git histories. Never solve a vault problem by
resetting or deleting the public fork, and never push the private vault to the public fork.

## Before a risky import

1. Confirm the vault has no remote: `git -C vault remote` should print nothing.
2. Commit current vault changes locally.
3. Run the new adapter with `--dry-run`.
4. Inspect expected source count, classifications, and destination paths.

## Roll back derived changes

Use the local vault Git diff to identify generated notes and state changes. Restore only the exact
derived paths from the last known-good commit. Raw archives remain immutable unless Cruz separately
approves deletion under the retention policy.

## Interrupted run

Raw records are created with exclusive writes; sync state is atomically replaced only after an
adapter completes. Re-run the same source. Content hashes make promoted records idempotent. Then run
the doctor and compare ledger counts with generated notes.

## Corrupt state

Do not guess or hand-edit hashes. Save the corrupt state for diagnosis, restore the last local Git
version of `sync-state.json`, and rerun the relevant source. The content-addressed archive remains the
ground truth.

## Lost local vault

Recovery depends on a tested local backup. A Git history with no remote protects reversibility but
does not protect against device loss. Configure an encrypted backup destination only after reviewing
its provider, retention, key custody, and restore procedure; perform a restore test before relying on
it.
