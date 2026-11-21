# 上游更新记录

来源仓库为 [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot)。每个 PR 只占一行。权重为本地采用优先级（1–10，10 最高）。后续涉及同一问题时，可按功能、工具名或 PR 号查找当时的取舍。

## 2026-11-21 · macOS 插件同步

登记时间 2026-11-21 09:26 +0800（Asia/Taipei）。upstream/dev 第一父链 [f8577350 → 6905f3fb](https://github.com/Fei2411/DS-Bot/compare/f8577350...6905f3fbdd296282742f7ceee546816b2489b215)，终点 `6905f3fbdd296282742f7ceee546816b2489b215`。共 43 个 PR，17 项采用、15 项暂缓、9 项跳过、2 项需讨论。上游根目录 CHANGELOG.md 本批无改动。采用结果见本地 CHANGELOG.md。

交付核验（2026-11-21 09:31 +0800）：实现提交 `11c3f88d` 已合入本地 dev。529 项针对性测试与 57 步模拟 Web 冒烟全部通过，客户端生成文件一致，179 个业务操作名覆盖检查通过。本地版本 0.3.8.17，Web 和 Desktop 两个 profile 各 163 个包内文件与发布包一致。Desktop 运行实例读回 0.3.8.16，需重启加载新版；日用 Web 进程加载状态未核实。

### 设计变更

- [搜索来源摘要](https://github.com/Fei2411/DS-Bot/blob/6905f3fbdd296282742f7ceee546816b2489b215/docs/plans/2026-11-14-search-summaries.md)（新增，#1879）。保留显示用短摘要和给模型的来源长摘要。凭据仅用于当前路由自己的地址；无匹配结果结束原生探测，仍可走无密钥回退。已采用。
- [IM](https://github.com/Fei2411/DS-Bot/blob/6905f3fbdd296282742f7ceee546816b2489b215/docs/plans/2026-11-04-im.md)（修订，#1306）。微信优先用平台提供的引用内容，也可按消息 ID 找近期短摘，找不到时提示原文不可用。其他渠道无需留存已发回复。已采用。
- [连接器](https://github.com/Fei2411/DS-Bot/blob/6905f3fbdd296282742f7ceee546816b2489b215/docs/plans/2026-11-04-connectors.md)（修订，#1139）。用户添加远程服务器时可以选 OAuth 登录，授权后使用连接器令牌覆盖同名请求头。命令型服务器继续走原配置。已采用。
- [文档识别](https://github.com/Fei2411/DS-Bot/blob/6905f3fbdd296282742f7ceee546816b2489b215/docs/plans/2026-11-14-read-document.md)、[语音服务](https://github.com/Fei2411/DS-Bot/blob/6905f3fbdd296282742f7ceee546816b2489b215/docs/plans/2026-11-14-deepseek-services.md)（新增，#1880、#1881）。前者提供文档识别工具，后者为听写和朗读提供独立选择。仅使用适用的官方凭据，按量计费，不借用网关或账号凭据。均暂缓。
- [浏览器与密钥](https://github.com/Fei2411/DS-Bot/blob/6905f3fbdd296282742f7ceee546816b2489b215/docs/plans/2026-10-08-browser-and-secrets.md)（修订，#1856）扩展了独立桌面应用的登录状态导入范围。[浏览器远程客户端](https://github.com/Fei2411/DS-Bot/blob/6905f3fbdd296282742f7ceee546816b2489b215/docs/plans/2026-11-17-web-remote.md)（新增，#1779）让网页作为独立设备配对，通过中继连接电脑，并限制网页可用接口。两者均跳过。
- [设计目录](https://github.com/Fei2411/DS-Bot/blob/6905f3fbdd296282742f7ceee546816b2489b215/docs/plans/README.md)（修订）更新微信引用说明，登记搜索、文档识别、语音和远程客户端设计；目录收录不代表本地已采用。

### 本批 43 个 PR 的处理状态

2026-11-21 09:39 +0800 复核：#1892、#1902 从“暂缓”改为“需讨论”，需确定项目卡执行中收到另一张卡的消息时，是否自动转后台及完成后向谁回报。#1841 保留“暂缓”，优先按本地任务范围移植。

| 上游 PR | 状态 | 权重 | 功能 | 本地处理及重审线索 |
| --- | --- | ---: | --- | --- |
| [#1892](https://github.com/Fei2411/DS-Bot/pull/1892) | 需讨论 | 9 | 忙碌时转后台和派生同级任务 | 依赖上一批暂缓的 #1887，前台结果需对应本地项目节点及回报目的地。 |
| [#1902](https://github.com/Fei2411/DS-Bot/pull/1902) | 需讨论 | 9 | 群里的后台任务 | 依赖暂缓的 #1887；本地群项目卡、节点会话、重启恢复均自行维护，需先明确所有权。 |
| [#1841](https://github.com/Fei2411/DS-Bot/pull/1841) | 暂缓 | 9 | 群历史中恢复压缩回复 | 与上一批 #1757 同属历史读取；本地账本按任务和群过滤，不能直接替换历史查询及消息展示。 优先适配；以同群两张任务卡为用例，验收压缩后能找回本卡回复且不会读到另一张卡。 |
| [#1433](https://github.com/Fei2411/DS-Bot/pull/1433) | 暂缓 | 8 | 会话分叉归属 | 上游在客户端记录派生会话和来源 Agent；本地的会话选择、成员历史和私聊入口已改写，index.js 接入位置冲突。 |
| [#1863](https://github.com/Fei2411/DS-Bot/pull/1863) | 暂缓 | 8 | 切换到小窗口模型 | 上游按被替换节点的实际大小生成检查点；本地分段及上下文测试已分化，需与此前 #1736、#1766 一起验证。 |
| [#1410](https://github.com/Fei2411/DS-Bot/pull/1410) | 暂缓 | 8 | 完全访问模式使用工作区外目录 | 本地群成员的目录覆盖存入 memberSettings；上游通过 memberDirs 判断继承，直接使用会按不同规则推导受影响会话。 |
| [#1771](https://github.com/Fei2411/DS-Bot/pull/1771) | 暂缓 | 8 | 给空闲群成员开新会话 | 本地已有任务内主动换段和成员历史；上游详情抽屉、服务通道和成员状态与本地实现冲突。 |
| [#1868](https://github.com/Fei2411/DS-Bot/pull/1868) | 暂缓 | 7 | IM 回复外发本地图片 | 上游依赖移动端共用的图片读取及路径边界；本地已移除移动服务，且群成员可覆盖工作目录。重审时需按实际会话校验取图范围。 |
| [#1880](https://github.com/Fei2411/DS-Bot/pull/1880) | 暂缓 | 7 | DeepSeek 文档识别 | 上游新增 read_document 和服务设置；本地宿主初始化、设置入口、存储和工具范围不同，需适配凭据隔离与工具权限。 |
| [#1854](https://github.com/Fei2411/DS-Bot/pull/1854) | 暂缓 | 7 | Bot 创建的终端标签页 | 上游监听终端事件并接入页头；本地客户端入口已重构，需验证群任务会话与终端归属。 |
| [#1861](https://github.com/Fei2411/DS-Bot/pull/1861) | 暂缓 | 6 | CodeBuddy 登录状态 | 探测 CLI 会话文件；本地 discover.js 对引擎和平台的处理已改动，补丁上下文冲突。 |
| [#1852](https://github.com/Fei2411/DS-Bot/pull/1852) | 暂缓 | 6 | 自动回忆缓存 | 上游按文件版本缓存解析结果；本地分库后的记忆测试夹具不同。调整记忆生命周期时复核跨请求失效。 |
| [#1864](https://github.com/Fei2411/DS-Bot/pull/1864) | 暂缓 | 6 | Qoder CN CLI 探测 | 上游区分可执行文件别名；本地 ACP 启动与路由选择已有调整，acp.js 补丁冲突。 |
| [#1882](https://github.com/Fei2411/DS-Bot/pull/1882) | 暂缓 | 6 | 布局、动效与无障碍修整 | 多模块混合修改，消息单元、浏览器面板和本地项目详情均有接入冲突，按具体问题拆取。 |
| [#1881](https://github.com/Fei2411/DS-Bot/pull/1881) | 暂缓 | 6 | DeepSeek 听写和朗读 | 依赖 #1880 的公共服务、凭据状态与设置面板；语音选择不能随配置密钥自动打开。 |
| [#1834](https://github.com/Fei2411/DS-Bot/pull/1834) | 暂缓 | 6 | 长对话跳到待批准的学习建议 | 上游在页头与卡片间导航；本地详情和页头入口已调整，需要验证跳转到正确会话。 |
| [#1870](https://github.com/Fei2411/DS-Bot/pull/1870) | 暂缓 | 5 | Firefox 设置菜单定位 | 上游替换部分宿主设置渲染；本地设置入口已有修改，settings.js 冲突。 |
| [#1828](https://github.com/Fei2411/DS-Bot/pull/1828) | 采用 | 8 | CLI 上下文窗口 | 优先使用智能体报告的实际窗口，避免错误显示 200K。 |
| [#1897](https://github.com/Fei2411/DS-Bot/pull/1897) | 采用 | 8 | Qoder 历史路由迁移 | 保留供应商 qoder/* 模型引用，有 CLI 使用依据时迁移到本地引擎。 |
| [#1306](https://github.com/Fei2411/DS-Bot/pull/1306) | 采用 | 8 | 微信引用回复 | 将被引用消息带给 Bot。仅声明支持引用的平台记录已发送正文，按连接、聊天和文本长度设上限。 |
| [#1866](https://github.com/Fei2411/DS-Bot/pull/1866) | 采用 | 8 | QQ 发送确认 | 即使 HTTP 成功也检查响应正文，正确识别发送失败。 |
| [#1865](https://github.com/Fei2411/DS-Bot/pull/1865) | 采用 | 8 | 本地智能体错误 | 保留 CLI 返回的上游错误码及详情。 |
| [#1234](https://github.com/Fei2411/DS-Bot/pull/1234) | 采用 | 8 | 子进程环境 | 按大小写无关的名称过滤已指定的宿主变量，成组移除 Git 注入配置。 |
| [#1871](https://github.com/Fei2411/DS-Bot/pull/1871) | 采用 | 8 | QQ 长回复重试 | 从首个未送达的分段继续发送，避免重复已送达内容。 |
| [#1879](https://github.com/Fei2411/DS-Bot/pull/1879) | 采用 | 7 | 搜索来源摘要 | auto 在当前路由自己的 HTTPS 地址尝试 DeepSeek Search，保留来源摘要和无 key 回退。 |
| [#1139](https://github.com/Fei2411/DS-Bot/pull/1139) | 采用 | 7 | 自定义远程 MCP 连接器 | 新增可选 OAuth 登录，兼容原有固定请求头和命令型配置。 |
| [#1803](https://github.com/Fei2411/DS-Bot/pull/1803) | 采用 | 6 | Discord 频道标题 | 优先采用频道名，保持不同发言人的会话归属。 |
| [#1804](https://github.com/Fei2411/DS-Bot/pull/1804) | 采用 | 6 | QQ 表格 | 识别无外侧竖线的 Markdown 表格。 |
| [#1885](https://github.com/Fei2411/DS-Bot/pull/1885) | 采用 | 5 | 连接器客户端登录指引 | 整理自备 OAuth 客户端的设置步骤和布局，与本地已采用的登录流程配套。 |
| [#1859](https://github.com/Fei2411/DS-Bot/pull/1859) | 采用 | 5 | DSH 聊天列宽 | 适配 0.2.2-rc.3 的宿主结构，保留 960px 内容宽度。 |
| [#1710](https://github.com/Fei2411/DS-Bot/pull/1710) | 采用 | 5 | 用量页 | 切换时间范围时立即显示新范围总量，减少增减标记移动。 |
| [#1884](https://github.com/Fei2411/DS-Bot/pull/1884) | 采用 | 4 | @ 候选菜单 | 使用实色背景，避免列表与底层文字重叠。 |
| [#1874](https://github.com/Fei2411/DS-Bot/pull/1874) | 采用 | 4 | 模型设置 | 深色主题下可读的下拉选项。 |
| [#1878](https://github.com/Fei2411/DS-Bot/pull/1878) | 采用 | 4 | 发送按钮 | 悬停时调整底色，避免整体淡出闪烁。 |
| [#1846](https://github.com/Fei2411/DS-Bot/pull/1846) | 跳过 | 2 | iPhone Safari 窄屏布局 | 本项目维护 macOS 插件，上游针对 iPhone Safari 的宿主网格。 |
| [#1903](https://github.com/Fei2411/DS-Bot/pull/1903) | 跳过 | 2 | 上游 CI 和构建提速 | 上游发布矩阵与本地二开发版独立，插件改动用于缩短测试等待。 |
| [#1856](https://github.com/Fei2411/DS-Bot/pull/1856) | 跳过 | 2 | 浏览器登录状态导入 | 依赖独立桌面壳提供的本机浏览器数据导入接口，插件页单独移植无法工作。 |
| [#1712](https://github.com/Fei2411/DS-Bot/pull/1712) | 跳过 | 1 | Windows 文件路径中的点目录 | 仅 Windows 链接语义。 |
| [#1851](https://github.com/Fei2411/DS-Bot/pull/1851) | 跳过 | 1 | 手机附件分块读取 | 本地已删除手机附件服务。 |
| [#1876](https://github.com/Fei2411/DS-Bot/pull/1876) | 跳过 | 1 | Windows 与 Linux 缩放快捷键 | 独立应用和非维护平台。 |
| [#1810](https://github.com/Fei2411/DS-Bot/pull/1810) | 跳过 | 1 | Linux 应用图标 | 独立应用发行件。 |
| [#1844](https://github.com/Fei2411/DS-Bot/pull/1844) | 跳过 | 1 | 手机设置群工作目录 | 仅移动客户端。 |
| [#1779](https://github.com/Fei2411/DS-Bot/pull/1779) | 跳过 | 1 | 浏览器远程客户端 | 依赖手机应用和加密中继，属于排除的远程产品。 |

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
