---
name: trellis-continue
description: "恢复当前任务。加载 workflow Phase 索引，判断应从哪个 Phase/Step 继续，再通过 get_context.py --mode phase 获取该步骤的详细说明。适用于返回进行中的任务并需要明确下一步时。"
---

# 继续当前任务

恢复当前 Task，并从 `.trellis/workflow.md` 中正确的 phase/step 继续。

---

## Step 1：加载当前上下文

```bash
python3 ./.trellis/scripts/get_context.py
```

确认：当前 Task、Git 状态、最近提交。

## Step 2：加载 Phase 索引

```bash
python3 ./.trellis/scripts/get_context.py --mode phase
```

显示 Phase 索引（规划 / 执行 / 收尾），包括路由和 Skill 映射。

## Step 3：判断当前位置

`get_context.py` 会显示当前 Task 的 `status` 字段。根据 `status` + 产物是否存在进行路由。此命令用于避免用户记忆 Trellis 流程；它本身不批准实现。

- `status=planning` + 没有 `prd.md` → **1.1**（加载 `trellis-brainstorm`）
- `status=planning` + 已有 `prd.md` → 运行 `task.py planning-status <task>`。`pending` 画像返回 **1.1**；推导为 `lightweight` 可进入 **1.4** 审查；推导为 `complex` 则返回 **1.1**，直到补齐 `design.md` + `implement.md`。
- `status=planning` + 复杂产物已完成 + sub-agent JSONL 尚未整理（仅有种子 `_example` 记录）→ **1.3**
- `status=planning` + `planning-status` 有效 + 必需 JSONL 已整理或使用行内模式 → **1.4**（请求启动审查）。对于 `meta.ui=true`，还必须具备 `prototype/manifest.json` 声明的入口和预览；使用 `task.py prototype-status <task>` 读取入口、当前摘要和状态，展示最新原型，并在 `task.py start` 前用 `task.py approve-prototype <task> <approval-evidence>` 记录确认。
- `status=in_progress` + 尚未开始实现 → **2.1**
- `status=in_progress` + 实现完成但尚未检查 → **2.2**
- `status=in_progress` + 检查已通过 → **3.3**（更新 Spec）→ **3.4**（提交）
- `status=completed`（少见；通常会立即归档）→ 归档流程

Phase 规则（完整详情见 `.trellis/workflow.md`）：

1. 在一个 Phase 内按顺序执行步骤——不得跳过 `[required]` 步骤
2. 如果必需输出已经存在，则 `[once]` 步骤视为已完成。由持久化的规划画像而非自由判断推导等级：`lightweight` 可以只用 `prd.md`；`complex` 还需要 `design.md` 和 `implement.md`；`pending` 状态不可启动。
3. 如果新发现要求回退，可以返回更早的 Phase

## Step 4：加载具体步骤

确定从哪个步骤恢复后：

```bash
python3 ./.trellis/scripts/get_context.py --mode phase --step <X.X> --platform dsh
```

遵循加载出的说明。每完成一个 `[required]` 步骤后，继续下一步。

---

## 参考

完整 workflow 和详细 Phase 步骤位于 `.trellis/workflow.md`。此命令只是入口——规范性指导以该文件为准。
