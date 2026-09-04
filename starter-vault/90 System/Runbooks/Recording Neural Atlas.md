---
date: 2026-09-04
type: runbook
tags:
  - demo
  - recording
  - privacy
  - neural-atlas
ai-first: true
classification: public
---

# Record the Cruz AI Neural Atlas

## For future agent

This is the privacy-safe launch and 30-45 second recording path for the local Neural Atlas plugin.
Use only the clearly labeled **Synthetic recording-safe** mode. Never switch to live metadata while
recording, because live mode may show local note titles and vault-relative paths on focus.

## Open the atlas

1. Open the command palette.
2. Run **Neural Atlas: Open recording-safe showcase**. This dedicated, one-way command applies the
   synthetic graph before revealing the Atlas tab.
3. Confirm the top rail says `SYNTHETIC` and `RECORDING-SAFE` before capturing anything.
4. Use **Fit** so all six synthetic clusters and labels are inside the frame.

Do not use the network-shaped ribbon icon or **Neural Atlas: Open Neural Atlas** as the public-demo
entrypoint. Those general openers resume the last selected mode, which can be live metadata. The
dedicated recording-safe command is safe even if the preceding session ended in live mode.

The atlas opens in a new center tab. Closing that tab returns to ordinary Obsidian notes; it does not
delete, move, or rewrite any note.

## Controls

- **Use live metadata / Use safe showcase** changes modes. Do not use live mode during a public recording.
- **Motion** starts or stops the slow local animation.
- **Labels** shows or hides the sparse synthetic labels.
- **Fit** frames the complete atlas after a resize.
- **Reset** restores the deterministic starting layout.
- Drag to pan, scroll to zoom, click a node to focus its cluster, and press `Escape` to show all clusters.

Matching command-palette commands are available for general open, recording-safe open, motion,
labels, fit, and reset. Only **Open recording-safe showcase** is the approved public-capture opener.

## Before recording

- Keep the amber `SYNTHETIC · RECORDING-SAFE` state visible.
- Collapse the file explorer and close unrelated tabs or windows.
- Disable notifications and hide account names, browser tabs, terminals, and local paths.
- Keep the global graph closed; it may reveal real filenames.
- Confirm Obsidian Sync and Publish remain disabled.
- For vertical video, use an exact 9:16 frame and press **Fit** after resizing.

## 30-45 second scene order

| Time | Frame | Action | Grounded narration |
|---:|---|---|---|
| 0-5s | Top rail + full atlas | Hold on the mode label and six-cluster field | "This is a local-first neural atlas running inside Obsidian." |
| 5-13s | Luminous clusters | Let the ambient field drift | "The recording view is deterministic synthetic data, clearly separated from live notes." |
| 13-22s | Pan and zoom | Move slowly across two clusters | "Two thousand decorative particles create density, while every fiber still follows one of the counted relations." |
| 22-31s | Focus | Select one node, then press `Escape` | "Focus reveals local structure while the public labels remain intentionally generic." |
| 31-38s | Motion state | Toggle motion off, then on | "Motion and reduced-motion behavior are under explicit local control." |
| 38-45s | Final fit | Press **Fit** and hold | "Cruz AI Neural Atlas: a living memory map with a visible privacy boundary." |

## Truth and privacy boundaries

Safe claims: local Canvas rendering, deterministic synthetic showcase, local metadata-only live mode,
truthful counts, 2,000 separately labeled decorative particles, fibers that trace only real graph
edges, no note-body reads, no runtime network, and reversible installation.

Do not claim that synthetic anchors are real notes, that ambient particles are knowledge records, that
the map understands note meaning, or that it is an official visual system of Obsidian, OpenAI,
Anthropic, or the inspirational creator.

## One-click rollback

Open **Settings → Community plugins** and switch off **Neural Atlas**. Ordinary notes and the built-in
Obsidian graph remain available. The plugin does not mutate note content, so disabling it removes the
custom view without a data migration.
