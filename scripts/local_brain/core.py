"""Safe primitives shared by the local-first vault adapters.

The important invariants live here rather than in prompts:

* paths are contained beneath the vault root;
* raw captures are content-addressed, immutable, and never overwritten;
* generated notes update only their generated sentinel block;
* sync state is replaced atomically;
* the audit log is append-only.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

GENERATED_START = "<!-- @generated:start -->"
GENERATED_END = "<!-- @generated:end -->"
USER_START = "<!-- @user:start -->"
USER_END = "<!-- @user:end -->"
CONTROL_MARKERS = (GENERATED_START, GENERATED_END, USER_START, USER_END)
CLASSIFICATION_RANK = {
    "public": 0,
    "private-local": 1,
    "sensitive": 2,
    "restricted": 3,
}
SOURCE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class BrainError(RuntimeError):
    """Raised when an operation would violate a vault safety invariant."""


def utc_now() -> str:
    """Return a stable, second-resolution UTC timestamp."""
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> bytes:
    """Encode JSON deterministically for content hashing and immutable storage."""
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def slug(value: str, fallback: str = "item", limit: int = 96) -> str:
    """Return a filesystem-safe, human-readable slug without path semantics."""
    cleaned = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", value).strip(" .-")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return (cleaned or fallback)[:limit].rstrip(" .-") or fallback


def resolve_in_vault(vault: Path, relative: str | Path) -> Path:
    """Resolve a configured relative path and refuse traversal outside the vault."""
    vault = vault.expanduser().resolve()
    candidate = Path(relative).expanduser()
    if candidate.is_absolute():
        resolved = candidate.resolve()
    else:
        resolved = (vault / candidate).resolve()
    try:
        resolved.relative_to(vault)
    except ValueError as exc:
        raise BrainError(f"path escapes vault: {relative}") from exc
    return resolved


def resolve_in_vault_no_symlinks(vault: Path, relative: str | Path) -> Path:
    """Resolve a relative vault path while rejecting every lexical symlink component."""
    vault = vault.expanduser().resolve()
    relative_path = Path(relative)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise BrainError(f"unsafe vault-relative path: {relative}")
    current = vault
    for part in relative_path.parts:
        if part in ("", "."):
            continue
        current = current / part
        if current.is_symlink():
            raise BrainError(f"refusing symlink in vault path: {relative}")
    return resolve_in_vault(vault, relative_path)


def resolve_input_path(vault: Path, configured: str | Path) -> Path:
    """Resolve an explicit input path.

    Relative inputs are vault-contained inboxes. Absolute inputs are allowed for
    deliberately configured read-only repositories or exports; adapters never
    discover or crawl outside this exact path.
    """
    path = Path(configured).expanduser()
    if path.is_symlink():
        raise BrainError(f"configured input root must not be a symlink: {configured}")
    return path.resolve() if path.is_absolute() else resolve_in_vault_no_symlinks(vault, path)


def _atomic_replace(path: Path, data: bytes, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.parent.is_symlink() or not path.parent.is_dir():
        raise BrainError(f"refusing unsafe destination directory: {path.parent}")
    if path.is_symlink():
        raise BrainError(f"refusing symlink destination: {path}")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temporary)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            temp_path.chmod(mode)
        temp_path.replace(path)
    finally:
        temp_path.unlink(missing_ok=True)


def write_if_absent(path: Path, data: bytes, mode: int = 0o444) -> bool:
    """Create an immutable file once; never replace an existing path."""
    if path.is_symlink():
        raise BrainError(f"refusing symlink at immutable path: {path}")
    if path.exists():
        if not path.is_file():
            raise BrainError(f"immutable path is not a regular file: {path}")
        if path.read_bytes() != data:
            raise BrainError(f"immutable archive collision at {path}")
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.parent.is_symlink() or not path.parent.is_dir():
        raise BrainError(f"refusing unsafe immutable parent: {path.parent}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, mode)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    path.chmod(mode)
    return True


def _append_in_vault_no_follow(
    vault: Path,
    relative: str | Path,
    data: bytes,
    *,
    mode: int = 0o600,
) -> None:
    """Append beneath a vault through directory descriptors when supported."""
    vault = vault.expanduser().resolve()
    relative_path = Path(relative)
    if (
        relative_path.is_absolute()
        or ".." in relative_path.parts
        or not relative_path.name
    ):
        raise BrainError(f"unsafe vault-relative append path: {relative}")
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    directory = getattr(os, "O_DIRECTORY", 0)
    supports_open_at = os.open in getattr(os, "supports_dir_fd", set())
    supports_mkdir_at = os.mkdir in getattr(os, "supports_dir_fd", set())
    if no_follow and supports_open_at and supports_mkdir_at:
        directory_flags = os.O_RDONLY | directory | no_follow
        current_fd: int | None = None
        try:
            current_fd = os.open(vault, directory_flags)
            for part in relative_path.parent.parts:
                try:
                    next_fd = os.open(part, directory_flags, dir_fd=current_fd)
                except FileNotFoundError:
                    try:
                        os.mkdir(part, 0o755, dir_fd=current_fd)
                    except FileExistsError:
                        pass
                    next_fd = os.open(part, directory_flags, dir_fd=current_fd)
                os.close(current_fd)
                current_fd = next_fd
            flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | no_follow
            output_fd = os.open(
                relative_path.name,
                flags,
                mode,
                dir_fd=current_fd,
            )
        except OSError as exc:
            raise BrainError(f"cannot safely append vault file: {relative}") from exc
        finally:
            if current_fd is not None:
                os.close(current_fd)
    else:
        destination = resolve_in_vault_no_symlinks(vault, relative_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination = resolve_in_vault_no_symlinks(vault, relative_path)
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | no_follow
        try:
            output_fd = os.open(destination, flags, mode)
        except OSError as exc:
            raise BrainError(f"cannot safely append vault file: {relative}") from exc
    with os.fdopen(output_fd, "ab") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def _yaml_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(str(value), ensure_ascii=False)


def render_frontmatter(fields: dict[str, Any]) -> str:
    lines = ["---"]
    for key, value in fields.items():
        if isinstance(value, list):
            lines.append(f"{key}:")
            lines.extend(f"  - {_yaml_scalar(item)}" for item in value)
        else:
            lines.append(f"{key}: {_yaml_scalar(value)}")
    lines.append("---")
    return "\n".join(lines)


def ensure_frontmatter_fields(
    path: Path,
    fields: dict[str, Any],
    *,
    dry_run: bool = False,
) -> str:
    """Add missing managed metadata without replacing any existing field."""
    if path.is_symlink() or not path.is_file():
        raise BrainError(f"refusing non-regular managed note: {path}")
    original = path.read_text(encoding="utf-8")
    if not original.startswith("---\n"):
        raise BrainError(f"refusing to alter missing or malformed frontmatter: {path}")
    closing = original.find("\n---\n", 4)
    if closing < 0:
        raise BrainError(f"refusing to alter unterminated frontmatter: {path}")
    frontmatter = original[4:closing]
    present = set(re.findall(r"^([A-Za-z0-9_-]+):", frontmatter, flags=re.MULTILINE))
    missing = {key: value for key, value in fields.items() if key not in present}
    if not missing:
        return "unchanged"
    rendered = render_frontmatter(missing).splitlines()[1:-1]
    revised = original[:closing] + "\n" + "\n".join(rendered) + original[closing:]
    if not dry_run:
        _atomic_replace(path, revised.encode("utf-8"), mode=path.stat().st_mode & 0o777)
    return "updated"


def ensure_classification(path: Path, desired: str, *, dry_run: bool = False) -> str:
    """Add or monotonically strengthen a managed note's classification."""
    if desired not in CLASSIFICATION_RANK:
        raise BrainError(f"invalid desired classification: {desired!r}")
    if path.is_symlink() or not path.is_file():
        raise BrainError(f"refusing non-regular managed note: {path}")
    original = path.read_text(encoding="utf-8")
    if not original.startswith("---\n"):
        raise BrainError(f"refusing to classify missing or malformed frontmatter: {path}")
    closing = original.find("\n---\n", 4)
    if closing < 0:
        raise BrainError(f"refusing to classify unterminated frontmatter: {path}")
    frontmatter = original[4:closing]
    pattern = re.compile(r"^classification:[^\n]*$", re.MULTILINE)
    matches = list(pattern.finditer(frontmatter))
    if not matches:
        return ensure_frontmatter_fields(path, {"classification": desired}, dry_run=dry_run)
    if len(matches) != 1:
        raise BrainError(f"duplicate classification keys at {path}")
    match = matches[0]
    raw_value = match.group(0).split(":", 1)[1].strip()
    allowed = "|".join(re.escape(value) for value in CLASSIFICATION_RANK)
    value_match = re.fullmatch(
        rf'(?:"(?P<double>{allowed})"|\'(?P<single>{allowed})\'|(?P<plain>{allowed}))'
        r"\s*(?:#.*)?",
        raw_value,
    )
    if not value_match:
        raise BrainError(f"invalid existing classification {raw_value!r} at {path}")
    current = next(value for value in value_match.groupdict().values() if value is not None)
    if CLASSIFICATION_RANK[desired] < CLASSIFICATION_RANK[current]:
        raise BrainError(
            f"refusing automatic classification downgrade from {current} to {desired} at {path}; "
            "declassification requires a separate explicit review"
        )
    if desired == current:
        return "unchanged"
    revised_frontmatter = pattern.sub(f"classification: {_yaml_scalar(desired)}", frontmatter, count=1)
    revised = original[:4] + revised_frontmatter + original[closing:]
    if not dry_run:
        _atomic_replace(path, revised.encode("utf-8"), mode=path.stat().st_mode & 0o777)
    return "updated"


def _neutralize_control_markers(value: str) -> str:
    """Keep imported text from impersonating note ownership boundaries."""
    for marker in CONTROL_MARKERS:
        value = value.replace(marker, marker.replace("<", "&lt;", 1))
    return value


def upsert_generated_note(
    path: Path,
    *,
    title: str,
    frontmatter: dict[str, Any],
    generated: str,
    future_agent: str,
    dry_run: bool = False,
) -> str:
    """Create or safely refresh a note while preserving all human-owned prose."""
    safe_generated = _neutralize_control_markers(generated.strip())
    generated_block = f"{GENERATED_START}\n{safe_generated}\n{GENERATED_END}"
    if path.exists():
        if path.is_symlink() or not path.is_file():
            raise BrainError(f"refusing non-regular generated note: {path}")
        original = path.read_text(encoding="utf-8")
        if (
            original.count(GENERATED_START) != 1
            or original.count(GENERATED_END) != 1
            or original.find(GENERATED_END)
            < original.find(GENERATED_START) + len(GENERATED_START)
        ):
            raise BrainError(f"refusing to rewrite note without one ordered generated block: {path}")
        classification_status = "unchanged"
        if "classification" in frontmatter:
            classification_status = ensure_classification(
                path,
                str(frontmatter["classification"]),
                dry_run=dry_run,
            )
        original = path.read_text(encoding="utf-8")
        start = original.index(GENERATED_START)
        end = original.index(GENERATED_END, start) + len(GENERATED_END)
        revised = original[:start] + generated_block + original[end:]
        if revised == original and classification_status == "unchanged":
            return "unchanged"
        if not dry_run:
            _atomic_replace(path, revised.encode("utf-8"), mode=path.stat().st_mode & 0o777)
        return "updated"

    safe_title = _neutralize_control_markers(re.sub(r"\s+", " ", title).strip()) or "Untitled"
    safe_title = (
        safe_title.replace("\\", "\\\\")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("`", "\\`")
        .replace("!", "\\!")
        .replace("[", "\\[")
        .replace("]", "\\]")
    )
    safe_future_agent = _neutralize_control_markers(future_agent.strip())
    document = (
        f"{render_frontmatter(frontmatter)}\n\n"
        f"# {safe_title}\n\n"
        f"## For future agent\n\n{safe_future_agent}\n\n"
        f"{generated_block}\n\n"
        f"{USER_START}\n## Cruz's notes\n\n"
        "Add interpretations, decisions, corrections, and links here. This block is never rewritten.\n"
        f"{USER_END}\n"
    )
    if not dry_run:
        _atomic_replace(path, document.encode("utf-8"), mode=0o644)
    return "created"


@dataclass
class SyncResult:
    source: str
    classification: str = "private-local"
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    archived: int = 0
    warnings: list[str] = field(default_factory=list)

    @property
    def changed(self) -> int:
        return self.created + self.updated


class Ledger:
    """Atomic sync cursor plus append-only event history."""

    def __init__(self, vault: Path, dry_run: bool = False):
        self.vault = vault.resolve()
        self.dry_run = dry_run
        self.state_path = resolve_in_vault_no_symlinks(
            vault,
            "90 System/Ledger/sync-state.json",
        )
        self.events_path = resolve_in_vault_no_symlinks(
            vault,
            "90 System/Ledger/events.jsonl",
        )
        self.state: dict[str, Any] = {"schema_version": 1, "sources": {}}
        if self.state_path.exists():
            try:
                loaded = json.loads(self.state_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise BrainError(f"invalid sync state: {self.state_path}") from exc
            if not isinstance(loaded, dict) or loaded.get("schema_version") != 1:
                raise BrainError(f"unsupported sync state schema: {self.state_path}")
            self.state = loaded

    def item(self, source: str, item_id: str) -> dict[str, Any] | None:
        return self.state.get("sources", {}).get(source, {}).get("items", {}).get(item_id)

    def remember(
        self,
        source: str,
        item_id: str,
        *,
        content_hash: str,
        archive_path: str,
        observed_at: str,
        classification: str = "private-local",
    ) -> None:
        source_state = self.state.setdefault("sources", {}).setdefault(source, {"items": {}})
        source_state.setdefault("items", {})[item_id] = {
            "content_hash": content_hash,
            "archive_path": archive_path,
            "observed_at": observed_at,
            "classification": classification,
        }
        source_state["last_success_at"] = observed_at

    def mark_source_success(self, source: str, observed_at: str) -> None:
        source_state = self.state.setdefault("sources", {}).setdefault(source, {"items": {}})
        source_state.setdefault("items", {})
        source_state["last_success_at"] = observed_at

    def save(self) -> None:
        if self.dry_run:
            return
        _atomic_replace(self.state_path, canonical_json(self.state), mode=0o600)

    def event(self, payload: dict[str, Any]) -> None:
        if self.dry_run:
            return
        if self.events_path.is_symlink():
            raise BrainError(f"refusing symlinked event ledger: {self.events_path}")
        _append_in_vault_no_follow(
            self.vault,
            "90 System/Ledger/events.jsonl",
            canonical_json(payload),
        )


def archive_bytes(
    vault: Path,
    *,
    source: str,
    data: bytes,
    extension: str,
    metadata: dict[str, Any],
    observed_at: str,
    dry_run: bool = False,
) -> tuple[str, str, bool]:
    """Store immutable content plus de-duplicated append-only observations."""
    vault = vault.expanduser().resolve()
    digest = sha256_bytes(data)
    try:
        stamp = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise BrainError(f"invalid observed_at timestamp: {observed_at}") from exc
    suffix = (extension if extension.startswith(".") else f".{extension}").lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,16}", suffix):
        raise BrainError(f"unsafe raw archive extension: {extension!r}")
    raw_root = resolve_in_vault_no_symlinks(vault, "20 Sources/Raw")
    observation_records: list[Path] = []
    if raw_root.exists():
        if not raw_root.is_dir():
            raise BrainError(f"raw archive root is not a directory: {raw_root}")
        for raw_source in sorted(raw_root.iterdir()):
            if raw_source.is_symlink():
                raise BrainError(f"refusing symlinked raw source root: {raw_source}")
            if not raw_source.is_dir():
                continue
            observation_parent = raw_source / "observations"
            if observation_parent.is_symlink():
                raise BrainError(f"refusing symlinked raw observation root: {observation_parent}")
            digest_observations = observation_parent / digest
            if digest_observations.is_symlink():
                raise BrainError(
                    f"refusing symlinked raw digest observation root: {digest_observations}"
                )
            if digest_observations.is_dir():
                observation_records.extend(sorted(digest_observations.glob("*.meta.json")))
    existing_payloads = []
    if raw_root.exists():
        existing_payloads = sorted(
            candidate
            for candidate in raw_root.rglob(f"{digest}.*")
            if candidate.is_file()
            and not candidate.is_symlink()
            and candidate.name != f"{digest}.meta.json"
            and "observations" not in candidate.relative_to(raw_root).parts
        )
    if existing_payloads:
        payload_path = existing_payloads[0]
        for candidate in existing_payloads:
            if candidate.read_bytes() != data:
                raise BrainError(f"SHA-256 archive collision at {candidate}")
        folder = payload_path.parent
    else:
        folder = resolve_in_vault_no_symlinks(
            vault,
            Path("20 Sources/Raw") / slug(source, "source") / f"{stamp:%Y}" / f"{stamp:%m}",
        )
        payload_path = folder / f"{digest}{suffix}"
    metadata_path = folder / f"{digest}.meta.json"
    classification = str(metadata.get("classification", "private-local"))
    if classification not in CLASSIFICATION_RANK:
        raise BrainError(f"invalid raw classification: {classification!r}")
    payload_relative = payload_path.relative_to(vault).as_posix()
    sidecar = {
        "schema_version": 1,
        **metadata,
        "source": source,
        "content_hash": f"sha256:{digest}",
        "observed_at": observed_at,
        "payload": payload_relative,
        "classification": classification,
    }
    observations_root = resolve_in_vault_no_symlinks(
        vault,
        Path("20 Sources/Raw") / slug(source, "source") / "observations" / digest,
    )
    observation_identity = {
        "schema_version": 1,
        "source": source,
        "content_hash": f"sha256:{digest}",
        "payload": payload_relative,
        "classification": classification,
        "classification_rank": CLASSIFICATION_RANK[classification],
        "metadata": metadata,
    }
    observation_digest = sha256_bytes(canonical_json(observation_identity))
    observation_path = observations_root / f"{observation_digest}.meta.json"
    observation = {**observation_identity, "first_observed_at": observed_at}

    existing_classifications: list[str] = []
    record_paths = [candidate.parent / f"{digest}.meta.json" for candidate in existing_payloads]
    if not record_paths:
        record_paths = [metadata_path]
    record_paths.extend(observation_records)
    for record_path in record_paths:
        if record_path.is_symlink():
            raise BrainError(f"refusing symlinked immutable raw metadata: {record_path}")
        if not record_path.exists():
            continue
        if not record_path.is_file():
            raise BrainError(f"raw metadata is not a regular file: {record_path}")
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise BrainError(f"invalid immutable raw metadata: {record_path}") from exc
        if record.get("content_hash") != f"sha256:{digest}":
            raise BrainError(f"raw provenance mismatch at {record_path}")
        recorded_classification = str(record.get("classification", "private-local"))
        if recorded_classification not in CLASSIFICATION_RANK:
            raise BrainError(f"invalid raw classification at {record_path}")
        existing_classifications.append(recorded_classification)
    if existing_classifications:
        strongest = max(existing_classifications, key=CLASSIFICATION_RANK.__getitem__)
        if CLASSIFICATION_RANK[classification] < CLASSIFICATION_RANK[strongest]:
            raise BrainError(
                f"refusing automatic raw classification downgrade from {strongest} "
                f"to {classification} for sha256:{digest}"
            )
    created = not existing_payloads
    if not dry_run:
        write_if_absent(payload_path, data)
        # The sidecar describes the first immutable capture. Later sightings of
        # the same bytes belong in the cursor/event ledger; rewriting the
        # sidecar would violate immutability and make a no-op sync fail merely
        # because its observation timestamp is newer.
        if not metadata_path.exists():
            write_if_absent(metadata_path, canonical_json(sidecar))
        if not observation_path.exists():
            write_if_absent(observation_path, canonical_json(observation))
    return payload_relative, digest, created


def observed_item_classifications(vault: Path, source: str) -> dict[str, str]:
    """Return the strongest immutable classification recorded for each source item."""
    source_root = resolve_in_vault_no_symlinks(
        vault,
        Path("20 Sources/Raw") / slug(source, "source"),
    )
    if not source_root.exists():
        return {}
    classifications: dict[str, str] = {}
    for path in sorted(source_root.rglob("*")):
        if path.is_symlink():
            raise BrainError(f"refusing symlink in immutable source history: {path}")
        if not path.is_file() or not path.name.endswith(".meta.json"):
            continue
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise BrainError(f"invalid immutable source history: {path}") from exc
        if record.get("source") != source:
            continue
        metadata = record.get("metadata")
        item_id = (
            metadata.get("item_id")
            if isinstance(metadata, dict)
            else record.get("item_id")
        )
        if not isinstance(item_id, str):
            continue
        classification = str(record.get("classification", "private-local"))
        if classification not in CLASSIFICATION_RANK:
            raise BrainError(f"invalid raw classification at {path}")
        current = classifications.get(item_id)
        if current is None or CLASSIFICATION_RANK[classification] > CLASSIFICATION_RANK[current]:
            classifications[item_id] = classification
    return classifications


def load_config(path: Path) -> dict[str, Any]:
    if path.is_symlink():
        raise BrainError(f"refusing symlinked config: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise BrainError(f"config not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise BrainError(f"invalid config JSON at {path}: {exc}") from exc
    data = _expand_env(data)
    if data.get("schema_version") != 1 or not isinstance(data.get("sources"), dict):
        raise BrainError("config must have schema_version 1 and a sources object")
    privacy = data.get("privacy")
    if not isinstance(privacy, dict):
        raise BrainError("config must have a privacy object")
    if privacy.get("default_classification") not in {
        "private-local",
        "sensitive",
        "restricted",
    }:
        raise BrainError("config privacy.default_classification is invalid")
    if privacy.get("cloud_embedding_allowed", False) is not False:
        raise BrainError("config privacy.cloud_embedding_allowed must remain false")
    if privacy.get("auto_publish_allowed", False) is not False:
        raise BrainError("config privacy.auto_publish_allowed must remain false")
    if privacy.get("raw_archives_immutable", True) is not True:
        raise BrainError("config privacy.raw_archives_immutable must remain true")
    source_slugs: dict[str, str] = {}
    for name, settings in data["sources"].items():
        if not isinstance(name, str) or not isinstance(settings, dict):
            raise BrainError("every configured source must be a named object")
        if not SOURCE_NAME_RE.fullmatch(name):
            raise BrainError(f"configured source name is unsafe: {name!r}")
        filesystem_slug = slug(name, "source").casefold()
        if filesystem_slug in source_slugs:
            raise BrainError(
                "configured source names collide on disk: "
                f"{source_slugs[filesystem_slug]!r} and {name!r}"
            )
        source_slugs[filesystem_slug] = name
        if type(settings.get("enabled")) is not bool:
            raise BrainError(f"source {name!r} enabled must be a boolean")
        if settings.get("adapter") not in {"github", "chatgpt_export", "inbox", "repository"}:
            raise BrainError(f"source {name!r} adapter is invalid")
        if "include_private" in settings and type(settings["include_private"]) is not bool:
            raise BrainError(f"source {name!r} include_private must be a boolean")
        if "classification" in settings and settings["classification"] not in CLASSIFICATION_RANK:
            raise BrainError(f"source {name!r} classification is invalid")
    return data


def _expand_env(value: Any) -> Any:
    if isinstance(value, str):
        return os.path.expandvars(value)
    if isinstance(value, list):
        return [_expand_env(item) for item in value]
    if isinstance(value, dict):
        return {key: _expand_env(item) for key, item in value.items()}
    return value
