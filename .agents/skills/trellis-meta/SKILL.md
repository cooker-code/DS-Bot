---
name: trellis-meta
description: "了解并自定义用户项目内的本地 Trellis 架构。在修改 .trellis 及平台 hooks、设置、agents、skills、commands、prompts，或由 trellis init 生成的 workflows 时使用。"
---

# Trellis Meta

此 skill 适用于已在项目中运行 `trellis init` 的本地 Trellis 用户。阅读完后，AI 应该了解该用户项目内的 Trellis 架构、运作模型和自定义入口点，然后根据用户的请求修改生成的 `.trellis/` 和平台目录文件。

在既有 workflow／持久化／平台模型上，Trellis v0.6 增加三个一等架构面：

1. `trellis channel` 多 Agent 协作运行时，通过项目级 JSONL 事件日志 `~/.trellis/channels/<project>/<channel>/events.jsonl` 协调 worker；它包含 worker OOM guard、forum/thread channel、持久化幂等键和内置 `.trellis/agents/{check,implement}.md` runtime 定义。
2. `trellis mem list | search | context | extract | projects` 跨会话记忆，读取本地平台会话存储而不上传内容；`--phase brainstorm|implement|all` 可切分支持此能力的会话，OpenCode 传入 `--phase` 时会警告并返回完整 SQLite 对话。
3. `@mindfoldhq/trellis`（CLI）与 `@mindfoldhq/trellis-core`（SDK，提供 `/channel`、`/task`、`/mem`、`/testing` 子路径）以同一版本和 git tag 锁步发布。

将这三个面与逐平台集成文件同等对待。`.trellis/` 包含 workflow、配置、tasks、spec、workspace、scripts、内置 runtime agents 和状态；共享 skill 层为 `.agents/skills/`。平台目录还包括 `.dsh/`：DeepSeek Harness 将共享 workflow skills 放在 `.agents/skills/`，DSH 私有 commands 和 `trellis-agent-*` 角色 skills 放在 `.dsh/skills/`；只有安装可选 `dsh-trellis` 插件时，才可用事件驱动的可继续子 Agent 等待，否则 child 必须一开始就在前台派发。Pi 的文件布局之外还提供原生 `trellis_subagent`，支持 `single` / `parallel` / `chain`、节流进度卡片与 `isTrellisAgent()` 校验。Reasonix 的 subagent skill 位于 `.reasonix/skills/<name>/SKILL.md` 并带 `runAs: subagent` frontmatter，且没有 settings 文件；Kimi Code 的 workflow skills 位于共享层，同时将相同 prompts 作为 `.kimi-code/skills/<name>/SKILL.md` 与 `.kimi-code/agents/<name>.md` 派发。不要假设用户拥有 Trellis 源码库，也不要默认修改全局 npm 安装目录或 `node_modules`。

默认操作范围是用户项目中的本地文件：

- `.trellis/`：workflow、配置、tasks、spec、工作区、脚本和 runtime 状态。
- 平台目录：`.claude/`、`.codex/`、`.cursor/`、`.opencode/`、`.kiro/`、`.gemini/`、`.qoder/`、`.codebuddy/`、`.github/`、`.factory/`、`.pi/`、`.reasonix/`、`.kilocode/`、`.agent/`、`.devin/`、`.kimi-code/`、`.dsh/` 和类似目录。Pi 在文件布局之外还提供原生 `trellis_subagent` 工具，支持 `single` / `parallel` / `chain` 派发模式、节流进度卡片和 `isTrellisAgent()` 验证。Reasonix 将 workflow skills 和 subagent skills 都存放在 `.reasonix/skills/<name>/SKILL.md`，subagent skills 带有 `runAs: subagent` frontmatter。Kimi Code 将 workflow skills 放在共享 `.agents/skills/` 层，在 `.kimi-code/skills/<name>/SKILL.md` 中提供 commands 和 agent prompts，并把相同的 agent prompts 写入 `.kimi-code/agents/<name>.md` 作为自定义子 Agent 定义。DeepSeek Harness 将共享 workflow skills 放在 `.agents/skills/`，并将 DSH 私有 commands 和 `trellis-agent-*` 角色 skills 放在 `.dsh/skills/`；有可选 `dsh-trellis` 插件时，其可继续子 Agent 使用事件驱动的结算等待，否则必需 child 从一开始在前台派发。
- 共享 skill 层：`.agents/skills/`。

不要假设用户拥有 Trellis 源存储库。不要默认修改全局 npm 安装目录或 `node_modules`。

## 如何使用

1. 首先读取`references/local-architecture/overview.md`来建立本地Trellis系统模型。
2. 如果请求涉及特定的 AI 工具，请阅读 `references/platform-files/platform-map.md` 和相关平台文件说明。
3. 请求涉及多 Agent 派发或 channel worker 时，阅读 `references/local-architecture/multi-agent-channel.md` 和内置 `.trellis/agents/` 文件。
4. 如果用户想要更改行为，请阅读 `references/customize-local/overview.md`，然后打开特定的自定义主题。
5. 在编辑之前，请读取用户项目中的实际文件，并将本地内容视为权威内容。

## 参考

### 本地架构

- `references/local-architecture/overview.md`：三层本地Trellis架构和定制原则。
- `references/local-architecture/generated-files.md`：由 `trellis init` 生成的文件及其自定义边界。
- `references/local-architecture/workflow.md`：`.trellis/workflow.md` 中的阶段、路由和 workflow 状态块。
- `references/local-architecture/task-system.md`：任务目录，活动 tasks、JSONL 上下文和 task runtime。
- `references/local-architecture/spec-system.md`：`.trellis/spec/` 是如何组织和注入的。
- `references/local-architecture/workspace-memory.md`：`.trellis/workspace/`、日志和跨会话内存。
- `references/local-architecture/context-injection.md`：挂钩、子agent前奏和上下文注入路径。
- `references/local-architecture/multi-agent-channel.md`：`trellis channel` 子命令、项目级事件存储、forum/thread、worker OOM guard、持久化幂等性和内置 runtime agents。
- `references/local-architecture/bundled-skills.md`：内置 skills 的自动派发，以及 `getBundledSkillTemplates()` 如何将其写入每个平台 skill root。

### 平台文件

- `references/platform-files/overview.md`：共享的 `.trellis/` 文件如何与平台目录相关。
- `references/platform-files/platform-map.md`：所有受支持平台（包括 DeepSeek Harness、Reasonix 和 Pi 原生 `trellis_subagent` 扩展）的 skills、agents、hooks 和扩展目录与路径。
- `references/platform-files/hooks-and-settings.md`：设置/配置文件、hooks、插件和扩展如何连接到 Trellis；包括 `channel.worker_guard.*` 和 `codex.dispatch_mode`。
- `references/platform-files/agents.md`：逐平台 agent 职责及 channel runtime 的 `.trellis/agents/{check,implement}.md`。
- `references/platform-files/skills-and-commands.md`：skills、commands、prompts 和工作流程之间的差异，以及如何更改它们。

### 本地化定制

- `references/customize-local/overview.md`：为用户的请求选择正确的本地自定义入口点。
- `references/customize-local/change-workflow.md`：更改阶段、路由、下一步操作和 workflow 状态。
- `references/customize-local/change-task-lifecycle.md`：更改 task 创建、状态、存档行为和 hooks。
- `references/customize-local/change-context-loading.md`：更改 tasks、specs、日志、hook context、channel inbox 和 `trellis mem` 回忆的加载方式。
- `references/customize-local/change-hooks.md`：更改平台 hooks、设置、task lifecycle hooks（`hooks.after_*`）和 shell 会话桥。
- `references/customize-local/change-agents.md`：更改逐平台 sub-agent、内置 channel runtime agent 和 Codex `dispatch_mode` 的研究、实施和检查行为。
- `references/customize-local/change-skills-or-commands.md`：添加或修改本地 skills、commands、prompts 和工作流程；包含上游内置 skill 自动派发。
- `references/customize-local/change-spec-structure.md`：调整`.trellis/spec/`下的项目spec结构。
- `references/customize-local/add-project-local-conventions.md`：将团队规则放入项目本地 specs 或本地 skills 中。

## 现行规则

- `.trellis/workflow.md` 是本地 workflow 事实来源。
- `.trellis/config.yaml` 是项目级 Trellis 配置和 task hook 配置入口点。
- `.trellis/spec/` 存储用户的项目特定编码约定和设计约束。
- `.trellis/tasks/` 存储 task PRD、技术说明、研究文件和 JSONL 上下文。
- `.trellis/workspace/` 存储开发者日志和跨会话内存。
- 平台设置/配置文件决定实际运行哪些 hooks、agents、skills、commands、prompts 和工作流程。
- `.trellis/.template-hashes.json` 和 `.trellis/.runtime/` 是管理/runtime 状态文件。编辑前请确认必要性。
- `.trellis/workflow.md` 的初始内容来自 `trellis init` 时所选的 `native`、`tdd`、`channel-driven-subagent-dispatch` 或 marketplace 模板；用 `trellis workflow --template <id>` 可重选。模板引用的 `.trellis/agents/<name>.md` 缺失时，CLI 会输出指向 `trellis update` 的非阻塞 stderr 警告。
- `.trellis/config.yaml` 还定义 task hooks（`hooks.after_create` / `after_start` / `after_finish` / `after_archive`）、journal（`session_commit_message` / `max_journal_lines` / `session_auto_commit`）、`channel.worker_guard.idle_timeout` / `max_live_workers`、`codex.dispatch_mode: inline | sub-agent` 及 `registry.spec.source` + `registry.spec.template`。
- 设置 `registry.spec` 后，`trellis update` 会刷新 spec；本地改动会在 `.trellis/.template-hashes.json` 中成为“modified by user”冲突。
- tasks 形成父子树，可用 `task.py create --parent <slug>`、`task.py add-subtask <parent> <child>`、`task.py remove-subtask <parent> <child>` 和 `task.py list-context <task>`；创建会拒绝 `.trellis/tasks/archive/**` 已存在的 slug。
- `.trellis/workspace/` 仅保存刻意写入的 journal；原始对话仍在 `~/.claude/projects/`、`~/.codex/sessions/`、`~/.pi/agent/sessions/` 等本地平台会话存储中，通过 `trellis mem search|extract|context` 读取。
- `.trellis/agents/{check,implement}.md` 由 `trellis channel spawn --agent <name>` 加载；编辑逐平台的 `trellis-implement.md`／`trellis-check.md` 不会改变 channel worker。`events.jsonl` 由文件锁分配序号并支持 `idempotencyKey`，不在 `.trellis/` 下。
- `trellis-meta`、`trellis-spec-bootstrap`、`trellis-session-insight`、`trellis-channel` 通过 `packages/cli/src/templates/common/index.ts` 的 `getBundledSkillTemplates()` 自动分发。

## 不要

- 不要将 Trellis 上游源代码视为本地自定义的默认目标。
- 不要修改全局npm安装目录或`node_modules/@mindfoldhq/trellis`来实现项目需求。
- 不要使用默认模板覆盖用户修改的本地文件。
- 不要将团队私有项目规则公开`trellis-meta`；将项目规则放入 `.trellis/spec/` 或项目本地 skill 中。
- 不要将已删除的历史机制描述为当前的 Trellis 行为。
- 不要覆盖用户修改的本地模板；先检查 `.trellis/.template-hashes.json`，优先使用 `.new` sidecar 做语义合并。
- 不要将团队私有规则写入公开内置 skill（`trellis-meta`、`trellis-spec-bootstrap`、`trellis-session-insight`、`trellis-channel`）；更新会覆盖这些目录。
- 不要手工修改 `~/.trellis/channels/<project>/<channel>/events.jsonl`；使用 `trellis channel` CLI 或 `@mindfoldhq/trellis-core/channel` SDK。
- 要改 channel runtime worker 时，不要只改逐平台 agent；应编辑 `.trellis/agents/<name>.md`。
- 声称配置或机制存在前，先与本地 `.trellis/config.yaml` 和安装 CLI 的 `trellis --help` 交叉核对。
