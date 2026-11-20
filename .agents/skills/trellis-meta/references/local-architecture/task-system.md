# 本地任务系统

Trellis task 系统完全存储在用户项目中的 `.trellis/tasks/` 下。每个 task 都是一个包含需求、上下文、研究、状态和关系信息的目录。

## 任务目录结构

```text
.trellis/tasks/
├── 04-28-example-task/
│   ├── task.json
│   ├── prd.md
│   ├── design.md
│   ├── implement.md
│   ├── implement.jsonl
│   ├── check.jsonl
│   └── research
└── archive/
    └── 2026-04/
```

| 文件 | 目的 |
| --- | --- |
| `task.json` | 任务元数据：状态、受让人、优先级、分支、父/子 tasks 和类似字段。 |
| `prd.md` | 面向人的 `Goal`、`Requirements` 和 `User-visible Outcomes`，顺序固定。轻量 Task 可以仅有 PRD。 |
| `design.md` | 复杂tasks的技术设计：边界、契约、数据流、兼容性、权衡。 |
| `implement.md` | 复杂 tasks 的执行计划：有序清单、验证 commands、审查门、回滚点。 |
| `implement.jsonl` | 规范与研究文件列表，工具 agent 必须首先读取。 |
| `check.jsonl` | 检查 agent 必须首先读取的 规范与研究文件列表。 |
| `{TASK_DIR}/research/` | 研究文物。复杂的发现不应该只存在于聊天中。 |

## `task.json`

`task.json` 记录 task 状态和元数据。常见字段：

| 场地 | 意义 |
| --- | --- |
| `id` / `name` / `title` | 任务标识和标题。 |
| `status` | 状态，例如 `planning`、`in_progress`、`review` 或 `completed`。 |
| `priority` | `P0`、`P1`、`P2`、`P3`。 |
| `creator` / `assignee` | 创建者和受让人。 |
| `package` | monorepo 中的目标包；可能为空。 |
| `branch` / `base_branch` | 工作分支和PR目标分支。 |
| `children` / `parent` | 父/子 task 关系。 |
| `commit` / `pr_url` | 完成后提交和 PR 信息。 |
| `meta` | 扩展字段。 |

## 父/子任务树

父/子 task 关系用于组织工作。父 task 将相关交付物归入同一组源需求；它不是依赖调度器，也不会取代子 task 自己的规划产物。

当请求有多个可独立验证的可交付成果时，请使用父级 task。父母拥有：

- 来源要求和面向用户的范围。
- 子 tasks 的地图及其责任边界。
- 跨儿童接受标准和最终整合审查。

将子 tasks 用于可独立进行规划、实施、检查和归档的可交付成果。如果一个孩子依赖于另一个孩子，请在孩子 `prd.md` / `implement.md` 中写入该依赖关系；不要依赖树的位置来暗示排序。

创建新的孩子：

```bash
python3 ./.trellis/scripts/task.py create "<child title>" --slug <child-slug> --parent <parent-dir>
```

链接或取消链接现有的 tasks ：

```bash
python3 ./.trellis/scripts/task.py add-subtask <parent-dir> <child-dir>
python3 ./.trellis/scripts/task.py remove-subtask <parent-dir> <child-dir>
```

父级上的 `children` 是历史列表。当子项被存档时，Trellis 会将该子项名称保留在父项中，因此在完成的子项移动到 `archive/` 后，像 `[2/3 done]` 这样的进度仍然有意义。

AI 不应把阶段编号当作 task 状态。task 进度主要由 `status`、产物是否存在（`prd.md`，以及可选的 `design.md` / `implement.md`）、是否为 sub-agent 模式配置了 JSONL 上下文，以及 `workflow.md` 中的阶段说明共同决定。

## 规划与 PRD 合同

由 `task.py create` 创建的标准 Task 使用规划合同 v2。七项布尔画像答案是唯一的等级输入：全部为 `false` 推导为 `lightweight`；任一为 `true` 推导为 `complex`；未决则推导为 `pending` 并阻止 `task.py start`。没有 `meta.planning_contract_version=2` 的历史 Task 保留旧路径。

PRD 按顺序保留 `Goal`、`Requirements` 和 `User-visible Outcomes`。Goal 是有序列表。Requirements 仅按实际发生的变更类型分组（`Add`、`Change`、`Remove`、`Preserve`、`Boundary`），并使用稳定的 `R1` / `R1.1` 编号。检查清单结果使用 `O1` 编号并映射回需求编号。技术设计放入 `design.md`，有序执行放入 `implement.md`，源码证据放入 `{TASK_DIR}/research/`。

当 `interaction_change=true` 时，User-visible Outcomes 还需要 Mermaid 交互变更图，包含新增/修改/删除文字和红色 `changed` 节点/路径。当 `data_model_change=true` 时，`design.md` 需要可执行 DDL、表和每个字段的注释、约束、迁移与回滚。ER 图仍然可选。

## UI 原型合同

使用 `--meta ui=true` 创建 UI Task。Trellis 会在 `{TASK_DIR}/research/` 旁加入 `prototype/manifest.json`；该清单指向 `prototype/` 下的主入口和静态预览，而 PRD 受管理块会在 User-visible Outcomes 内公开入口、预览、状态和摘要。使用 `task.py prototype-status <task>` 同时检查清单批准状态与 PRD 引用一致性。用户审阅后，`task.py approve-prototype <task> <approval-evidence>` 会将批准绑定到摘要并同步 PRD 块。`task.py start` 会在更改 Task 状态、活动指针或生命周期 hook 前，拒绝缺失、待定、过期、目录外或与 PRD 不一致的原型。

## 活动任务

用户看到“当前 task”，但 Trellis 存储每个会话的活动 task 状态。

```text
.trellis/.runtime/sessions/<context-key>.json
```

`task.py start` 将 task 路径写入当前会话的 runtime 会话文件中。 `task.py current --source` 显示当前的 task 及其来源。不同的AI窗口可以指向不同的tasks，而不会互相覆盖。

如果平台或 shell 环境没有稳定的会话身份，`task.py start` 可能无法设置活动的 task。 AI 应该读取错误，检查平台 hook/session 环境，而不是回退到共享全局指针。

## JSONL 上下文

`implement.jsonl` 和 `check.jsonl` 是子 agents 首先读取的上下文清单。它们不会取代 `implement.md`； `implement.md` 是人类可读的执行计划。

格式：

```jsonl
{"file": ".trellis/spec/cli/backend/index.md", "reason": "Backend conventions"}
{"file": ".trellis/tasks/04-28-example/research/api.md", "reason": "API research"}
```

规则：

- 包括 spec 和研究文件。
- 不要包含将要修改的代码文件。
- 不要将聊天中的临时结论视为唯一的背景。
- 不含 `file` 字段的行会被 reader 跳过。旧的 `{"_example": ...}` 占位行会被 `task.py validate` 拒绝；应删除它们。两种情况不同：前者只是 reader 忽略，后者是校验错误。

## 常用命令

```bash
python3 ./.trellis/scripts/task.py create "<title>" --slug <slug>
python3 ./.trellis/scripts/task.py create "<UI title>" --slug <slug> --meta ui=true
python3 ./.trellis/scripts/task.py set-planning-profile <task> <seven boolean flags>
python3 ./.trellis/scripts/task.py planning-status <task>
python3 ./.trellis/scripts/task.py prototype-status <task>
python3 ./.trellis/scripts/task.py approve-prototype <task> "<approval-evidence>"
python3 ./.trellis/scripts/task.py start <task>
python3 ./.trellis/scripts/task.py current --source
python3 ./.trellis/scripts/task.py add-context <task> implement <file> <reason>
python3 ./.trellis/scripts/task.py validate <task>
python3 ./.trellis/scripts/task.py finish
python3 ./.trellis/scripts/task.py archive <task>
```

修改 task 系统时，AI 应优先使用脚本 commands 来维护结构。仅当脚本不能满足需要时，才直接编辑 JSON/Markdown 。

## 本地定制点

| 需要 | 编辑位置 |
| --- | --- |
| 更改默认的 task 模板 | `.trellis/scripts/common/task_store.py` 和 task 创建说明。 |
| 修改等级、PRD、交互或数据库设计门禁 | `.trellis/scripts/common/planning_gate.py`、`task.py` 和 PRD 合同。 |
| 更改状态语义 | `.trellis/workflow.md`、workflow-状态 hook 逻辑和 task 使用约定。 |
| 添加 task 生命周期操作 | `hooks.after_*` 在 `.trellis/config.yaml` 中。 |
| 更改上下文规则 | `.trellis/workflow.md` 和相关平台 agent/hook 指令中的规划产物指南。 |
| 更改存档策略 | `.trellis/scripts/common/task_store.py` / `task_utils.py`。 |

这些是用户项目中的本地文件。不要默认编辑 Trellis CLI 源代码，除非用户想要向上游贡献。
