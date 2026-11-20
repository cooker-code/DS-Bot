# 挂钩和设置

挂钩/设置是将平台连接到 Trellis 的入口层。他们决定平台针对哪些事件运行哪些脚本、插件或扩展。

## 设置职责

设置/配置文件通常注册：

- session-start hook：在新会话启动或上下文重置时注入 Trellis 概述。
- workflow-state hook：从 `.trellis/workflow.md` 解析 `[workflow-state:STATUS]` 块，并在每个用户输入上发出与当前 task `status` 匹配的正文。仅解析器；该脚本不嵌入后备内容。
- sub-agent 上下文 hook：在实施/检查/研究 agents 开始时注入 task 上下文。
- shell/会话桥：让 shell commands 查看相同的 Trellis 会话身份。
- 平台插件或扩展入口点。

`.trellis/config.yaml` 还承载项目级 task lifecycle hooks（`hooks.after_create` / `after_start` / `after_finish` / `after_archive`）、journal 形状（`session_commit_message` / `max_journal_lines` / `session_auto_commit`）、channel worker guard（`channel.worker_guard.idle_timeout` / `max_live_workers`）、Codex 派发模式（`codex.dispatch_mode: inline | sub-agent`）及 spec registry（`registry.spec.source` + `registry.spec.template`）。

常用文件：

| 平台 | 设置/配置 |
| --- | --- |
| Claude Code | `.claude/settings.json` |
| Cursor | `.cursor/hooks.json` |
| Codex | `.codex/hooks.json`、`.codex/config.toml` |
| OpenCode | `.opencode/package.json`、`.opencode/plugins/*`、`.opencode/hooks/inject-spec-context.py` |
| Kiro | `.kiro/hooks/` + 平台配置 |
| Gemini CLI | `.gemini/settings.json` |
| Qoder | `.qoder/settings.json` |
| CodeBuddy | `.codebuddy/settings.json` |
| GitHub Copilot | `.github/copilot/hooks.json` |
| Factory Droid | `.factory/settings.json` |
| Pi代理 | `.pi/settings.json`、`.pi/extensions/trellis/` |
| Trae IDE | `.trae/hooks.json` |

Reasonix 是拉取式平台，其 agent 文件包含启动后读取上下文的 prelude 指令。ZCode 使用带共享 hooks 的 `.zcode/config.json`，包括用于子 agent prompt 注入的 PreToolUse。Kimi Code 同样是拉取式平台，Trellis 不写入项目级 settings/hooks 文件（hooks 只位于用户级 `~/.kimi-code/config.toml`），因此其 agent prompts 以包含相同 prelude 的 skills 形式提供。DeepSeek Harness 也没有 Trellis 写入的项目级 hook/settings 接口；可选 `dsh-trellis` profile 插件提供每轮面包屑和事件驱动的 `trellis_wait`，而 DSH 角色 skills 在有插件和无插件的路径中都拉取任务上下文。

这些文件是否存在于项目中取决于用户运行的 `trellis init --<platform>` 标志。

## 挂钩脚本类型

| 脚本 | 目的 |
| --- | --- |
| `session-start.py` | 生成会话启动上下文。 |
| `inject-workflow-state.py` | 解析 `.trellis/workflow.md` 中的 `[workflow-state:STATUS]` 块并发出与当前 task 状态匹配的正文。当不存在匹配块时，回退到 `Refer to workflow.md for current step.`。 |
| `inject-subagent-context.py` | 将 PRD、JSONL 上下文和相关 规范与研究 注入子 agents。 |
| `inject-spec-context.py` | 匹配路径范围内的 spec，并管理有预算限制的交付状态。 |
| `inject-shell-session-context.py` | 让 shell commands 继承 Trellis 会话身份。 |

并非每个平台都有所有 hook。不要仅仅因为某个平台缺少 hook 就从另一个平台复制文件；首先确认该平台是否支持对应的事件。

## 局部变化场景

| 用户需求 | 编辑位置 |
| --- | --- |
| AI 应该在新会话中看到更多/更少的上下文 | 平台 `session-start` hook。 |
| 每回合提示政策应该改变 | `[workflow-state:STATUS]` 块位于 `.trellis/workflow.md` 中。 hook 逐字解析 workflow.md — 无需编辑脚本。 |
| 子agent无法读取PRD/spec | `inject-subagent-context` hook 或 agent 前奏。 |
| shell 中的 `task.py current` 没有活动的 task | Shell/会话桥 hook 或平台环境变量配置。 |
| 禁用自动注入 | 对应的 hook 注册在settings/config.xml中。 |

## 修改原则

1. **设置连接起来； hooks 定义行为**。如果只有 hook 发生变化，平台可能永远不会调用它。如果仅更改设置，行为可能不会改变。
2. **首先确认平台事件名称**。不同的平台对 SessionStart、UserPromptSubmit、AgentSpawn、shell 执行和类似事件使用不同的名称。
3. **挂钩读取本地 `.trellis/`，而不是上游源**。用户项目中的 `.trellis/scripts/` 和 `.trellis/workflow.md` 是默认目标。
4. **错误必须是可见的**。挂钩失败应该告诉用户什么没有注入，而不是默默地留下 AI 没有上下文。
5. **不要跨平台照搬 hooks**。先确认平台支持对应事件；缺少 hook 不表示应复制另一平台的文件。

## 故障排除路径

如果用户说“AI没有读取Trellis状态”：

1. 检查平台设置是否注册了hook。
2. 检查hook文件是否存在。
3. 手动运行 hook 所依赖的 `.trellis/scripts/get_context.py` 或 `task.py current --source` command 。
4. 检查 `.trellis/.runtime/sessions/` 中是否存在活动的 task 状态。
5. 检查平台shell是否传递会话身份。
