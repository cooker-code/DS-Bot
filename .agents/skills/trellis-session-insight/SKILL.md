---
name: trellis-session-insight
description: "通过 `trellis mem` CLI 检索过去的 AI 对话。当用户询问“上次如何解决 X”“之前讨论过吗”“关于 X 的决定是什么”“本任务做了什么”，或开始与既有工作重叠的 brainstorm、排查熟悉的缺陷、跨会话继续工作、复盘任务时使用。命令返回原始历史对话；应根据当时情境决定更新规范、追加任务注记、在回答中引用，还是仅作为理解背景。"
---

# Trellis 会话洞察

本技能说明 AI **如何调用 `trellis mem`**——项目的跨会话记忆来源——以及**何时应使用它**。

它刻意是一个**能力技能，而非工作流**。没有固定输出文件、没有必须写回的步骤，也没有“每次 finish-work 后都运行”的规则。如何处理 `mem` 返回的内容，应在当前对话中判断；本技能的作用是让 AI 知道有此能力并能自行决定。

## `trellis mem` 是什么

这是一个本地 CLI，会索引用户过去的 Claude Code、Codex、Devin CLI、Grok、OpenCode、Pi Agent 和 ZCode 对话日志；可以列出、搜索、按 Trellis task 边界切分，并导出清理后的对话。Claude 和 Codex 分别使用 `~/.claude/projects/` 与 `~/.codex/sessions/`。Devin CLI（Cognition 终端 Agent，而非 `trellis init --devin` 的 Desktop）使用 `~/.local/share/devin/cli/sessions.db`。Grok 使用 `~/.grok/sessions/`。OpenCode 使用 `~/.local/share/opencode/opencode.db`（零依赖 SQLite 读取器）。Pi 使用默认或环境配置的会话根目录、全局 `~/.pi/agent/settings.json` 和当前项目的 `.pi/settings.json`；相对 `sessionDir` 以 settings 文件所在目录解析。项目本地 Pi 设置需要从当前 cwd 或 `--cwd` 进行项目范围查找。ZCode 使用 `~/.zcode/cli/db/db.sqlite`。

`mem` 不会上传任何内容，所有读取都在本机完成。

## 何时应使用

判断标准是：资深同事会不会问“这件事我们之前是不是已经讨论过？”以下是常见场景：

- **重复 brainstorm 的风险。** 开始一个涉及用户过去工作领域的新任务，希望先确认是否已有决定，避免再次询问用户。
- **熟悉缺陷的排查。** 当前缺陷模式像用户以前报告或修复过的问题，读取相关会话可省掉完整的调试循环。
- **跨会话继续。** 用户间隔一段时间后恢复工作，只说“做到哪了”或“继续上次的”。
- **检索决定。** 用户提到“我们关于 X 的决定”，但该决定存在于旧 brainstorm，而不在 `prd.md` 或 `.trellis/spec/` 中。
- **finish-work 复盘。** 用户明确要求总结本任务中决定了什么、哪里困难、有什么意外；不是每次 finish-work 的强制步骤。
- **从历史工作中发现模式。** 用户问“我是否总在 X 上犯同样错误”或“我每次都踩这个坑吗”，需要跨会话搜索。

若这些场景都不适用，不要调用 `mem`。它是工具，不是仪式。

## 何时不应使用

- 当前轮次、`prd.md`、`design.md`、最近的 `git log` 或已打开文件已经包含所需上下文。`mem` 用于那些已脱离即时范围的信息。
- 用户询问的是代码事实，而非过去对话事实。直接读取文件、使用 `git log -p` 或 `grep` 更快也更权威。
- 你是子 Agent（`trellis-implement` / `trellis-check`），派发提示已含精选的 `implement.jsonl` / `check.jsonl` 上下文；额外加入 `mem` 通常只会制造噪声。
- 用户明确说“不要翻历史，只回答当前问题”。

## 如何处理 `mem` 的结果

将输出视为**原材料**，而非交付物。拿到结果后根据当前对话决定：

- 如果某段旧对话直接回答用户当前问题，**在回复中引用**，并给出 session-id / phase，方便用户核验。
- 如果 `mem` 找到本应写下但未写下的关键决定，**更新 `<task>/prd.md` 或 `<task>/design.md`**；先向用户展示拟议修改。
- 如果发现属于当前任务记录、但不适合写入 PRD，可**追加到任务本地注记文件**，例如 `<task>/notes.md`。
- 如果发现是能帮助未来任务的项目级约定或陷阱，**更新 `.trellis/spec/`**；此时运行 `trellis-update-spec` 技能，`session-insight` 只负责发现。
- 也可以**仅吸收**结果，在接下来几轮更好地回答，不写入任何文件；这通常适合一次性回忆。

Trellis 不规定唯一的归宿。强行把每次检索写入固定文件只会积累噪声，应由情境决定。

## 如何调用

完整 CLI 参考见 `references/cli-quick-reference.md`。大多数情形使用以下命令之一：

```bash
# Find sessions whose contents mention a keyword (project-scope is default;
# add --global to search every project on this machine).
trellis mem search "<keyword>"

# Dump dialogue from one session, optionally filtered by phase or keyword.
trellis mem extract <session-id> --phase brainstorm
trellis mem extract <session-id> --grep "<keyword>"

# Drill into a session: top-N hit turns + surrounding context.
trellis mem context <session-id> --turns 3 --around 2

# When you do not know the session id yet, start with list + filter.
trellis mem list --cwd <project-path>
trellis mem projects   # → list active project cwds, then narrow
```

阶段切分（`--phase brainstorm|implement|all`）以 `task.py create` 和 `task.py start` 为边界。复盘当前任务时，`--phase brainstorm` 可恢复规划讨论，`--phase implement` 可恢复执行过程；默认是 `all`。OpenCode 不支持此类 task 边界切分：传入 `--phase` 时 CLI 会警告并返回完整会话（等同 `all`）。

## 触发模式

`references/triggering-patterns.md` 收集了更多应让你想到“使用 `mem`”的英文和中文用户原话；训练判断时可随时参考。

## 范围外

- `mem` 不编辑代码或更新文件。任何写回都由你在当时自行判断。
- `mem` 对平台 JSONL 存储只读，不会 push 或同步到远端。
- 本技能不替代 `trellis-update-spec`（后者用于把发现沉淀为项目级指导），也不替代平台原生的 task / spec 工作流。
