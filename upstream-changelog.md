# 上游更新记录

来源仓库为 [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot)。每个 PR 只占一行。权重为本地采用优先级（1–10，10 最高）。后续涉及同一问题时，可按功能、工具名或 PR 号查找当时的取舍。

## 2026-11-20 · 首批补记

| 项目 | 记录 |
| --- | --- |
| 首次登记时间（本批各条目共用） | 2026-11-20 13:54 UTC+08:00（Asia/Taipei）；上一轮处理日期为 2026-11-20 |
| 已盘点区间 | upstream/dev 第一父链，[83013153 → f8577350](https://github.com/Fei2411/DS-Bot/compare/83013153...f85773506037e38644d6327f738f73525b2f56fb)，终点 `f85773506037e38644d6327f738f73525b2f56fb` |
| 上一轮处理结果 | 51 个 PR：27 项已应用到本地工作区，当时未提交；19 项暂缓；5 项跳过 |
| 上一轮验证 | 客户端构建与生成文件检查通过；487 项针对性测试通过，1 项 Windows 专用测试跳过；模拟模型 DSH Web 冒烟 55 步全部通过。 |
| 本机插件同步 | 2026-11-20 14:09 +0800：按当前工作区更新 Web 链接安装及 Desktop 本地包安装；两个 profile 各核对 161 个包内文件，内容一致。已运行实例的重载状态未验证。 |

### 上游设计文档说明

本批新增 1 篇设计，改写 6 篇已有设计正文，另更新 1 份目录。下列链接固定到本批终点。

| 来源 | 新增功能或解释 | 本地处理 |
| --- | --- | --- |
| #1655、#1887 · [Bot 异步工作](https://github.com/Fei2411/DS-Bot/blob/f85773506037e38644d6327f738f73525b2f56fb/docs/plans/2026-11-16-async-work.md) | 改变原有「并行靠多个 Bot」的决定。自己的会话中，Shell 默认等待 5 秒后转后台，群聊仍沿用群轮次。另一种后台工作由同一 Bot 的独立会话执行，有稳定 taskId，可查看、发消息和停止，结果回到前台。重启后区分续跑、继续等待和命令已中断。文中把「用户插话时自动把整段工作转后台」列为后续 PR。 | 两项暂缓；本地项目卡已有执行轮次与恢复逻辑。重审时先明确后台结果对应哪个节点。 |
| #1736 · [Bot 运行与恢复](https://github.com/Fei2411/DS-Bot/blob/f85773506037e38644d6327f738f73525b2f56fb/docs/plans/2026-10-10-bot-runtime.md) | 启动时比对会话记录、投影缓存和持久化模型选择，满足条件才省略重新选模型，减少大群日志重读。活跃会话或缺记录仍走原路径。 | 暂缓；需结合本地分库和群成员模型设置。 |
| #1752 · [上下文与记忆](https://github.com/Fei2411/DS-Bot/blob/f85773506037e38644d6327f738f73525b2f56fb/docs/plans/2026-10-09-context-and-memory.md)、[私有 Bot](https://github.com/Fei2411/DS-Bot/blob/f85773506037e38644d6327f738f73525b2f56fb/docs/plans/2026-10-27-private-bots.md)、[记忆恢复](https://github.com/Fei2411/DS-Bot/blob/f85773506037e38644d6327f738f73525b2f56fb/docs/plans/2026-11-01-memory-restore.md)、[本地智能体](https://github.com/Fei2411/DS-Bot/blob/f85773506037e38644d6327f738f73525b2f56fb/docs/plans/2026-11-04-local-agents.md)、[记忆分层](https://github.com/Fei2411/DS-Bot/blob/f85773506037e38644d6327f738f73525b2f56fb/docs/plans/2026-11-09-memory-layers.md) | 五篇同步更新为 bot_remember、bot_forget、bot_recall，说明记忆读写、恢复和本地智能体场景中的调用名称。 | 暂缓；以后改工具接口时一起核对调用方。 |
| #1717、#1655 · [设计目录](https://github.com/Fei2411/DS-Bot/blob/f85773506037e38644d6327f738f73525b2f56fb/docs/plans/README.md) | #1717 补列已有的「群聊里的改动」「一个 Bot 同时跑两个会话」「批量换 Bot 的模型」；另由 #1655 登记异步工作。前三项是索引补录。 | 保留本地目录，后续分别按实际功能检索。 |

### 已合入本地工作区

| 上游 PR | 权重 | 功能 | 本地处理及重审线索 |
| --- | ---: | --- | --- |
| [#1754](https://github.com/Fei2411/DS-Bot/pull/1754) | 9 | 异常模型响应重试 | 保留群成员的模型选择；注册顺序测试包含本地分段监听。 |
| [#1778](https://github.com/Fei2411/DS-Bot/pull/1778) | 9 | 本地智能体错误转换 | 数字或空错误码仍能保留原始原因。 |
| [#1813](https://github.com/Fei2411/DS-Bot/pull/1813) | 9 | Bot 浏览器请求失败 | 表单请求失败或标签页崩溃时收尾，保留本地会话逻辑。 |
| [#1707](https://github.com/Fei2411/DS-Bot/pull/1707) | 8 | 本地智能体权限预设 | 按群、Bot、宿主的有效预设启动，保留群成员模型覆盖。 |
| [#1681](https://github.com/Fei2411/DS-Bot/pull/1681) | 8 | Claude 接收分块输入 | 调用 steer 时解开内容块数组。 |
| [#1853](https://github.com/Fei2411/DS-Bot/pull/1853) | 8 | Antigravity 登录 | 修正 macOS 上的登录状态识别。 |
| [#1820](https://github.com/Fei2411/DS-Bot/pull/1820) | 8 | Windows Pi 启动 | 传递已解析的可执行文件路径；Windows 原生启动待实机验证。 |
| [#1651](https://github.com/Fei2411/DS-Bot/pull/1651) | 8 | 群目标结算 | 结算期间保留空闲检查预算。 |
| [#1749](https://github.com/Fei2411/DS-Bot/pull/1749) | 8 | 定时任务编辑 | 显式拒绝宿主会忽略的更新字段。 |
| [#1714](https://github.com/Fei2411/DS-Bot/pull/1714) | 8 | 聊天文件链接 | 正确处理文件名中的井号和问号。 |
| [#1680](https://github.com/Fei2411/DS-Bot/pull/1680) | 8 | 飞书 | 修正按钮卡片、富文本和文件接收及提及判断。 |
| [#1862](https://github.com/Fei2411/DS-Bot/pull/1862) | 8 | QQ、钉钉、微信 | 修复接收图片和文件。 |
| [#1827](https://github.com/Fei2411/DS-Bot/pull/1827) | 8 | QQ 语音 | 将平台语音识别文本交给 Bot。 |
| [#1594](https://github.com/Fei2411/DS-Bot/pull/1594) | 7 | Slack 连接器登录 | 手动配置客户端和回调监听清理；测试用本地 savedTeam() 读取分库结果。 |
| [#1029](https://github.com/Fei2411/DS-Bot/pull/1029) | 7 | 模型菜单搜索 | 搜索与键盘筛选可和本地弹窗左右对齐共存。 |
| [#1829](https://github.com/Fei2411/DS-Bot/pull/1829) | 6 | 长公式聊天输入卡顿 | 跳过屏外消息正文的渲染。 |
| [#1756](https://github.com/Fei2411/DS-Bot/pull/1756) | 6 | 插件设置页 | 修复高度塌缩，保留本地任务详情布局。 |
| [#1790](https://github.com/Fei2411/DS-Bot/pull/1790) | 6 | 连接提示 | 短暂重连时避免闪现警告。 |
| [#1799](https://github.com/Fei2411/DS-Bot/pull/1799) | 6 | Slack 消息格式 | 正确发送粗体。 |
| [#1798](https://github.com/Fei2411/DS-Bot/pull/1798) | 6 | Telegram 消息格式 | 按转义后的长度拆分代码块。 |
| [#1801](https://github.com/Fei2411/DS-Bot/pull/1801) | 6 | QQ 表格 | 单元格内换行时保留行的列表结构。 |
| [#1782](https://github.com/Fei2411/DS-Bot/pull/1782) | 5 | 头像库 | 限制并发读取数量。 |
| [#1781](https://github.com/Fei2411/DS-Bot/pull/1781) | 5 | 长回复导读 | 共用滚动监听，保留本地阅读区计算。 |
| [#1679](https://github.com/Fei2411/DS-Bot/pull/1679) | 5 | 连接器和企业微信 | 首次使用时加载授权客户端和 WebSocket 依赖。 |
| [#1839](https://github.com/Fei2411/DS-Bot/pull/1839) | 4 | 斜杠菜单 | 说明紧跟对应命令。 |
| [#1742](https://github.com/Fei2411/DS-Bot/pull/1742) | 4 | 模型供应商卡片 | 徽标保持在卡片内。 |
| [#1711](https://github.com/Fei2411/DS-Bot/pull/1711) | 4 | 浏览器下载测试 | 使用可控时钟验证下载等待窗口。 |

### 暂缓 · 后续相关修改先查

| 上游 PR | 权重 | 功能 | 本地处理及重审线索 |
| --- | ---: | --- | --- |
| [#1887](https://github.com/Fei2411/DS-Bot/pull/1887) | 10 | Bot 后台任务 | 上游独立会话、稳定任务 ID 和恢复机制与本地项目节点派工、结果回报重叠。调整任务执行或恢复时，对照任务归属与回报目的地。 |
| [#1655](https://github.com/Fei2411/DS-Bot/pull/1655) | 10 | 慢 Shell 命令转后台 | 上游将结果送回发起会话；本地项目节点需要绑定执行轮次。调整长命令时核对谁持有状态和结果。 |
| [#1652](https://github.com/Fei2411/DS-Bot/pull/1652) | 10 | report_back 回报路由 | 上游定位调用方的开放会话段；本地还需要群和任务归属。修改回报时核对并行任务。 |
| [#1628](https://github.com/Fei2411/DS-Bot/pull/1628) | 10 | 群消息去重 | 上游消除重复状态与结束语；本地消息含任务范围。调整去重时保留不同任务各自的事件。 |
| [#1709](https://github.com/Fei2411/DS-Bot/pull/1709) | 10 | 连续开工提示 | 上游按同一个 Bot 折叠；本地一个 Bot 可连续处理两个任务。修改展示时核对任务和轮次。 |
| [#1736](https://github.com/Fei2411/DS-Bot/pull/1736) | 9 | 减少启动重放 | 上游用已保存的模型选择减少重读会话；本地分库、群成员模型覆盖均参与启动。重审启动或历史加载时核对。 |
| [#1757](https://github.com/Fei2411/DS-Bot/pull/1757) | 9 | 群历史补齐 | 上游从群会话回填早于消息账本的记录；本地按群拆库并按任务范围查询。迁移时验证旧消息完整和不串任务。 |
| [#1858](https://github.com/Fei2411/DS-Bot/pull/1858) | 9 | 群聊读图 | 上游选择有视觉能力的路线并调整文字识别回退；本地允许按群覆盖成员模型。改动读图或模型路由时参照。 |
| [#1766](https://github.com/Fei2411/DS-Bot/pull/1766) | 8 | 压缩后继续腾出上下文 | 上游用实际用量修正分段估计；本地群成员可主动申请新段。修改上下文或换段时核对同时触发的顺序。 |
| [#1789](https://github.com/Fei2411/DS-Bot/pull/1789) | 8 | 删除 Bot 的并发清理 | 上游先保护删除，再清理侧聊和临时对话；本地还需清理项目助理与成员配置。调整 roster 删除流程时重审。 |
| [#1860](https://github.com/Fei2411/DS-Bot/pull/1860) | 7 | 群聊顶部审批 | 上游把待批准操作带到顶栏和详情；本地详情抽屉已承载项目任务。修改审批入口时核对 Bot、群和当前任务。 |
| [#1783](https://github.com/Fei2411/DS-Bot/pull/1783) | 6 | 能力状态缓存 | 本地支持技能目录导入、删除和按 Bot 启用；改能力列表性能时核对缓存失效条件。 |
| [#1752](https://github.com/Fei2411/DS-Bot/pull/1752) | 5 | 记忆工具改名 | 上游统一三个工具名；本地提示词、模拟模型、工具过滤和测试亦依赖名字。调整记忆接口时成组核对。 |
| [#1776](https://github.com/Fei2411/DS-Bot/pull/1776) | 4 | 窄屏聊天与侧栏 | 上游改 Web 插件布局；本地已调整返回入口并移除独立窗口测试。改窄屏布局时参照其响应式处理。 |
| [#1150](https://github.com/Fei2411/DS-Bot/pull/1150) | 4 | 折叠侧栏图标居中 | 上游给 Agent 行指定宽度；本地侧栏样式上下文不同。调整折叠栏时参照。 |
| [#1650](https://github.com/Fei2411/DS-Bot/pull/1650) | 4 | 宿主错误翻译 | 上游补充错误文案，本地翻译表已有新增项。维护翻译时按实际错误逐条对照。 |
| [#1791](https://github.com/Fei2411/DS-Bot/pull/1791) | 4 | 批注测试时序 | 上游消除事件循环依赖；本地备注已移到引用外。修批注时保留本地断言再参考等待方式。 |
| [#1780](https://github.com/Fei2411/DS-Bot/pull/1780) | 3 | 审批通知索引 | 上游优化的 notify 模块已在本地移除。重做通知列表时参照按会话索引的方法。 |
| [#1734](https://github.com/Fei2411/DS-Bot/pull/1734) | 3 | 任务状态常量 | 上游删除未用常量；本地状态集合扩展了 clarify 和 failed。整理任务模型时复查引用。 |

### 跳过

| 上游 PR | 权重 | 功能 | 本地处理及重审线索 |
| --- | ---: | --- | --- |
| [#1758](https://github.com/Fei2411/DS-Bot/pull/1758) | 1 | Android 返回键 | 移动客户端已移除。 |
| [#1706](https://github.com/Fei2411/DS-Bot/pull/1706) | 1 | Windows 独立应用启动脚本 | 本地已移除 start.ps1。 |
| [#1769](https://github.com/Fei2411/DS-Bot/pull/1769) | 2 | 贡献流程 | 上游要求在 PR 标记智能体与模型，属于上游协作约定。 |
| [#1717](https://github.com/Fei2411/DS-Bot/pull/1717) | 2 | 文档导航 | 贡献和部署文档依赖上游产品范围；本批只记录其设计目录补充。 |
| [#1814](https://github.com/Fei2411/DS-Bot/pull/1814) | 2 | 持续集成 | 上游将浏览器安全测试接入 CI；本批未采用其工作流与贡献规范改动。 |
