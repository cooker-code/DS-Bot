"""
Common utilities for Trellis workflow scripts.

This module provides shared functionality used by other Trellis scripts.
"""

from .paths import (
    DIR_WORKFLOW,
    DIR_WORKSPACE,
    DIR_TASKS,
    DIR_ARCHIVE,
    DIR_SPEC,
    DIR_SCRIPTS,
    FILE_DEVELOPER,
    FILE_CURRENT_TASK,
    FILE_TASK_JSON,
    FILE_JOURNAL_PREFIX,
    ENV_DEVELOPER,
    DEVELOPER_HINT,
    get_repo_root,
    get_developer,
    check_developer,
    get_tasks_dir,
    get_workspace_dir,
    get_active_journal_file,
    count_lines,
    get_current_task,
    get_current_task_abs,
    normalize_task_ref,
    resolve_task_ref,
    set_current_task,
    clear_current_task,
    has_current_task,
    generate_task_date_prefix,
)

from .active_task import (
    ActiveTask,
    clear_active_task,
    resolve_active_task,
    resolve_context_key,
    set_active_task,
)
