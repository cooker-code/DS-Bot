# 工作流模式

按协作意图使用下列模式。多轮工作优先使用持久通道，单次提问使用
`channel run`。

## 模式 A：多轮 Brainstorm

当用户说“和 codex/claude 讨论一下”、“brainstorm”或“拉一个 agent
进来一起看”时使用。

```bash
trellis channel create brainstorm-storage-layer --by main \
  --task .trellis/tasks/05-XX-storage-adapter

trellis channel spawn brainstorm-storage-layer \
  --agent architect --provider codex \
  --file .trellis/tasks/05-XX-storage-adapter/prd.md \
  --file .trellis/tasks/05-XX-storage-adapter/design.md \
  --as cx-arch --timeout 30m

trellis channel send brainstorm-storage-layer \
  --as main --to cx-arch --text-file /tmp/brainstorm-r1.md

trellis channel wait brainstorm-storage-layer \
  --as main --kind done --from cx-arch --timeout 10m
```

不要在得到一轮回答后就停止。阅读回答，找出含糊区域，发送新的追问，
反复进行，直到产物可以执行。

每轮至少包含以下结构：

1. 方向拆分：应放入既有机制，还是建立新机制？
2. MVP 边界：v1、v2，以及哪些条件会迫使 v2 回到 v1。
3. 数据契约：事件、schema、metadata、状态唯一事实来源和兼容性。
4. CLI / UX 契约：命令名、参数、错误、默认值和歧义。
5. 跨层风险与测试：共享 helper、漂移点和阻断发布的测试。

可选轮次：

- 运维：日志、调试、卡住的 worker、终止/重启和恢复。
- 迁移/发布：破坏性状态、manifest、changelog、文档站点。
- 对立审查：要求同伴 agent 反驳当前计划。

每个追问都应要求给出具体文件路径、命令、schema、被否决的替代方案和
阻断发布的问题。需要决策时，不接受含糊其辞。

## 模式 B：实施 / 检查 Agent

当用户要求派发实施或审查工作时使用。

```bash
TASK=.trellis/tasks/05-12-foo
trellis channel create cr-foo --task "$TASK" --by main

trellis channel spawn cr-foo \
  --agent check \
  --jsonl "$TASK/check.jsonl" \
  --file "$TASK/prd.md" \
  --file "$TASK/design.md" \
  --file "$TASK/implement.md" \
  --cwd "$PWD" --timeout 15m

trellis channel send cr-foo --as main --to check --text-file /tmp/cr-brief.md
trellis channel wait cr-foo --as main --kind done --from check --timeout 15m
trellis channel messages cr-foo --kind message --from check
```

实施工作使用 `--agent implement`，并发送实施简报。检查工作须包含准确的
diff 范围、相关 spec 和已经运行的验证。

## 模式 C：并行审查者

使用一个通道和不同的 worker 名称。

```bash
trellis channel create cr-feature --by main --ephemeral

trellis channel spawn cr-feature --agent check \
  --jsonl "$TASK/check.jsonl" --file "$TASK/prd.md" --file "$TASK/design.md" \
  --timeout 15m

trellis channel spawn cr-feature --agent check --provider codex --as check-cx \
  --jsonl "$TASK/check.jsonl" --file "$TASK/prd.md" --file "$TASK/design.md" \
  --timeout 15m

trellis channel send cr-feature --as main --to check --text-file /tmp/cr-brief.md
trellis channel send cr-feature --as main --to check-cx --text-file /tmp/cr-brief.md
trellis channel wait cr-feature --as main --kind done --from check,check-cx --all --timeout 15m
```

`--all` 表示列出的每个 worker 都必须发出匹配事件。

## 模式 D：单次 Worker

```bash
trellis channel run --provider codex --message "say hi in 3 words" --timeout 1m
trellis channel run --agent plan --message-file /tmp/plan-question.md --timeout 10m
```

成功时，`run` 会删除 ephemeral 通道。发生错误、超时或被终止时，它会保留通道
并输出用于检查的路径。

## 模式 E：论坛通道

用于 issue 论坛、主题式反馈、发布待办、agent 发现和内部 changelog。
完整模型请阅读 `forum.md`。

## 模式 F：接管已有 Thread

如果用户给出了论坛或 thread 名称，请自行恢复上下文：

```bash
trellis channel forum <board> --scope global
trellis channel thread <board> <thread> --scope global --raw
trellis channel context list <board> --scope global --thread <thread>
trellis channel messages <board> --scope global --raw --thread <thread>
```

输出约束摘要，而不是转录全文：

- 用户层问题
- 影响本仓库的上下文文件
- 当前版本与未来版本的需求
- 当前代码/设计是否满足需求
- 下一步动作或要追加的评论
