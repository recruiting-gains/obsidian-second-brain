---
name: cruz-vault-search
description: Search and summarize Cruz's local-first AI vault through metadata and derived notes by default; private notes and raw payloads require current item-specific approval.
metadata:
  category: vault
---

# Cruz Vault Search

Read `AGENTS.md` and `_CLAUDE.md`. Treat a generic vault-search request as authorization for a
privacy-safe search only. Search the full permitted scope rather than sampling:

- Search metadata and indexes, including filenames, titles, aliases, source ids, hashes, dates,
  and the records in `20 Sources/Manifests/`.
- Search relevant body text in derived and canonical notes, preferring `30 Knowledge/`,
  `40 Learning/`, and `50 Work/`.
- Exclude `10 Private/` entirely and do not open or search payload/body content in
  `20 Sources/Raw/` by default. Use manifests and derived notes to identify relevant raw records.

Before reading, searching, quoting, summarizing, or placing in model context any content under
`10 Private/` or any payload/body from `20 Sources/Raw/`, require explicit approval in the current
request for each exact note or source record, identified by a vault-relative path, source id, or
content hash. A generic search request, skill invocation, blanket approval, earlier approval, or
approval for a different item does not count. If metadata reveals a candidate but the user has not
approved it, report the metadata-only match and ask for approval naming that item; after approval,
inspect only the named item for the requested purpose.

Return the note path, a short relevant excerpt, source/observation date when available, and why the
result is relevant. Distinguish a source statement, assistant output, Cruz's own note, and later
correction. If evidence conflicts or is stale, show the conflict; if the search was bounded, state
the boundary instead of claiming absence. Do not return an excerpt from unapproved private or raw
content.

Keep retrieval local. Approval to inspect an item does not authorize sending `10 Private/` or raw
vault content to external search, embedding, or additional model services. Search is read-only
unless Cruz separately asks for an edit.
