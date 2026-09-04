"""Command-line entry point for the local-first AI vault."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .adapters import run_adapter
from .core import (
    GENERATED_END,
    GENERATED_START,
    USER_END,
    USER_START,
    BrainError,
    Ledger,
    canonical_json,
    load_config,
    resolve_in_vault,
    resolve_in_vault_no_symlinks,
    sha256_bytes,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE_ROOT = REPO_ROOT / "starter-vault"
CONFIG_TEMPLATE = REPO_ROOT / "config" / "local-ai-vault.example.json"
LOCAL_SKILLS_ROOT = REPO_ROOT / "local-skills"
LOCAL_CURATED_SKILLS = (
    "cruz-fde-coach",
    "cruz-local-vault",
    "cruz-source-review",
    "cruz-vault-search",
)
CURATED_SKILLS = LOCAL_CURATED_SKILLS
SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
PUSH_GUARD_MARKER = "local-brain-private-vault-guard:v1"


def _safe_git_env() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update({"GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"})
    return env


def _copy_template(vault: Path, owner: str) -> tuple[int, int, int]:
    if not TEMPLATE_ROOT.is_dir():
        raise BrainError(f"starter template missing: {TEMPLATE_ROOT}")
    created = 0
    unchanged = 0
    preserved = 0
    for source in sorted(TEMPLATE_ROOT.rglob("*")):
        relative = source.relative_to(TEMPLATE_ROOT)
        target = resolve_in_vault_no_symlinks(vault, relative)
        if source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        data = source.read_bytes()
        if source.suffix.lower() in {".json", ".md", ".txt"}:
            data = data.replace(b"{{OWNER}}", owner.encode("utf-8"))
        if target.exists():
            if target.read_bytes() == data:
                unchanged += 1
            else:
                preserved += 1
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        created += 1
    return created, unchanged, preserved


def _write_local_config(vault: Path, account: str) -> bool:
    target = resolve_in_vault_no_symlinks(vault, ".brain/config.json")
    if target.exists():
        return False
    config = json.loads(CONFIG_TEMPLATE.read_text(encoding="utf-8"))
    config["owner"] = "Cruz"
    if account:
        config["sources"]["github"]["account"] = account
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(canonical_json(config))
    target.chmod(0o600)
    return True


def _copy_public_schemas(vault: Path) -> tuple[int, int, int]:
    created = 0
    unchanged = 0
    preserved = 0
    for source in sorted((REPO_ROOT / "schemas").glob("*.schema.json")):
        target = resolve_in_vault_no_symlinks(
            vault,
            Path("90 System/Schemas") / source.name,
        )
        data = source.read_bytes()
        if target.exists():
            if target.read_bytes() != data:
                preserved += 1
            else:
                unchanged += 1
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        created += 1
    return created, unchanged, preserved


def _push_guard_text() -> str:
    return (
        "#!/bin/sh\n"
        f"# {PUSH_GUARD_MARKER}\n"
        "if [ \"${ALLOW_PRIVATE_VAULT_PUSH:-0}\" != \"1\" ]; then\n"
        "  echo 'Push blocked: this vault is local-only. Set ALLOW_PRIVATE_VAULT_PUSH=1 only after configuring an encrypted/private destination.' >&2\n"
        "  exit 1\n"
        "fi\n"
    )


def _effective_pre_push_hook(vault: Path) -> Path:
    vault = vault.expanduser().resolve()
    git_dir = vault / ".git"
    if git_dir.is_symlink() or not git_dir.is_dir():
        raise BrainError("local Git metadata must be a regular in-vault .git directory")
    hooks_dir = git_dir / "hooks"
    if hooks_dir.is_symlink():
        raise BrainError("refusing symlinked local Git hooks directory")
    if hooks_dir.exists() and not hooks_dir.is_dir():
        raise BrainError("local Git hooks path is not a directory")

    configured = subprocess.run(
        ["git", "-C", str(vault), "config", "--get", "core.hooksPath"],
        check=False,
        capture_output=True,
        text=True,
        env=_safe_git_env(),
    )
    if configured.returncode not in (0, 1):
        raise BrainError(
            f"cannot inspect the local Git hook configuration: {configured.stderr.strip()}"
        )
    if configured.returncode == 0:
        raise BrainError(
            f"custom core.hooksPath is set to {configured.stdout.strip()!r}; "
            "refusing to claim the private-vault guard is installed"
        )
    hook = hooks_dir / "pre-push"
    if hook.is_symlink():
        raise BrainError("refusing symlinked local Git pre-push hook")
    if hook.exists() and not hook.is_file():
        raise BrainError("local Git pre-push hook is not a regular file")
    return hook


def _init_local_git(vault: Path) -> str:
    git_dir = vault / ".git"
    created = False
    if git_dir.is_symlink():
        raise BrainError("refusing symlinked local Git metadata directory")
    if git_dir.exists() and not git_dir.is_dir():
        raise BrainError("local Git metadata must be a directory")
    if git_dir.exists():
        status = "existing"
    else:
        completed = subprocess.run(
            ["git", "init", "-b", "main", str(vault)],
            check=False,
            capture_output=True,
            text=True,
            env=_safe_git_env(),
        )
        if completed.returncode != 0:
            raise BrainError(f"git init failed: {completed.stderr.strip()}")
        created = True
        status = "created"
    hook = _effective_pre_push_hook(vault)
    hook.parent.mkdir(parents=True, exist_ok=True)
    if hook.parent.is_symlink() or not hook.parent.is_dir():
        raise BrainError("refusing unsafe local Git hooks directory")
    if hook.exists():
        content = hook.read_text(encoding="utf-8", errors="replace")
        if content == _push_guard_text():
            hook.chmod(0o700)
            return status
        if PUSH_GUARD_MARKER in content:
            raise BrainError(
                "existing private-vault pre-push guard was modified; refusing to overwrite it"
            )
        if "Push blocked: this vault is local-only" in content:
            status = f"{status}-guard-upgraded"
        else:
            raise BrainError(
                "existing pre-push hook was preserved but lacks the private-vault guard; "
                "compose it with the local-brain guard before using this repository"
            )
    elif not created:
        status = f"{status}-guard-added"
    hook.write_text(_push_guard_text(), encoding="utf-8")
    hook.chmod(0o700)
    return status


def _validate_vault_destination(vault: Path, *, allow_ignored_subdir: bool = False) -> None:
    """Prevent initialization from writing into the public foundation checkout."""
    foundation = REPO_ROOT.resolve()
    if vault == foundation:
        raise BrainError("refusing to initialize the public foundation repository as a private vault")
    try:
        relative = vault.relative_to(foundation)
    except ValueError:
        return
    intended = foundation / "vault"
    if vault != intended and not allow_ignored_subdir:
        raise BrainError(
            "a vault inside the foundation checkout must use the ignored vault/ path; "
            "pass --allow-ignored-subdir only for an intentional ignored test location"
        )
    ignored = subprocess.run(
        [
            "git",
            "-C",
            str(foundation),
            "check-ignore",
            "-q",
            "--no-index",
            "--",
            relative.as_posix(),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=_safe_git_env(),
    )
    if ignored.returncode != 0:
        raise BrainError(f"refusing non-ignored vault path inside the public checkout: {relative}")
    tracked = subprocess.run(
        ["git", "-C", str(foundation), "ls-files", "--", relative.as_posix()],
        check=False,
        capture_output=True,
        text=True,
        env=_safe_git_env(),
    )
    if tracked.returncode != 0 or tracked.stdout.strip():
        raise BrainError(f"refusing tracked vault path inside the public checkout: {relative}")


def command_init(args: argparse.Namespace) -> int:
    requested_vault = Path(args.vault).expanduser()
    if requested_vault.is_symlink():
        raise BrainError("refusing a symlinked vault destination")
    vault = requested_vault.resolve()
    _validate_vault_destination(
        vault,
        allow_ignored_subdir=bool(getattr(args, "allow_ignored_subdir", False)),
    )
    vault.mkdir(parents=True, exist_ok=True)
    created, unchanged, preserved = _copy_template(vault, args.name)
    schema_created, schema_unchanged, schema_preserved = _copy_public_schemas(vault)
    config_created = _write_local_config(vault, args.github_account)
    git_status = "disabled" if args.no_git else _init_local_git(vault)
    print(f"Initialized local AI vault at {vault}")
    print(
        f"Template files: {created} created, {unchanged} already identical, "
        f"{preserved} changed files preserved"
    )
    print(
        f"Schemas: {schema_created} created, {schema_unchanged} already identical, "
        f"{schema_preserved} changed files preserved"
    )
    print(f"Private config: {'created' if config_created else 'kept existing'}")
    print(f"Local Git safety boundary: {git_status}")
    return 0


def _copy_skill_tree(source: Path, target: Path) -> int:
    if source.is_symlink() or not source.is_dir():
        raise BrainError(f"refusing non-regular Agent Skill source: {source}")
    count = 0
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise BrainError(f"refusing symlink in Agent Skill source: {path}")
        relative = path.relative_to(source)
        destination = target / relative
        if path.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
        count += 1
    return count


def _skill_manifest(skill_root: Path, names: list[str], mode: str) -> dict[str, Any]:
    files: dict[str, str] = {}
    for name in names:
        for path in sorted((skill_root / name).rglob("*")):
            if path.is_file():
                relative = path.relative_to(skill_root).as_posix()
                files[relative] = f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"
    revision = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
        check=False,
        capture_output=True,
        text=True,
        env=_safe_git_env(),
    ).stdout.strip()
    tree_hash = hashlib.sha256(canonical_json(files)).hexdigest()
    dirty = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "status", "--porcelain", "--untracked-files=normal"],
        check=False,
        capture_output=True,
        text=True,
        env=_safe_git_env(),
    ).stdout.strip()
    return {
        "schema_version": 1,
        "source": "reviewed-local-brain-checkout",
        "source_revision": revision,
        "source_worktree_dirty": bool(dirty),
        "source_tree_hash": f"sha256:{tree_hash}",
        "mode": mode,
        "owned_skills": names,
        "files": files,
    }


def _load_skill_manifest(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BrainError(f"invalid Agent Skills ownership manifest: {path}") from exc
    if (
        data.get("schema_version") != 1
        or not isinstance(data.get("owned_skills"), list)
        or not isinstance(data.get("files"), dict)
    ):
        raise BrainError(f"unsupported Agent Skills ownership manifest: {path}")
    data["owned_skills"] = _validated_skill_names(
        data["owned_skills"],
        label="Agent Skills ownership manifest",
    )
    return data


def _validated_skill_names(values: Any, *, label: str) -> list[str]:
    if not isinstance(values, (list, tuple)):
        raise BrainError(f"{label} must be a list")
    result: list[str] = []
    for value in values:
        if not isinstance(value, str) or not SKILL_NAME_RE.fullmatch(value):
            raise BrainError(f"{label} contains an unsafe skill name: {value!r}")
        if value in result:
            raise BrainError(f"{label} contains a duplicate skill name: {value}")
        result.append(value)
    return result


def command_install_skills(args: argparse.Namespace) -> int:
    vault = Path(args.vault).expanduser().resolve()
    if not (vault / ".obsidian").is_dir():
        raise BrainError(f"not an initialized Obsidian vault: {vault}")
    if not LOCAL_SKILLS_ROOT.is_dir():
        raise BrainError(f"local Agent Skills source is missing: {LOCAL_SKILLS_ROOT}")
    sources = {path.name: path for path in LOCAL_SKILLS_ROOT.iterdir() if path.is_dir()}
    if args.full:
        build = subprocess.run(
            ["bash", str(REPO_ROOT / "scripts" / "build.sh"), "--platform", "agent-skills"],
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if build.returncode != 0:
            raise BrainError(f"Agent Skills build failed: {build.stderr.strip()}")
        upstream_source = REPO_ROOT / "dist" / "agent-skills" / "skills"
        sources.update(
            {path.name: path for path in upstream_source.iterdir() if path.is_dir()}
        )
    target_lexical = vault / ".agents" / "skills"
    if target_lexical.is_symlink():
        raise BrainError("refusing symlinked Agent Skills destination")
    target = resolve_in_vault_no_symlinks(vault, ".agents/skills")
    available = _validated_skill_names(sorted(sources), label="available Agent Skills")
    selected = available if args.full else _validated_skill_names(
        CURATED_SKILLS,
        label="curated Agent Skills",
    )
    missing = sorted(set(selected) - set(available))
    if missing:
        raise BrainError(f"built Agent Skills missing expected entries: {', '.join(missing)}")

    manifest_path = resolve_in_vault_no_symlinks(
        vault,
        ".brain/agent-skills-manifest.json",
    )
    previous_manifest = _load_skill_manifest(manifest_path)
    existing = target.exists() and any(target.iterdir())
    if existing and not args.refresh:
        raise BrainError("skills already installed; pass --refresh to replace them with a backed-up build")
    if existing and previous_manifest is None:
        raise BrainError("cannot refresh skills without an ownership manifest; unrelated skills may exist")

    previous_owned = set(previous_manifest.get("owned_skills", [])) if previous_manifest else set()
    for name in selected:
        if (target / name).exists() and name not in previous_owned:
            raise BrainError(f"refusing to replace unrelated skill: {name}")

    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    stage = resolve_in_vault_no_symlinks(vault, f".brain/staging/agent-skills-{stamp}")
    backup = resolve_in_vault_no_symlinks(vault, f".brain/backups/agent-skills-{stamp}")
    if stage.exists() or backup.exists():
        raise BrainError("skill staging path already exists; retry after the current second")
    stage.mkdir(parents=True)
    count = 0
    for name in selected:
        count += _copy_skill_tree(sources[name], stage / name)

    staged_manifest = _skill_manifest(stage, selected, "full" if args.full else "curated")
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_fd, manifest_temp_name = tempfile.mkstemp(
        prefix=f".{manifest_path.name}.",
        suffix=".tmp",
        dir=manifest_path.parent,
    )
    manifest_temp = Path(manifest_temp_name)
    with os.fdopen(manifest_fd, "wb") as handle:
        handle.write(canonical_json(staged_manifest))
        handle.flush()
        os.fsync(handle.fileno())
    manifest_temp.chmod(0o600)

    target.mkdir(parents=True, exist_ok=True)
    moved_new: list[str] = []
    moved_old: list[str] = []
    try:
        if previous_owned:
            backup.mkdir(parents=True)
            for name in sorted(previous_owned):
                old = target / name
                if old.exists():
                    old.replace(backup / name)
                    moved_old.append(name)
        for name in selected:
            (stage / name).replace(target / name)
            moved_new.append(name)
        manifest_temp.replace(manifest_path)
    except BaseException:
        for name in moved_new:
            shutil.rmtree(target / name, ignore_errors=True)
        for name in moved_old:
            if (backup / name).exists():
                (backup / name).replace(target / name)
        raise
    finally:
        manifest_temp.unlink(missing_ok=True)
        shutil.rmtree(stage, ignore_errors=True)
        try:
            stage.parent.rmdir()
        except OSError:
            pass

    if moved_old:
        print(f"Previous owned skills backed up to {backup}")
    if args.full:
        print("WARN Full mode includes generic upstream write skills; review their folder assumptions.")
    print(f"Installed {len(selected)} {'full' if args.full else 'curated'} Agent Skills ({count} files)")
    print(f"Ownership manifest: {manifest_path}")
    return 0


def _configured_path(vault: Path, args: argparse.Namespace) -> Path:
    if args.config:
        configured = Path(args.config).expanduser()
        if configured.is_symlink():
            raise BrainError("private config must not be a symlink")
        return configured.resolve()
    return resolve_in_vault_no_symlinks(vault, ".brain/config.json")


def command_sync(args: argparse.Namespace) -> int:
    vault = Path(args.vault).expanduser().resolve()
    config = load_config(_configured_path(vault, args))
    default_classification = str(
        config.get("privacy", {}).get("default_classification", "private-local")
    )
    selected = set(args.source or [])
    unknown = selected - set(config["sources"])
    if unknown:
        raise BrainError(f"unknown source(s): {', '.join(sorted(unknown))}")
    failures: list[str] = []
    ran = 0
    for source_name, settings in config["sources"].items():
        if selected and source_name not in selected:
            continue
        if not settings.get("enabled", False):
            print(f"SKIP {source_name}: disabled in local config")
            continue
        ran += 1
        ledger = Ledger(vault, dry_run=args.dry_run)
        effective_settings = dict(settings)
        effective_settings.setdefault("classification", default_classification)
        try:
            result = run_adapter(vault, source_name, effective_settings, ledger)
        except Exception as exc:
            detail = str(exc) or type(exc).__name__
            failures.append(detail)
            ledger.event(
                {
                    "schema_version": 1,
                    "event": "sync_failed",
                    "source": source_name,
                    "classification": effective_settings["classification"],
                    "observed_at": datetime.now(UTC)
                    .replace(microsecond=0)
                    .isoformat()
                    .replace("+00:00", "Z"),
                    "error_type": type(exc).__name__,
                    "error": detail,
                }
            )
            print(f"ERROR {detail}", file=sys.stderr)
            continue
        mode = "DRY-RUN" if args.dry_run else "SYNC"
        print(
            f"{mode} {source_name}: {result.created} created, {result.updated} updated, "
            f"{result.unchanged} unchanged, {result.archived} raw captures"
        )
        for warning in result.warnings:
            print(f"WARN {source_name}: {warning}")
    if not ran:
        print("No enabled sources selected.")
    return 1 if failures else 0


def _secret_findings(value: Any, prefix: str = "") -> list[str]:
    findings: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            path = f"{prefix}.{key}" if prefix else key
            lowered = key.lower()
            if any(word in lowered for word in ("api_key", "password", "secret", "token")):
                if item not in (None, "", "${REDACTED}"):
                    findings.append(path)
            findings.extend(_secret_findings(item, path))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            findings.extend(_secret_findings(item, f"{prefix}[{index}]"))
    return findings


def _parse_utc(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def _raw_integrity_findings(vault: Path) -> list[str]:
    """Check no-follow, mode, content-address, and observation-record invariants."""
    findings: list[str] = []
    vault = vault.expanduser().resolve()
    try:
        raw_root = resolve_in_vault_no_symlinks(vault, "20 Sources/Raw")
    except BrainError:
        return ["raw archive root escapes the vault"]
    if not raw_root.exists():
        return findings
    if not raw_root.is_dir():
        return ["raw archive root is not a directory"]
    payloads: dict[str, tuple[Path, str]] = {}
    capture_references: set[str] = set()
    observation_references: set[str] = set()
    for path in sorted(raw_root.rglob("*")):
        relative = path.relative_to(raw_root)
        if path.is_symlink():
            findings.append(f"symlink in raw archive: {relative}")
            continue
        if not path.is_file() or path.name == ".gitkeep":
            continue
        if stat.S_IMODE(path.stat().st_mode) & 0o222:
            findings.append(f"mutable raw archive file: {relative}")
        if path.name.endswith(".meta.json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                findings.append(f"invalid raw metadata JSON: {relative}")
                continue
            content_hash = record.get("content_hash")
            payload_relative = record.get("payload")
            classification = record.get("classification", "private-local")
            if (
                not isinstance(content_hash, str)
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", content_hash)
            ):
                findings.append(f"invalid raw metadata hash: {relative}")
                continue
            if classification not in {"public", "private-local", "sensitive", "restricted"}:
                findings.append(f"invalid raw metadata classification: {relative}")
            if not isinstance(payload_relative, str):
                findings.append(f"invalid raw metadata payload path: {relative}")
                continue
            lexical_payload = vault / Path(payload_relative)
            if lexical_payload.is_symlink():
                findings.append(f"symlinked raw payload: {payload_relative}")
                continue
            try:
                payload = resolve_in_vault(vault, payload_relative)
                payload.relative_to(raw_root)
            except (BrainError, ValueError):
                findings.append(f"raw metadata payload escapes archive: {relative}")
                continue
            if not payload.is_file() or payload.is_symlink():
                findings.append(f"raw metadata payload is missing: {relative}")
                continue
            if sha256_bytes(payload.read_bytes()) != content_hash.removeprefix("sha256:"):
                findings.append(f"raw payload hash mismatch: {payload_relative}")
            record_source = record.get("source")
            source_location_matches = (
                isinstance(record_source, str)
                and bool(relative.parts)
                and relative.parts[0] == record_source
            )
            if not source_location_matches:
                findings.append(f"raw metadata source directory mismatch: {relative}")
            if "observations" in relative.parts:
                if (
                    path.parent.name != content_hash.removeprefix("sha256:")
                    or not source_location_matches
                ):
                    findings.append(f"raw observation directory mismatch: {relative}")
                else:
                    observation_references.add(payload_relative)
                identity = dict(record)
                identity.pop("first_observed_at", None)
                expected_name = f"{sha256_bytes(canonical_json(identity))}.meta.json"
                if path.name != expected_name:
                    findings.append(f"raw observation hash mismatch: {relative}")
            else:
                expected_sidecar = payload.with_name(
                    f"{content_hash.removeprefix('sha256:')}.meta.json"
                )
                if path != expected_sidecar or not source_location_matches:
                    findings.append(f"raw first-capture sidecar location mismatch: {relative}")
                else:
                    capture_references.add(payload_relative)
            continue

        if "observations" in relative.parts:
            findings.append(f"unexpected raw observation file: {relative}")
            continue
        expected_digest = path.name.split(".", 1)[0]
        if not re.fullmatch(r"[a-f0-9]{64}", expected_digest):
            findings.append(f"raw payload is not content-addressed: {relative}")
        elif sha256_bytes(path.read_bytes()) != expected_digest:
            findings.append(f"raw payload filename hash mismatch: {relative}")
        else:
            payloads[path.relative_to(vault).as_posix()] = (path, expected_digest)
    for payload_relative, (payload, digest) in sorted(payloads.items()):
        expected_sidecar = payload.with_name(f"{digest}.meta.json")
        if (
            payload_relative not in capture_references
            or not expected_sidecar.is_file()
            or expected_sidecar.is_symlink()
        ):
            findings.append(f"raw payload is missing its first-capture sidecar: {payload_relative}")
        if payload_relative not in observation_references:
            findings.append(f"raw payload is missing an observation record: {payload_relative}")
    return findings


def command_doctor(args: argparse.Namespace) -> int:
    vault = Path(args.vault).expanduser().resolve()
    errors: list[str] = []
    warnings: list[str] = []
    required = [
        ".obsidian/app.json",
        "Home.md",
        "AGENTS.md",
        "_CLAUDE.md",
        "90 System/Policies/Source Boundaries.md",
        "90 System/Policies/Retention Policy.md",
    ]
    for relative in required:
        if not resolve_in_vault(vault, relative).exists():
            errors.append(f"missing required vault file: {relative}")

    config_lexical = (
        Path(args.config).expanduser()
        if args.config
        else vault / ".brain/config.json"
    )
    config_path = _configured_path(vault, args)
    config: dict[str, Any] | None = None
    try:
        config = load_config(config_path)
    except BrainError as exc:
        errors.append(str(exc))
    if config_lexical.is_symlink():
        errors.append("private config must not be a symlink")
    elif config_path.exists() and stat.S_IMODE(config_path.stat().st_mode) != 0o600:
        errors.append("private config must have mode 0600")
    if config:
        secret_paths = _secret_findings(config)
        if secret_paths:
            errors.append("secrets found in config fields: " + ", ".join(secret_paths))

    for note in vault.rglob("*.md") if vault.exists() else []:
        relative_note = note.relative_to(vault)
        if relative_note.parts[:2] == ("20 Sources", "Raw"):
            continue
        if note.is_symlink() or not note.is_file():
            errors.append(f"non-regular Markdown path: {relative_note}")
            continue
        try:
            content = note.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            errors.append(f"non-UTF-8 Markdown: {note.relative_to(vault)}")
            continue
        for start, end, label in (
            (GENERATED_START, GENERATED_END, "generated"),
            (USER_START, USER_END, "user"),
        ):
            start_count = content.count(start)
            end_count = content.count(end)
            if start_count == 0 and end_count == 0:
                continue
            if (
                start_count != 1
                or end_count != 1
                or content.find(start) > content.find(end)
            ):
                errors.append(f"invalid {label} sentinels: {relative_note}")

    errors.extend(_raw_integrity_findings(vault))

    try:
        state_path = resolve_in_vault_no_symlinks(vault, "90 System/Ledger/sync-state.json")
    except BrainError as exc:
        errors.append(str(exc))
        state_path = None
    try:
        events_path = resolve_in_vault_no_symlinks(vault, "90 System/Ledger/events.jsonl")
    except BrainError as exc:
        errors.append(str(exc))
        events_path = None
    if events_path is not None and events_path.exists():
        if not events_path.is_file():
            errors.append("events.jsonl is not a regular file")
        elif stat.S_IMODE(events_path.stat().st_mode) != 0o600:
            errors.append("events.jsonl must have mode 0600")
    if state_path is not None and state_path.exists():
        if not state_path.is_file():
            errors.append("sync-state.json is not a regular file")
            state = None
        else:
            if stat.S_IMODE(state_path.stat().st_mode) != 0o600:
                errors.append("sync-state.json must have mode 0600")
            try:
                state = json.loads(state_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                errors.append("sync-state.json is invalid JSON")
                state = None
        if state is not None:
            now = datetime.now(UTC)
            if config:
                for name, settings in config["sources"].items():
                    if not settings.get("enabled"):
                        continue
                    last = state.get("sources", {}).get(name, {}).get("last_success_at")
                    parsed = _parse_utc(last)
                    if not parsed:
                        warnings.append(f"enabled source has never synced: {name}")
                        continue
                    max_age = float(settings.get("max_age_hours", 168))
                    age_hours = (now - parsed).total_seconds() / 3600
                    if age_hours > max_age:
                        warnings.append(f"stale source: {name} ({age_hours:.1f}h > {max_age:g}h)")

    if (vault / ".git").exists():
        try:
            hook_path = _effective_pre_push_hook(vault)
        except BrainError as exc:
            errors.append(str(exc))
            hook_path = None
        if hook_path is not None and not hook_path.is_file():
            errors.append("local Git pre-push privacy guard is missing")
        elif hook_path is not None:
            hook_text = hook_path.read_text(encoding="utf-8", errors="replace")
            if hook_text != _push_guard_text():
                errors.append("local Git pre-push hook does not exactly match the privacy guard")
            if not (hook_path.stat().st_mode & stat.S_IXUSR):
                errors.append("local Git pre-push privacy guard is not executable")
        for relative in (".brain/config.json", ".agents/probe", ".env"):
            ignored = subprocess.run(
                ["git", "-C", str(vault), "check-ignore", "-q", "--no-index", relative],
                check=False,
                capture_output=True,
                text=True,
                env=_safe_git_env(),
            )
            if ignored.returncode != 0:
                errors.append(f"local Git ignore rules do not protect {relative}")
            tracked = subprocess.run(
                ["git", "-C", str(vault), "ls-files", "--", relative],
                check=False,
                capture_output=True,
                text=True,
                env=_safe_git_env(),
            )
            if tracked.returncode != 0 or tracked.stdout.strip():
                errors.append(f"sensitive local Git path is tracked: {relative}")
        tracked_skills = subprocess.run(
            ["git", "-C", str(vault), "ls-files", "--", ".agents"],
            check=False,
            capture_output=True,
            text=True,
            env=_safe_git_env(),
        )
        if tracked_skills.returncode != 0 or tracked_skills.stdout.strip():
            errors.append("regenerable Agent Skills are tracked by local Git")
        remotes = subprocess.run(
            ["git", "-C", str(vault), "remote"],
            check=False,
            capture_output=True,
            text=True,
            env=_safe_git_env(),
        ).stdout.split()
        if remotes:
            warnings.append("vault has a Git remote; verify it is private and encrypted before pushing")
    else:
        warnings.append("vault is not under local Git; rollback history is unavailable")

    try:
        skills_root = resolve_in_vault_no_symlinks(vault, ".agents/skills")
    except BrainError as exc:
        errors.append(str(exc))
        skill_count = 0
    else:
        unsafe_skill_paths = [path for path in skills_root.rglob("*") if path.is_symlink()]
        for path in unsafe_skill_paths:
            errors.append(f"symlink in Agent Skills tree: {path.relative_to(vault)}")
        skill_count = (
            0
            if unsafe_skill_paths
            else len(
                [
                    path
                    for path in skills_root.glob("*/SKILL.md")
                    if path.is_file() and not path.is_symlink()
                ]
            )
        )
        manifest_path = vault / ".brain" / "agent-skills-manifest.json"
        if skill_count and not manifest_path.exists():
            errors.append("Agent Skills ownership manifest is missing")
        elif manifest_path.exists() and not manifest_path.is_symlink():
            try:
                manifest = _load_skill_manifest(manifest_path)
            except BrainError as exc:
                errors.append(str(exc))
            else:
                assert manifest is not None
                owned = set(manifest["owned_skills"])
                safe_manifest_files: set[str] = set()
                for relative, expected_hash in manifest["files"].items():
                    if not isinstance(relative, str) or not isinstance(expected_hash, str):
                        errors.append("Agent Skills manifest contains an invalid file record")
                        continue
                    relative_path = Path(relative)
                    if (
                        relative_path.is_absolute()
                        or ".." in relative_path.parts
                        or not relative_path.parts
                        or relative_path.parts[0] not in owned
                    ):
                        errors.append(f"Agent Skills manifest contains unsafe path: {relative}")
                        continue
                    safe_manifest_files.add(relative_path.as_posix())
                    try:
                        installed = resolve_in_vault_no_symlinks(
                            vault,
                            Path(".agents/skills") / relative_path,
                        )
                    except BrainError as exc:
                        errors.append(str(exc))
                        continue
                    actual_hash = (
                        f"sha256:{hashlib.sha256(installed.read_bytes()).hexdigest()}"
                        if installed.is_file()
                        else "missing"
                    )
                    if actual_hash != expected_hash:
                        errors.append(f"Agent Skill hash mismatch: {relative}")
                actual_owned_files: set[str] = set()
                for name in sorted(owned):
                    try:
                        owned_root = resolve_in_vault_no_symlinks(
                            vault,
                            Path(".agents/skills") / name,
                        )
                    except BrainError as exc:
                        errors.append(str(exc))
                        continue
                    if not owned_root.is_dir():
                        errors.append(f"owned Agent Skill is missing: {name}")
                        continue
                    for installed in owned_root.rglob("*"):
                        if installed.is_symlink():
                            errors.append(
                                f"symlink in owned Agent Skill: {installed.relative_to(vault)}"
                            )
                        elif installed.is_file():
                            actual_owned_files.add(installed.relative_to(skills_root).as_posix())
                if actual_owned_files != safe_manifest_files:
                    errors.append("Agent Skills manifest file set does not match installed owned files")
        elif manifest_path.is_symlink():
            errors.append("Agent Skills ownership manifest must not be a symlink")
    if skill_count == 0:
        warnings.append("Codex Agent Skills are not installed in the vault")
    print(f"Vault doctor: {len(errors)} error(s), {len(warnings)} warning(s), {skill_count} skills")
    for error in errors:
        print(f"ERROR {error}")
    for warning in warnings:
        print(f"WARN {warning}")
    return 1 if errors else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage Cruz's local-first Obsidian AI vault")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser("init", help="Create the sanitized vault scaffold")
    init.add_argument("--vault", required=True)
    init.add_argument("--name", default="Cruz")
    init.add_argument("--github-account", default="")
    init.add_argument("--no-git", action="store_true")
    init.add_argument(
        "--allow-ignored-subdir",
        action="store_true",
        help="Allow an explicitly ignored in-repository test vault outside vault/",
    )
    init.set_defaults(handler=command_init)

    install = subparsers.add_parser(
        "install-skills",
        help="Install the vault-native Agent Skills",
    )
    install.add_argument("--vault", required=True)
    install.add_argument("--refresh", action="store_true")
    install.add_argument(
        "--full",
        action="store_true",
        help="Also build and install every generic upstream skill for isolated evaluation",
    )
    install.set_defaults(handler=command_install_skills)

    sync = subparsers.add_parser("sync", help="Run configured source adapters")
    sync.add_argument("--vault", required=True)
    sync.add_argument("--config")
    sync.add_argument("--source", action="append", help="Source name; repeat to select several")
    sync.add_argument("--dry-run", action="store_true")
    sync.set_defaults(handler=command_sync)

    doctor = subparsers.add_parser("doctor", help="Validate privacy and vault invariants")
    doctor.add_argument("--vault", required=True)
    doctor.add_argument("--config")
    doctor.set_defaults(handler=command_doctor)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.handler(args))
    except BrainError as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("Interrupted; no in-progress raw file was promoted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
