# DS Bot 程序化设置与岗位验证

2026-11-20。操作者现可按岗位修改资料、登记技能、独立查询某个群的 task。入口在仓库根目录的 AGENTS.md 和 `.agents/skills/ds-bot-doc/SKILL.md`。

| 交付与验证 | 实际结果 |
| --- | --- |
| 岗位和工具归属 | 根目录 `vision.md` 说明项目初始化、管理员首答、架构师缺席时的查证责任、按需报告、独立复核以及不同项目的 Git 约定。`docs/bot-role-profiles.zh.md` 给出十二个可复用岗位及其技能。 |
| 接口和维护 | 三份接口表覆盖 172 个操作者操作名，各出现一次。仓库 CI 检查分派与文档的一致性。字段和返回语义仍需在同一变更逐项维护。SQLite 指南包含目录库、Bot 库、群库、锁及可执行查询。 |
| 隔离 Web 的设置 | 从本实例的正式启动输出建立同源会话。导入架构核验、Diffmap、进度分析和 ds-bot-doc 的实际文件，通过 API 创建十二个预置岗位。重复配置复用原 Bot ID 和唯一绑定，给已有成员只补技能可保留定制简介。群内模型覆盖能独立保存。重启后按 ID 回读相符。 |
| 查询项目进度 | `project-task-list` 复用全队视图的摘要，同一响应返回群 ID、修订号、task 和待处理收件。两个群相互隔离，空群返回两个空数组，未知群返回业务错误，只读宿主可以查询。单个 task 的错误或重试仍须读取轮次明细。 |
| 自动验证 | 22 项通道和项目执行用例通过。宿主冒烟测试 55 步通过。构建产物一致，三个仓库技能通过格式校验。对停机副本执行指南中的 SQL、外键检查、完整性检查及事务回滚，结果符合预期。两套隔离环境的进程、端口、写锁及临时数据已清理。 |

## 日用团队与安装版本

在线只读核对确认，十二份简介都有换行且没有嵌入当前群名。工程和数据两个任务助理都已绑定 `ds-bot-task-slicing`、`visible-bot-delegation`、`interrupted-node-recovery`。日用共享库已登记 `verify-gitnexus-context` 和 `analyze-task-progress`。

本机 Web profile 链接到当前工作区。Desktop profile 已通过 DSH 插件管理器安装本次本地包；和上一份安装包比较，仅插件服务端 `src/host/channel.js` 发生变化。已逐字节核对已安装文件与工作区一致。

用户批准日用维护窗口后，Desktop 正常退出，临时 DSH Web 接管写锁并通过正式登录会话配置原团队。登记两个文件夹技能，共 11 个文件。更新进度技能，补入按群查询和按 task 查看轮次的用法。八个 Bot 新增十项绑定，均从恢复后的 Desktop 回读，`capabilityStatuses` 的十项状态均为 `ready`。

| 岗位 | 日用团队已绑定 |
| --- | --- |
| 小圈，两个群的管理员 | `ds-bot-doc`，含手册、接口表及操作脚本。 |
| 架构工程师 | `verify-gitnexus-context` 和 `generate-diffmap`，含本机 Diffmap 技能的两个文件。 |
| 报告工程师、任务助理、数据任务助理 | 各绑定 `analyze-task-progress`。 |
| 需求梳理 | `bigdata-conan-text2sql` 和 `bigdata-conan-governance`。 |
| 上线复核员 | `readonly-acceptance-handoff`。 |
| ETL 开发 | 原岗位说明已包含候选作业测试，已补 `bigdata-conan-ops`。 |

维护交接约 15 秒。临时 Web 随后退出，新 Desktop 宿主持有原团队写锁。从新进程签发的同源登录会话验证，`state` 返回可写、12 个 Bot 和 2 个群。对两个群分别调用 `project-task-list`，均能读到对应群的 task 和收件。比对维护前后 SQLite，全部成员简介、模型、工作目录、权限、原有技能以及群成员和群内覆盖一致。导入的 11 个文件与仓库及本机原包逐字节相符。

本机可在子 shell 加载 `~/.local/state/ds-bot/operator.env`。其中只有当前服务地址和本人可读的原始启动输出路径。登录由 Desktop 签发，保存在权限为 `0600` 的启动输出中。当前会话可直接通过 `request.py` 操作。Desktop 再次启动后，按新进程的启动公告更新该连接配置。

本次交付核实的是岗位、运行时技能状态和项目进度的读取入口。真实需求的开发与验收过程，应从对应业务 task 的候选、轮次与复核记录核查。
