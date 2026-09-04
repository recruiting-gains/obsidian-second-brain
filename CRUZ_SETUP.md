# Cruz's Local-First Obsidian AI Second Brain

This fork keeps the upstream project as a reviewed foundation and adds a private-by-default vault,
source adapters, learning system, and operating boundaries tailored to Cruz.

## What is implemented

- A sanitized `starter-vault/` that is safe to keep in this public fork.
- A live `vault/` materialization path that is ignored by the public repository.
- A second, local-only Git repository inside the live vault for reversible changes.
- A pre-push guard that blocks accidental vault pushes unless Cruz deliberately overrides it.
- Four small Codex-compatible skills bound to this vault's numbered schema and safety rules.
- Working SHA-256, content-addressed ingestion primitives with immutable raw records.
- Atomic sync state, append-only event logging, deduplication, and source freshness checks.
- Generated-note sentinels that preserve user-authored content on every refresh.
- Adapters for authenticated GitHub metadata, ChatGPT data exports, deliberate news/image/usage
  inboxes, and a metadata-only read of the separate Prometheus repository.
- A sourced, adaptive Forward Deployed Engineer roadmap with practical gates, quizzes, spaced
  retrieval, competency scoring, and evidence-of-mastery templates.
- A doctor command that checks vault validity, raw modes and hashes, sentinel balance, known
  secret-bearing config fields, source freshness, Agent Skills installation, and Git remote risk.
- A plugin-free, reversible `Prometheus Neural Glass` v1 CSS direction plus a sanitized recording
  dashboard, Canvas system map, and claim-safe 30-45 second walkthrough.

## Trust decision on upstream

The upstream repository is useful and actively tested, but this setup does not run its network-piped
or interactive installers.

| Area | Review result | Decision here |
|---|---|---|
| License | MIT | Reuse with upstream history and attribution intact |
| Security guidance | Coordinated disclosure policy covers scripts, hooks, keys, paths, and prompt injection | Keep; add stricter local source boundaries |
| Classic install | Writes Claude commands/skills and a SessionStart hook into user-level settings; optionally creates an API-key file | Do not run for this Codex vault |
| Setup script | Writes `OBSIDIAN_VAULT_PATH`, adds Claude hooks, and can offer an MCP server | Do not run; this is not needed for local Codex Agent Skills |
| Codex path | Unified `agent-skills` is the upstream-recommended successor to the deprecated standalone Codex build | Keep the generic build available for evaluation; install only the four vault-native skills by default |
| Raw/derived model | Upstream distinguishes raw sources and supports generated/user sentinel regions | Reuse and strengthen with enforced immutable writes and a ledger |
| Update behavior | Guarded updater uses clean-tree checks, fast-forward-only pulls, tests, backups, and rollback for copied builds | Use only after reviewing each upstream change; the personalized layer stays separate |
| Optional research | Some commands can call third-party APIs; local semantic search is optional | Leave cloud research/embeddings unconfigured by default |

The source was reviewed before any installer ran. No installer was run, no global Claude settings were
changed, and no API key file was created.

## Architecture

```text
Explicit source boundary
        │
        ▼
adapter reads only configured account/path/inbox
        │
        ├──► immutable raw bytes + capture and observation records
        │       20 Sources/Raw/<source>/<year>/<month>/<sha256>.*
        │       20 Sources/Raw/<source>/observations/<sha256>/<observation>.meta.json
        │
        ├──► atomic cursor + append-only events
        │       90 System/Ledger/
        │
        └──► refreshable manifest/project/transcript note
                generated sentinel: replaceable
                user sentinel: never overwritten
```

The public fork and private vault are deliberately separate:

```text
public fork (this repository)          ignored local vault/
├── reviewed upstream foundation      ├── .obsidian/ (valid vault)
├── source adapters and tests         ├── .agents/skills/ (regenerable)
├── sanitized starter-vault/          ├── raw + derived private records
└── no private exports or secrets     └── nested local Git, no remote
```

## Create or verify the live vault

From this repository root:

```text
python3 -m scripts.local_brain init \
  --vault vault \
  --name Cruz \
  --github-account recruiting-gains

python3 -m scripts.local_brain install-skills --vault vault
python3 -m scripts.local_brain doctor --vault vault
```

Then open the absolute `vault/` directory in Obsidian as a vault. The setup requires no community
plugin. Obsidian's core Templates feature can use `Templates/`; optional Dataview/Kanban/semantic
search should be added only when a real workflow justifies their maintenance and privacy cost. The
scaffold explicitly disables the Obsidian Sync and Publish core plugins; enabling either is a separate
privacy and backup decision.

The starter enables dark mode and the local `prometheus-neural-glass` CSS snippet. This visual layer
uses only native/system fonts and local CSS; it makes no network requests. It is a reversible v1
direction, not a permanent brand approval: disable it in **Settings → Appearance → CSS snippets** or
remove its name from `.obsidian/appearance.json` to return to the default interface. The underlying
Markdown, Canvas data, source records, and privacy controls do not depend on the snippet.

For a privacy-safe screen recording, open `80 Dashboards/Neural Glass Demo.md` and its linked Canvas.
Do not record the global graph or browse live source folders: their node and file labels can reveal
private filenames even when note bodies remain closed. Follow `90 System/Runbooks/Recording Neural
Glass Demo.md` before every capture.

The machine-local source registry is `vault/.brain/config.json`. It is mode `0600` and ignored by
the vault's Git. It contains paths and account names, never credentials. Provider authentication stays
in the provider's existing secure store-for example, the GitHub CLI keychain.

The default four-skill set is `cruz-local-vault`, `cruz-vault-search`, `cruz-source-review`, and
`cruz-fde-coach`. Generic upstream skills are deliberately excluded because the shared core includes
installers, network helpers, and `raw/`, `wiki/`, `index.md`, and `log.md` assumptions that do not
match this vault. `install-skills --full` remains available for isolated evaluation, but it prints a
warning and should not be used here without pruning those scripts and adapting folder/ownership rules.

## Synchronize sources

Always preview a new source or config change:

```text
python3 -m scripts.local_brain sync --vault vault --source github --dry-run
python3 -m scripts.local_brain sync --vault vault --source github
python3 -m scripts.local_brain doctor --vault vault
```

Run every enabled source by omitting `--source`. A failed source reports its error and does not prevent
independent sources from completing.

### GitHub projects

The first milestone reads metadata for every repository visible to the configured authenticated
account, including private repositories when `include_private` is true. It does not clone, read code,
create issues, change settings, or push. Each repository gets an immutable metadata record and a
generated project note with a protected user section.

### ChatGPT chats

No private ChatGPT scraping or undocumented API is assumed. Request a data export, review it, place
`conversations.json` in `vault/00 Inbox/ChatGPT/`, then intentionally enable the source. The adapter
archives each conversation object and renders its active branch. Assistant output remains attributed
as assistant output and is not promoted to fact merely because it appears in a transcript.

### Daily AI-news automation

Have the approved automation write one dated Markdown or JSON artifact into
`vault/00 Inbox/AI News/`. The contract is documented inside that folder. Ingestion archives the exact
artifact; it does not follow URLs or publish anything. A later synthesis step should cite the raw
record and canonical article URL, label source/publication times, and avoid copying full articles.

### Prometheus AI project

The public template leaves this source disabled until the exact local path is confirmed. The adapter
records read-only Git metadata, tracked-file count, working-tree change count, sanitized remote, and
hashes of a small root-doc allowlist. Git inspection disables hooks, file-system monitors, optional
locks, and inherited Git environment overrides. It never modifies, stages, commits, installs, or
copies source code from the Prometheus repository.

### Images and AI-learning/usage history

Only files deliberately placed in their inboxes are read. Images are archived with metadata and left
in a review queue; no photo-library scan, face recognition, OCR, or cloud vision runs automatically.
Usage imports accept deliberate CSV/JSON/Markdown/text exports and never invent missing cost data.

## Privacy, provenance, and rollback

- Raw payloads are addressed by SHA-256 and created once at mode `0444`; the doctor recomputes their
  hashes and rejects writable files or symlinks.
- The first-capture sidecar is immutable. Each distinct item/classification sighting also gets a
  content-addressed, append-only observation record with source, item id, time, raw path, and other
  provenance. Exact repeat sightings deduplicate.
- Effective raw classification is the highest-severity observation ever recorded. Automatic
  downgrades are refused; declassification requires a separate, explicit migration and audit trail.
- The current cursor is atomic; the event history is append-only.
- Failed source runs append an audit event without promoting their partial in-memory cursor.
- Derived notes without one valid generated block are treated as user-owned and refresh is refused.
- `10 Private/` is excluded from cloud embedding and cross-source automation by default.
- The live vault has no remote, and its pre-push hook blocks accidental pushes. Local Git is for
  rollback, not publication.
- Raw deletion follows the documented retention and tombstone process; synchronization never deletes.
- A local Git history is not a device-loss backup. Add an encrypted backup only after testing restore
  and documenting key custody, retention, and provider access.

## Maintenance and upstream updates

Keep these remotes in the public foundation repository:

- `origin`: `recruiting-gains/obsidian-second-brain`
- `upstream`: `eugeniughelbur/obsidian-second-brain`

Review changes on a branch. Pay special attention to installers, hooks, dependencies, network calls,
schema/write behavior, and security notes. Run the full upstream tests and the local-brain tests before
refreshing Agent Skills. Existing vault skills must be backed up before replacement.

## Phased integration plan

### Milestone 1 - Safe local spine (implemented)

- Fork/remotes, sanitized scaffold, local vault, Codex skills, source registry, GitHub metadata sync,
  export/drop-folder adapters, read-only Prometheus contract, privacy policies, learning roadmap,
  doctor, and tests.

### Milestone 2 - Connect deliberate exports

- Point the existing AI-news automation at its inbox.
- Import one reviewed ChatGPT export and one AI-usage export.
- Run reconciliation and manually inspect samples from every privacy class.
- Establish an encrypted backup and complete a restore drill.

### Milestone 3 - Review and learning loop

- Build a small local review queue for accept/quarantine/reject decisions.
- Add explicit claim extraction with source citations and confidence.
- Complete the FDE baseline and seed the skills matrix from artifacts.
- Schedule only source-health and due-review checks; stay quiet when no action is needed.

### Milestone 4 - Retrieval and evaluation

- Add permission-aware local keyword retrieval first.
- Add local embeddings only if measured recall warrants them; keep private zones excluded.
- Create a representative eval set for citation accuracy, abstention, privacy enforcement, and
  retrieval failures before adding agentic automation.

### Milestone 5 - Field deployment capstone

- Use one consenting real workflow, measure its baseline, ship the smallest pilot, instrument it,
  red-team it, document it, and hand it off. A sanitized cloud deployment may follow only after the
  security gate; the private vault itself remains local.

## Recommendations

1. Make this second-brain the continuous spine project for FDE learning; avoid disconnected tutorial
   projects unless they isolate a missing prerequisite.
2. Limit work in progress to one active build and one remediation area.
3. Keep Obsidian as the evidence and learning index-not the home for full repositories, secrets,
   deployed runtimes, or indiscriminate datasets.
4. Choose one cloud only when a deployment milestone needs it; Kubernetes remains optional until a
   real orchestration problem appears.
5. Prefer local keyword search before embeddings. Measure retrieval failures before adding complexity.
6. Require citations and explicit abstention before trusting synthesis.
7. Keep model/provider calls behind adapters and test with fixtures or local mocks first.
8. Measure user outcomes, operational reliability, and delayed recall-not notes created or hours watched.
9. End each learning gate with a demo, decision record, runbook update, and retrospective.
10. Recheck volatile FDE postings, LLM documentation, and security guidance quarterly.
