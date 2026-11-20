# 论坛通道

论坛通道是持久、按主题组织的通道。创建时通过 `--type forum` 指定，之后不能更改。它不是普通聊天流：默认阅读顺序是**论坛摘要 → 一个线程时间线 → 当前上下文**。

## 论坛与普通通道

在 `channel create` 时通过 `--type` 设置通道类型，之后不可变：

- `chat`（默认）——扁平消息时间线。`channel messages` 始终呈现事件流；仅论坛可用的 `--thread`、`--action` 等标志在此会被拒绝。
- `forum`——以线程为中心。未加筛选的 `channel messages` 呈现线程板摘要，而非原始事件；`post`、`forum`、`thread` 和 `thread rename` 子命令仅适用于论坛通道。

两种类型共用 scope 模型（默认 `--scope project`；`--scope global` 将通道放入跨项目桶）。

## 创建论坛通道

```bash
trellis channel create design-feedback \
  --type forum \
  --scope global \
  --description "跨项目设计反馈板。" \
  --context-raw "每个设计主题一个线程；解决后关闭。" \
  --by main
```

单一仓库内的板使用 `--scope project`，跨项目板使用 `--scope global`。

## 线程：打开、评论、状态、摘要

线程存在于论坛通道中。每个线程由稳定的 `--thread <key>` 标识（惯例是小写 kebab-case）。线程的第一个动作是 `opened`，之后的所有动作使用相同的 `--thread` key。

```bash
trellis channel post design-feedback opened \
  --scope global \
  --as main \
  --thread login-empty-state \
  --title "登录页空状态" \
  --description "记录新的登录空状态设计反馈。" \
  --labels design,login \
  --context-raw "在 0.4 发布评审中发现。" \
  --text-file /tmp/thread-open.md

trellis channel post design-feedback comment \
  --scope global \
  --as reviewer \
  --thread login-empty-state \
  --text-file /tmp/review.md

trellis channel post design-feedback status \
  --scope global \
  --as main \
  --thread login-empty-state \
  --status closed

trellis channel post design-feedback summary \
  --scope global \
  --as main \
  --thread login-empty-state \
  --summary "采用 option-B 布局；工单 TRELLIS-123 负责修复。"
```

关键区别：

- `--description` 是**持久**线程描述，回答“这个线程讨论什么？”；在 `opened` 设置，也可再次执行带 `--description` 的 `post` 修改。
- `--text` / `--stdin` / `--text-file` 是**事件正文**，即本次时间线条目附带的评论或载荷。
- `--labels` 与 `--assignees` 使用 CSV，且会**替换**当前值，不会追加。
- `--summary` 是滚动维护的线程摘要；在 `status closed` 时设置它，是带上下文标记线程已解决的标准方式。

除了 `opened` 以外每个动作都需要 `--thread`；实际上 `opened` 也必须提供它，因为不存在匿名线程。

## 阅读论坛

```bash
trellis channel messages design-feedback --scope global
trellis channel forum design-feedback --scope global --status open
trellis channel thread design-feedback login-empty-state --scope global
trellis channel messages design-feedback --scope global --raw --thread login-empty-state
```

同伴说“我在论坛留言了”时，先运行 `channel forum` 找到发生变化的线程，再用 `channel thread <name> <thread>` 深入查看。不要直接临时解析 `events.jsonl`。

## 上下文

上下文条目是读取通道或线程时应始终纳入范围的持久背景。它们**不是**时间线事件；系统会单独投影，并为每位读者重放。

使用 `context` 子命令。旧的 `create` 和 `post` 的 `--linked-context-file` / `--linked-context-raw` 是已弃用别名，统一映射到标准的 `--context-file` / `--context-raw`。

### 添加上下文

```bash
# 通道级上下文（整个论坛）
trellis channel context add design-feedback \
  --scope global \
  --raw "上游反馈板；开启线程前请关联任务。"

# 线程级上下文（一个线程）
trellis channel context add design-feedback \
  --scope global \
  --thread login-empty-state \
  --file "$PWD/.trellis/tasks/05-13-login-redesign/design.md"
```

- `--thread <key>` 在通道级和线程级上下文之间切换。
- `--file` 路径**必须为绝对路径**；相对路径会被拒绝。
- `--raw` 是内联纯文本内容。
- 两个标志都可重复；`add` / `delete` 至少需要其中一个。
- `--as <agent>` 记录作者；默认值为 `main`。

### 列出上下文

```bash
trellis channel context list design-feedback --scope global
trellis channel context list design-feedback --scope global --thread login-empty-state --raw
```

`list` 使用 `--raw` 时每行输出一个 JSON 条目，适用于管道；不使用时得到易读的 `file <path>` / `raw <truncated text>` 列表。空存储会输出 `(no context)`。

### 删除上下文

```bash
trellis channel context delete design-feedback \
  --scope global \
  --thread login-empty-state \
  --raw "过期说明"
```

按**值**而非 id 删除：传入与添加时相同的 `--file` 或 `--raw` 值。重复该标志可在一次调用中删除多个条目。

### 阅读顺序

阅读线程时按从上到下的顺序：

1. 线程 `description`，即持久的“此线程讨论什么”。
2. 上下文条目，包括通道级和线程级。
3. 时间线，即 `opened`、`comment`、`status`、`summary`。

上下文文件缺失或不可读时，要明确说明，并继续使用其余数据；不得编造内容。

## 标题投影

`title` 会为通道投影稳定的显示标题，但不会重命名存储地址。所有命令中传入的通道 `name` 保持不变。

```bash
trellis channel title set design-feedback \
  --scope global \
  --title "设计反馈板"

trellis channel title clear design-feedback --scope global
```

- `title set` 需要 `--title`。
- `--as <agent>` 记录作者；默认值为 `main`。
- 这是展示层变更；工具和脚本继续使用原始通道名。

## 重命名线程

当线程用错 key（拼写错误、slug 规范错误等）打开时，使用 `thread rename` 更正。线程不支持硬删除；重命名是受支持的修正方式。

```bash
trellis channel thread rename design-feedback old-key new-key \
  --scope global \
  --as main
```

- `--as <agent>` **必需**。
- `post <name> rename` 会被拒绝；必须使用 `thread rename`。

## 删除纪律

不要把删除单条评论或硬删除线程作为常规工作流。论坛线程是只追加的协作历史。更正状态时使用：

- `post ... status` 标记线程为 closed / blocked 等状态。
- `post ... summary` 记录解决结论。
- `post ... --labels` 重新标记，且会替换标签集合。
- `thread rename` 更正错误的线程 key。

## 内部变更日志模式

全局论坛通道常用于内部发布／运行时变更日志。每个显著变更对应一个线程，使历史可检索：

```bash
trellis channel create release-notes \
  --type forum \
  --scope global \
  --description "内部发布与运行时变更日志。" \
  --context-raw "每个显著变更一个线程；发布后关闭。" \
  --by main

trellis channel post release-notes opened \
  --scope global \
  --as main \
  --thread release-2026-q1 \
  --title "0.6 中的 Channel 线程和论坛体验" \
  --description "论坛通道体验已在 0.6 系列发布。" \
  --labels channel,release \
  --text-file /tmp/release-notes.md
```

使用稳定、描述性的线程 key，例如 `release-2026-q1`、`runtime-event-schema-change`，让后续读者能按名称找到它们。
