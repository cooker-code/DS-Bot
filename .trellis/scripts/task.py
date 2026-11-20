#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Task Management Script.

Usage:
    python3 task.py create "<title>" --description "<desc>" [--slug <name>] [--assignee <dev>] [--priority P0|P1|P2|P3] [--parent <dir>] [--package <pkg>] [--no-start] [--force]
    python3 task.py add-context <dir> <file> <path> [reason] # Add jsonl entry
    python3 task.py validate <dir>              # Validate jsonl files
    python3 task.py list-context <dir>          # List jsonl entries
    python3 task.py start <dir>                 # Set active task, record current branch
    python3 task.py current [--source] [--json] # Show active task
    python3 task.py finish                      # Clear active task
    python3 task.py delivery-status [task] [--json] # Read local delivery receipt
    python3 task.py deliver <task> --mode local-merge|pr|retain [--authorize] [--reason TEXT] [--json]
    python3 task.py set-branch <dir> <branch>   # Set git branch
    python3 task.py set-base-branch <dir> <branch>  # Set PR target branch
    python3 task.py set-scope <dir> <scope>     # Set scope for PR title
    python3 task.py set-meta <dir> <key> <value>  # Set a task metadata key
    python3 task.py set-planning-profile <dir> [profile flags]  # Classify planning scope
    python3 task.py planning-status <dir>         # Show planning contract status
    python3 task.py prototype-status <dir>      # Show the current UI prototype contract
    python3 task.py approve-prototype <dir> <evidence>  # Approve the current UI prototype
    python3 task.py archive <task-dir>          # Archive completed task
    python3 task.py list                        # List active tasks
    python3 task.py list-archive [month]        # List archived tasks
    python3 task.py add-subtask <parent-dir> <child-dir>     # Link child to parent
    python3 task.py remove-subtask <parent-dir> <child-dir>  # Unlink child from parent
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# This script is stamped into user repositories. Avoid creating untracked
# __pycache__ files merely by inspecting or delivering a Task.
sys.dont_write_bytecode = True

from common.i18n import set_locale, t
from common.log import Colors, colored
from common.paths import (
    DEVELOPER_HINT,
    DIR_WORKFLOW,
    DIR_TASKS,
    FILE_TASK_JSON,
    get_repo_root,
    get_developer,
    get_tasks_dir,
    get_current_task,
)
from common.active_task import (
    clear_active_task,
    resolve_active_task,
    resolve_context_key,
    set_active_task,
)
from common.git import current_branch_name
from common.io import (
    describe_json_read_failure,
    read_json,
    read_json_checked,
    write_json,
)
from common.task_utils import resolve_task_dir, run_task_hooks
from common.tasks import iter_active_tasks, children_progress
from common.workflow_selection import WORKFLOW_ID_RE, workflow_md_for_task
from common.prototype_gate import (
    APPROVED_STATUS,
    approve_ui_prototype,
    compute_artifact_digest,
    is_ui_task,
    load_ui_manifest,
    validate_ui_prototype,
)
from common.planning_gate import (
    PROFILE_FIELDS,
    apply_planning_profile,
    planning_status,
    sync_ui_prototype_block,
    ui_prototype_block_current,
    validate_planning_contract,
)

# Import command handlers from split modules (also re-exports for plan.py compatibility)
from common.task_store import (
    cmd_create,
    cmd_rename,
    cmd_archive,
    cmd_set_branch,
    cmd_set_base_branch,
    cmd_set_scope,
    cmd_set_meta,
    cmd_add_subtask,
    cmd_remove_subtask,
)
from common.task_context import (
    cmd_add_context,
    cmd_validate,
    cmd_list_context,
    curated_entry_count,
)
from common.delivery import cmd_deliver, cmd_delivery_cleanup, cmd_delivery_status


# =============================================================================
# Command: start / finish
# =============================================================================

def _print_prototype_errors(
    errors: list[str], heading_key: str = "prototype_gate.blocked"
) -> None:
    """Print localized, actionable prototype-gate failures."""
    print(colored(t(heading_key), Colors.RED))
    for error in errors:
        print(f"  - {t('prototype_gate.' + error)}")


def _print_planning_errors(
    errors: list[str], heading_key: str = "planning_gate.blocked"
) -> None:
    """Print localized, actionable planning-contract failures."""
    print(colored(t(heading_key), Colors.RED))
    for error in errors:
        print(f"  - {t('planning_gate.' + error)}")


def _start_json_read_error(path: Path, reason: str | None) -> tuple[str, str]:
    """Return localized start diagnostics for an invalid task record."""
    suffix = {
        "missing": "missing",
        "invalid": "invalid",
        "unreadable": "unreadable",
        "not-object": "not_object",
        "empty": "empty",
        "undecodable": "undecodable",
    }.get(reason, "unknown")
    return (
        t(f"task.start_json_{suffix}", path=path),
        t(f"task.start_json_{suffix}_hint"),
    )


def _record_start_state(
    task_json_path: Path,
    repo_root: Path,
    label: str = "",
) -> None:
    """Move a freshly started task to in_progress and record its branch.

    Both updates share one read/write: the status flip from planning, and the
    checked-out branch when `branch` is still empty. Recording at start is what
    keeps `branch` trustworthy at archive time — a task whose branch is only
    ever set by hand tends to reach archive with `branch: null`.

    Tolerant on purpose — a broken task.json does not fail `start`, because the
    session pointer is the point of the command. But the read overwrites the
    file it just read, so no failure may be silent: without a message the
    absent status line looks like the task simply was not in planning.
    """
    data, reason = read_json_checked(task_json_path)
    if data is None:
        problem, hint = describe_json_read_failure(task_json_path, reason)
        print(
            colored(f"Warning: {problem}; task.json not updated.", Colors.YELLOW),
            file=sys.stderr,
        )
        print(hint, file=sys.stderr)
        return

    applied: list[str] = []

    if data.get("status") == "planning":
        data["status"] = "in_progress"
        applied.append(t("task.status_started_degraded" if label else "task.status_started"))

    # Only fill an empty field: an explicit `set-branch` must survive a later
    # `start` (re-starting a task after a checkout is a normal thing to do).
    base_branch_conflict: str | None = None
    if not data.get("branch"):
        branch = current_branch_name(repo_root)
        if branch:
            data["branch"] = branch
            applied.append(f"✓ Branch recorded: {branch}{label}")
            if branch == data.get("base_branch"):
                base_branch_conflict = branch
        else:
            print(
                colored(
                    "Note: no checked-out branch (detached HEAD, or not a git "
                    "repository); task branch not recorded.",
                    Colors.YELLOW,
                ),
                file=sys.stderr,
            )

    if not applied:
        return

    if not write_json(task_json_path, data):
        print(
            colored(
                f"Warning: Failed to write {task_json_path}; "
                "status and branch are unchanged.",
                Colors.YELLOW,
            ),
            file=sys.stderr,
        )
        return

    for line in applied:
        print(colored(line, Colors.GREEN))

    if base_branch_conflict:
        # Recorded anyway — the value is true, it just cannot describe a PR.
        # Archive refuses this shape, so say so now rather than at the gate.
        print(
            colored(
                f"Warning: '{base_branch_conflict}' is also this task's base_branch; "
                "a PR cannot target its own branch, and archive will refuse it.",
                Colors.YELLOW,
            ),
            file=sys.stderr,
        )
        print(
            f"Once you branch off, run: python3 {DIR_WORKFLOW}/scripts/task.py "
            "set-branch <task> <feature-branch>",
            file=sys.stderr,
        )


def cmd_start(args: argparse.Namespace) -> int:
    """Set active task."""
    repo_root = get_repo_root()
    task_input = args.dir

    if not task_input:
        print(colored(t("task.start_required"), Colors.RED))
        return 1

    # Resolve task directory (supports task name, relative path, or absolute path)
    full_path = resolve_task_dir(task_input, repo_root)

    if full_path is None:
        # resolve_task_dir already named the exact reason on stderr. A second,
        # generic line on stdout would split one diagnosis across two streams
        # and bury the specific message.
        return 1

    if not full_path.is_dir():
        print(colored(t("task.task_not_found", task=task_input), Colors.RED))
        print(t("task.task_lookup_hint"))
        return 1

    # Context-manifest gate (#573): a seeded-but-uncurated implement/check
    # manifest means every sub-agent dispatched for this task runs with zero
    # spec context, and nothing downstream surfaces that to the main session.
    # An absent manifest is not gated — create seeds the files only on
    # sub-agent-capable platforms, so absence means no sub-agent reads them.
    if not getattr(args, "allow_empty_context", False):
        empty_manifests = [
            name
            for name in ("implement.jsonl", "check.jsonl")
            if curated_entry_count(full_path / name) == 0
        ]
        if empty_manifests:
            print(colored(
                f"Error: {' and '.join(empty_manifests)} "
                f"{'has' if len(empty_manifests) == 1 else 'have'} no curated entries",
                Colors.RED,
            ))
            print("Sub-agents (implement/check) would run with zero spec context.")
            print(f"  Curate:  python3 .trellis/scripts/task.py add-context {task_input} implement <path> \"<why>\"")
            print(f"  Verify:  python3 .trellis/scripts/task.py validate {task_input}")
            print("  Intentionally empty? Re-run start with --allow-empty-context")
            return 1

    # Convert to relative path for storage. repo_root is resolved because
    # full_path already is (resolve_task_dir only returns paths inside the
    # resolved root), so an unresolved repo_root would mismatch under a
    # symlink (e.g. /tmp on macOS) and reject a perfectly normal task.
    try:
        task_dir = full_path.relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        # resolve_task_dir already refused everything outside the repo, so
        # this is unreachable in practice. Refuse rather than fall back to
        # str(full_path) — that fallback (a lexical relative_to() paired with
        # an absolute-path fallback) is exactly the pattern that let a `..`
        # ref escape into storage before this fix.
        print(colored(f"Error: Task not found: {task_input}", Colors.RED))
        print("Hint: Use task name (e.g., 'my-task') or full path (e.g., '.trellis/tasks/01-31-my-task')")
        return 1

    task_json_path = full_path / FILE_TASK_JSON
    task_data, read_reason = read_json_checked(task_json_path)
    if task_data is None:
        problem, hint = _start_json_read_error(task_json_path, read_reason)
        print(colored(problem, Colors.RED), file=sys.stderr)
        print(hint, file=sys.stderr)
        return 1

    # Versioned planning validation shares the prototype gate's no-side-effect
    # boundary. Legacy tasks return no errors and retain prior behavior.
    planning_errors = validate_planning_contract(full_path, task_data)
    if planning_errors:
        _print_planning_errors(planning_errors)
        return 1

    # This must remain before every start side effect: both the normal pointer
    # branch and degraded mode share this check.
    _, prototype_errors = validate_ui_prototype(full_path, task_data)
    if prototype_errors:
        _print_prototype_errors(prototype_errors)
        return 1

    if not resolve_context_key():
        # Degraded mode: no session identity available.
        # Hook didn't inject TRELLIS_CONTEXT_ID (common on Windows + Claude Code,
        # --continue resume path, fork distribution, hooks disabled, etc.). Skip
        # per-session pointer write; AI continues based on conversation context.
        print(colored(
            t("task.session_identity_unavailable"),
            Colors.YELLOW,
        ))
        print(colored(
            t("task.session_identity_hint"),
            Colors.YELLOW,
        ))

        # Still flip task.json status: planning → in_progress so downstream phases proceed.
        if task_json_path.is_file():
            _record_start_state(task_json_path, repo_root, " (degraded)")
            run_task_hooks("after_start", task_json_path, repo_root)
        return 0

    active = set_active_task(task_dir, repo_root)
    if active:
        print(colored(t("task.current_set", task=task_dir), Colors.GREEN))
        print(f"Source: {active.source}")

        if task_json_path.is_file():
            _record_start_state(task_json_path, repo_root)

        print()
        print(colored(t("task.context_injection_hint"), Colors.BLUE))

        run_task_hooks("after_start", task_json_path, repo_root)
        return 0
    else:
        print(colored(t("task.set_current_failed"), Colors.RED))
        return 1


def cmd_approve_prototype(args: argparse.Namespace) -> int:
    """Bind explicit approval evidence to the current UI prototype digest."""
    repo_root = get_repo_root()
    task_dir = resolve_task_dir(args.dir, repo_root)
    if task_dir is None:
        return 1
    task_json_path = task_dir / FILE_TASK_JSON
    task_data = read_json(task_json_path) if task_json_path.is_file() else None
    if not isinstance(task_data, dict):
        print(colored(t("task.task_not_found", task=args.dir), Colors.RED))
        return 1
    if not is_ui_task(task_data):
        _print_prototype_errors(["not_ui_task"], "prototype_gate.approval_failed")
        return 1
    original_manifest, original_errors = load_ui_manifest(task_dir, task_data)
    if original_errors or not isinstance(original_manifest, dict):
        _print_prototype_errors(
            original_errors or ["invalid_manifest"], "prototype_gate.approval_failed"
        )
        return 1
    digest, errors = approve_ui_prototype(task_dir, task_data, args.evidence)
    if errors:
        _print_prototype_errors(errors, "prototype_gate.approval_failed")
        return 1
    manifest, manifest_errors = load_ui_manifest(task_dir, task_data)
    if manifest_errors or not isinstance(manifest, dict):
        _print_prototype_errors(
            manifest_errors or ["invalid_manifest"], "prototype_gate.approval_failed"
        )
        return 1
    prd_errors = sync_ui_prototype_block(
        task_dir,
        entry=str(manifest.get("entry", "")),
        preview=str(manifest.get("preview", "")),
        status=str(manifest.get("status", "")),
        digest=digest,
    )
    if prd_errors:
        if not write_json(task_dir / "prototype" / "manifest.json", original_manifest):
            prd_errors.append("prototype_rollback_failed")
        _print_planning_errors(prd_errors, "planning_gate.prototype_sync_failed")
        return 1
    print(colored(t("prototype_gate.approved", digest=digest), Colors.GREEN))
    return 0


def cmd_prototype_status(args: argparse.Namespace) -> int:
    """Print the current UI prototype contract and freshly computed digest."""
    repo_root = get_repo_root()
    task_dir = resolve_task_dir(args.dir, repo_root)
    if task_dir is None:
        return 1
    task_json_path = task_dir / FILE_TASK_JSON
    task_data = read_json(task_json_path) if task_json_path.is_file() else None
    if not isinstance(task_data, dict):
        print(colored(t("task.task_not_found", task=args.dir), Colors.RED))
        return 1
    if not is_ui_task(task_data):
        _print_prototype_errors(["not_ui_task"], "prototype_gate.status_failed")
        return 1
    manifest, errors = load_ui_manifest(task_dir, task_data)
    if errors:
        _print_prototype_errors(errors, "prototype_gate.status_failed")
        return 1
    assert manifest is not None
    digest, errors = compute_artifact_digest(task_dir, manifest)
    if errors:
        _print_prototype_errors(errors, "prototype_gate.status_failed")
        return 1
    assert digest is not None
    evidence = manifest.get("approval_evidence")
    approval_current = (
        manifest.get("status") == APPROVED_STATUS
        and manifest.get("artifact_digest") == digest
        and manifest.get("approved_digest") == digest
        and isinstance(evidence, str)
        and bool(evidence.strip())
    )
    prd_reference_current = ui_prototype_block_current(
        task_dir,
        entry=str(manifest.get("entry", "")),
        preview=str(manifest.get("preview", "")),
        status=str(manifest.get("status", "")),
        digest=digest if manifest.get("status") == APPROVED_STATUS else None,
    )
    print(json.dumps({
        "entry": manifest.get("entry"),
        "preview": manifest.get("preview"),
        "status": manifest.get("status"),
        "current_digest": digest,
        "artifact_digest": manifest.get("artifact_digest"),
        "approved_digest": manifest.get("approved_digest"),
        "approval_evidence": evidence,
        "approval_current": approval_current,
        "prd_reference_current": prd_reference_current,
    }, ensure_ascii=False, indent=2))
    return 0


def cmd_set_planning_profile(args: argparse.Namespace) -> int:
    """Persist all complexity answers together and derive the planning tier."""
    repo_root = get_repo_root()
    task_dir = resolve_task_dir(args.dir, repo_root)
    if task_dir is None:
        return 1
    task_json_path = task_dir / FILE_TASK_JSON
    task_data = read_json(task_json_path) if task_json_path.is_file() else None
    if not isinstance(task_data, dict):
        print(colored(t("task.task_not_found", task=args.dir), Colors.RED))
        return 1
    values = {field: getattr(args, field) for field in PROFILE_FIELDS}
    updated, errors = apply_planning_profile(task_data, values)
    if errors or updated is None:
        _print_planning_errors(errors, "planning_gate.profile_failed")
        return 1
    if not write_json(task_json_path, updated):
        _print_planning_errors(["task_write_failed"], "planning_gate.profile_failed")
        return 1
    meta = updated.get("meta", {})
    print(colored(t("planning_gate.profile_saved", tier=meta.get("planning_tier")), Colors.GREEN))
    return 0


def cmd_planning_status(args: argparse.Namespace) -> int:
    """Print the side-effect-free planning-contract report."""
    repo_root = get_repo_root()
    task_dir = resolve_task_dir(args.dir, repo_root)
    if task_dir is None:
        return 1
    task_json_path = task_dir / FILE_TASK_JSON
    task_data = read_json(task_json_path) if task_json_path.is_file() else None
    if not isinstance(task_data, dict):
        print(colored(t("task.task_not_found", task=args.dir), Colors.RED))
        return 1
    report = planning_status(task_dir, task_data)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report.get("valid") else 1


def cmd_finish(args: argparse.Namespace) -> int:
    """Clear active task."""
    repo_root = get_repo_root()
    active = clear_active_task(repo_root)
    current = active.task_path

    if not current:
        print(colored(t("task.no_current"), Colors.YELLOW))
        return 0

    # Resolve task.json path before clearing
    task_json_path = repo_root / current / FILE_TASK_JSON

    print(colored(t("task.current_cleared", task=current), Colors.GREEN))
    print(f"Source: {active.source}")

    if task_json_path.is_file():
        run_task_hooks("after_finish", task_json_path, repo_root)
    return 0


# =============================================================================
# Command: workflow
# =============================================================================

def cmd_workflow(args: argparse.Namespace) -> int:
    """Set or clear the workflow selection on the current session's active task."""
    repo_root = get_repo_root()
    if args.clear and args.id:
        print(colored(t("task.workflow_choose_one"), Colors.RED))
        return 1
    if not args.clear and not args.id:
        print(colored(t("task.workflow_id_required"), Colors.RED))
        return 1

    active = resolve_active_task(repo_root)
    if not active.task_path:
        print(colored(t("task.no_current_task"), Colors.RED))
        return 1
    task_dir = repo_root / active.task_path
    task_json_path = task_dir / FILE_TASK_JSON
    data = read_json(task_json_path)
    if not data:
        print(colored(t("task.workflow_read_failed", path=task_json_path), Colors.RED))
        return 1

    if args.clear:
        if data.pop("workflow", None) is None:
            print(colored(t("task.workflow_not_set"), Colors.YELLOW))
        elif not write_json(task_json_path, data):
            print(colored(t("task.workflow_write_failed"), Colors.RED))
            return 1
        else:
            print(colored(t("task.workflow_cleared"), Colors.GREEN))
    else:
        workflow_id = args.id
        if not WORKFLOW_ID_RE.match(workflow_id):
            print(colored(t("task.workflow_invalid", workflow=workflow_id), Colors.RED))
            return 1
        data["workflow"] = workflow_id
        if not write_json(task_json_path, data):
            print(colored(t("task.workflow_write_failed"), Colors.RED))
            return 1
        print(colored(t("task.workflow_set", workflow=workflow_id), Colors.GREEN))

    effective = workflow_md_for_task(repo_root, task_dir)
    try:
        effective_display = effective.relative_to(repo_root).as_posix()
    except ValueError:
        effective_display = str(effective)
    print(t("task.workflow_effective", path=effective_display))
    return 0


def cmd_current(args: argparse.Namespace) -> int:
    """Show active task."""
    repo_root = get_repo_root()
    active = resolve_active_task(repo_root)

    if getattr(args, "json", False):
        task_obj = None
        read_error = None
        if active.task_path:
            task_json_path = repo_root / active.task_path / FILE_TASK_JSON
            data, reason = read_json_checked(task_json_path)
            if data is None:
                # Without this, a corrupt task.json emits null for every field
                # — indistinguishable from a task whose fields really are null.
                problem, hint = describe_json_read_failure(task_json_path, reason)
                read_error = {
                    "file": str(task_json_path),
                    "reason": reason,
                    "message": f"{problem}. {hint}",
                }
                data = {}
            task_obj = {
                "dir": active.task_path,
                "id": data.get("id") or data.get("name"),
                "title": data.get("title"),
                "status": data.get("status"),
                "parent": data.get("parent"),
                "children": data.get("children", []),
                "branch": data.get("branch"),
                "base_branch": data.get("base_branch"),
            }
        payload = {
            "current_task": task_obj,
            "source": active.source,
            "stale": active.stale,
        }
        # Only present when the read failed, so the healthy shape is unchanged.
        if read_error:
            payload["error"] = read_error
        print(json.dumps(payload, ensure_ascii=False))
        return 0 if active.task_path else 1

    if args.source:
        print(f"Current task: {active.task_path or '(none)'}")
        print(f"Source: {active.source}")
        if active.stale:
            print("State: stale")
        return 0 if active.task_path else 1

    if active.task_path:
        print(active.task_path)
        return 0

    return 1


# =============================================================================
# Command: list
# =============================================================================

def _display_status(t, all_statuses: dict) -> str:
    """Return the status label to show for a task in `list` output.

    A parent task's stored status stays "planning" until someone runs
    `task.py start` on the parent directly, even while its children are
    actively being worked — a misleading label for anyone scanning the
    list (#399 item 3). Show "active" instead when at least one child is
    past planning; the stored status.json value is left untouched.
    """
    if t.status == "planning" and t.children:
        child_in_flight = any(
            all_statuses.get(c) not in (None, "planning") for c in t.children
        )
        if child_in_flight:
            return "active"
    return t.status


def cmd_list(args: argparse.Namespace) -> int:
    """List active tasks."""
    repo_root = get_repo_root()
    tasks_dir = get_tasks_dir(repo_root)
    current_task = get_current_task(repo_root)
    developer = get_developer(repo_root)
    filter_mine = args.mine
    filter_status = args.status
    as_json = getattr(args, "json", False)

    # Single pass: collect all tasks via shared iterator
    all_tasks = {t.dir_name: t for t in iter_active_tasks(tasks_dir)}
    all_statuses = {name: t.status for name, t in all_tasks.items()}

    if as_json:
        if filter_mine and not developer:
            print(
                json.dumps({"error": "No developer set", "hint": DEVELOPER_HINT}),
                file=sys.stderr,
            )
            return 1

        items = []
        for dir_name in sorted(all_tasks.keys()):
            task = all_tasks[dir_name]
            if filter_mine and (task.assignee or "-") != developer:
                continue
            if filter_status and task.status != filter_status:
                continue
            items.append({
                "dir": f"{DIR_WORKFLOW}/{DIR_TASKS}/{dir_name}",
                "id": task.raw.get("id") or dir_name,
                "title": task.title,
                "status": task.status,
                "display_status": _display_status(task, all_statuses),
                "priority": task.priority,
                "assignee": task.assignee or None,
                "parent": task.parent,
                "children": list(task.children),
                "package": task.package,
            })
        print(json.dumps({"tasks": items}, ensure_ascii=False))
        return 0

    if filter_mine:
        if not developer:
            print(colored(t("task.no_developer"), Colors.RED), file=sys.stderr)
            return 1
        print(colored(t("task.my_tasks_header", developer=developer), Colors.BLUE))
    else:
        print(colored(t("task.all_tasks_header"), Colors.BLUE))
    print()

    # Display tasks hierarchically
    count = 0

    def _print_task(dir_name: str, indent: int = 0) -> None:
        nonlocal count
        task = all_tasks[dir_name]

        # Apply --mine filter
        if filter_mine and (task.assignee or "-") != developer:
            return

        # Apply --status filter
        if filter_status and task.status != filter_status:
            return

        relative_path = f"{DIR_WORKFLOW}/{DIR_TASKS}/{dir_name}"
        marker = ""
        if relative_path == current_task:
            marker = f" {colored(t('task.current_marker'), Colors.GREEN)}"

        # Children progress
        progress = children_progress(task.children, all_statuses)
        status_label = _display_status(task, all_statuses)

        # Package tag
        pkg_tag = f" @{task.package}" if task.package else ""

        prefix = "  " * indent + "  - "

        if filter_mine:
            print(f"{prefix}{dir_name}/ ({status_label}){pkg_tag}{progress}{marker}")
        else:
            print(f"{prefix}{dir_name}/ ({status_label}){pkg_tag}{progress} [{colored(task.assignee or '-', Colors.CYAN)}]{marker}")
        count += 1

        # Print children indented
        for child_name in task.children:
            if child_name in all_tasks:
                _print_task(child_name, indent + 1)

    # Display only top-level tasks: those without a parent, plus orphans
    # whose recorded parent is not (or no longer) in the active set — a
    # dangling parent ref must still render flat instead of disappearing.
    for dir_name in sorted(all_tasks.keys()):
        parent = all_tasks[dir_name].parent
        if not parent or parent not in all_tasks:
            _print_task(dir_name)

    if count == 0:
        if filter_mine:
            print(t("task.no_assigned", prefix="  "))
        else:
            print(t("task.no_active", prefix="  "))

    print()
    print(t("task.total", count=count))
    return 0


# =============================================================================
# Command: list-archive
# =============================================================================

def cmd_list_archive(args: argparse.Namespace) -> int:
    """List archived tasks."""
    repo_root = get_repo_root()
    tasks_dir = get_tasks_dir(repo_root)
    archive_dir = tasks_dir / "archive"
    month = args.month

    print(colored(t("task.archived_header"), Colors.BLUE))
    print()

    if month:
        month_dir = archive_dir / month
        if month_dir.is_dir():
            print(f"[{month}]")
            for d in sorted(month_dir.iterdir()):
                if d.is_dir():
                    print(f"  - {d.name}/")
        else:
            print(t("task.no_archives_for_month", month=month))
    else:
        if archive_dir.is_dir():
            for month_dir in sorted(archive_dir.iterdir()):
                if month_dir.is_dir():
                    month_name = month_dir.name
                    count = sum(1 for d in month_dir.iterdir() if d.is_dir())
                    print(t("task.archive_month_count", month=month_name, count=count))

    return 0


# =============================================================================
# Help
# =============================================================================

def show_usage() -> None:
    """Show usage help."""
    print(t("task.usage"))


# =============================================================================
# Main Entry
# =============================================================================

def main() -> int:
    """CLI entry point."""
    set_locale()

    # Deprecation guard: `init-context` was removed in v0.5.0-beta.12.
    # Detect early so argparse doesn't mask the real reason with a generic
    # "invalid choice" error.
    if len(sys.argv) >= 2 and sys.argv[1] == "init-context":
        print(
            colored(
                t("task.init_context_removed"),
                Colors.RED,
            ),
            file=sys.stderr,
        )
        print(
            t("task.init_context_seeded"),
            file=sys.stderr,
        )
        print(
            t("task.init_context_curated"),
            file=sys.stderr,
        )
        print(t("task.init_context_guidance"), file=sys.stderr)
        print(
            "  python3 ./.trellis/scripts/get_context.py --mode phase --step 1",
            file=sys.stderr,
        )
        print(
            t("task.init_context_append"),
            file=sys.stderr,
        )
        return 2

    parser = argparse.ArgumentParser(
        description=t("task.arg_description"),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", help=t("task.arg_commands"))

    # create
    p_create = subparsers.add_parser("create", help=t("task.arg_create"))
    p_create.add_argument("title", help=t("task.arg_title"))
    p_create.add_argument("--slug", "-s", help=t("task.arg_slug"))
    p_create.add_argument("--assignee", "-a", help=t("task.arg_assignee"))
    p_create.add_argument("--priority", "-p", default="P2", help=t("task.arg_priority"))
    p_create.add_argument("--description", "-d", help=t("task.arg_task_description"))
    p_create.add_argument("--parent", help=t("task.arg_parent"))
    p_create.add_argument("--package", help=t("task.arg_package"))
    p_create.add_argument("--base-branch", help=t("task.arg_create_base_branch"))
    p_create.add_argument("--meta", action="append", help=t("task.arg_meta"))
    p_create.add_argument("--no-start", action="store_true", help=t("task.arg_no_start"))
    p_create.add_argument("--workflow", help=t("task.arg_create_workflow"))
    p_create.add_argument("--force", action="store_true", help="Overwrite an existing task on explicit request")

    # add-context
    p_add = subparsers.add_parser("add-context", help=t("task.arg_add_context"))
    p_add.add_argument("dir", help=t("task.arg_dir"))
    p_add.add_argument("file", help=t("task.arg_jsonl"))
    p_add.add_argument("path", help=t("task.arg_path"))
    p_add.add_argument("reason", nargs="?", help=t("task.arg_reason"))

    # validate
    p_validate = subparsers.add_parser("validate", help=t("task.arg_validate"))
    p_validate.add_argument("dir", help=t("task.arg_dir"))

    # list-context
    p_listctx = subparsers.add_parser("list-context", help=t("task.arg_list_context"))
    p_listctx.add_argument("dir", help=t("task.arg_dir"))

    # start
    p_start = subparsers.add_parser("start", help=t("task.arg_start"))
    p_start.add_argument("dir", help=t("task.arg_dir"))
    p_start.add_argument("--allow-empty-context", action="store_true", help="Start with uncurated context manifests")

    # current
    p_current = subparsers.add_parser("current", help=t("task.arg_current"))
    p_current.add_argument("--source", action="store_true",
                           help=t("task.arg_source"))
    p_current.add_argument("--json", action="store_true", help=t("task.arg_json"))

    # finish
    subparsers.add_parser("finish", help=t("task.arg_finish"))

    # workflow
    p_workflow = subparsers.add_parser("workflow", help=t("task.arg_workflow"))
    p_workflow.add_argument("id", nargs="?", help=t("task.arg_workflow_id"))
    p_workflow.add_argument("--clear", action="store_true", help=t("task.arg_workflow_clear"))

    # delivery lifecycle. The status command is intentionally read-only; the
    # write-capable command requires a mode-specific explicit flag/reason.
    p_delivery_status = subparsers.add_parser(
        "delivery-status", help="Show the local Git delivery receipt"
    )
    p_delivery_status.add_argument("task", nargs="?", help=t("task.arg_dir"))
    p_delivery_status.add_argument("--json", action="store_true", help=t("task.arg_json"))
    p_deliver = subparsers.add_parser("deliver", help="Perform an authorized delivery action")
    p_deliver.add_argument("task", help=t("task.arg_dir"))
    p_deliver.add_argument("--mode", required=True, choices=("local-merge", "pr", "retain"))
    p_deliver.add_argument("--authorize", action="store_true", help="Authorize local merge for this invocation")
    p_deliver.add_argument("--reason", help="Required explicit reason when retaining a branch")
    p_deliver.add_argument("--json", action="store_true", help=t("task.arg_json"))
    p_cleanup = subparsers.add_parser("delivery-cleanup", help="Perform explicitly authorized delivery cleanup")
    p_cleanup.add_argument("task", help=t("task.arg_dir"))
    p_cleanup.add_argument("--remove-worktree", action="store_true")
    p_cleanup.add_argument("--delete-branch", action="store_true")
    p_cleanup.add_argument("--authorize", action="store_true")
    p_cleanup.add_argument("--json", action="store_true", help=t("task.arg_json"))

    # set-branch
    p_branch = subparsers.add_parser("set-branch", help=t("task.arg_set_branch"))
    p_branch.add_argument("dir", help=t("task.arg_dir"))
    p_branch.add_argument("branch", help=t("task.arg_branch"))

    # set-base-branch
    p_base = subparsers.add_parser("set-base-branch", help=t("task.arg_set_base"))
    p_base.add_argument("dir", help=t("task.arg_dir"))
    p_base.add_argument("base_branch", help=t("task.arg_base_branch"))

    # set-scope
    p_scope = subparsers.add_parser("set-scope", help=t("task.arg_set_scope"))
    p_scope.add_argument("dir", help=t("task.arg_dir"))
    p_scope.add_argument("scope", help=t("task.arg_scope"))

    # set-meta
    p_setmeta = subparsers.add_parser("set-meta", help=t("task.arg_set_meta"))
    p_setmeta.add_argument("dir", help=t("task.arg_dir"))
    p_setmeta.add_argument("key", help=t("task.arg_meta_key"))
    p_setmeta.add_argument("value", help=t("task.arg_meta_value"))

    # set-planning-profile
    p_profile = subparsers.add_parser(
        "set-planning-profile", help=t("task.arg_set_planning_profile")
    )
    p_profile.add_argument("dir", help=t("task.arg_dir"))
    for field in PROFILE_FIELDS:
        p_profile.add_argument(
            "--" + field.replace("_", "-"),
            dest=field,
            required=True,
            choices=("true", "false"),
            help=t("task.arg_" + field),
        )

    # planning-status
    p_planning_status = subparsers.add_parser(
        "planning-status", help=t("task.arg_planning_status")
    )
    p_planning_status.add_argument("dir", help=t("task.arg_dir"))

    # prototype-status
    p_prototype_status = subparsers.add_parser(
        "prototype-status", help=t("task.arg_prototype_status")
    )
    p_prototype_status.add_argument("dir", help=t("task.arg_dir"))

    # approve-prototype
    p_approve_prototype = subparsers.add_parser(
        "approve-prototype", help=t("task.arg_approve_prototype")
    )
    p_approve_prototype.add_argument("dir", help=t("task.arg_dir"))
    p_approve_prototype.add_argument("evidence", help=t("task.arg_approval_evidence"))

    # rename
    p_rename = subparsers.add_parser("rename", help="Rename task and its references")
    p_rename.add_argument("name", help="Task directory or name")
    p_rename.add_argument("new_slug", help="New slug without the MM-DD date prefix")
    p_rename.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the change set without writing anything",
    )

    # archive
    p_archive = subparsers.add_parser("archive", help=t("task.arg_archive"))
    p_archive.add_argument("name", help=t("task.arg_name"))
    p_archive.add_argument("--no-commit", action="store_true", help=t("task.arg_no_commit"))
    p_archive.add_argument("--skip-branch-validation", action="store_true", help="Archive despite missing or self-referential branch metadata")

    # list
    p_list = subparsers.add_parser("list", help=t("task.arg_list"))
    p_list.add_argument("--mine", "-m", action="store_true", help=t("task.arg_mine"))
    p_list.add_argument("--status", "-s", help=t("task.arg_status"))
    p_list.add_argument("--json", action="store_true", help=t("task.arg_json"))

    # add-subtask
    p_addsub = subparsers.add_parser("add-subtask", help=t("task.arg_add_subtask"))
    p_addsub.add_argument("parent_dir", help=t("task.arg_parent_dir"))
    p_addsub.add_argument("child_dir", help=t("task.arg_child_dir"))

    # remove-subtask
    p_rmsub = subparsers.add_parser("remove-subtask", help=t("task.arg_remove_subtask"))
    p_rmsub.add_argument("parent_dir", help=t("task.arg_parent_dir"))
    p_rmsub.add_argument("child_dir", help=t("task.arg_child_dir"))

    # list-archive
    p_listarch = subparsers.add_parser("list-archive", help=t("task.arg_list_archive"))
    p_listarch.add_argument("month", nargs="?", help=t("task.arg_month"))

    args = parser.parse_args()

    if not args.command:
        show_usage()
        return 1

    commands = {
        "create": cmd_create,
        "add-context": cmd_add_context,
        "validate": cmd_validate,
        "list-context": cmd_list_context,
        "start": cmd_start,
        "current": cmd_current,
        "finish": cmd_finish,
        "workflow": cmd_workflow,
        "delivery-status": cmd_delivery_status,
        "deliver": cmd_deliver,
        "delivery-cleanup": cmd_delivery_cleanup,
        "set-branch": cmd_set_branch,
        "set-base-branch": cmd_set_base_branch,
        "set-scope": cmd_set_scope,
        "set-meta": cmd_set_meta,
        "set-planning-profile": cmd_set_planning_profile,
        "planning-status": cmd_planning_status,
        "prototype-status": cmd_prototype_status,
        "approve-prototype": cmd_approve_prototype,
        "rename": cmd_rename,
        "archive": cmd_archive,
        "add-subtask": cmd_add_subtask,
        "remove-subtask": cmd_remove_subtask,
        "list": cmd_list,
        "list-archive": cmd_list_archive,
    }

    if args.command in commands:
        return commands[args.command](args)
    else:
        show_usage()
        return 1


if __name__ == "__main__":
    sys.exit(main())
