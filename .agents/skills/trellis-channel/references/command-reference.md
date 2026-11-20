# 命令参考

这是 `trellis channel` 子命令的权威当前参考，已根据 `packages/cli/src/commands/channel/` 中的源码验证（`index.ts` 的 Commander 接线和每个子命令处理器）。

除非特别说明，每个子命令都接受 `--scope <project|global>`；默认值为 `project`，它按当前 cwd 解析项目桶。

## 顶层

```
trellis channel <subcommand>
```

> 多智能体协作运行时：通过共享事件日志派生、协调和中断 worker agent。

---

## 创建／列出

### `create <name>`

```bash
trellis channel create <name>
  [--scope project|global]                # 默认：project
  [--type chat|forum]                     # 默认：chat
  [--task <path>]                         # 关联的 Trellis task 目录
  [--project <slug>]
  [--labels a,b,c]
  [--description <text>]                  # 稳定的 channel 描述
  [--context-file <abs-path>] ...         # 可重复
  [--context-raw  <text>]      ...        # 可重复
  [--linked-context-file <abs-path>]      # [已弃用别名]
  [--linked-context-raw  <text>]          # [已弃用别名]
  [--cwd <path>]                          # 写入 create 事件的 cwd
  [--by <agent>]                          # 默认：main
  [--force]                               # 覆盖已有 channel
  [--ephemeral]                           # 默认列表隐藏，可被 prune
```

行为：

- 追加一条 `create` 事件；`type` 是不可变的，创建后不能在 forum 与 chat 之间转换。
- `--ephemeral` channel 默认在 `channel list` 中隐藏，是 `channel prune --ephemeral` 的清理目标。
- `--linked-context-*` 会折叠为 `--context-*`；使用时会输出弃用提示。

### `list`

```bash
trellis channel list
  [--scope project|global]
  [--json]
  [--project <slug>]                      # task 字段的子串匹配
  [--all]                                 # 包含 ephemeral（后缀 '*'）
  [--all-projects]                        # 扫描每个项目桶
```

行为：

- 默认 scope 是当前 cwd 的项目。`--all-projects` 扫描全部桶。
- 美化模式按最近活动排序，打印 `NAME WORKERS EVENTS LAST KIND TYPE TASK`，页脚说明被隐藏的 ephemeral 数量。
- `--json` 改为输出 JSON 数组。

---

## Chat 消息

### `send <name> [text]`

```bash
trellis channel send <name> [text]
  --as <agent>                            # 必需：作者
  [--scope project|global]
  [--to <agents,csv>]                     # 默认：广播
  [--stdin | --text-file <path>]          # 从 stdin 或文件读取正文
  [--delivery-mode appendOnly|requireKnownWorker|requireRunningWorker]
```

行为：

- 正文优先级：位置参数 `[text]` → `--stdin` → `--text-file`。
- `--to` 只有一个条目时存为字符串；多个条目时存为数组；省略表示广播。
- `--delivery-mode` 选择定向投递校验：
  - `appendOnly`（默认式行为：只记录），
  - `requireKnownWorker`（目标必须有 `spawned` 事件），
  - `requireRunningWorker`（worker 当前必须存活）。
- 在 stdout 输出追加事件的一行 JSON。

> **注意：** `send` 没有 `--tag`，也没有 `--kind` flag。请见下方 [`tag-vs-kind`](#tag-vs-kind--事件形状实际如何控制)。

### `messages <name>`

```bash
trellis channel messages <name>
  [--scope project|global]
  [--raw]                                 # 每行一个 JSON 事件
  [--follow]                              # 流式输出新事件
  [--last <N>]                            # 最后 N 条匹配事件
  [--since <seq>]                         # seq > N
  [--kind <kind>]                         # `CHANNEL_EVENT_KINDS` 中的一种
  [--from <csv>]                          # 作者过滤
  [--to <target>]                         # 路由目标过滤
  [--thread <key>]                        # 仅 forum
  [--action <thread-action>]              # 仅 forum
  [--no-progress]                         # 隐藏 progress 事件
```

行为：

- 自动识别 forum channel：没有过滤器时渲染 thread board 而不是事件流。`--thread` / `--action` 仅适用于 forum；对 chat channel 使用会报错。
- `--kind` 按 `CHANNEL_EVENT_KINDS` 校验（单值，不是 CSV；CSV 是 `wait` 的语义）。

### `wait <name>`

```bash
trellis channel wait <name>
  --as <agent>                            # 必需：用于过滤上下文的自身名称
  [--scope project|global]
  [--timeout <Ns|Nm|Nh|Nms>]              # 由 parseDuration 解析
  [--from <a,b>]                          # 作者 CSV
  [--kind <k1,k2>]                        # CSV，OR 语义
  [--thread <key>]                        # forum 过滤
  [--action <thread-action>]              # forum 过滤
  [--to <target>]                         # 默认：自身 agent（广播 + 自身）
  [--include-progress]                    # progress 事件也唤醒
  [--all]                                 # 要求每个 --from 都匹配
```

行为：

- 将匹配事件逐行以 JSON 流式输出。
- 默认 `--to` 过滤调用者自身 agent；广播事件仍会匹配（广播 + 明确发给自身）。
- `--all` 要求 `--from` 中列出的每个 agent 都产生匹配事件。
- 使用 `--all` 时，超时以 **124** 退出，并在 stderr 输出 `timeout: still waiting on ...`。

---

## tag 与 kind：事件形状实际如何控制

v0.6.0 channel CLI 的任意位置都**没有 `--tag` flag**；`--kind` 也不是某个 `--tag` 的旧别名。

当前源码的具体模型：

- `--kind` 是唯一事件类型过滤器，受 Trellis 产生的白名单限制（`packages/core/src/channel/internal/store/events.ts` 中的 `CHANNEL_EVENT_KINDS`）：
  - `create`、`join`、`leave`、`message`、`thread`、`context`、`channel`、
    `spawned`、`killed`、`respawned`、`progress`、`done`、`error`、`waiting`、
    `awake`、`undeliverable`、`interrupt_requested`、`turn_started`、
    `turn_finished`、`interrupted`、`supervisor_warning`。
  - 传入其它值会抛出 `Invalid --kind '<x>'. Must be one of: …`。
- `--kind` 存在于 `wait`（CSV、OR 语义）和 `messages`（单个值）。`send` 与 `run` 不能产生自定义 kind：每个 `send` 都写入 `message` 事件。
- 回合中途终止 worker 不是 tag，而是专用 `channel interrupt` 命令。它追加 `interrupt_requested` / `interrupted` 事件，并在 provider 层中断 worker。

调度器等待 worker 的实用规则：

- 对“worker 完成一个回合”，使用 `--kind done,turn_finished`。这是 supervisor 自动触发的系统事件；不要依赖 worker LLM 记得发送自定义信号。
- 仅在确实要中途终止时使用 `trellis channel interrupt`。
- 不要虚构用户侧 tag 作为完成信号。不存在 `--tag` filter；worker 在最终消息中写一段自定义字符串，只是 `message` 事件正文中的文本，不能由 `wait` 匹配。

长正文始终通过 stdin 或文件传递：

```bash
trellis channel send T --as A --stdin < /tmp/message.md
trellis channel send T --as A --text-file /tmp/message.md
```

---

## 中断

### `interrupt <name> [text]`

```bash
trellis channel interrupt <name> [text]
  --as <agent>                            # 必需：调用者
  --to <agent>                            # 必需：目标 worker
  [--scope project|global]
  [--stdin | --text-file <path>]
```

行为：

- 先追加 `interrupt_requested` 事件（`reason: "user"`，带替代指令正文）；支持且目标 worker 非终态时，supervisor 会在 provider 层尝试中断（Claude `/interrupt`，Codex 回合取消），并追加 `interrupted` 事件记录结果。
- 在 stdout 输出最后一条持久化事件的 JSON。

---

## Worker

### `spawn <name>`

```bash
trellis channel spawn <name>
  [--scope project|global]
  [--agent <agent-name>]                  # 加载 .trellis/agents/<name>.md
  [--provider claude|codex]               # 覆盖 agent 文件
  [--as <worker-name>]                    # 默认：agent 名称
  [--cwd <path>]
  [--model <id>]
  [--resume <id>]                         # 恢复 session/thread id
  [--sandbox read-only|workspace-write|danger-full-access]
                                          # 仅 Codex；默认 workspace-write
  [--timeout <Ns|Nm|Nh>]                  # 到期自动 kill
  [--warn-before <Ns|Nm|Nh>]              # supervisor_warning 提前量
                                          # 默认 5m，0ms 禁用
  [--file <path>] ...                     # glob、可重复；注入内容
  [--jsonl <path>] ...                    # Trellis manifest、可重复
  [--by <agent>]                          # spawn 事件作者
                                          # 默认：TRELLIS_CHANNEL_AS env 或 'main'
  [--inbox-policy explicitOnly|broadcastAndExplicit]
                                          # 默认：explicitOnly
  [--idle-timeout <Ns|Nm|Nh>]             # OOM guard 空闲 TTL
                                          # 默认 5m，0 禁用
  [--max-live-workers <n>]                # spawn 时存活 worker 预算
                                          # 默认 6，0 禁用
```

行为：

- provider 会按 adapter registry（`packages/cli/src/commands/channel/adapters/`）校验；当前值为 `claude`、`codex`。
- `--sandbox` 仅传给 Codex 的 `thread/start`：`read-only` 适合只读审查，`workspace-write`（默认）允许写工作区，`danger-full-access` 给予不受沙箱限制的访问；对 Claude 不适用。
- worker 在首个 `send --to <worker>` 前保持 inbox-idle。
- 写入含 `pid`、`provider`、`agent`、`files`、`manifests` 的 `spawned` 事件。
- OOM guard 优先级：CLI flag → env var（`TRELLIS_CHANNEL_WORKER_IDLE_TIMEOUT`、`TRELLIS_CHANNEL_MAX_LIVE_WORKERS`）→ `.trellis/config.yaml#channel.worker_guard` → 内置默认值。

### `run [name]`

```bash
trellis channel run [name?]
  [--agent <name>]
  [--provider claude|codex]
  [--as <worker-name>]
  [--cwd <path>]
  [--model <id>]
  [--file <path>] ...                     # 可重复、glob
  [--jsonl <path>] ...                    # 可重复
  [--message <text> | --message-file <path> | --stdin]
  [--timeout <Ns|Nm|Nh>]                  # 默认 5m
```

行为：

- 单次执行。省略 `name` 时自动生成 `run-<hex>`。
- 创建 ephemeral channel（`createMode=run`），派生一个 worker，发送提示，等待 `done`，在 stdout 输出最终 assistant 文本，成功时删除 channel。失败时保留 channel 供检查，退出码为 1。

> `run` **没有** `--tag` flag。完成由 supervisor 产生的 `done` 事件识别。

### `kill <name>`

```bash
trellis channel kill <name>
  --as <agent>                            # 必需：worker agent 名称
  [--scope project|global]
  [--force]                               # 立即 SIGKILL
```

行为：

- 默认路径：SIGTERM → 8 秒宽限 → SIGKILL 升级；需要 SIGKILL 时 CLI 写入 `killed` 事件，使日志如实反映结果。
- 清理 `pid`、`worker-pid`、`config`、`spawnlock` sidecar 文件；保留 `log`、`session-id`、`thread-id` 供取证／恢复。

### `rm <name>`

```bash
trellis channel rm <name>
  [--scope project|global]
```

行为：

- 终止所有存活 worker，然后删除整个 channel 目录。
- 输出 `Removed channel '<name>'`。

### `prune`

```bash
trellis channel prune
  [--scope project|global]                # 省略：扫描每个项目
  [--all | --empty | --idle <Ns|Nm|Nh|Nd> | --ephemeral]   # 互斥
  [--yes]                                 # 实际删除（默认：dry-run）
  [--dry-run]                             # 默认 true；与默认值重复
  [--keep <names,csv>]                    # 排除列表
```

行为：

- 过滤 flag 相互排斥，否则报错。
- 默认 dry-run；`--yes` 切换为真实删除。
- 未传 `--scope` 时扫描**每个**项目桶（有意的全仓库清理）；使用 `--scope project|global` 时限制为对应桶。
- 无论过滤器为何，含存活 worker 的 channel 都会跳过。
- 输出：每个候选一行 `name  last-ts  (reason)`，随后输出摘要。

---

## Forum 通道

### `post <name> <action>`

```bash
trellis channel post <name> <action>
  --as <agent>                            # 必需
  [--scope project|global]
  [--thread <key>]                        # action=opened 之外必需
  [--title <text>]
  [--text <text> | --stdin | --text-file <path>]
  [--description <text>]                  # 稳定 thread 描述
  [--status <status>]
  [--labels a,b]                          # 替换 thread labels
  [--assignees a,b]                       # 替换 assignees
  [--summary <text>]
  [--context-file <abs-path>] ...
  [--context-raw  <text>]      ...
  [--linked-context-file <abs-path>]      # [已弃用别名]
  [--linked-context-raw  <text>]          # [已弃用别名]
```

行为：

- CLI 表面上的 `<action>` 是自由文本；约定值包括 `opened`、`comment`、`status`、`labels`、`assignees`、`summary`、`processed`。
- `action=rename` 会被拒绝；请改用 `thread rename`。
- `--labels` / `--assignees` 是替换语义，不是追加。
- stdout 输出追加事件 JSON。

### `forum <name>`

```bash
trellis channel forum <name>
  [--scope project|global]
  [--status <status>]
  [--raw]
```

行为：

- 列出 threads（规约后的状态）。`--status` 按当前 thread status 过滤。`--raw` 每个 thread 输出一条 JSON。

### `thread <name> <thread>` / `thread rename`

```bash
trellis channel thread <name> <thread-key>
  [--scope project|global]
  [--raw]

trellis channel thread rename <name> <old-thread> <new-thread>
  --as <agent>                            # 必需
  [--scope project|global]
```

行为：

- `thread <name> <key>` 显示一个 thread 的时间线：标题 `<thread> [<status>] <title>`，随后为 description / labels / assignees / summary / timeline 行。`--raw` 切换为原始事件。
- `thread rename` 是唯一的变更路径；`post --action rename` 会被拒绝。

---

## Context／Title

### `context add` / `context delete` / `context list`

```bash
trellis channel context add <name>
  [--as <agent>]                          # 默认：main
  [--scope project|global]
  [--thread <key>]                        # thread 级，而非 channel 级
  [--file <abs-path>] ...                 # 可重复
  [--raw <text>]      ...                 # 可重复
                                          # 至少提供 --file 或 --raw 之一

trellis channel context delete <name>
  [--as <agent>]                          # 默认：main
  [--scope project|global]
  [--thread <key>]
  [--file <abs-path>] ...
  [--raw <text>]      ...

trellis channel context list <name>
  [--scope project|global]
  [--thread <key>]
  [--raw]                                 # 每行一个 JSON entry
```

行为：

- `add` / `delete` 追加 `context` 事件并输出该事件 JSON。
- `list` 投影当前 context entries；美化输出为 `file <path>` / `raw <truncated text>` 行；为空时为 `(no context)`。

### `title set <name>` / `title clear <name>`

```bash
trellis channel title set <name>
  --title <text>                          # 必需
  [--as <agent>]                          # 默认：main
  [--scope project|global]

trellis channel title clear <name>
  [--as <agent>]                          # 默认：main
  [--scope project|global]
```

行为：

- 追加 `title` 事件，将稳定显示标题投影到 channel。输出：事件 JSON。

---

## 隐藏／内部命令

| 命令 | 用途 |
|---|---|
| `channel __supervisor <channel> <worker> <config>` | `spawn` 调用的 fork 入口。不要直接调用。 |
| `channel __parse-trace <adapter> <file>` | 开发辅助：将记录的 stream-json / wire trace 通过匹配 adapter 重放，输出产生的 channel 事件。adapter 会按 provider registry 校验。 |

---

## 事件模型

`CHANNEL_EVENT_KINDS`（由 `parseChannelKind` 强制执行的白名单）：

`create`、`join`、`leave`、`message`、`thread`、`context`、`channel`、
`spawned`、`killed`、`respawned`、`progress`、`done`、`error`、`waiting`、
`awake`、`undeliverable`、`interrupt_requested`、`turn_started`、
`turn_finished`、`interrupted`、`supervisor_warning`。

`MEANINGFUL_EVENT_KINDS`（未显式传 `--kind` 时，`wait` / `messages` 默认可见的子集）：

`create`、`join`、`leave`、`message`、`thread`、`context`、`channel`、
`spawned`、`killed`、`respawned`、`done`、`error`。

非 meaningful kinds（例如 `progress`、`waiting`、`awake`、`supervisor_warning`，以及 `turn_*` / `interrupt*` 集合）仍会流经 store；通过 `--kind` 或 `--include-progress` 主动纳入。

Forum channel 使用事件溯源；状态投影应使用 CLI reducer（`forum`、`thread`、`context list`）。

---

## 输出约定

- **变更命令**（`send`、`interrupt`、`post`、`context add/delete`、`title set/clear`、`thread rename`）在 **stdout** 输出追加事件的一行 JSON。
- **流式读取**（`wait`、`messages --follow`）在 stdout 每行输出一个 JSON 事件。
- **美化读取**（`list`、`messages`、`forum`、`thread`、`context list`）输出带颜色、补齐的表格／时间线。
- **`run`** 只在 stdout 输出最终 assistant 文本，以便调用者 pipe；诊断说明输出到 stderr。
- **错误**通过 `chalk.red("Error:")` 输出到 stderr，并以 `exit 1` 退出。
- **`wait` 超时**固定以 **124** 退出。
