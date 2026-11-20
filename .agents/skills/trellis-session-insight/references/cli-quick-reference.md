# `trellis mem` CLI 参考

五个子命令的完整参数参考。将本文件作为权威说明：运行时的 `trellis mem help` 会输出同样内容，因此二者有差异即是缺陷。

## 子命令

| 命令 | 用途 |
| --- | --- |
| `list` | 列出会话；未提供子命令时的默认命令。 |
| `search <keyword>` | 查找内容匹配关键字的会话。 |
| `context <session-id>` | 深入一个会话：返回最相关的若干轮及周边上下文；配合 `--grep` 锚定关键字。 |
| `extract <session-id>` | 导出清理后的对话；结合 `--phase` / `--grep` 切分。 |
| `projects` | 列出活跃项目的 `cwd` 及会话数量，用于确定其他子命令应传入哪个 `--cwd`。 |

## 参数（在适用处使用）

| 参数 | 子命令 | 含义 |
| --- | --- | --- |
| `--platform claude\|codex\|devin\|grok\|opencode\|pi\|zcode\|all` | 全部 | 默认 `all`。`devin` 指 Cognition Devin CLI（`sessions.db`），不是 `trellis init --devin`（Desktop）。 |
| `--since YYYY-MM-DD` | list / search | 含当天的日期下界。 |
| `--until YYYY-MM-DD` | list / search | 含当天的日期上界。 |
| `--global` | list / search | 包含本机所有项目的会话；默认仅当前项目 `cwd`。 |
| `--cwd <path>` | list / search | 强制指定项目 cwd，不从当前所在位置推断。 |
| `--limit N` | list / search | 限制输出行数，默认 `50`。 |
| `--grep KW` | extract / context | 按关键字过滤轮次；空白分隔的多个 token 采用 AND。 |
| `--phase brainstorm\|implement\|all` | extract | 按 Trellis task 边界切分会话。`brainstorm` = `[task.py create, task.py start)`；`implement` = brainstorm 窗口以外的轮次；默认 `all`。 |
| `--turns N` | context | 返回命中的轮次数，默认 `3`。 |
| `--around N` | context | 每个命中附带的周边轮次数，默认 `1`。 |
| `--max-chars N` | context | 输出总字符预算，默认 `6000`（约 1500 tokens）。 |
| `--include-children` | search / context | 将 OpenCode 子 Agent 会话合并进父会话。 |
| `--json` | 全部 | 输出机器可解析的 JSON，而非人类可读文本。 |

## 常用单行命令

```bash
# What past sessions discussed "deadlock" anywhere on this machine?
trellis mem search "deadlock" --global --limit 20

# Inside a specific session, surface the top 5 turns that mention "lock contention"
# plus 2 turns of surrounding context.
trellis mem context 5842592d --grep "lock contention" --turns 5 --around 2

# Recover the brainstorm window for a session — useful when continuing a task
# the user started a week ago.
trellis mem extract 5842592d --phase brainstorm

# List every project this machine has Trellis sessions for, with counts.
trellis mem projects
```

## 输出形式

- **默认人类可读输出**（不带 `--json`）：按终端宽度换行，高亮 session id 并显示轮次标记。适合直接阅读，但不适合粘贴到 Markdown 文件。
- **`--json`**：结构稳定，适合解析和后续处理。将 `mem` 输出接入下一步（例如汇总 Lessons 段）时，应优先使用 `--json`。

## 注意事项

- **OpenCode 已由本地只读 SQLite adapter 支持。** 它读取 OpenCode 1.2+ 的 `~/.local/share/opencode/opencode.db`，可用于 list、search、context 和 extract；`--include-children` 可在 search/context 中合并 OpenCode 子 agent 会话。OpenCode 不支持基于 Trellis task 边界的 `--phase` 切分：指定该参数时 CLI 会警告并返回完整会话（等同 `all`），不要把 phase 过滤结果归因于 OpenCode。
- **`--platform devin` 是 Cognition Devin CLI**（`~/.local/share/devin/cli/sessions.db`），不是 `trellis init --devin`（Devin Desktop / Cascade），也不是 Factory Droid。
- **`--phase` 切分依赖会话记录的 bash 调用中出现 `task.py create` / `task.py start`。** 若用户在其他终端而非记录的 AI 循环中运行 `task.py`，就没有阶段边界；此时 `--phase all` 是安全回退。
- **`mem` 直接索引平台 JSONL 文件。** 用户若已清除 Claude / Codex / Pi 会话存储，`mem` 无法恢复已经不在磁盘上的内容。
- **`mem` 只读。** 不会远端同步，也不会编辑平台 JSONL；基于 `mem` 检索结果的任何写入，都属于你之后自行执行的动作。

## 需要更多信息时

在用户 shell 中运行 `trellis mem help`。快速变化的 beta 阶段中，运行时帮助比本参考更具权威性。
