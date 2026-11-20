---
name: trellis-channel
description: 使用 Trellis channel 进行实时多智能体协作、派生 worker、跨代理审查、进度检查、论坛通道和通道日志排障。
---

# trellis-channel

`trellis channel` 是本地多智能体协作运行时。代理需要通过持久事件日志讨论、把 worker 派生为同级进程、排查或中断运行中的 worker，或将反馈记录到持久的 `--type forum` 通道时，使用此技能。

典型用户表述包括：“和 codex/claude 讨论”“brainstorm with another agent”“spawn an implement/check worker”“let agent review”“open an issue board / changelog forum”“look at this thread”“channel is stuck / no output”“progress was truncated”“how do I write that channel command”。

本技能是索引。只加载当前工作所需的参考文件，不要预加载所有文件。

## 首先执行的命令

```bash
trellis --version
trellis channel --help
trellis channel list --all
trellis channel list --scope global --all
```

如果用户提到通道或线程，先检查它，再询问背景：

```bash
trellis channel forum <board> --scope global
trellis channel thread <board> <thread> --scope global
trellis channel context list <board> --scope global --thread <thread>
```

## 按用户意图选择

| 用户意图 | 读取 |
|---|---|
| “和 codex/claude 讨论一下”“brainstorm with another agent” | `references/workflows.md` |
| “派一个 implement/check agent”“让 agent review”“spawn a worker” | `references/workflows.md`，然后是 `references/workers.md` |
| “开 issue 区 / topic 群 / changelog / board”“make a forum” | `references/forum.md` |
| “看看这个 thread / linked context”“inspect a thread” | `references/forum.md` |
| “channel 卡住了 / 没输出 / progress 被截断”“worker stalled” | `references/progress-debugging.md` |
| “具体命令怎么写”“what flags does X take” | `references/command-reference.md` |

## 核心规则

- 新论坛通道使用 `--type forum`。`thread` 是论坛通道内的一项。
- 使用 `--context-file` / `--context-raw` 以及 `trellis channel context add/delete/list`。`--linked-context-*` 是已弃用术语。
- 长消息使用 `--stdin` 或 `--text-file`。不要把混合中英文长文本放进位置参数。
- 美化的 `messages` 输出是操作面板，可能截断进度。审计时使用 `--raw`。
- `--as` 视命令而定，是发言者或 worker handle。多人或多会话时用明确、稳定的名称。
- `--scope project`（默认）操作当前 cwd 的项目桶；`--scope global` 操作共享的 `__global__` 桶。请主动选择 scope：没有传 `--scope global` 时，项目列表看不到全局 board。
- brainstorm 应进行多轮压力测试。一次回答加一次确认是 review，不是 brainstorm。
- **调度器等待模式**：完成信号使用 Trellis 产生的 `--kind done` / `--kind turn_finished`，不要使用不存在的用户 `--tag`。`--kind` 只能过滤 Trellis 定义的事件类型；`channel interrupt` 产生 `interrupt_requested`，并在实际尝试中断后产生 `interrupted`。依赖 worker 发送自定义信号不可靠，LLM 写入正文的字符串只是 `message` 事件文本，不能由 `wait` 过滤。请见 `references/command-reference.md` 的“tag 与 kind”。
- 论坛通道采用事件溯源。不要先解析 `events.jsonl`；使用 `forum`、`thread`、`messages --thread` 和 `context list`。
- `@mindfoldhq/trellis-core` 负责可复用的 channel/thread 状态、事件追加、seq 分配、上下文/标题投影、reducer 与任务辅助；CLI 负责 flags、终端渲染、提示、worker 生命周期和进程退出。

## 参考文件

- `references/workflows.md`：规范协作模式 A–F（同伴 brainstorm、派生审查、派发并等待、论坛 issue 记录、中断并重定向、单次 run）。
- `references/forum.md`：论坛通道、上下文、标题、重命名、changelog 论坛与线程筛选。
- `references/workers.md`：spawn、agent 卡片、上下文注入（`--file` / `--jsonl`）、中断和 kill 语义。
- `references/progress-debugging.md`：进度／raw 检查、卡住 worker 诊断、OOM guard、退出码。
- `references/command-reference.md`：当前 CLI 命令参考（每个子命令、每个 flag、输出约定和 scope/type 模型）。

## 不适用的情况

- 一次静态审查，Markdown 文件和提示已足够。
- 用自我日志替代正常工具调用。
- 长期记忆检索。可操作 issue 使用持久 forum 通道；会话／历史检索使用 `trellis mem`（`trellis-session-insight` 技能）。
