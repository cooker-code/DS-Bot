# DeepSeek Harness（dsh）中的 Trellis

dsh 是一个 **class-2 拉取式** Trellis 宿主。它从项目中发现 Trellis 技能，使用原生、可继续的子 Agent 承担隔离的实现和评审角色，并向每个受管理的 shell 暴露稳定的 `DSH_SESSION_ID`。

| 能力 | 没有配套插件 | 有 `dsh-trellis` |
| --- | --- | --- |
| 共享技能和入口技能 | 可用 | 可用 |
| 会话范围的活动任务 | 通过已验证的 `DSH_SHELL=1` + `DSH_SESSION_ID` 工作，也支持嵌套启动 | 每次执行的受管理身份可以转发不同的子会话 |
| implement/check/research 角色 | 前台原生子 Agent | 后台原生子 Agent |
| 每轮工作流提示 | 不可用 | 从 `workflow.md` 注入 |
| 事件驱动的子 Agent 等待 | 不可用 | `trellis_wait` |
| 工具命令 | 不可用 | `/trellis-status`、`/trellis-finish` |

## 快速开始

```bash
trellis init --dsh -u your-name
dsh web        # 或：dsh --profile headless "start a Trellis task for ..."
```

在 dsh 中：

1. 用自然语言描述工作；当会话需要显式初始化 Trellis 时，加载 `trellis-start`。
2. 主会话通过 DSH 原生的 `subagent` 工具派发 `trellis-agent-research`、`trellis-agent-implement` 和 `trellis-agent-check`。每个子 Agent 只加载一个对应的角色技能。
3. 使用 `trellis-finish-work` 收尾，它会保留必须遵循的顺序：提交、归档、再记录 journal。

## 配套插件的降级约定

Trellis 适配器不会安装 DSH profile 插件。派发角色前，先检查 `trellis_wait` 工具是否可用：

- 可用时，采用 DSH 默认的、可继续的后台模式；继续执行独立工作；然后对每个有依赖关系的 child id 调用一次 `trellis_wait`，并在进入依赖关卡前消费每个原生完成通知。
- 不可用时，从一开始就用 `run_in_background: false` 派发每个子 Agent，确保依赖工作流关卡不会越过子 Agent。

不得以 shell sleep、轮询循环、`job_output` 或重复轮询 agent 列表替代任一路径。

## 嵌套宿主会话

DSH 会继承启动它的进程的普通环境变量。若外层进程已经是活动的 Trellis 会话，`TRELLIS_CONTEXT_ID` 原本会覆盖内层 `DSH_SESSION_ID`。DSH 会为每个受管理 shell 重建完整的 `DSH_*` 命名空间，因此 beta 适配器会将 `DSH_SHELL=1` 和 `DSH_SESSION_ID` 视为当前 DSH 身份，并优先于继承的通用覆盖项解析，即使没有插件也是如此。可选插件还会在必须转发不同于 shell 自身 session id 的子身份时，提供受信任的 `DSH_TRELLIS_CONTEXT_ID`。

## 文件映射

- `.agents/skills/`：共享工作流和内置技能，与其他 Agent Skills 写入方保持字节级一致。
- `.dsh/skills/trellis-{start,continue,finish-work}/`：DSH 私有入口技能。
- `.dsh/skills/trellis-agent-{research,implement,check}/`：仅供子 Agent 使用的角色技能；implement/check 包含拉取式任务上下文前置加载。
- `.dsh/DSH.md`：本操作指南。
- `.trellis/`：工作流、规范、任务、workspace journal 和共享脚本。

## 注意事项

- 生成的 Python 命令在源模板中使用 `python3`，并在 `trellis init` / `trellis update` 时替换为检测到的 Windows 启动器。
- 角色派发提示必须以 `Active task: <task path>` 开头。这个精确任务路径是子 Agent 的主要上下文来源；子 Agent 不能全局猜测。
- 每次 `dsh --profile headless` 调用都会创建新的 DSH 会话。不要期待活动任务指针跨越独立的 headless 调用而保留；应在同一会话中完成工作流，或显式恢复返回的 session id。
- 可选配套插件由 <https://github.com/SajoLuo/dsh-trellis> 单独维护。
