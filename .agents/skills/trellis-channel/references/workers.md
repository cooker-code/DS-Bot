# Worker 与 Agent 卡片

当需要由同级 Agent 独立执行工作，并通过 channel 事件日志回报时，使用 worker。Worker 是挂接到 channel 的已注册子进程（`claude` 或 `codex`）；supervisor 将收件箱消息转发给它，再把其输出转换回 channel 事件。

## 启动

```bash
trellis channel create impl-task --by dispatcher --cwd /path/to/repo
trellis channel spawn impl-task --provider codex --as codex-impl --timeout 30m

echo "Implement the schema for table X per .trellis/.../prd.md" \
  | trellis channel send impl-task --as dispatcher --to codex-impl --stdin

trellis channel wait impl-task --as dispatcher --from codex-impl --kind done --timeout 30m
```

`spawn` 会派生一个 `channel __supervisor` worker：它发出 `spawned`、持续输出 `progress`，并应以 `done`、`error` 或 `killed` 结束。Worker 会保持收件箱空闲状态，直到 `send --to <worker>` 唤醒它；若设置了 `--inbox-policy broadcastAndExplicit`，广播同样可以唤醒它。

`spawn` 的主要参数：

- `--agent <name>`：加载 `.trellis/agents/<name>.md`，其中提供 provider、model、`as` 与 system prompt 的默认值。
- `--provider <claude|codex>`：覆盖 Agent 卡片中的 provider；会对照 adapter registry 校验。
- `--as <name>`：channel 中 worker 的句柄；默认使用 agent 名称。
- `--cwd <path>`：worker 的工作目录，同时也是 `--file` / `--jsonl` 的路径限制根目录。
- `--model <id>`：覆盖模型。
- `--resume <id>`：恢复已有的 claude session 或 codex thread。
- `--sandbox <read-only|workspace-write|danger-full-access>`：仅 Codex；控制其 `thread/start` 沙箱。`read-only` 用于只读审查，`workspace-write` 为默认写工作区模式，`danger-full-access` 不受沙箱限制；对 Claude 不适用。
- `--timeout <duration>`：在 `30s` / `2m` / `1h` 后自动 kill。
- `--warn-before <duration>`：`supervisor_warning` 的提前告警时间，默认 `5m`；`0ms` 禁用。
- `--file <path>`：可重复、支持 glob；将文件内容注入 system prompt。
- `--jsonl <path>`：可重复；Trellis JSONL 清单，每行是 `{file, reason}`。
- `--by <agent>`：`spawned` 事件作者；默认 `$TRELLIS_CHANNEL_AS` 或 `main`。
- `--inbox-policy <explicitOnly|broadcastAndExplicit>`：默认 `explicitOnly`。
- `--idle-timeout <duration>`：OOM guard 的空闲 TTL；默认 `5m`，`0` 禁用。
- `--max-live-workers <n>`：spawn 时允许的存活 worker 上限；默认 `6`，`0` 禁用。

成功事件 `spawned` 会记录 `pid`、`provider`、`agent`、注入的 `files` 以及解析后的 `manifests`，使之后的旁观者可以审计上下文。

## Agent 卡片

`--agent <name>` 会解析为 `.trellis/agents/<name>.md`。卡片名称必须匹配 `[A-Za-z0-9._-]+`。默认 Trellis 安装包含两份卡片：

- `.trellis/agents/check.md`：代码质量审查员。
- `.trellis/agents/implement.md`：实施运行时的编码 worker。

```yaml
---
name: check
description: Code quality check expert.
provider: claude
---
```

Frontmatter 字段会填充 `spawn` 默认值（provider、model、`as`）；Markdown 正文成为 worker 在 system prompt 中的角色说明。卡片**不会**自动附加 task 文件，必须在每次 spawn 时显式注入上下文，见下文。

启动命名 Agent 前，始终先检查项目中的卡片：

```bash
ls .trellis/agents
sed -n '1,100p' .trellis/agents/check.md
```

## 上下文注入

两个参数会由 `context-loader` 将内容组装为 system prompt 内的 `# CONTEXT FILES` 区块：

- `--file <path>`：可重复、支持 glob（`*`、`**`）。读取并连接每个匹配文件。
- `--jsonl <path>`：可重复；Trellis 清单，每行都应为 `{"file":"<path>","reason":"<why>"}`。每份文件内容前会保留其 reason 作为头部注释。

加载器会执行以下限制：

- 单文件硬上限为 1 MB，超出即报错。
- 单文件达到 200 KB 时向 stderr 输出 warning。
- 组装后的上下文总量达到 500 KB 时向 stderr 输出 warning。
- 路径穿越限制：所有解析后的路径都必须位于 `--cwd` 下。

以下示例在 task 目录上启动 check agent：

```bash
TASK=.trellis/tasks/05-13-example
trellis channel spawn cr-example --agent check --provider codex --as check-cx \
  --file "$TASK/prd.md" \
  --file "$TASK/design.md" \
  --file "$TASK/implement.md" \
  --jsonl "$TASK/check.jsonl" \
  --cwd "$PWD" --timeout 30m
```

`spawned` 事件会记录字面的 `files` 数组以及从 `--jsonl` 展开的 `manifests`，因此审计轨迹会准确留下 worker 实际看到的内容。

## 名称与路由

`--as` 有两种含义：

- 对 `send` / `wait` / `interrupt`：作为发言者身份，也就是结果事件的作者。
- 对 `spawn`：作为其他 Agent 使用 `--to` 寻址的 worker 句柄。

当一个 channel 有多个 worker 或 provider 时，使用明确名称：

```bash
trellis channel spawn cr-feature --agent check --as check-claude
trellis channel spawn cr-feature --agent check --provider codex --as check-cx

trellis channel wait cr-feature --as main \
  --from check-claude,check-cx --kind done --all --timeout 15m
```

`--all` 必须和 `--from` 一起使用；它会阻塞到每个列出的 worker 都产生匹配事件。超时时退出码为 **124**，并向 stderr 输出 `timeout: still waiting on ...`。

## 软中断：`interrupt`

`channel interrupt` 用于协作式重定向：它先追加 `interrupt_requested` 事件（reason 为 `"user"`），并在 adapter 支持且目标 worker 非终态时向 provider 请求中断当前 turn、替换执行指令；实际尝试后会追加 `interrupted` 事件。适用于 worker 应立即放下当前 turn 按新输入行动、但不应丢失 session 的情况。

```bash
echo "Stop refactoring the parser — switch to fixing the failing test in src/foo.ts" \
  | trellis channel interrupt impl-task --as dispatcher --to codex-impl --stdin
```

参数：

- `--as <agent>` **（必填）**：调用方身份。
- `--to <agent>` **（必填）**：目标 worker。
- `--scope <project|global>`：channel 作用域。
- `--stdin` / `--text-file <path>` / `[text]`：替换指令正文。

中断请求追加 `interrupt_requested`；若 CLI 实际尝试了中断，还会追加 `interrupted`。下游可分别用 `wait --kind interrupt_requested,interrupted` 或 `messages --kind interrupted` 观察改派事件。

对可以等到 worker 下一轮再处理的低优先级提示，应改发普通消息：

```bash
echo "Check this when you reach the next turn." \
  | trellis channel send impl-task --as dispatcher --to codex-impl \
      --stdin
```

## 硬中断：`kill` + `--resume`

当 worker 必须**立即**停止时使用 `kill`，例如出现失控循环、已经在执行错误指令，或 adapter 不接受 `interrupt`。Supervisor 会按 SIGTERM → 8 秒宽限期 → SIGKILL 升级；若确实需要 SIGKILL，CLI 会写入 `killed` 事件，保持事件日志真实。

```bash
trellis channel kill impl-task --as codex-impl
trellis channel spawn impl-task --as codex-impl --provider codex \
  --resume "$(cat ~/.trellis/channels/<bucket>/impl-task/worker.session-id)"

echo "STOP — new instructions: ..." \
  | trellis channel send impl-task --as dispatcher --to codex-impl --stdin
```

`kill` 参数：

- `--as <agent>` **（必填）**：指定 worker 名称；位置参数 `<name>` 是 channel 名称。
- `--scope <project|global>`。
- `--force`：立即发送 SIGKILL，同时 kill 内部 worker pid。

副作用：会清理 `pid`、`worker-pid`、`config`、`spawnlock` sidecar 文件；保留 `log`、`session-id`、`thread-id` 以便取证和恢复。

当 `interrupt` 无法收敛时，`kill` + `--resume` 是保证能够完成重定向的路径。

## Worker OOM Guard

OOM guard 防止孤儿或空闲 worker 不断累积并耗尽宿主资源。它会在每次 `spawn` 时运行，并对每个 project bucket 实施两项策略：

- **空闲 TTL**：清扫最后活动时间早于配置阈值的 worker，默认 `5m`，`0` 禁用。
- **存活 worker 预算**：如果同一 project bucket 内已有超过 N 个存活 worker，则拒绝新的 spawn，默认 `6`，`0` 禁用。

优先级从高到低：

1. CLI 参数：`spawn` 的 `--idle-timeout`、`--max-live-workers`。
2. 环境变量：`TRELLIS_CHANNEL_WORKER_IDLE_TIMEOUT`、`TRELLIS_CHANNEL_MAX_LIVE_WORKERS`。
3. `.trellis/config.yaml` 中的 `channel.worker_guard`。
4. 内置默认值：`5m`、`6`。

清理通知会在 spawn 时写入 stderr，使操作者能了解清扫了哪些空闲 worker，以及为何拒绝新的 spawn。Guard 不会以不同方式对待 ephemeral / `channel run` worker：它们受相同的空闲 TTL 与预算限制。

如需审计当前状态，可通过 `channel list` 查看 worker（`WORKERS` 列），并检查 `~/.trellis/channels/<bucket>/<channel>/` 下每个 channel 的 `pid` / `worker-pid` sidecar 文件。

## Worker 收件箱 API

收件箱是 worker 被唤醒时使用的 channel 表面。路由由两个开关控制：

- **收件箱策略**（`spawn --inbox-policy`）：
  - `explicitOnly`（默认）：worker 只会被 `send --to <worker>` 或 `interrupt --to <worker>` 唤醒。
  - `broadcastAndExplicit`：没有 `--to` 的广播同样会唤醒 worker。
- **投递模式**（`send --delivery-mode`）：
  - `appendOnly`：无论 worker 状态如何都追加事件。
  - `requireKnownWorker`：若 `--to` 中命名的 worker 从未 spawn，则失败。
  - `requireRunningWorker`：若命名 worker 当前不存活，则失败。

更严格的投递模式可避免调用者本来期望一个运行中的同级 Agent 时，消息却静默丢失。

与收件箱相关的子命令：

- `send <channel> [text]`：追加 `message` 事件。
  - `--as <agent>` **（必填）**：作者。
  - `--to <agents>`：CSV；一个目标为 string，多个目标为 array；缺省时为广播。
  - `--stdin` / `--text-file <path>` / `[text]`：正文来源。
  - `--delivery-mode <appendOnly|requireKnownWorker|requireRunningWorker>`。
- `interrupt <channel> [text]`：软中断重定向，见上文。
- `wait <channel>`：阻塞到匹配事件到达。
  - `--as <agent>` **（必填）**：过滤上下文中的 `self`。
  - `--from <agents>`：CSV 作者。
  - `--kind <kind[,kind...]>`：CSV，使用 OR 语义；支持 `interrupt_requested`、`interrupted`、`done`、`progress` 等。
  - `--to <target>`：默认自身 Agent，接收广播和明确发给自己的事件。
  - `--include-progress`：progress 事件也会唤醒。
  - `--all`：要求每个 `--from` Agent 都匹配，超时退出 **124**。
  - `--timeout <duration>`：`30s` / `2m` / `1h` / `1000ms`。
- `messages <channel>`：查看、过滤或跟随事件流。
  - `--follow`：尾随；`--kind` / `--from` / `--to`：过滤；`--raw`：每行 JSON；`--no-progress`：隐藏 progress 噪声。

典型的 dispatcher 循环：

```bash
# 1. 唤醒 worker。
echo "Run the failing test and report." \
  | trellis channel send impl-task --as dispatcher --to codex-impl --stdin \
      --delivery-mode requireRunningWorker

# 2. 阻塞到它结束。
trellis channel wait impl-task --as dispatcher \
  --from codex-impl --kind done,error --timeout 30m

# 3. 读取最终回答。
trellis channel messages impl-task --from codex-impl --last 1 --raw
```

所有会发出事件的子命令（`send`、`interrupt`、`post`、`context add` / `delete`、`title set` / `clear`、`thread rename`）都会在 stdout 将追加事件打印成单行 JSON，使收件箱层易于脚本化使用。
