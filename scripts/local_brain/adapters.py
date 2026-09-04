"""Explicit, source-bounded adapters for the local AI vault."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .core import (
    CLASSIFICATION_RANK,
    BrainError,
    Ledger,
    SyncResult,
    archive_bytes,
    canonical_json,
    ensure_classification,
    observed_item_classifications,
    resolve_in_vault_no_symlinks,
    resolve_input_path,
    sha256_bytes,
    slug,
    upsert_generated_note,
    utc_now,
)

TEXT_EXTENSIONS = {".csv", ".html", ".json", ".md", ".txt", ".yaml", ".yml"}
IMAGE_EXTENSIONS = {".gif", ".heic", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
CLASSIFICATIONS = {"public", "private-local", "sensitive", "restricted"}


def _rel_link(path: str) -> str:
    return path.removesuffix(".md")


def _text_fence(value: str) -> str:
    """Fence untrusted text with a delimiter longer than any embedded run."""
    longest = max((len(run) for run in re.findall(r"`+", value)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}text\n{value}\n{fence}"


def _inline_code(value: Any) -> str:
    """Render untrusted scalar metadata without allowing Markdown escape."""
    text = re.sub(r"\s+", " ", str(value)).strip()
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * max(1, longest + 1)
    return f"{fence} {text} {fence}"


def _classification(settings: dict[str, Any]) -> str:
    value = str(settings.get("classification", "private-local"))
    if value not in CLASSIFICATIONS:
        raise BrainError(f"invalid source classification: {value!r}")
    return value


def _managed_note_folder(
    vault: Path,
    configured: Any,
    *,
    default: str,
    allowed_root: str,
) -> Path:
    folder = resolve_in_vault_no_symlinks(vault, configured or default)
    root = resolve_in_vault_no_symlinks(vault, allowed_root)
    try:
        folder.relative_to(root)
    except ValueError as exc:
        raise BrainError(f"managed note folder must stay under {allowed_root}: {folder}") from exc
    return folder


def _preflight_item_classification(
    ledger: Ledger,
    source_name: str,
    item_id: str,
    desired: str,
    immutable_classifications: dict[str, str],
) -> dict[str, Any] | None:
    """Reject an item downgrade before any new immutable bytes are promoted."""
    previous = ledger.item(source_name, item_id)
    candidates = []
    if previous is not None:
        candidates.append(str(previous.get("classification", "private-local")))
    if item_id in immutable_classifications:
        candidates.append(immutable_classifications[item_id])
    for current in candidates:
        if current not in CLASSIFICATION_RANK:
            raise BrainError(
                f"{source_name}: invalid prior classification {current!r} for item {item_id!r}"
            )
    strongest = max(candidates, key=CLASSIFICATION_RANK.__getitem__) if candidates else None
    if strongest is not None and CLASSIFICATION_RANK[desired] < CLASSIFICATION_RANK[strongest]:
        raise BrainError(
            f"{source_name}: refusing item classification downgrade from {strongest} "
            f"to {desired} for {item_id!r}"
        )
    return previous


def _note_result(result: SyncResult, status: str) -> None:
    if status == "created":
        result.created += 1
    elif status == "updated":
        result.updated += 1
    else:
        result.unchanged += 1


def _finish(ledger: Ledger, result: SyncResult, observed_at: str) -> SyncResult:
    ledger.mark_source_success(result.source, observed_at)
    ledger.save()
    ledger.event(
        {
            "schema_version": 1,
            "event": "sync_completed",
            "source": result.source,
            "classification": result.classification,
            "observed_at": observed_at,
            "created": result.created,
            "updated": result.updated,
            "unchanged": result.unchanged,
            "archived": result.archived,
            "warnings": result.warnings,
        }
    )
    return result


def sync_github(
    vault: Path,
    source_name: str,
    settings: dict[str, Any],
    ledger: Ledger,
) -> SyncResult:
    account = str(settings.get("account", "")).strip()
    if not account or account.startswith("${"):
        raise BrainError(f"{source_name}: set a GitHub account in the local config")
    limit = int(settings.get("limit", 1000))
    fields = (
        "name,nameWithOwner,description,isPrivate,isFork,isArchived,updatedAt,pushedAt,"
        "url,primaryLanguage,defaultBranchRef,visibility"
    )
    command = [
        "gh",
        "repo",
        "list",
        account,
        "--limit",
        str(limit),
        "--json",
        fields,
    ]
    completed = subprocess.run(command, check=False, capture_output=True, text=True)
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "unknown error"
        raise BrainError(f"{source_name}: GitHub CLI failed: {detail}")
    try:
        repositories = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise BrainError(f"{source_name}: GitHub CLI returned invalid JSON") from exc
    if not isinstance(repositories, list):
        raise BrainError(f"{source_name}: GitHub CLI result was not a list")

    if not settings.get("include_private", False):
        repositories = [repo for repo in repositories if not repo.get("isPrivate")]
    observed_at = utc_now()
    classification = _classification(settings)
    result = SyncResult(source_name, classification=classification)
    immutable_classifications = observed_item_classifications(vault, source_name)
    links: list[str] = []
    note_folder = _managed_note_folder(
        vault,
        settings.get("note_folder"),
        default="50 Work/GitHub",
        allowed_root="50 Work/GitHub",
    )

    for repo in sorted(repositories, key=lambda item: str(item.get("nameWithOwner", "")).lower()):
        item_id = str(repo.get("nameWithOwner") or repo.get("name") or "unknown")
        previous = _preflight_item_classification(
            ledger,
            source_name,
            item_id,
            classification,
            immutable_classifications,
        )
        payload = canonical_json(repo)
        archive_path, digest, archived = archive_bytes(
            vault,
            source=source_name,
            data=payload,
            extension="json",
            metadata={
                "item_id": item_id,
                "kind": "github_repository_metadata",
                "classification": classification,
                "retention": settings.get("retention", "keep"),
            },
            observed_at=observed_at,
            dry_run=ledger.dry_run,
        )
        result.archived += int(archived)
        status_word = "unchanged" if previous and previous.get("content_hash") == digest else "changed"
        language = (repo.get("primaryLanguage") or {}).get("name") or "Not reported"
        visibility = "private" if repo.get("isPrivate") else "public"
        title = item_id
        item_suffix = sha256_bytes(item_id.encode("utf-8"))[:10]
        note_name = f"{slug(item_id.replace('/', ' - '), limit=72)} - {item_suffix}.md"
        note_path = note_folder / note_name
        note_rel = note_path.relative_to(vault).as_posix()
        links.append(f"- [[{_rel_link(note_rel)}|{item_id}]] - {visibility}, {language}")
        if previous and previous.get("content_hash") == digest and note_path.exists():
            _note_result(
                result,
                ensure_classification(
                    note_path,
                    classification,
                    dry_run=ledger.dry_run,
                ),
            )
            ledger.remember(
                source_name,
                item_id,
                content_hash=digest,
                archive_path=archive_path,
                observed_at=observed_at,
                classification=classification,
            )
            continue
        body = f"""## Source snapshot

- Repository: {_inline_code(item_id)}
- GitHub URL: {_inline_code(repo.get('url', ''))}
- Visibility: {_inline_code(visibility)}
- Primary language: {_inline_code(language)}
- Default branch: {_inline_code((repo.get('defaultBranchRef') or {}).get('name') or 'Not reported')}
- Fork: {_inline_code(str(bool(repo.get('isFork'))).lower())}
- Archived: {_inline_code(str(bool(repo.get('isArchived'))).lower())}
- GitHub updated: {_inline_code(repo.get('updatedAt') or 'Not reported')}
- Last push: {_inline_code(repo.get('pushedAt') or 'Not reported')}
- Observed locally: {_inline_code(observed_at)}
- Raw immutable record: `[[{_rel_link(archive_path)}]]`
- Content hash: `sha256:{digest}`
- Sync comparison: `{status_word}`

## Description (untrusted source text)

{_text_fence(str(repo.get('description') or 'No GitHub description.'))}
"""
        status = upsert_generated_note(
            note_path,
            title=title,
            frontmatter={
                "date": observed_at[:10],
                "type": "project-source",
                "tags": ["source/github", "project"],
                "ai-first": True,
                "managed-by": "local-brain",
                "source": source_name,
                "source-id": item_id,
                "classification": classification,
            },
            generated=body,
            future_agent=(
                "GitHub-derived project metadata. Treat the generated block as a refreshable snapshot; "
                "Cruz's notes are authoritative for intent and decisions."
            ),
            dry_run=ledger.dry_run,
        )
        _note_result(result, status)
        ledger.remember(
            source_name,
            item_id,
            content_hash=digest,
            archive_path=archive_path,
            observed_at=observed_at,
            classification=classification,
        )

    index_body = "## Repositories\n\n" + ("\n".join(links) if links else "_No repositories returned._")
    index_status = upsert_generated_note(
        note_folder / "Index.md",
        title="GitHub Projects",
        frontmatter={
            "date": observed_at[:10],
            "type": "dashboard",
            "tags": ["dashboard", "source/github"],
            "ai-first": True,
            "managed-by": "local-brain",
            "classification": classification,
        },
        generated=index_body,
        future_agent="Current project inventory from GitHub. Use repository notes as pointers, not as proof of project intent.",
        dry_run=ledger.dry_run,
    )
    _note_result(result, index_status)
    return _finish(ledger, result, observed_at)


def _message_text(message: dict[str, Any]) -> str:
    content = message.get("content") or {}
    parts = content.get("parts") or []
    rendered: list[str] = []
    for part in parts:
        if isinstance(part, str):
            rendered.append(part)
        elif isinstance(part, dict):
            rendered.append(json.dumps(part, ensure_ascii=False, sort_keys=True))
        else:
            rendered.append(str(part))
    return "\n".join(rendered).strip()


def active_chat_messages(conversation: dict[str, Any]) -> list[dict[str, str]]:
    """Return the active ChatGPT branch, tolerating older export variants."""
    mapping = conversation.get("mapping") or {}
    current = conversation.get("current_node")
    ordered_nodes: list[dict[str, Any]] = []
    seen: set[str] = set()
    while current and current in mapping and current not in seen:
        seen.add(current)
        node = mapping[current]
        ordered_nodes.append(node)
        current = node.get("parent")
    if ordered_nodes:
        ordered_nodes.reverse()
    else:
        ordered_nodes = sorted(
            mapping.values(),
            key=lambda node: ((node.get("message") or {}).get("create_time") or 0),
        )
    messages: list[dict[str, str]] = []
    for node in ordered_nodes:
        message = node.get("message") or {}
        text = _message_text(message)
        if not text:
            continue
        role = ((message.get("author") or {}).get("role") or "unknown").strip()
        messages.append({"role": role, "text": text})
    return messages


def sync_chatgpt_export(
    vault: Path,
    source_name: str,
    settings: dict[str, Any],
    ledger: Ledger,
) -> SyncResult:
    configured = settings.get("path")
    if not configured:
        raise BrainError(f"{source_name}: configure the exported conversations.json path")
    export_path = resolve_input_path(vault, configured)
    if not export_path.is_file():
        raise BrainError(f"{source_name}: export not found at {export_path}")
    try:
        conversations = json.loads(export_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BrainError(f"{source_name}: invalid ChatGPT export JSON") from exc
    if not isinstance(conversations, list):
        raise BrainError(f"{source_name}: expected a list in conversations.json")

    observed_at = utc_now()
    classification = _classification(settings)
    result = SyncResult(source_name, classification=classification)
    immutable_classifications = observed_item_classifications(vault, source_name)
    note_folder = _managed_note_folder(
        vault,
        settings.get("note_folder"),
        default="30 Knowledge/ChatGPT",
        allowed_root="30 Knowledge/ChatGPT",
    )
    max_items = int(settings.get("max_items", 100000))
    for conversation in conversations[:max_items]:
        item_id = str(conversation.get("id") or sha256_bytes(canonical_json(conversation))[:16])
        previous = _preflight_item_classification(
            ledger,
            source_name,
            item_id,
            classification,
            immutable_classifications,
        )
        title = str(conversation.get("title") or "Untitled ChatGPT conversation")
        payload = canonical_json(conversation)
        archive_path, digest, archived = archive_bytes(
            vault,
            source=source_name,
            data=payload,
            extension="json",
            metadata={
                "item_id": item_id,
                "kind": "chatgpt_conversation",
                "classification": classification,
                "retention": settings.get("retention", "keep"),
            },
            observed_at=observed_at,
            dry_run=ledger.dry_run,
        )
        result.archived += int(archived)
        note_name = f"ChatGPT - {slug(title, limit=64)} - {sha256_bytes(item_id.encode())[:8]}.md"
        note_path = note_folder / note_name
        if previous and previous.get("content_hash") == digest and note_path.exists():
            _note_result(
                result,
                ensure_classification(
                    note_path,
                    classification,
                    dry_run=ledger.dry_run,
                ),
            )
            ledger.remember(
                source_name,
                item_id,
                content_hash=digest,
                archive_path=archive_path,
                observed_at=observed_at,
                classification=classification,
            )
            continue
        messages = active_chat_messages(conversation)
        transcript = []
        for message in messages:
            role = re.sub(r"[^A-Za-z0-9 _-]", "", message["role"]).strip()[:32] or "unknown"
            transcript.append(f"### {role.title()}\n\n{_text_fence(message['text'])}")
        body = f"""## Provenance

- Export file: {_inline_code(export_path.name)}
- Conversation id: {_inline_code(item_id)}
- Updated at source: {_inline_code(conversation.get('update_time') or 'Not reported')}
- Observed locally: {_inline_code(observed_at)}
- Raw immutable record: `[[{_rel_link(archive_path)}]]`
- Content hash: `sha256:{digest}`

## Active-branch transcript

{chr(10).join(transcript) if transcript else '_No textual messages found in the active branch._'}
"""
        status = upsert_generated_note(
            note_path,
            title=title,
            frontmatter={
                "date": observed_at[:10],
                "type": "conversation",
                "tags": ["source/chatgpt", "conversation"],
                "ai-first": True,
                "managed-by": "local-brain",
                "source": source_name,
                "source-id": item_id,
                "classification": classification,
            },
            generated=body,
            future_agent=(
                "ChatGPT export transcript. Preserve the raw record and distinguish Cruz's statements, "
                "assistant suggestions, and later user corrections before treating anything as fact."
            ),
            dry_run=ledger.dry_run,
        )
        _note_result(result, status)
        ledger.remember(
            source_name,
            item_id,
            content_hash=digest,
            archive_path=archive_path,
            observed_at=observed_at,
            classification=classification,
        )
    return _finish(ledger, result, observed_at)


def sync_inbox(
    vault: Path,
    source_name: str,
    settings: dict[str, Any],
    ledger: Ledger,
) -> SyncResult:
    configured = settings.get("path")
    if not configured:
        raise BrainError(f"{source_name}: configure an explicit inbox path")
    input_folder = resolve_input_path(vault, configured)
    if not input_folder.is_dir():
        raise BrainError(f"{source_name}: inbox not found at {input_folder}")
    vault_root = vault.expanduser().resolve()
    try:
        vault_root.relative_to(input_folder)
    except ValueError:
        pass
    else:
        raise BrainError(f"{source_name}: inbox cannot contain the vault or its managed outputs")
    try:
        input_folder.relative_to(vault_root)
    except ValueError:
        pass
    else:
        inbox_root = resolve_in_vault_no_symlinks(vault, "00 Inbox")
        try:
            input_folder.relative_to(inbox_root)
        except ValueError as exc:
            raise BrainError(f"{source_name}: in-vault input must stay under 00 Inbox") from exc
    extensions = {value.lower() for value in settings.get("extensions", TEXT_EXTENSIONS | IMAGE_EXTENSIONS)}
    maximum = int(settings.get("max_file_bytes", 100 * 1024 * 1024))
    observed_at = utc_now()
    classification = _classification(settings)
    result = SyncResult(source_name, classification=classification)
    immutable_classifications = observed_item_classifications(vault, source_name)
    note_folder = _managed_note_folder(
        vault,
        settings.get("note_folder"),
        default=f"20 Sources/Manifests/{slug(source_name)}",
        allowed_root="20 Sources/Manifests",
    )
    for path in sorted(input_folder.rglob("*")):
        if path.is_symlink():
            result.warnings.append(f"Skipped symbolic link: {path.name}")
            continue
        if not path.is_file() or path.name.startswith(".") or path.name.lower() == "readme.md":
            continue
        if path.suffix.lower() not in extensions:
            result.warnings.append(f"Skipped unsupported file: {path.name}")
            continue
        if path.stat().st_size > maximum:
            result.warnings.append(f"Skipped oversized file: {path.name}")
            continue
        data = path.read_bytes()
        relative_input = path.relative_to(input_folder).as_posix()
        previous = _preflight_item_classification(
            ledger,
            source_name,
            relative_input,
            classification,
            immutable_classifications,
        )
        archive_path, digest, archived = archive_bytes(
            vault,
            source=source_name,
            data=data,
            extension=path.suffix or ".bin",
            metadata={
                "item_id": relative_input,
                "kind": settings.get("kind", "inbox_file"),
                "original_name": path.name,
                "media_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                "classification": classification,
                "retention": settings.get("retention", "review"),
                "source_modified_at": datetime.fromtimestamp(path.stat().st_mtime, UTC)
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z"),
            },
            observed_at=observed_at,
            dry_run=ledger.dry_run,
        )
        result.archived += int(archived)
        note_name = f"{slug(relative_input, limit=72)} - {sha256_bytes(relative_input.encode())[:8]}.md"
        note_path = note_folder / note_name
        if previous and previous.get("content_hash") == digest and note_path.exists():
            _note_result(
                result,
                ensure_classification(
                    note_path,
                    classification,
                    dry_run=ledger.dry_run,
                ),
            )
            ledger.remember(
                source_name,
                relative_input,
                content_hash=digest,
                archive_path=archive_path,
                observed_at=observed_at,
                classification=classification,
            )
            continue
        excerpt = ""
        if path.suffix.lower() in TEXT_EXTENSIONS:
            excerpt = data.decode("utf-8", errors="replace")[:1200].strip()
        if path.suffix.lower() in IMAGE_EXTENSIONS:
            preview = f"![[{archive_path}]]"
        else:
            preview = f"[[{_rel_link(archive_path)}|Open immutable source]]"
        body = f"""## Provenance

- Deliberate inbox: {_inline_code(input_folder)}
- Original relative path: {_inline_code(relative_input)}
- Observed locally: {_inline_code(observed_at)}
- Raw immutable record: `{preview}`
- Content hash: `sha256:{digest}`

## Processing status

- [ ] Review source quality and sensitivity
- [ ] Extract durable claims with citations
- [ ] Link to a project, concept, or learning objective
- [ ] Mark retention decision
"""
        if excerpt:
            body += f"\n## Source preview (first 1,200 characters)\n\n{_text_fence(excerpt)}\n"
        status = upsert_generated_note(
            note_path,
            title=path.stem,
            frontmatter={
                "date": observed_at[:10],
                "type": "source-manifest",
                "tags": [f"source/{source_name}", "needs-review"],
                "ai-first": True,
                "managed-by": "local-brain",
                "source": source_name,
                "source-id": relative_input,
                "retention": settings.get("retention", "review"),
                "classification": classification,
            },
            generated=body,
            future_agent=(
                "Manifest for a deliberately dropped source. Do not infer facts from the filename or "
                "preview; inspect the immutable source before synthesizing."
            ),
            dry_run=ledger.dry_run,
        )
        _note_result(result, status)
        ledger.remember(
            source_name,
            relative_input,
            content_hash=digest,
            archive_path=archive_path,
            observed_at=observed_at,
            classification=classification,
        )
    return _finish(ledger, result, observed_at)


def _run_git(repo: Path, *args: str, required: bool = True) -> str:
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(
        {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
        }
    )
    completed = subprocess.run(
        [
            "git",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            f"core.hooksPath={os.devnull}",
            "-C",
            str(repo),
            *args,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    if completed.returncode != 0:
        if required:
            detail = completed.stderr.strip().splitlines()
            reason = detail[-1] if detail else "unknown Git error"
            raise BrainError(f"read-only Git inspection failed for {args[0]}: {reason}")
        return ""
    return completed.stdout.strip()


def _sanitize_remote(remote: str) -> str:
    if "://" not in remote:
        scp_like = re.fullmatch(r"([^@/:\s]+)@([^/:\s]+):(.+)", remote)
        if scp_like and scp_like.group(1) != "git":
            return f"{scp_like.group(2)}:{scp_like.group(3)}"
        return remote
    parsed = urlsplit(remote)
    hostname = parsed.hostname or ""
    if parsed.port:
        hostname = f"{hostname}:{parsed.port}"
    return urlunsplit((parsed.scheme, hostname, parsed.path, "", ""))


def sync_repository(
    vault: Path,
    source_name: str,
    settings: dict[str, Any],
    ledger: Ledger,
) -> SyncResult:
    configured = settings.get("path")
    if not configured:
        raise BrainError(f"{source_name}: configure the exact read-only repository path")
    repo = resolve_input_path(vault, configured)
    if not repo.is_dir():
        raise BrainError(f"{source_name}: repository not found at {repo}")
    observed_at = utc_now()
    classification = _classification(settings)
    immutable_classifications = observed_item_classifications(vault, source_name)
    item_id = str(repo)
    previous = _preflight_item_classification(
        ledger,
        source_name,
        item_id,
        classification,
        immutable_classifications,
    )
    if _run_git(repo, "rev-parse", "--is-inside-work-tree") != "true":
        raise BrainError(f"{source_name}: configured path is not a Git work tree")
    tracked_files = _run_git(repo, "ls-files").splitlines()
    selected_docs: dict[str, str] = {}
    for name in ("README.md", "AGENTS.md", "CLAUDE.md", "pyproject.toml", "package.json"):
        candidate = repo / name
        if candidate.is_file() and not candidate.is_symlink():
            selected_docs[name] = f"sha256:{sha256_bytes(candidate.read_bytes())}"
    status_lines = _run_git(repo, "status", "--porcelain").splitlines()
    snapshot = {
        "schema_version": 1,
        "kind": "read_only_repository_snapshot",
        "path": str(repo),
        "branch": _run_git(repo, "branch", "--show-current"),
        "head": _run_git(repo, "rev-parse", "HEAD"),
        "remote": _sanitize_remote(
            _run_git(repo, "remote", "get-url", "origin", required=False)
        ),
        "tracked_file_count": len(tracked_files),
        "working_tree_change_count": len(status_lines),
        "selected_document_hashes": selected_docs,
    }
    payload = canonical_json(snapshot)
    archive_path, digest, archived = archive_bytes(
        vault,
        source=source_name,
        data=payload,
        extension="json",
        metadata={
            "item_id": item_id,
            "kind": snapshot["kind"],
            "classification": classification,
            "retention": settings.get("retention", "keep"),
        },
        observed_at=observed_at,
        dry_run=ledger.dry_run,
    )
    result = SyncResult(
        source_name,
        classification=classification,
        archived=int(archived),
    )
    docs = "\n".join(f"- `{name}`: `{digest_value}`" for name, digest_value in selected_docs.items())
    body = f"""## Read-only snapshot

- Local path: {_inline_code(repo)}
- Branch: {_inline_code(snapshot['branch'] or 'Not reported')}
- HEAD: {_inline_code(snapshot['head'] or 'Not reported')}
- Remote: {_inline_code(snapshot['remote'] or 'Not reported')}
- Files observed: {_inline_code(snapshot['tracked_file_count'])}
- Working-tree changes observed: {_inline_code(snapshot['working_tree_change_count'])}
- Observed locally: {_inline_code(observed_at)}
- Raw immutable record: `[[{_rel_link(archive_path)}]]`
- Content hash: `sha256:{digest}`

## Selected document fingerprints

{docs or '_No standard root documents found._'}

This adapter records metadata and fingerprints only. It never writes to or copies source code from the repository.
"""
    note_folder = _managed_note_folder(
        vault,
        settings.get("note_folder"),
        default="50 Work/Prometheus",
        allowed_root="50 Work",
    )
    note_path = note_folder / "Project Snapshot.md"
    if previous and previous.get("content_hash") == digest and note_path.exists():
        _note_result(
            result,
            ensure_classification(
                note_path,
                classification,
                dry_run=ledger.dry_run,
            ),
        )
        ledger.remember(
            source_name,
            item_id,
            content_hash=digest,
            archive_path=archive_path,
            observed_at=observed_at,
            classification=classification,
        )
        return _finish(ledger, result, observed_at)
    status = upsert_generated_note(
        note_path,
        title=settings.get("title", "Prometheus AI Project"),
        frontmatter={
            "date": observed_at[:10],
            "type": "project-source",
            "tags": [f"source/{source_name}", "project"],
            "ai-first": True,
            "managed-by": "local-brain",
            "source": source_name,
            "access-mode": "read-only",
            "classification": classification,
        },
        generated=body,
        future_agent=(
            "Read-only project pointer. Use it to detect drift and locate the project, but ask before "
            "crossing into source content or modifying that repository."
        ),
        dry_run=ledger.dry_run,
    )
    _note_result(result, status)
    ledger.remember(
        source_name,
        item_id,
        content_hash=digest,
        archive_path=archive_path,
        observed_at=observed_at,
        classification=classification,
    )
    return _finish(ledger, result, observed_at)


def run_adapter(
    vault: Path,
    source_name: str,
    settings: dict[str, Any],
    ledger: Ledger,
) -> SyncResult:
    adapter = settings.get("adapter")
    if adapter == "github":
        return sync_github(vault, source_name, settings, ledger)
    if adapter == "chatgpt_export":
        return sync_chatgpt_export(vault, source_name, settings, ledger)
    if adapter == "inbox":
        return sync_inbox(vault, source_name, settings, ledger)
    if adapter == "repository":
        return sync_repository(vault, source_name, settings, ledger)
    raise BrainError(f"{source_name}: unknown adapter {adapter!r}")
