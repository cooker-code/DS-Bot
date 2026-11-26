# 后门（Backdoor）· 验收记录

- 日期：2026-11-26
- 工作树：项目主目录下的 `.worktree/feat%2Fcodex-local-access`，实际路径通过 `git worktree list --porcelain` 核对。
- 分支：`feat/codex-local-access`；比较基线 `dev@ec64d5e0`
- 候选：本提交中的后门功能。独立验收后仅补充命名、定位和提交记录，保留原有行为与命令。
- 结论：实现完成，独立技术验收通过；用户验收、合入 dev、日用安装和发布尚未进行。

## 用户可见结果

1. **O1 通过：默认关闭，显式启用后才接入。** 新团队没有活动 socket 或发现文件；启用命令返回 `enabled:true,active:true`。macOS 上使用 Unix socket，启用/禁用前后真实宿主的 TCP listener 集合不变，数量均为 1。实现不读、不导出 DSH 登录 URL、Token 或 Cookie。
2. **O2 通过：真实服务中的查询和正文修改可用。** 隔离 DSH `0.2.2-rc.5` 实例中，通过本机入口修改中文两行 Bot 简介和群公告，再按相同 ID 从本机入口及原宿主 API 回读，均与约定保存正文逐字一致。首尾空白沿用原服务 trim，内部换行保留。通过真实群消息创建项目卡后，列表和详情查询成功；宿主重启后正文仍一致。
3. **O3 通过：范围外操作在分派前被拒绝。** 模型、权限、宿主更新、未知 endpoint 和附加字段均拒绝；不安全的 0644 授权文件、符号链接、错误写锁 PID 与只读宿主不能越权。团队状态及修改回执不返回供应商、密钥、连接器、浏览器和私有会话配置。
4. **O4 通过：撤销、异常和退出均有明确结果。** 撤销后新请求失败，再启用恢复；重启后按原授权恢复，PID/socket 更新，旧 socket 不存在。独立测试者另测半正文撤销和 shutdown：补完正文均为 403，业务分派次数为 0，disposer 等待连接收尾。监视报错后停止入口，排队同步不能重开，命令提示需要重开宿主。最终测试进程、socket、发现文件、隔离目录及 Python 缓存均已清理。
5. **O5 通过：授权与交付边界清楚。** help、调用契约、安全模型和设计说明均声明授权对象为当前 macOS 账户，同账户的其他进程也能使用；只开放五项操作；监视失败需择时重开；已有保存可能在撤销后完成。功能尚未安装到日用 Desktop，没有把隔离验证说成日用已加载。

## 自动验证

- 在 `ds-bot/` 运行 `DSH_HARNESS="$(git rev-parse --path-format=absolute --git-common-dir)/../ds-bot/dev/harness" PYTHONDONTWRITEBYTECODE=1 npm test -- test/local-operator.test.js test/client-channel.test.js`：最终 25/25 通过。
- `node --test test/local-operator.test.js`：6/6 通过，未使用 `--test-force-exit`，进程正常退出；独立测试者另行重跑同样通过。
- 修改文件的 oxlint 检查：无警告。全项目 lint 成功，但已有文件仍有原有警告，本次未修改那些文件。
- `python3 .agents/skills/ds-bot-doc/scripts/check_contract.py`：190 项宿主接口均已登记一次。
- Python 语法、CLI 帮助、设计链接和 `git diff --check`：通过。
- 独立测试者验证原 HTTP 登录路径兼容：mount prefix、302/Set-Cookie 及后续同源 Cookie 请求均成功。

## 真实隔离实例

候选实例名 `local-operator`，端口 58338/58339；使用项目模拟模型，无真实模型密钥。验证脚本为 [verify-runtime.py](verify-runtime.py)。

`exercise` 返回以下结果均为 true：`real_intro_exact`、`real_notice_exact`、`task_list_and_detail`、`scope_refusal`、`revocation_and_reenable`。

停止并重启同一隔离宿主后，`after-restart` 返回以下结果均为 true：`restart_restored_access`、`persisted_intro_exact`、`persisted_notice_exact`、`old_socket_cleaned`。独立测试者再次只读执行并确认同样结果。

完整标准冒烟 `node dev/smoke.mjs local-operator 58338` 执行完成，存在两项失败，未称全通过：

- `the big view survives a re-read of the part`：页面只有 1 项，未找到视图卡。
- `Writer condensed in place, not switched`：先前 parts 从 4 变成 6。

另用 `git archive ec64d5e0 ds-bot` 导出的原始源码，在同样 DSH CLI、模拟模型和上下文参数下运行基线实例 `local-operator-baseline`（59910/59911），逐条复现上述相同失败。两项对照达到目的后停止基线的剩余步骤，没有把基线说成完整跑完。独立测试者据此判为既有非回归，当前功能通过。

## 独立回执与清理

独立测试者：`local_access_acceptance`（只读 reviewer）。先指出目录监视异常与关闭过程未串行的问题；修复后复验六项本机测试、半正文并发、旧 HTTP 兼容和真实宿主重启回读，最终结论为“通过，未发现剩余可操作缺陷”。该代理受只读约束没有写文件，本记录由主代理根据其工具验证回执整理。

主代理最终核实：所有本次 bench 进程组退出；58338、58339、59910、59911 四个端口均不再监听；账户 socket 运行目录为空并已移除，候选发现文件不存在；两套隔离实例及基线源码副本删除；工作树内本次生成的 Python 缓存删除。主目录原有改动和用户日用 Desktop 均保留。

## 命名与提交

用户将功能命名为“后门”，英文定位名 `backdoor`。设计索引、技能入口和源码注释均可按这两个名称定位。相关代码、测试、调用契约和本任务记录放在同一个 `feat(backdoor)` 提交中，便于独立查看及后续扩展。
