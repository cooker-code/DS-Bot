---
name: trellis-finish-work
description: "结束当前会话：确认质量门禁已通过，提醒用户提交，归档状态为 completed 的 Task，并将会话进度记录到开发者日志。适用于编码完成并准备结束会话时。"
---

# 结束工作

结束当前会话：归档当前 Task（以及用户希望一并清理的其他 completed 但未归档 Task），并记录 Session 日志。这里不执行代码提交——代码提交应在调用此命令前的 workflow Phase 3.4 完成。

## Step 1：检查当前状态

```bash
python3 ./.trellis/scripts/get_context.py --mode record
```

此命令会输出：

- **我的当前 Task**——检查除当前 Task 外，是否还有实际已完成（代码已合并、验收标准已满足）并应在本轮归档的 Task。
- **Git 状态**——快速查看哪些内容处于有变更状态。
- **最近提交**——Step 4 的 `--commit` 需要这些哈希。

如果 `--mode record` 显示与当前会话无关的其他 completed Task，请只向用户确认一次：“这 N 个 Task 看起来已完成——本轮也一起归档吗？[y/N]”。默认不处理；无论如何，当前 Task 都会在 Step 3 归档。

## Step 2：健全性检查——对有变更路径分类

运行：

```bash
git status --porcelain
```

过滤 `.trellis/workspace/` 和 `.trellis/tasks/` 下的路径——它们由 `add_session.py` 和 `task.py archive` 的自动提交管理，并会因为此 Skill 自身的工作而显示为有变更。

对剩余每个有变更路径，判断它属于**当前 Task**还是**其他并行工作**（例如另一个终端窗口正在编辑同一仓库）。参考判断：

- 当前 Task 的 `prd.md` / `implement.jsonl` / `check.jsonl` 引用的路径 → 当前 Task
- 与 Task 声明范围匹配的代码区域，或你记得本会话编辑过的路径 → 当前 Task
- 无关区域且你不记得本会话触碰过的路径 → 其他并行工作

然后进行路由：

- **任何剩余路径看起来属于当前 Task**——退出并提示：
  > “工作区中仍有来自当前 Task 的未提交代码变更：`<list>`。请返回 workflow Phase 3.4 提交后，再运行 `trellis-finish-work`。”

  不要在这里运行 `git commit`。不要提示用户自行提交。用户返回 Phase 3.4，由 AI 驱动分批提交。
- **所有剩余路径看起来都无关**（其他并行窗口的工作）——只报告一次，然后继续 Step 3：
  > “提示：Task 范围外有其他变更文件——将它们留给其他窗口：`<list>`。”
- **确实无法判断**——只询问用户一次：“`<list>` 是我忘记提交的当前 Task 工作，还是另一个窗口的？（提交 / 忽略）”——然后按回答路由。

## Step 3：核对交付状态，再归档 Task

归档前运行：

```bash
python3 ./.trellis/scripts/task.py delivery-status <task-name> --json
```

`uncommitted` 应返回 Phase 3.4，并使用回执中的工作目录路径和任务分支。
对于 `integration_pending`，只询问用户一次是本地合并、创建合并请求
还是保留；默认不进行 Git 写入、push 或清理。任何已授权选择后都要重新读取
回执。遇到 `integration_blocked` 和 `committed` 时停止；`retained`、
`integrated` 与 `cleanup_pending` 才可以归档。完成 `no_code_change`
Task 前需取得非代码验收；`unavailable` 仅可用于历史非 Git／无代码 Task。
清理需要单独授权。最终交接须说明代码位置、任务提交、目标分支、集成状态、
远端状态、工作目录/分支清理状态和下一步动作。

## Step 4：归档 Task

```bash
python3 ./.trellis/scripts/task.py archive <task-name>
```

至少处理当前 Task（如有），再加上用户在 Step 1 确认的额外 Task。每次归档都会通过脚本自动提交，生成 `chore(task): archive ...`。

如果没有当前 Task，且用户也没有确认任何额外清理项，则跳过此步骤。

## Step 5：记录 Session 日志

```bash
python3 ./.trellis/scripts/add_session.py \
  --title "会话标题" \
  --commit "哈希1,哈希2" \
  --summary "简要总结"
```

`--commit` 使用 Phase 3.4 生成的工作提交哈希（可在 Step 1 的 `Recent commits` 列表或 `git log --oneline` 中看到）。不要包含 Step 3 的归档提交哈希。此命令会生成一个 `chore: record journal` 提交。

最终 Git 日志顺序：`<work commits from 3.4>` → `chore(task): archive ...`（一个或多个）→ `chore: record journal`。
