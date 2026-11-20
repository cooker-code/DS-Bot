# 进度与排障

美化输出面向操作人员；原始输出才是审计日志。应先使用子命令 `forum`、`thread`、`messages`、`context` 作为审计接口，而不是手工 `grep events.jsonl`。

## 美化输出与 `--raw`

`trellis channel messages <channel>` 给出紧凑、易读的时间、身份、kind 与短正文，适合扫描，不适合诊断。美化输出可能截断长 `text_delta`、部分工具参数、工具名或命令行、多行状态和结构化 `detail`，以及超出列预算的论坛标题。看到进度行中途结束、动作显示 `...` 或 worker 看似异常时，改用 `--raw`；它逐行输出与 `events.jsonl` 相同的 JSON，不会丢字段。

```bash
# 美化输出（操作视图）
trellis channel messages <channel> --kind done --last 10
trellis channel messages <channel> --kind error --last 10

# 原始输出（诊断视图），每行一个 JSON 事件
trellis channel messages <channel> --raw --kind progress --last 20
trellis channel messages <channel> --raw --last 50
```

经验法则：绝不依据被截断的进度行诊断 worker。

### 重建流式文本

要还原模型在一次 turn 中实际流出的内容，拼接 progress 事件的 `detail.text_delta`：

```bash
trellis channel messages <channel> --raw --kind progress --last 80 \
  | python3 -c 'import json,sys; [print((json.loads(l).get("detail") or {}).get("text_delta",""), end="") for l in sys.stdin if l.strip()]'
```

## 卡住 worker 的诊断

症状是 `trellis channel list` 显示 worker 仍在运行，但 `messages` 没有新事件且 `wait` 一直超时。按以下顺序排查：

1. **定位通道文件。** 不确定通道在哪个桶时使用 `list --all --all-projects`。

   ```bash
   trellis channel list --all --all-projects
   CHAN=~/.trellis/channels/<bucket>/<channel>
   ```

2. **确认 supervisor 与 worker PID 存活。**

   ```bash
   cat "$CHAN/<worker>.pid"            # supervisor PID
   cat "$CHAN/<worker>.worker-pid"     # 实际 CLI 子进程 PID
   ps -p "$(cat "$CHAN/<worker>.pid")"
   ps -p "$(cat "$CHAN/<worker>.worker-pid")"
   ```

   supervisor PID 消失但通道仍列出 worker 时，这是 ghost entry；用 `trellis channel kill <name> --as <worker> --force` 清理。

3. **跟随 worker 日志。** 这是查看不会进入通道的 provider、MCP 或工具启动输出的标准位置。

   ```bash
   tail -f "$CHAN/<worker>.log"
   ```

4. **查看最后原始事件。** 有 `progress` 但没有 `message`/`done` 往往表示仍在流式执行或卡在工具调用：

   ```bash
   trellis channel messages <channel> --raw --last 50
   ```

常见“存活但沉默”原因：首次 token 前的 provider 冷启动、启动时阻塞的 MCP server、等待挂起子进程的工具结果，或超大 prompt／模型限流；分别查看 worker log 与 provider 侧错误。

## Progress 事件的解释

`progress` 表示进行中的工作。其形状会随 `action` 变化，但关键字段都位于 `detail`：

- `detail.text_delta`：增量模型输出，可跨事件拼接。
- `detail.tool_name`、`detail.tool_input`：即将或正在执行的工具调用。
- `detail.status`：长操作使用的短状态，如 `starting`、`running`、`flushing`、`done`。
- `detail.action`：语义标签，例如线程 heartbeat 的 `status`。

progress 天生嘈杂。`wait` 除非指定 `--include-progress` 否则忽略它；确实需要时优先使用：

```bash
trellis channel messages <channel> --raw --kind progress --last 80
```

稳定产生 progress 但从不以 `done` / `error` / `message` 收尾的流，是典型的工具调用挂起形态；检查 worker log 中的子进程。

## `wait` 语义速查

`channel wait` 从 `events.jsonl` 的 EOF 开始观察，遇到以下事件唤醒：`message`、`done`、`error`、`killed`；只有指定 `--include-progress` 才包括 `progress`。

```bash
trellis channel wait T --as main --from check --kind done --timeout 15m
trellis channel wait T --as main --from check,check-cx --kind done --all --timeout 15m
trellis channel wait T --as worker --kind interrupt_requested,interrupted --timeout 1h
trellis channel wait T --as main --thread release-note --action status --timeout 10m
```

退出码：`0` 表示匹配，`124` 表示超时，`1` / `2` 表示错误。`wait --all` 超时时，stderr 会列出仍缺失的 worker。

## 审计 `events.jsonl`：先用子命令，不用 `grep`

每个通道把完整历史保存到 `$CHAN/events.jsonl`。直接 `tail` / `grep` / `jq` 很诱人，但不应成为习惯，尤其**不能**用于论坛通道。

子命令优先的原因：`messages` 已能按 `--kind`、`--from`、`--last`、`--thread`、`--action` 过滤，并提供准确 JSON 的 `--raw`；`wait` 使用同一文件的 EOF 语义，手写 `tail -f | jq` 在负载下会丢事件或错序；`context` 会投影保存的上下文条目，手工筛选不会尊重 thread 或 channel 级别的投影。

### 论坛通道：绝不直接解析 `events.jsonl`

论坛把多个逻辑线程复用在一个 `events.jsonl`。事件含有 `thread`、`action` 和 tag，论坛子命令知道如何折叠它们。手工解析会混合线程、漏掉 open/status/close 生命周期事件，并忽略 inbox cursor，使已消费事件看起来仍待处理。

改用论坛视图：

```bash
# 列出论坛中的逻辑线程
trellis channel forum <channel>

# 端到端查看一个线程
trellis channel thread <channel> <thread>

# 重放一个线程的消息（支持 --raw、--kind、--last）
trellis channel messages <channel> --thread <thread> --raw --last 100

# 某个 worker 仍待处理的内容
trellis channel context list <channel>
```

只有怀疑 CLI 本身有问题时才直接读取 `events.jsonl`，例如确认事件确实已持久化，或在调试 supervisor 时与 `<worker>.inbox-cursor` 对照；即使如此也不要直接解析论坛的 `events.jsonl`。

## 常见故障

| 症状 | 原因 | 处理 |
|---|---|---|
| `trellis: command not found` | CLI 未全局安装 | `npm install -g @mindfoldhq/trellis` |
| `wait` 立即退出 | filter 错误或 identity 冲突 | 使用不同 `--as`，检查原始 messages |
| zsh 处理消息文本时报错 | shell 解释了标点 | 使用 `--stdin` 或 `--text-file` |
| progress 行被截断 | 美化输出截断 | 使用 `messages --raw --kind progress` |
| worker 从不发言 | provider 启动、prompt 或 MCP 延迟 | 检查 `<worker>.log`、`ps` 与原始事件 |
| 另一 cwd 找不到 channel | 项目 bucket 不同 | `cd` 到项目、使用 `--scope global` 或 `list --all-projects` |
| list 中有 ghost worker | supervisor 未清理即退出 | `trellis channel kill <name> --as <worker> --force` |
| 论坛线程看起来混乱 | 手工解析 `events.jsonl` | 使用 `forum`、`thread`、`messages --thread` |

## 存储布局

```text
~/.trellis/channels/
└── <bucket>/
    └── <channel-name>/
        ├── events.jsonl
        ├── <channel>.lock
        ├── <worker>.log
        ├── <worker>.pid
        ├── <worker>.worker-pid
        ├── <worker>.config
        ├── <worker>.session-id
        ├── <worker>.thread-id
        ├── <worker>.inbox-cursor
        └── <worker>.spawnlock
```

Agent 通常使用 CLI，不直接读取文件。直接读取仅用于 CLI 视图不足时的调试；即使在该情况下，也不要读取论坛通道的 `events.jsonl`。
