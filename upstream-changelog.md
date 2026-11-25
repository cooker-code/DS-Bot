# 上游更新记录

来源仓库为 [Fei-Craft/DS-Bot](https://github.com/Fei-Craft/DS-Bot)，原名 Fei2411/DS-Bot，GitHub 仓库 ID 为 `1409013846`（2026-11-25 核实）。迁名前后沿用同一来源键。每个 PR 只占一行。权重为本地采用优先级（1–10，10 最高）。后续涉及同一问题时，可按功能、工具名或 PR 号查找当时的取舍。

## 2026-11-25 · macOS 插件同步

登记时间 2026-11-25 09:58 +0800（Asia/Taipei）。upstream/dev 第一父链 [fb0d3c03 → bb1b1592](https://github.com/Fei-Craft/DS-Bot/compare/fb0d3c033a952033c66daf737eb99835f98a25cb...bb1b1592472084c32278c12287944ee40b8087c5)，起点 `fb0d3c033a952033c66daf737eb99835f98a25cb`，终点 `bb1b1592472084c32278c12287944ee40b8087c5`。共 34 个 PR，采用 10，暂缓 16，跳过 8，需讨论 0。采用中有 4 项部分采用。比较基线 `44f81fe0`。本批上游根目录 CHANGELOG.md 无变更，包版本仍为 0.3.10。本地功能说明见 CHANGELOG.md。

### 新功能和设计变更

| 设计 | 上游的实际行为、限制与变化 | 本地判断 |
| --- | --- | --- |
| 额外工作文件夹 | Bot 和群可另列最多 8 个真实目录。文件工具提权时按所有目标路径检查并批准当前一次，shell 仍走人工审批。群有主工作目录时使用群的列表，未设主目录时合并群与成员列表。列表变更无需换段；本地 CLI 和隐私 Bot 不提供此列表。 | #1298 暂缓，需兼容本地群成员目录和项目工作树。见 [2026-11-10-extra-folders](https://github.com/Fei-Craft/DS-Bot/blob/bb1b1592472084c32278c12287944ee40b8087c5/docs/plans/2026-11-10-extra-folders.md)。 |
| 对外统一 API | 默认关闭的本机网关，默认 127.0.0.1:17830。可撤销 Token 按能力和 Bot/群范围授权，REST、SSE、MCP、CLI 及可选 OpenAI 兼容层共用 Run 完成态。支持幂等和重启后查询，敏感管理能力另行确认。 | #2016 暂缓。上游 Run 的群完成态及后台任务需与本地项目节点对应，不能仅用“已发送”表示任务已完成。见 [2026-11-21-external-api](https://github.com/Fei-Craft/DS-Bot/blob/bb1b1592472084c32278c12287944ee40b8087c5/docs/plans/2026-11-21-external-api.md)。 |
| MCP 入口收口 | 原独立 MCP 网关由统一 API 同端口的 /mcp 承接，并迁移旧配置。 | 旧 #1919 的重审入口更新为 #2016。见 [2026-11-20-mcp-access](https://github.com/Fei-Craft/DS-Bot/blob/bb1b1592472084c32278c12287944ee40b8087c5/docs/plans/2026-11-20-mcp-access.md)。 |
| 显式转后台 | 普通私聊的新消息恢复为插入当前轮或顺序排队。用户显式点击“将当前工作转到后台”，IM 可发 /background 或 /bg。存在交互卡、排队输入或本地 CLI 时限制移交。隐藏同伴轮继续自动隔离；失败交接要求输入持久可恢复。 | #2180、#2216 暂缓。上游已调整旧 #1892 的自动切换方案，需按新设计重新对照卡片所有权。见 [2026-11-16-async-work](https://github.com/Fei-Craft/DS-Bot/blob/bb1b1592472084c32278c12287944ee40b8087c5/docs/plans/2026-11-16-async-work.md)。 |
| 工作目录与隐私 | 运行配置增加额外目录入口；隐私 Bot 的目录隔离也检查其他 Bot 和群的额外目录，隐私 Bot 自己不设额外目录。 | 跟随 #1298 一起适配。见 [2026-10-10-bot-runtime](https://github.com/Fei-Craft/DS-Bot/blob/bb1b1592472084c32278c12287944ee40b8087c5/docs/plans/2026-10-10-bot-runtime.md)、[2026-10-27-private-bots](https://github.com/Fei-Craft/DS-Bot/blob/bb1b1592472084c32278c12287944ee40b8087c5/docs/plans/2026-10-27-private-bots.md)。 |
| 设计索引 | 新增额外目录、统一 API 条目，并标记旧 MCP 设计已由新方案承接；远程浏览器条目补充部署与存储边界。 | 索引用于追踪适用设计，远程浏览器产品仍跳过。见 [README](https://github.com/Fei-Craft/DS-Bot/blob/bb1b1592472084c32278c12287944ee40b8087c5/docs/plans/README.md)。 |

审批代审的三阶段代码在上游已通过 #1302、#1934、#1935 补齐，新增权限模式、设置和浏览器/目录/隐私/外部 CLI 的动作证据。本批 docs/plans 未修改该设计正文，本地仍须适配项目卡审批上下文。

### 本批 34 个 PR 的处理状态

| 上游 PR | 状态 | 权重（1–10） | 功能或修复 | 本地处理、差异和重审条件 |
| --- | --- | ---: | --- | --- |
| [#2177](https://github.com/Fei-Craft/DS-Bot/pull/2177) | 采用 | 9 | 宿主子系统泄漏、僵尸进程和死循环修复 | 部分采用连接器网关的关闭清理、活动请求中止、失败响应释放和刷新异常处理。浏览器、邮件、IM、CLI、预览等余项涉及本地改写的生命周期或尚未采用的模块，继续暂缓。 |
| [#2174](https://github.com/Fei-Craft/DS-Bot/pull/2174) | 跳过 | 1 | 独立桌面应用和中继降低 CPU 与内存 | app、link 及手机中继接线属于已排除产品。 |
| [#2175](https://github.com/Fei-Craft/DS-Bot/pull/2175) | 采用 | 7 | 减少客户端轮询、重复绘制与资源泄漏 | 部分采用隐藏页面停止定时任务轮询、恢复可见时刷新、阻止重叠请求；复用皮肤探色画布，录音启动失败释放设备。其余聊天、侧栏、头像引用、动画和后台任务改动需适配本地界面。 |
| [#2176](https://github.com/Fei-Craft/DS-Bot/pull/2176) | 采用 | 8 | 限制宿主缓存并减少统计开销 | 部分采用模型推理档位缓存过期清理、Agent 释放时清理会话选择，以及用量缓存上限、归属缓存和关闭清理。已按本地实际缓存结构适配；账本、群派工、记忆、后台任务和团队存储余项暂缓。 |
| [#1934](https://github.com/Fei-Craft/DS-Bot/pull/1934) | 暂缓 | 8 | 把模型代审做成权限模式并增加设置 | 上游补齐 #1302 的权限入口。本地权限、群成员设置、SQLite 与项目卡审批上下文均有扩展，需整体适配模式迁移和运行中取消。 对照 `ds-bot/src/host/local-agents/index.js`。 |
| [#1935](https://github.com/Fei-Craft/DS-Bot/pull/1935) | 暂缓 | 9 | 为浏览器、目录、隐私和 CLI 审批提供动作证据 | 依赖 #1302、#1934，需验证本地群与卡片中的原始用户要求、目标路径、单次批准、迟到结果失效和人工回退。 对照 `ds-bot/src/host/browser-plugins.js`。 |
| [#1654](https://github.com/Fei-Craft/DS-Bot/pull/1654) | 暂缓 | 6 | Bot 内置维护与插件开发技能 | 上游指南包含自己的部署、设置和插件体系；本地仅维护 macOS 插件，已有 ds-bot-doc 与项目卡操作，需要改写入口和路径后再注入 Bot。 对照 `ds-bot/src/host/prompt.js`。 |
| [#1298](https://github.com/Fei-Craft/DS-Bot/pull/1298) | 暂缓 | 8 | Bot 和群可配置额外工作文件夹 | 上游保存 extraDirs 并在文件工具提权时按目标自动批准。本地群成员目录、项目工作树、SQLite 和审批归属不同。需验证额外目录不跨隐私边界，shell 仍交原审批流程。 对照 `ds-bot/src/host/channel.js`。 |
| [#2160](https://github.com/Fei-Craft/DS-Bot/pull/2160) | 暂缓 | 8 | CLI 探测离线、超时强杀及过期结果保护 | 本地探测实现与上游 #2052、#2057、#2177 不同，需一并验证超时后进程退出、刷新结果不会倒退及主会话不中断。 对照 `ds-bot/src/host/local-agents/acp.js`。 |
| [#2180](https://github.com/Fei-Craft/DS-Bot/pull/2180) | 暂缓 | 9 | 显式转后台并恢复插话和排队语义 | 上游普通私聊改由用户点击或 IM 命令转后台；隐藏同伴轮仍自动隔离。本地未采用 #1887 后台任务，且项目卡有执行所有权，需验证原卡执行与新消息的归属。 对照 `ds-bot/src/host/channel.js`。 |
| [#2194](https://github.com/Fei-Craft/DS-Bot/pull/2194) | 跳过 | 2 | 修正上游已知问题文档中的旧仓库死链 | 本地该处已使用 Fei2411 链接，未含上游此次修复的 unionsup 死链；源仓库迁移另记本批。 |
| [#2193](https://github.com/Fei-Craft/DS-Bot/pull/2193) | 跳过 | 1 | 从新仓库发布 GHCR 镜像 | Docker 发布与镜像构建范围。 |
| [#2205](https://github.com/Fei-Craft/DS-Bot/pull/2205) | 跳过 | 1 | 修复复制 .. 前缀目录被误判为越界 | 独立应用导入的 copy-tree 实现。 |
| [#2198](https://github.com/Fei-Craft/DS-Bot/pull/2198) | 采用 | 3 | npm 包的源码、首页和缺陷链接迁到新上游 | 只采用插件元数据和对应测试，指向 Fei-Craft/DS-Bot。独立应用包清单跳过。 |
| [#2208](https://github.com/Fei-Craft/DS-Bot/pull/2208) | 采用 | 9 | Codex 空闲恢复后重新连接团队工具 | 每个活动会话独立持有 Codex 进程，关闭旧桥后恢复不会沿用旧 MCP 地址。保留本地 managedSkills 及已有的启动失败清理，测试覆盖另一个会话不受中断。 |
| [#2200](https://github.com/Fei-Craft/DS-Bot/pull/2200) | 跳过 | 1 | 仅读取独立桌面应用日志尾部 | 独立应用日志后端及基准。 |
| [#2209](https://github.com/Fei-Craft/DS-Bot/pull/2209) | 暂缓 | 8 | QQ 回复支持发送图片 | 依赖之前暂缓的 IM 图片外发路径 #1868；本地新增企微文档发送与工作目录边界，需按真实会话校验 QQ 图片路径及部分发送失败。 对照 `ds-bot/src/host/im/index.js`。 |
| [#2207](https://github.com/Fei-Craft/DS-Bot/pull/2207) | 暂缓 | 10 | 失败轮结束后唤醒排队消息 | 上游移动收件箱消息后恢复派活记录。本地换段与恢复绑定任务卡，需验证失败后保留顺序、只唤醒一次并回到同一节点。 对照 `ds-bot/src/host/parts.js`。 |
| [#2196](https://github.com/Fei-Craft/DS-Bot/pull/2196) | 跳过 | 1 | 独立应用导入时并行复制会话 | 独立应用导入流程。 |
| [#2199](https://github.com/Fei-Craft/DS-Bot/pull/2199) | 采用 | 3 | 更新订阅源和源码仓库链接 | 部分采用插件诊断页的缺陷入口。其他发布订阅源、独立应用、手机、上游维护技能和与本地不同的公开文档余项跳过。 |
| [#2202](https://github.com/Fei-Craft/DS-Bot/pull/2202) | 采用 | 4 | 用量扫描忽略宿主明确不支持的子代理描述 | 仅压掉 unsupported 诊断，保留真实损坏或不可读记录的提示。 |
| [#2195](https://github.com/Fei-Craft/DS-Bot/pull/2195) | 跳过 | 1 | 并行重建导入文件的符号链接 | 独立应用 copy-tree 导入逻辑。 |
| [#2215](https://github.com/Fei-Craft/DS-Bot/pull/2215) | 跳过 | 1 | 检查通过后才发布 Docker 镜像 | Docker CI 发布作业。 |
| [#2203](https://github.com/Fei-Craft/DS-Bot/pull/2203) | 暂缓 | 8 | 归档被清理的后台任务会话 | 依赖 #1887；本地保留群成员当前段、历史段和任务结果引用，需区别归档与删除，并保证验收文档仍能定位。 对照 `ds-bot/src/host/parts.js`。 |
| [#2223](https://github.com/Fei-Craft/DS-Bot/pull/2223) | 采用 | 7 | 识别 Qoder CN 登录状态 | 增加 CN 三种命令别名和专用登录标记，设置中的登录指引跟随实际命令。保留本地登录缓存与探测结构；关联 #1864 的错误消息指引余项。 |
| [#2221](https://github.com/Fei-Craft/DS-Bot/pull/2221) | 暂缓 | 6 | 隐藏的 Bot 往返不再显示未读点 | 上游隐藏回合及完成状态依赖 #2130；本地侧栏和项目回执未读定义有改动，需保留用户可见任务完成提醒。 对照 `ds-bot/src/client/index.js`。 |
| [#2227](https://github.com/Fei-Craft/DS-Bot/pull/2227) | 暂缓 | 9 | 限制任务继承的前台历史序号范围 | 依赖后台任务与较新聊天索引；本地群历史按任务过滤，需验证后续前台消息不会被后台任务读取，关联 #1841。 对照 `ds-bot/src/host/chat-index.js`。 |
| [#2222](https://github.com/Fei-Craft/DS-Bot/pull/2222) | 暂缓 | 10 | 将无进展的本地 ACP 轮次判为失败 | 上游增加进展心跳、看门狗和重试策略，依赖较新的 CLI 生命周期与用量处理。本地维护技能选择和任务恢复，需要验证审批等待不被误杀、真卡死能释放原节点。 对照 `ds-bot/src/host/local-agents/acp.js`。 |
| [#2225](https://github.com/Fei-Craft/DS-Bot/pull/2225) | 暂缓 | 8 | 前一次调用结束后可再次提及同一群成员 | 上游允许无待处理批次后再次叫人，仍使用成环守卫。本地批次还携带任务归属，需验证二次调用不会重复派工或绕过返工暂停。 对照 `ds-bot/src/host/groups.js`。 |
| [#2220](https://github.com/Fei-Craft/DS-Bot/pull/2220) | 采用 | 9 | 重试 Gemini 特定异常工具响应 | 将三种精确的 PI_AI_ERROR 停止原因按 MALFORMED_RESPONSE 处理，保留原重试预算；其他错误文字不会误触发重试。 |
| [#2206](https://github.com/Fei-Craft/DS-Bot/pull/2206) | 暂缓 | 3 | 修复全量并发下的测试抖动 | 涉及未采用的工作树、后台任务和宿主性能夹具，并含 IM 回复等待。需跟随相应模块适配，保留本地正在使用的测试结构。 对照 `ds-bot/src/host/im/index.js`。 |
| [#2016](https://github.com/Fei-Craft/DS-Bot/pull/2016) | 暂缓 | 8 | 对外统一 API、MCP、CLI 和 OpenAI 兼容接口 | 本机网关默认关闭，独立 Token 按能力与目标授权，支持 Run、流式事件和幂等。本地缺少上游后台任务与群回报状态机，需将 Run 完成态与项目卡节点对齐，关联 #1919 的接入范围讨论。 对照 `ds-bot/src/host/approvals.js`。 |
| [#2224](https://github.com/Fei-Craft/DS-Bot/pull/2224) | 采用 | 8 | Telegram 标题和表格便于阅读 | 将支持的 Markdown 标题与表格转换为 Telegram HTML/条目，保留文本回退、平台长度限制与安全转义。 |
| [#2216](https://github.com/Fei-Craft/DS-Bot/pull/2216) | 暂缓 | 10 | 前台交接失败时持久保留用户输入 | 依赖 #2180 和后台任务持久化；本地项目卡另有输入和恢复记录，需验证交接落盘失败后输入可恢复且 IM 重投不重复建卡。 |

## 2026-11-24 · macOS 插件同步

登记时间 2026-11-24 14:47 +0800（Asia/Taipei）。upstream/dev 第一父链 [c08ca3ab → fb0d3c03](https://github.com/Fei2411/DS-Bot/compare/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7...fb0d3c033a952033c66daf737eb99835f98a25cb)，起点 `c08ca3ab394fae9946f8bc34c610f3d4a7873ce7`，终点 `fb0d3c033a952033c66daf737eb99835f98a25cb`。共 38 个 PR，采用 6（含 2 项部分采用），暂缓 25，跳过 6，需讨论 1。本地比较基线 `ac9f8877`。本批上游根目录 CHANGELOG.md 无改动，上游包版本仍为 0.3.10；本地用户可见变化另记 CHANGELOG.md。

交付核验（2026-11-24 14:50 +0800）。实现候选 `8d23a780` 通过独立只读验收。去重后的 235 项定向测试中 233 项通过，2 项翻译完整性检查在本地基线同样失败且缺失键集合一致，本批无新增缺失。真实浏览器多行密钥测试 1 项、隔离模拟冒烟 57 步、181 个接口名检查和客户端生成一致性均通过。变更文件静态检查无错误、8 条风格警告。浏览器上下文与进程已关闭，临时 profile 与脚本已清理；冒烟及 CLI 夹具进程退出、3972/8972 端口释放，隔离测试目录已清理。未连接真实第三方 IM 或生产 ACP 服务。

候选已合入本地 dev，发布提交 `827ce40b`，四段版本 **0.3.10.19**，npm 版本 `0.3.10-local.19`，安装包 `/tmp/ds-bot-0.3.10-local.19.tgz`。集成后的源码和客户端产物与验收候选一致。Web 链接与 Desktop 本地包安装均已更新，各 168 个包内文件与 tarball 一致。运行实例加载状态尚未核实，Desktop 的已授权只读请求返回 HTTP 401。未重启日用会话。

### 新功能和设计解释

| 功能或设计 | 能解决的问题和实际行为 | 本地采用判断 |
| --- | --- | --- |
| Bot 插件体系与面板 | 可发现、安装和启停内置插件、DSH 包或 MCP 服务，普通插件可按 Bot 开关，浏览器后端为全团队单选并可热切换。保留旧 browserPlugin 配置。目录有 HTTPS、响应大小和超时约束。普通第三方 DSH 浏览器插件仍自行管理浏览器隔离；未启用热重载的宿主可能需要重启才能完全加载或释放包。 | #2102、#2106、#2146 暂缓。需接入本地浏览器、权限、设置和 SQLite。设计已落地于上游，本地尚无此入口。见 [2026-11-22-bot-plugins](https://github.com/Fei2411/DS-Bot/blob/fb0d3c033a952033c66daf737eb99835f98a25cb/docs/plans/2026-11-22-bot-plugins.md)。 |
| Bot 派活与交卷 | delegate_work 创建有编号和状态的工作单，ask_back/answer_work 处理阻塞追问，cancel_work 静默取消，note_bot 只留信。连续无效往返会暂停并让用户继续或取消；有实质内容的连续文字协作采用返工检查点。 | #2130 需讨论现有项目卡与上游工作单的关系，#2139 等修复依赖它。上游取代了 message_bot，本地仍使用现有卡片和工具。见 [2026-10-16-bot-handoffs](https://github.com/Fei2411/DS-Bot/blob/fb0d3c033a952033c66daf737eb99835f98a25cb/docs/plans/2026-10-16-bot-handoffs.md)。 |
| 统一审批代审 | 目标是让单独、无工具的模型预审已有审批请求。必须取得原始用户消息和完整动作，只能单次批准；证据缺失、非文本上下文、提交表单或上传等转人工。模型限时 30 秒，人工回答或上下文变化使迟到结果失效。 | #1302 为第一阶段审核管线，设置与权限选择器还需后续工作。本地须接入卡片、群及子会话归属。普通权限内危险命令、MCP 副作用检测等仍是后续计划。见 [2026-11-10-approval-review](https://github.com/Fei2411/DS-Bot/blob/fb0d3c033a952033c66daf737eb99835f98a25cb/docs/plans/2026-11-10-approval-review.md)。 |
| 群最终回报与防空转 | 群派活默认等长任务、审批、接力、批次和 Goal 一起结束再向原派发者汇报，重启后对账。检测成环的无效接力并暂停，用户可点击继续；状态帖和记忆等元工具无法伪装实质进展。 | #2109、#2125、#2143 暂缓，需与本地项目节点和验收回执统一。见 [2026-10-07-group-chat](https://github.com/Fei2411/DS-Bot/blob/fb0d3c033a952033c66daf737eb99835f98a25cb/docs/plans/2026-10-07-group-chat.md)、[2026-11-01-group-goal](https://github.com/Fei2411/DS-Bot/blob/fb0d3c033a952033c66daf737eb99835f98a25cb/docs/plans/2026-11-01-group-goal.md)。 |
| 后台任务轻量启动 | 同伴派活一律不复制目标 Bot 无关的前台历史；task_start 只在父会话不超过默认 600 条事件时 fork，较长会话用摘要新建，并保留检索父段的入口。用户打断触发的前台转后台仍 fork 以保留缓存。 | #2155 暂缓，依赖尚未采用的 #1887 和功能包。见 [2026-11-16-async-work](https://github.com/Fei2411/DS-Bot/blob/fb0d3c033a952033c66daf737eb99835f98a25cb/docs/plans/2026-11-16-async-work.md)。 |
| IM 来源与记忆边界 | 进行中的 IM 群轮次加入网页、桌面、定时任务等非 IM 输入后撤回外发来源；常驻团队记忆的删除须明确 always:true；达到 40 个主题后写入 earlier 溢流文件。 | #2154 暂缓，需适配本地任务来源与记忆实现。见 [2026-11-04-im](https://github.com/Fei2411/DS-Bot/blob/fb0d3c033a952033c66daf737eb99835f98a25cb/docs/plans/2026-11-04-im.md)、[2026-11-09-memory-layers](https://github.com/Fei2411/DS-Bot/blob/fb0d3c033a952033c66daf737eb99835f98a25cb/docs/plans/2026-11-09-memory-layers.md)。 |
| DSH 公开能力的限制 | 新登记空闲压缩不支持保留尾部预算、切小窗口的预算约束、developer 角色兼容、长期 429 额度耗尽仍重试，以及缺少后台增量会话索引等五项限制。 | 属于上游现状说明，插件适配继续使用公开 API。见 [2026-10-13-dsh-concessions](https://github.com/Fei2411/DS-Bot/blob/fb0d3c033a952033c66daf737eb99835f98a25cb/docs/plans/2026-10-13-dsh-concessions.md)。 |
| 手机更新、通知与设计目录 | 手机增加更新与通知事件及 API，Bot 插件设计加入总索引。 | 手机相关跳过，索引用于核对已定设计。见 [2026-10-24-mobile-api](https://github.com/Fei2411/DS-Bot/blob/fb0d3c033a952033c66daf737eb99835f98a25cb/docs/plans/2026-10-24-mobile-api.md)、[2026-10-24-mobile-app](https://github.com/Fei2411/DS-Bot/blob/fb0d3c033a952033c66daf737eb99835f98a25cb/docs/plans/2026-10-24-mobile-app.md)、[README](https://github.com/Fei2411/DS-Bot/blob/fb0d3c033a952033c66daf737eb99835f98a25cb/docs/plans/README.md)。 |

### 本批 38 个 PR 的处理状态

每个来源 PR 只有一行。采用行写明部分采用的余项，暂缓和需讨论行给出本地差异与后续验收条件。

| 上游 PR | 状态 | 权重（1–10） | 功能或修复 | 本地处理、差异和重审条件 |
| --- | --- | ---: | --- | --- |
| [#2100](https://github.com/Fei2411/DS-Bot/pull/2100) | 暂缓 | 10 | 防止压缩、交接和本地 CLI 恢复后丢上下文 | 上游联动后台任务、聊天索引、记忆与换段；本地后台任务底座 #1887 未采用，并有按项目卡保存的历史与恢复。需分别验证压缩后任务约束、派工来源和 CLI 会话恢复，关联 #1841、#1863。 对照 `ds-bot/src/host/chat-index.js`。 |
| [#2102](https://github.com/Fei2411/DS-Bot/pull/2102) | 暂缓 | 8 | Bot 插件运行时、插件目录和可切换浏览器后端 | 新增 builtin、DSH 包、MCP 三种插件，可按 Bot 开关并全团队切换浏览器。与本地浏览器挂载、工具权限、SQLite 团队存储不同，需适配插件状态和失效回滚；独立应用接线跳过。 对照 `ds-bot/src/host/browser-plugins.js`。 |
| [#2101](https://github.com/Fei2411/DS-Bot/pull/2101) | 跳过 | 1 | Android 应用更新和离线通知 | 手机、配对与中继专用；插件内对申请卡的推送接线也只服务这些客户端。 |
| [#2106](https://github.com/Fei2411/DS-Bot/pull/2106) | 暂缓 | 7 | Bot 插件面板和浏览器切换入口 | 依赖 #2102，本地设置仍为原导航且有项目设置；需将安装、按 Bot 开关、浏览器切换接入本地设置。独立应用入口跳过。 对照 `ds-bot/src/client/api.js`。 |
| [#2109](https://github.com/Fei2411/DS-Bot/pull/2109) | 暂缓 | 9 | 群工作结束后向派发者回报并恢复原 IM 路由 | 上游持久保存 roomReports，等审批、迟到回复和群 Goal 完成。本地由项目卡、节点和轮次决定回执归属，需要统一原卡结案与 IM 回报，关联 #1892、#1902。 对照 `ds-bot/src/host/approvals.js`。 |
| [#2113](https://github.com/Fei2411/DS-Bot/pull/2113) | 采用 | 8 | 本地智能体维护恢复及指令状态保存 | 部分采用。只修复 ACP 指令还未发送就提前保存 promptHash，保留本地模型思考强度与技能配置。resumeOnly、防止维护恢复失败后创建空会话的余项依赖 #2100 的恢复语义，暂缓。 |
| [#2121](https://github.com/Fei2411/DS-Bot/pull/2121) | 跳过 | 1 | 导入时减少会话目录扫描 | 独立桌面应用的导入实现。 |
| [#2120](https://github.com/Fei2411/DS-Bot/pull/2120) | 跳过 | 3 | 对照当前实现整理公开文档 | 正文作为本批设计核对资料。上游手册依赖尚未采用的功能，不覆盖本地项目卡和会话行为。 |
| [#2123](https://github.com/Fei2411/DS-Bot/pull/2123) | 暂缓 | 8 | 将内置工具过滤统一到宿主事件 | 依赖本地尚未采用的 builtin-packs 和 #2019。需同时验证本地项目工具、Main 管理权限和每卡工具范围。 对照 `ds-bot/src/host/tools.js`。 |
| [#2125](https://github.com/Fei2411/DS-Bot/pull/2125) | 暂缓 | 9 | 加固群最终回报与 IM 来源隔离 | 依赖 #2109；上游新增 room-reports 模块，本地群回执由卡片管理。验收原群审批、跨群派单、重启与最终回报只到发起方。 对照 `ds-bot/src/host/groups.js`。 |
| [#2130](https://github.com/Fei2411/DS-Bot/pull/2130) | 需讨论 | 9 | 将 Bot 通讯改为派活与交卷状态机 | 上游以 delegate_work、ask_back、answer_work、cancel_work、note_bot 替换 message_bot，引入工作单和返工暂停。本地已有项目卡派工、节点轮次和重试规则。需决定上游工作单是否仅承担卡外协作，还是替换卡内派工；两种选择影响现有工具与历史记录迁移。 对照 `ds-bot/src/host/channel.js`。 |
| [#2135](https://github.com/Fei2411/DS-Bot/pull/2135) | 暂缓 | 10 | 压缩重试保留输出空间与正确消息来源 | 上游在 parts.js 的压缩引擎和重试目标处理中修复，本地有任务内换段和上下文接续。与 #2100、#2136 一起验证切模型、压缩失败重试和原节点续跑。 对照 `ds-bot/src/host/parts.js`。 |
| [#2140](https://github.com/Fei2411/DS-Bot/pull/2140) | 暂缓 | 9 | 后台交接隐藏回合、群继续信号和重复唤醒 | 依赖 #1887、#2130；本地继续任务由项目卡恢复流程处理，需要区分群继续与重跑某个节点。 对照 `ds-bot/src/host/groups.js`。 |
| [#2146](https://github.com/Fei2411/DS-Bot/pull/2146) | 暂缓 | 5 | 插件面板增加浏览器控制区和官方标志 | 依赖 #2102、#2106。采用时须同步 NOTICE 来源声明并适配本地设置，当前没有插件面板入口。 对照 `ds-bot/src/client/i18n.js`。 |
| [#2136](https://github.com/Fei2411/DS-Bot/pull/2136) | 暂缓 | 9 | 换段保留缓存并优先裁剪工具结果 | 本地 parts.js 有主动换段和群成员历史。需与 #2135 一起验证缓存、模型窗口预算和任务指令在换段后仍可读。 对照 `ds-bot/src/host/parts.js`。 |
| [#2137](https://github.com/Fei2411/DS-Bot/pull/2137) | 暂缓 | 8 | 改进记忆召回、提示预算和整理性能 | 本地未采用对应主题搜索与整理改写，关联 #1852、#1955、#2080。需保持群与私聊范围，验证召回排序、合并条目与大规模主题整理。 对照 `ds-bot/src/host/memory-copy.js`。 |
| [#2138](https://github.com/Fei2411/DS-Bot/pull/2138) | 暂缓 | 10 | 群轮次折叠、IM 分类和成员退出死锁 | 本地群批次还绑定项目节点及验收轮次，上游 roomReports 与本地卡归属不同。需验证成员中途退出时卡片能结束，混入桌面消息后回复停止外发。 对照 `ds-bot/src/host/groups.js`。 |
| [#2139](https://github.com/Fei2411/DS-Bot/pull/2139) | 暂缓 | 9 | 将派活工作树与后台任务统一并处理竞态 | 依赖 #2130 和 #1887；本地已有项目节点所有权、回执与重启恢复。需避免同一节点由上游工作单和本地卡同时结案。 对照 `ds-bot/src/host/delivery.js`。 |
| [#2141](https://github.com/Fei2411/DS-Bot/pull/2141) | 暂缓 | 8 | 隔离本地智能体侧聊、稳定提示前缀并优化聊天索引 | 本地已将上下文、侧栏和历史查询绑定所选群成员会话；上游还依赖功能包与较新的历史索引。需验证侧聊不污染正文、项目卡范围与模型前缀缓存。 对照 `ds-bot/src/host/browser/mount.js`。 |
| [#2143](https://github.com/Fei2411/DS-Bot/pull/2143) | 暂缓 | 9 | 加固群空转判定、目标推进、变更跟踪和搜索 | 上游用有向环与实质工具判断暂停，本地用项目卡规则安排工作。需区分真实节点返工与无效互相确认；搜索保留群和任务双重过滤。 对照 `ds-bot/src/host/changes.js`。 |
| [#2142](https://github.com/Fei2411/DS-Bot/pull/2142) | 暂缓 | 10 | 记忆作用域、写入因果与审核可靠性 | 本地群记忆和项目节点有独立范围，上游增加重放去重和审核状态处理。需验证群 A 的回执和记忆不会写到群 B，重试后条目只生效一次。 对照 `ds-bot/src/host/channel.js`。 |
| [#2144](https://github.com/Fei2411/DS-Bot/pull/2144) | 暂缓 | 10 | 投递持久化、重启恢复和状态清理 | 上游连同后台工作树和 state.json 清理一起修改，本地使用 SQLite 事务与项目恢复。需验证落库失败、重启、重复投递时节点和消息归属一致。 对照 `ds-bot/src/host/delivery.js`。 |
| [#2149](https://github.com/Fei2411/DS-Bot/pull/2149) | 跳过 | 1 | 独立应用设置自动更新开关 | 依赖独立应用 updater 和预加载接口；插件 About 页的接线仅为该应用服务。 |
| [#2134](https://github.com/Fei2411/DS-Bot/pull/2134) | 跳过 | 2 | Safari 登录状态导入及浏览器快照修复 | 依赖独立应用读取浏览器数据并导入的后端；与已跳过 #1856 同范围。macOS 适用也需要独立应用后端。 |
| [#1980](https://github.com/Fei2411/DS-Bot/pull/1980) | 采用 | 8 | 给未设取消信号的 IM 请求加超时 | 采用公共 boundedFetch 并接入本地 IM 环境。默认 60 秒未收到响应头就中止，不覆盖调用方自带信号，也不截断已开始读取的响应正文。 |
| [#1981](https://github.com/Fei2411/DS-Bot/pull/1981) | 暂缓 | 7 | 合并排队中的团队保存操作 | 上游合并 state.json 快照保存。本地 store.save 支持 mutate 事务及修订号，不能让多次项目卡更新共用一次快照承诺；需按事务语义重新设计并发保存。 对照 `ds-bot/src/host/store.js`。 |
| [#1989](https://github.com/Fei2411/DS-Bot/pull/1989) | 采用 | 5 | 活动行复用运行中消息的宿主位置 | 采用运行槽缓存、脱离文档时重找及停止后释放。保留本地直接遍历子元素的入场动画实现，该部分已独立优化。 |
| [#1787](https://github.com/Fei2411/DS-Bot/pull/1787) | 采用 | 5 | 头像选择器新增八种水生角色 | 新增海豚、章鱼、海龟、螃蟹、河豚、水母、海星、海马，含头像绘制和各语言名称。 |
| [#2154](https://github.com/Fei2411/DS-Bot/pull/2154) | 暂缓 | 9 | 加固 IM 混源、团队记忆和协作边界 | 群轮次混入非 IM 输入立即撤回外发来源；记忆满 40 个主题时溢流到 earlier；修改团队常驻记忆需 always:true。本地 IM 与记忆路径已分化，协作限制还依赖 #2130。 对照 `ds-bot/src/host/handoffs.js`。 |
| [#2155](https://github.com/Fei2411/DS-Bot/pull/2155) | 暂缓 | 8 | 轻量启动后台任务并按上下文裁剪工具 | 依赖 #1887 和 #2019。上游同伴派活不复制无关前台，长会话以摘要建轻量任务；本地需保留任务卡上下文、权限和可检索历史。 对照 `ds-bot/src/host/capabilities.js`。 |
| [#2157](https://github.com/Fei2411/DS-Bot/pull/2157) | 跳过 | 1 | 修复手机端动画与唤醒 | 仅 mobile 下的动画组件和测试。 |
| [#2156](https://github.com/Fei2411/DS-Bot/pull/2156) | 暂缓 | 7 | 迁移旧对话并将会话段说明移出主状态 | 上游精简 state.json 并外置分段摘要，本地已采用 SQLite 拆分存储，且项目卡引用历史段。需核对迁移需求和摘要查找入口。 对照 `ds-bot/src/host/channel.js`。 |
| [#2158](https://github.com/Fei2411/DS-Bot/pull/2158) | 暂缓 | 7 | 将中断的提问卡草稿放回输入框 | 本地草稿与当前会话、任务引用绑定。需验证 A 卡草稿被救回时不会覆盖 B 卡输入，也不会误发给其他 Bot，关联 #1909。 对照 `ds-bot/src/client/composer.js`。 |
| [#2161](https://github.com/Fei2411/DS-Bot/pull/2161) | 暂缓 | 9 | 启动时恢复孤立工作单并记录 CLI 用量 | 工作单对账依赖 #2130；CLI 用量部分与本地适配器和统计实现冲突，需分别验证重启只恢复原节点以及一轮用量只统计一次。 对照 `ds-bot/src/host/channel.js`。 |
| [#1993](https://github.com/Fei2411/DS-Bot/pull/1993) | 采用 | 6 | 升级 DSH 兼容目标并补充内容拒绝提示 | 部分采用 CONTENT_REFUSED 的错误说明和翻译。运行隔离冒烟使用已安装的 DSH 0.2.2-rc.5；测试依赖版本、其他夹具、独立应用和 Docker 的升级接线未采用。 |
| [#2165](https://github.com/Fei2411/DS-Bot/pull/2165) | 暂缓 | 8 | 修复换段视图闪烁并折叠空分隔线 | 本地保留成员历史和手动会话入口，上游已在 #2042 删除这些入口。直接采用会改变本地打开历史会话的行为，需适配打开、页头、侧栏及视图切换的同一目标。 对照 `ds-bot/src/host/parts.js`。 |
| [#2166](https://github.com/Fei2411/DS-Bot/pull/2166) | 采用 | 9 | 支持多行密钥输入和多种形式的脱敏 | 密钥输入支持换行、自动增高及 Cmd/Ctrl+Enter 提交，后台规范行尾并拒绝 NUL。脱敏覆盖多行、JSON、URL 编码及空格折叠形式，复用本地按消息缓存的失效机制。 |
| [#1302](https://github.com/Fei2411/DS-Bot/pull/1302) | 暂缓 | 8 | 用独立模型预审待批准的操作 | 新增审核管线与动作取证，仍依赖后续权限选择器和设置工作。本地审批携带项目卡、群和子会话来源，需完整接入取证、取消、迟到结果和人工回退后再开放。 对照 `ds-bot/src/host/approvals.js`。 2026-11-25 09:58 +0800 重审依据更新。上游 #1934、#1935 已补齐权限设置与取证接线，原“等待后续入口”的依据已更新；本地项目卡和子会话适配仍待完成。 |

## 2026-11-23 · macOS 插件同步

登记时间 2026-11-23 10:20 +0800（Asia/Taipei）。upstream/dev 第一父链 [6905f3fb → c08ca3ab](https://github.com/Fei2411/DS-Bot/compare/6905f3fbdd296282742f7ceee546816b2489b215...c08ca3ab394fae9946f8bc34c610f3d4a7873ce7)，共 99 个 PR。采用 12，暂缓 54，跳过 26，需讨论 7。上游 CHANGELOG 包含 0.3.9 和 0.3.10；本地插件采用范围见下表。

交付核验（2026-11-23 10:22 +0800）。实现提交 `40f9bbf1` 通过独立审查，504 项定向测试、57 步隔离模拟冒烟、客户端构建一致性和 180 个业务接口名检查通过。冒烟进程已退出并清理测试目录。候选及本地版本提交 `81d2ac30` 已合入本地 dev，集成后复跑 49 项通过。Web 链接安装、Desktop 本地包安装均已更新至 0.3.10.1，各 166 个包内文件与打包内容逐字节一致。当前运行实例加载版本未核实；Desktop 只读请求返回 HTTP 401，未重启日用会话。飞书、Discord 和 ACP 的外部协议行为通过模拟验证。

### 五项新增设计

| 设计 | 上游实际行为 | 本地判断 |
| --- | --- | --- |
| [mcp-access](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-20-mcp-access.md) | 其他本机智能体可用 MCP（模型上下文协议）给 Bot 派活、等待回信或查聊天。团队写锁宿主显式启用后才监听回环地址，每个客户端独立授权，默认仅 Main Bot，无群访问权。审批和设置仍须由人在宿主操作。 | #1919 需讨论授予项目群后可读哪些任务消息。 |
| [feature-packs](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-21-feature-packs.md) | 每个 Bot 的技能、MCP 与工具包可设为常驻、仅列清单供当前会话按需加载、关闭。旧配置默认常驻。管理工具再按 Main 身份裁剪。 | #2019、#2035、#2043、#2070 暂缓，需验证项目卡的派工和恢复工具始终可用。 |
| [settings-console](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-22-settings-console.md) | 设置首页汇总缺少的凭据和团队状态，九个分组承载设置，⌘K 可定位设置、模型、Bot 或群；外观可实时预览。 | #2006、#2028 需讨论，可单独评估搜索的价值。本批已修好现有模型选择器。 |
| [self-report-issue](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/self-report-issue.md) | Bot 准备公开缺陷报告，在自己的私聊展示实际将发送的正文。宿主将一次性确认卡绑定草稿，用户同意后使用现有 GitHub 连接器发往上游；安全问题转私密渠道。 | #1942 需先决定二开问题的投递仓库。 |
| [chatgpt-sign-in](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-22-chatgpt-sign-in.md) | 独立应用主进程处理账号登录、令牌刷新及系统加密存储，一个安装绑定一个账号；多账号选择是后续设想。 | #2045、#2056、#2063 跳过，普通 DSH 插件缺少该独立应用后端。 |

### 既有设计的变动与本地影响

- **会话和后台工作。** 上游正式废除同 Bot 多会话和手动换段，把前台保留为一条连续对话，并用后台任务或其他 Bot 并发执行。异步设计已包含任务列表、读结果和停止任务。本地仍需从成员详情读历史段，并把工作结果交回对应项目节点。重审 #1892、#1902 时要决定 A 卡执行中收到 B 卡消息后，两张卡分别由谁接手、结果回哪张卡。相关设计见 [parallel-sessions](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-13-parallel-sessions.md)、[async-work](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-16-async-work.md)、[bot-handoffs](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-16-bot-handoffs.md)、[local-agents](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-04-local-agents.md)。
- **群与上下文。** 上游澄清群派活的忙碌判断、群目标与 DSH Goal 的关系，整理按模型窗口换段和记忆读取的说明。本地处理 #1841、#1984 时需验证压缩后当前卡的回复可恢复，其他卡不可见。见 [group-chat](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-07-group-chat.md)、[group-goal](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-01-group-goal.md)、[context-and-memory](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-09-context-and-memory.md)、[memory-layers](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-09-memory-layers.md)。
- **权限与工具。** 设计修订涉及斜杠命令限制、模型 Bot 与本地 CLI 的工具提供方、连接器鉴权和浏览器默认只读与显式启用方式。见 [roles-and-permissions](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-07-roles-and-permissions.md)、[bot-runtime](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-10-bot-runtime.md)、[connectors](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-04-connectors.md)、[browser-plugins](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-21-browser-plugins.md)、[browser-and-secrets](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-08-browser-and-secrets.md)、[dsh-concessions](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-13-dsh-concessions.md)。
- **设置、渠道与文件。** 上游更新头像校验、IM 设置与来源、消息布局、加密密钥设置、文档识别和语音服务位置，以及 Office 文件检查范围。本批实际采用的 IM 改动只有 Discord 已编辑消息和飞书长连接。见 [avatar-library](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-23-avatar-library.md)、[im](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-04-im.md)、[message-layout](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-22-message-layout.md)、[encrypted-secrets](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-12-encrypted-secrets.md)、[read-document](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-14-read-document.md)、[deepseek-services](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-14-deepseek-services.md)、[office-documents](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-27-office-documents.md)。
- **已排除的产品。** 独立应用启动、导入、打包、移动 API 和远程访问也有说明更新，适用范围见 [desktop-app](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-16-desktop-app.md)、[linux-app-package](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-21-linux-app-package.md)、[start-window](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-26-start-window.md)、[windows-onboarding](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-26-windows-onboarding.md)、[start-copy](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-29-start-copy.md)、[mobile-api](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-24-mobile-api.md)、[mobile-app](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-10-24-mobile-app.md)、[ios-release](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-13-ios-release.md)、[web-remote](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/2026-11-17-web-remote.md)。
- **索引。** 上游重新整理已定设计入口，历史并行会话文档保留废除说明。见 [README](https://github.com/Fei2411/DS-Bot/blob/c08ca3ab394fae9946f8bc34c610f3d4a7873ce7/docs/plans/README.md)。

### 本批 99 个 PR 的处理状态

权重表示对本地插件的采用优先级。暂缓行列出工程依赖或重审用例；需讨论行列出会改变本地行为的选择。

| 上游 PR | 状态 | 权重（1–10） | 功能或修复 | 本地差异、采用范围或重审条件 |
| --- | --- | ---: | --- | --- |
| [#1914](https://github.com/Fei2411/DS-Bot/pull/1914) | 暂缓 | 4 | 统一设置页的宿主组件入口 | 与本地设置导航、图标和消息组件一起适配。 对照文件 `ds-bot/src/client/dsh-primitives.js`。 |
| [#1907](https://github.com/Fei2411/DS-Bot/pull/1907) | 跳过 | 1 | 恢复 Windows 桌面测试 | 独立应用的 Windows 测试。 |
| [#1908](https://github.com/Fei2411/DS-Bot/pull/1908) | 暂缓 | 9 | 即时通信（IM）消息重投后保留回复 | 本地投递入口已改，需验证同一平台事件重发时既不丢回复也不重复派工。 本地差异见 `ds-bot/src/host/im/index.js`。 |
| [#1912](https://github.com/Fei2411/DS-Bot/pull/1912) | 暂缓 | 4 | 群搜索复用小写化结果 | 本地搜索按群和任务筛选，适配后对照相同范围的命中结果。 本地差异见 `ds-bot/src/host/group-search.js`。 |
| [#1906](https://github.com/Fei2411/DS-Bot/pull/1906) | 暂缓 | 3 | 补充翻译跟随所属模块 | 本地增加了项目卡词条和翻译检查，需对照命名空间。 本地差异见 `ds-bot/test/i18n.test.js`。 |
| [#1910](https://github.com/Fei2411/DS-Bot/pull/1910) | 暂缓 | 7 | 设置中暂停或恢复定时任务 | 本地任务设置有扩展，与 #1931 一起验证暂停与同时编辑的行为。 对照文件 `ds-bot/src/client/icons.js`。 |
| [#1909](https://github.com/Fei2411/DS-Bot/pull/1909) | 暂缓 | 7 | 切换 Bot 或会话时保留未发草稿 | 本地输入框还携带项目卡上下文，草稿恢复须核对目标卡。 对照文件 `ds-bot/src/client/composer.js`。 |
| [#1936](https://github.com/Fei2411/DS-Bot/pull/1936) | 暂缓 | 7 | 在桌面查看后台任务、进度和正文 | 依赖后台任务运行时 #1887；本地已有项目卡执行与结果入口。手机部分跳过。 对照文件 `ds-bot/src/client/browser-pane.js`。 |
| [#1944](https://github.com/Fei2411/DS-Bot/pull/1944) | 跳过 | 4 | 更新异步任务设计和愿景 | 作为设计证据记入本批，本地尚未采用对应运行时。 |
| [#1925](https://github.com/Fei2411/DS-Bot/pull/1925) | 跳过 | 1 | 修复独立应用 Windows 文字渲染 | Windows 专用。 |
| [#1921](https://github.com/Fei2411/DS-Bot/pull/1921) | 暂缓 | 5 | 用汇总表加快用量统计 | 本地用量测试和存储已有变更，需核对旧数据的汇总结果。 本地差异见 `ds-bot/test/usage.test.js`。 |
| [#1682](https://github.com/Fei2411/DS-Bot/pull/1682) | 暂缓 | 9 | 切换会话段后防止重复发送成员回复及失败通知 | 本地任务节点可跨段恢复，需用同一节点续跑核对投递次数和归属。 对照文件 `ds-bot/src/host/bot-tasks.js`。 |
| [#1678](https://github.com/Fei2411/DS-Bot/pull/1678) | 跳过 | 1 | 修复原生手机聊天页头透底 | 手机专用。 |
| [#1941](https://github.com/Fei2411/DS-Bot/pull/1941) | 暂缓 | 6 | Bot 内置使用手册 | 本地 API、项目卡和安装方式均有差异，直接采用会给用户错误操作说明。 对照文件 `ds-bot/index.js`。 |
| [#1922](https://github.com/Fei2411/DS-Bot/pull/1922) | 暂缓 | 7 | 电脑控制会话已结束时自动重开 | 本地工具目录实现有差异，重开时需保留当前 Bot 的权限。 本地差异见 `ds-bot/src/host/computer/catalog.js`。 |
| [#1759](https://github.com/Fei2411/DS-Bot/pull/1759) | 采用 | 9 | 本地智能体结束时释放待答请求、清理工作进程 | 移植 ACP 和 Claude 的请求清理、探测复用与进程生命周期修复。 |
| [#1708](https://github.com/Fei2411/DS-Bot/pull/1708) | 暂缓 | 3 | 侧边面板打开后仍可拖动窗口 | 上游通过插件样式和面板代码处理窗口拖动，本地需协调浏览器、成员详情面板的点击和拖动范围。 对照文件 `ds-bot/src/client/bot-browsers.js`。 |
| [#1920](https://github.com/Fei2411/DS-Bot/pull/1920) | 需讨论 | 9 | 混合来源的一轮对话保留 IM 回信目标 | 本地项目卡和 IM 消息可能一起续跑。需决定此时只发可归属 IM 的回复，还是允许整轮结果外发。 对照文件 `ds-bot/src/host/im/index.js`。 |
| [#1942](https://github.com/Fei2411/DS-Bot/pull/1942) | 需讨论 | 5 | Bot 经用户审核后公开提交缺陷报告 | 上游目标固定为上游仓库。需确定二开问题应发本地仓库、上游仓库，还是只生成草稿。 对照文件 `ds-bot/index.js`。 |
| [#1947](https://github.com/Fei2411/DS-Bot/pull/1947) | 暂缓 | 6 | 为最新消息和附近消息查询加索引 | 本地群及任务过滤改变了读路径，需覆盖分页边界和已归档卡片。 本地差异见 `ds-bot/src/host/chat-index.js`。 |
| [#1945](https://github.com/Fei2411/DS-Bot/pull/1945) | 跳过 | 1 | 修复 Windows 插件文字渲染 | 仅处理 Windows ClearType。 |
| [#1919](https://github.com/Fei2411/DS-Bot/pull/1919) | 需讨论 | 7 | 外部智能体通过本机 MCP 调用团队 | 默认仅 Main Bot，可逐群授权。需决定项目群授权是否包含卡内消息和派工能力。 对照文件 `ds-bot/index.js`。 2026-11-25 09:58 +0800 重审依据更新。上游 #2016 已用对外统一 API 的 /mcp 承接独立入口，后续参看新 Token 能力域、目标范围和 Run 完成态。 |
| [#1949](https://github.com/Fei2411/DS-Bot/pull/1949) | 暂缓 | 3 | 自动召回时复用当天日期 | 本地记忆测试已分化，复核日期边界及群记忆用例。 本地差异见 `ds-bot/test/memory.test.js`。 |
| [#1948](https://github.com/Fei2411/DS-Bot/pull/1948) | 跳过 | 1 | 缺陷报告中的 Windows 路径脱敏 | Windows 专用。 |
| [#1950](https://github.com/Fei2411/DS-Bot/pull/1950) | 跳过 | 1 | 首次导入前即开始计算耗时预算 | 独立应用的导入流程。 |
| [#1933](https://github.com/Fei2411/DS-Bot/pull/1933) | 暂缓 | 3 | 异步初始化前完成测试注册 | 需适配本地扩展后的测试文件，避免漏跑已有用例。 对照文件 `ds-bot/test/right-panel.test.js`。 |
| [#1931](https://github.com/Fei2411/DS-Bot/pull/1931) | 暂缓 | 7 | 防止暂停定时任务时覆盖同时发生的修改 | 依赖 #1910；需要本地设置接口的并发更新验收。手机入口跳过。 对照文件 `ds-bot/src/client/schedules.js`。 |
| [#1923](https://github.com/Fei2411/DS-Bot/pull/1923) | 跳过 | 1 | 滑动打开手机团队抽屉 | 手机专用。 |
| [#1926](https://github.com/Fei2411/DS-Bot/pull/1926) | 跳过 | 1 | Android 换段后仍可访问群历史 | Android 专用。 |
| [#1930](https://github.com/Fei2411/DS-Bot/pull/1930) | 采用 | 7 | Discord 已编辑消息保留 Markdown | 接入插件的 Discord 消息适配器。 |
| [#1951](https://github.com/Fei2411/DS-Bot/pull/1951) | 暂缓 | 3 | 测试等到 MAX_TOKENS 诊断再断言 | 本地后续执行测试已改，需适配断言位置。 本地差异见 `ds-bot/test/follow-through.test.js`。 |
| [#1952](https://github.com/Fei2411/DS-Bot/pull/1952) | 暂缓 | 3 | 写记忆快照时复用当天日期 | 本地记忆写入路径有差异，需保留现有快照范围。 本地差异见 `ds-bot/src/host/memory.js`。 |
| [#1954](https://github.com/Fei2411/DS-Bot/pull/1954) | 跳过 | 1 | 并行计算导入数据大小 | 独立应用的导入流程。 |
| [#1953](https://github.com/Fei2411/DS-Bot/pull/1953) | 暂缓 | 10 | 防止后台任务结果发往其他 IM 聊天 | 依赖 #1887；适配后台任务时必须验证 A 群派发的结果不会回到 B 群。 对照文件 `ds-bot/src/host/im/index.js`。 |
| [#1924](https://github.com/Fei2411/DS-Bot/pull/1924) | 跳过 | 1 | Android 菜单添加 DSH Agent | Android 专用。 |
| [#1918](https://github.com/Fei2411/DS-Bot/pull/1918) | 跳过 | 2 | 统一上游 PR 和独立审查标签 | 上游贡献流程，本地已有派工验收规则。 |
| [#1955](https://github.com/Fei2411/DS-Bot/pull/1955) | 暂缓 | 5 | 记忆检索复用已解析文件 | 本地尚未采用对应检索路径，结合 #1852 核对文件变更后缓存失效。 对照文件 `ds-bot/src/host/memory.js`。 |
| [#1958](https://github.com/Fei2411/DS-Bot/pull/1958) | 采用 | 7 | 按消息缓存历史记录的密钥遮盖结果 | 相同消息复用脱敏结果，避免反复计算。 |
| [#1971](https://github.com/Fei2411/DS-Bot/pull/1971) | 跳过 | 1 | 上游 0.3.9 发布回合 | 发布信息作对照，插件按逐项采用结果发本地版本。 |
| [#1959](https://github.com/Fei2411/DS-Bot/pull/1959) | 跳过 | 2 | 浏览器远程客户端停止后台任务 | 独立的远程访问入口，依赖上游后台任务。 |
| [#2007](https://github.com/Fei2411/DS-Bot/pull/2007) | 采用 | 9 | 修复打开设置模型选择器时崩溃 | 采用模型选择器的 React Hook 修复。 |
| [#2010](https://github.com/Fei2411/DS-Bot/pull/2010) | 暂缓 | 9 | 微信重启后恢复排队的回复 | 本地 IM 恢复入口有差异，需验证同一条消息重启后只回复一次。 本地差异见 `ds-bot/src/host/im/index.js`。 |
| [#2008](https://github.com/Fei2411/DS-Bot/pull/2008) | 采用 | 8 | 飞书长连接发现和重试 | 修复发现服务和失败后重试的处理。 |
| [#2011](https://github.com/Fei2411/DS-Bot/pull/2011) | 采用 | 8 | 停止 ACP 智能体后消除上一轮的错误 | 采用取消后的错误处理。 |
| [#2013](https://github.com/Fei2411/DS-Bot/pull/2013) | 采用 | 8 | 限制取消 ACP 请求后的等待时间 | 上游代理没有回复也能结束取消等待。 |
| [#1983](https://github.com/Fei2411/DS-Bot/pull/1983) | 采用 | 5 | 消除模型菜单原生提示闪烁 | 修正菜单提示处理。 |
| [#1995](https://github.com/Fei2411/DS-Bot/pull/1995) | 暂缓 | 4 | 整理设置图标和卡片间距 | 涉及本地定制导航与已删除的手机入口，需要逐块取用。 对照文件 `ds-bot/src/client/mcp-page.js`。 |
| [#2014](https://github.com/Fei2411/DS-Bot/pull/2014) | 暂缓 | 9 | 群提问和表单卡回到发起方 IM 群 | 本地另有任务卡归属，需保留群、卡与操作人的对应关系。 对照文件 `ds-bot/src/host/channel.js`。 |
| [#2021](https://github.com/Fei2411/DS-Bot/pull/2021) | 暂缓 | 7 | 侧栏显示待审批、待回答状态 | 本地侧栏已有群任务状态，需避免一张卡重复计数。 对照文件 `ds-bot/src/client/sidebar.js`。 |
| [#2022](https://github.com/Fei2411/DS-Bot/pull/2022) | 采用 | 8 | 重启后保留提供方注册的 antigravity/* 模型 | 采用模型引用恢复修复。 |
| [#1991](https://github.com/Fei2411/DS-Bot/pull/1991) | 跳过 | 1 | 合并独立应用日志写入 | 独立应用专用。 |
| [#1985](https://github.com/Fei2411/DS-Bot/pull/1985) | 暂缓 | 5 | 线性拆分本地智能体的输出行 | 本地 Claude 输出处理已改，需覆盖跨块和末尾半行。 本地差异见 `ds-bot/src/host/local-agents/claude.js`。 |
| [#1984](https://github.com/Fei2411/DS-Bot/pull/1984) | 暂缓 | 7 | 读取群消息时避免扫描整本账本 | 本地按群和任务读取。与 #1841 一起验收压缩回复可见、其他任务不可见。 本地差异见 `ds-bot/src/host/groups.js`。 |
| [#1982](https://github.com/Fei2411/DS-Bot/pull/1982) | 暂缓 | 5 | 写记忆时仅读变更日志末尾 | 本地记忆模块初始化不同，可与已采用的 #2082 分开移植。 本地差异见 `ds-bot/src/host/memory.js`。 |
| [#1979](https://github.com/Fei2411/DS-Bot/pull/1979) | 采用 | 6 | 创建 Bot 后捕获欢迎消息发送失败 | 避免异步错误无人处理。 |
| [#1996](https://github.com/Fei2411/DS-Bot/pull/1996) | 跳过 | 4 | 手动新会话可从空白开始 | 上游随后在 #2042 移除该入口；本地对会话入口的选择见 #2039、#2042。 |
| [#1990](https://github.com/Fei2411/DS-Bot/pull/1990) | 采用 | 4 | 打开消息浮层时才监听可视区域 | 关闭后释放监听，减少闲置开销。 |
| [#1988](https://github.com/Fei2411/DS-Bot/pull/1988) | 暂缓 | 4 | 加快新消息提示的检查 | 本地聊天页头包含任务和成员历史，需核对提示定位。 本地差异见 `ds-bot/src/client/header.js`。 |
| [#1987](https://github.com/Fei2411/DS-Bot/pull/1987) | 暂缓 | 4 | 仅在被观察的列消失后重扫布局 | 本地面板观察器已改，需覆盖成员详情和原生插件。 本地差异见 `ds-bot/src/client/frame-watch.js`。 |
| [#1999](https://github.com/Fei2411/DS-Bot/pull/1999) | 暂缓 | 8 | 清除 DSH Agent 对已删会话的引用 | 本地同时保留活动和归档会话，需区别删除与归档。 本地差异见 `ds-bot/test/agents.test.js`。 |
| [#2001](https://github.com/Fei2411/DS-Bot/pull/2001) | 暂缓 | 9 | 重启后恢复上轮遗留的插入请求 | 本地已有项目节点恢复，需验证同一请求只由一个执行者接手。 本地差异见 `ds-bot/src/host/resume.js`。 |
| [#2000](https://github.com/Fei2411/DS-Bot/pull/2000) | 暂缓 | 8 | 群轮次跟踪本地 CLI 的工作状态 | 本地执行与节点绑定，需验证节点完成条件。 本地差异见 `ds-bot/src/host/turns.js`。 |
| [#2023](https://github.com/Fei2411/DS-Bot/pull/2023) | 暂缓 | 6 | 电脑交还消息使用宿主可保存的来源 | 本地消息单元渲染和任务归属不同，需覆盖持久化后的恢复。 本地差异见 `ds-bot/src/client/cells.js`。 |
| [#2018](https://github.com/Fei2411/DS-Bot/pull/2018) | 暂缓 | 7 | 在原 IM 群回复文本或多选表单 | 依赖 #2014 的原群路由。 对照文件 `ds-bot/src/host/im/index.js`。 |
| [#2027](https://github.com/Fei2411/DS-Bot/pull/2027) | 暂缓 | 7 | 隔离浮层崩溃并检查 React Hook 调用 | 本地浮层还挂载任务和历史面板，需要逐个保留；模型选择器修复已单取 #2007。 对照文件 `ds-bot/src/client/cells.js`。 |
| [#2032](https://github.com/Fei2411/DS-Bot/pull/2032) | 暂缓 | 8 | 通过宿主工具事件截获后台 shell 调用 | 依赖上游后台命令运行时，本地需遵循现有 DSH 公开接口。 对照文件 `ds-bot/src/host/steer.js`。 |
| [#2006](https://github.com/Fei2411/DS-Bot/pull/2006) | 需讨论 | 6 | 重做设置导航并增加操作导览 | 本地有项目设置。需决定保留现有分组仅加搜索，还是迁入上游总控台。 对照文件 `ds-bot/src/client/about.js`。 |
| [#2019](https://github.com/Fei2411/DS-Bot/pull/2019) | 暂缓 | 8 | 按会话装卸工具和技能包 | 本地有项目卡工具和自带技能，需验证按需加载后派工和恢复仍可用。 对照文件 `ds-bot/src/host/capabilities.js`。 |
| [#2031](https://github.com/Fei2411/DS-Bot/pull/2031) | 暂缓 | 7 | IM 表单拒绝未知的 !card 编号 | 依赖 #2014、#2018，需核对任务卡消息与表单命令分流。 对照文件 `ds-bot/src/host/im/index.js`。 |
| [#2025](https://github.com/Fei2411/DS-Bot/pull/2025) | 暂缓 | 9 | 在收件箱接收消息时转交前台任务 | 依赖 #1892 的归属决策，需保留正在执行的项目卡。 对照文件 `ds-bot/src/host/bot-tasks.js`。 |
| [#2039](https://github.com/Fei2411/DS-Bot/pull/2039) | 需讨论 | 9 | 移除同一 Bot 的并行会话 | 本地可查看群成员各段和任务。需决定执行中能否另起私聊，先保留现状。 对照文件 `ds-bot/src/client/details-drawer.js`。 |
| [#2035](https://github.com/Fei2411/DS-Bot/pull/2035) | 暂缓 | 7 | Bot 设置中选择常驻、清单或关闭 | 依赖 #2019 的按会话加载机制，先确定本地任务工具的默认档位。 对照文件 `ds-bot/src/client/bot-settings.js`。 |
| [#2041](https://github.com/Fei2411/DS-Bot/pull/2041) | 暂缓 | 9 | 重放输入前等待正在进行的后台交接 | 依赖 #1892；迁移时验证重启不会让两个执行者接同一张卡。 对照文件 `ds-bot/src/host/bot-tasks.js`。 |
| [#2042](https://github.com/Fei2411/DS-Bot/pull/2042) | 需讨论 | 9 | 删除手动新建、切换会话及相关接口 | 本地成员详情能打开当前段与历史段。需分别决定保留只读历史、手动换段和并行执行中的哪些能力。 对照文件 `ds-bot/src/client/details-drawer.js`。 |
| [#2043](https://github.com/Fei2411/DS-Bot/pull/2043) | 暂缓 | 8 | 普通 Bot 不显示 Main 专属管理工具 | 本地已有管理权限限制；需检查功能包裁剪后 Main 和普通成员各自可见的工具。 对照文件 `ds-bot/src/host/tools.js`。 |
| [#2028](https://github.com/Fei2411/DS-Bot/pull/2028) | 需讨论 | 6 | 设置总览、⌘K 搜索和外观实时预览 | 与 #2006 一起决定整套采用或仅取搜索；移植时需裁掉手机等入口。 对照文件 `ds-bot/src/client/bot-models-page.js`。 |
| [#2046](https://github.com/Fei2411/DS-Bot/pull/2046) | 跳过 | 3 | 设计说明与当前实现对齐 | 设计变化计入本批，不能据此认定本地已有对应功能。 |
| [#2048](https://github.com/Fei2411/DS-Bot/pull/2048) | 跳过 | 1 | 上游 0.3.10 发布回合 | 版本及发布说明作对照，功能逐项登记。 |
| [#2052](https://github.com/Fei2411/DS-Bot/pull/2052) | 暂缓 | 7 | 本地 CLI 登录探测超时后使用回退 | 本地 macOS 登录探测已有差异，与 #2057 一起覆盖已登录和超时场景。 对照文件 `ds-bot/src/host/local-agents/discover.js`。 |
| [#2045](https://github.com/Fei2411/DS-Bot/pull/2045) | 跳过 | 1 | 独立桌面应用支持 ChatGPT 账号登录 | 依赖 Electron 主进程和系统凭据存储，日用 DSH 插件无此后端。 |
| [#2054](https://github.com/Fei2411/DS-Bot/pull/2054) | 跳过 | 3 | 重整公开文档、设计目录及界面规范 | 上游发布资料；适用设计见本批摘要。 |
| [#2057](https://github.com/Fei2411/DS-Bot/pull/2057) | 暂缓 | 7 | 处理登录探测并发刷新和超时 | 依赖 #2052；需验证较早的探测结果不会覆盖新状态。 对照文件 `ds-bot/src/host/local-agents/discover.js`。 |
| [#2069](https://github.com/Fei2411/DS-Bot/pull/2069) | 跳过 | 2 | 删除并行会话旧翻译键 | 本地仍有会话入口，保留相应文案。 |
| [#2070](https://github.com/Fei2411/DS-Bot/pull/2070) | 暂缓 | 8 | 多 Bot 在线时保留 Main 的管理工具 | 与 #2019、#2043 的角色裁剪一起核对。 对照文件 `ds-bot/src/host/tools.js`。 |
| [#2072](https://github.com/Fei2411/DS-Bot/pull/2072) | 暂缓 | 5 | 切回 Bot 模式时就地显示侧栏 | 本地侧栏和群详情有自定义布局。 本地差异见 `ds-bot/src/client/sidebar.js`。 |
| [#2073](https://github.com/Fei2411/DS-Bot/pull/2073) | 暂缓 | 8 | 浏览器断连后避免向空对象导航 | 本地浏览器挂载流程有差异，适配时验证断线后重新导航。 本地差异见 `ds-bot/src/host/browser/mount.js`。 |
| [#2071](https://github.com/Fei2411/DS-Bot/pull/2071) | 暂缓 | 9 | 后台任务另起一轮结束时仍回复原 IM | 依赖 #1887 和原始目标绑定，与 #1953 的跨群测试一起验收。 对照文件 `ds-bot/src/host/im/index.js`。 |
| [#2081](https://github.com/Fei2411/DS-Bot/pull/2081) | 暂缓 | 5 | 加快微信引用缓存淘汰 | 本地有微信引用测试，需核对过期后和跨聊天的回退行为。 本地差异见 `ds-bot/test/im.test.js`。 |
| [#2080](https://github.com/Fei2411/DS-Bot/pull/2080) | 暂缓 | 5 | 在统计词频时直接计算记忆搜索得分 | 与 #1852、#1955 一起适配，核对排名及搜索范围。 本地差异见 `ds-bot/src/host/memory-search.js`。 |
| [#2082](https://github.com/Fei2411/DS-Bot/pull/2082) | 采用 | 7 | 读取记忆日志末尾失败后允许重试 | 读成功才标记已加载，一次临时失败后仍能恢复。 |
| [#2079](https://github.com/Fei2411/DS-Bot/pull/2079) | 跳过 | 1 | 首次导入包含后台任务会话 | 独立应用的首次导入。 |
| [#2056](https://github.com/Fei2411/DS-Bot/pull/2056) | 跳过 | 1 | ChatGPT 套餐路由使用独立的工具命名空间 | 依赖独立应用的账号路由 #2045。 |
| [#2074](https://github.com/Fei2411/DS-Bot/pull/2074) | 暂缓 | 8 | DSH Desktop 更新前释放长时间挂起的请求 | 适用于插件；本地浏览器和宿主通道有自定义请求，需要核对取消和重连。 对照文件 `ds-bot/src/client/bot-browsers.js`。 |
| [#2078](https://github.com/Fei2411/DS-Bot/pull/2078) | 跳过 | 1 | 导入时跳过不可能的会话目录 | 独立应用的导入流程。 |
| [#2063](https://github.com/Fei2411/DS-Bot/pull/2063) | 跳过 | 1 | 设置增加 ChatGPT 登录入口 | 依赖独立应用的 #2045 后端。 |
| [#2084](https://github.com/Fei2411/DS-Bot/pull/2084) | 暂缓 | 6 | 宿主 API 支持群头像 | 本地有自定义群存储，先验证修改头像只更新目标群并可持久化。 对照文件 `ds-bot/src/host/channel.js`。 |
| [#2086](https://github.com/Fei2411/DS-Bot/pull/2086) | 暂缓 | 6 | 新 Bot 照片沿用群照片的校验 | 依赖 #2084 的图片处理逻辑及依赖，需验证现有头像导入。 对照文件 `ds-bot/src/host/roster.js`。 |
| [#2085](https://github.com/Fei2411/DS-Bot/pull/2085) | 暂缓 | 5 | 桌面和手机可设置群头像 | 插件设置依赖 #2084，本地群详情有项目设置；手机部分跳过。 对照文件 `ds-bot/src/client/group-settings.js`。 |
| [#2088](https://github.com/Fei2411/DS-Bot/pull/2088) | 跳过 | 1 | 手机端将头像统一转为 JPEG | 手机专用。 |

## 2026-11-21 · macOS 插件同步

登记时间 2026-11-21 09:26 +0800（Asia/Taipei）。upstream/dev 第一父链 [f8577350 → 6905f3fb](https://github.com/Fei2411/DS-Bot/compare/f8577350...6905f3fbdd296282742f7ceee546816b2489b215)，终点 `6905f3fbdd296282742f7ceee546816b2489b215`。共 43 个 PR，18 项采用、14 项暂缓、9 项跳过、2 项需讨论。上游根目录 CHANGELOG.md 本批无改动。采用结果见本地 CHANGELOG.md。

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
| [#1892](https://github.com/Fei2411/DS-Bot/pull/1892) | 需讨论 | 9 | 忙碌时转后台和派生同级任务 | 依赖上一批暂缓的 #1887，前台结果需对应本地项目节点及回报目的地。 2026-11-25 09:58 +0800 重审依据更新。上游 #2180 已将普通私聊改为显式转后台，原自动切换方案需按新交互重审；本地卡片执行所有权仍待讨论。 |
| [#1902](https://github.com/Fei2411/DS-Bot/pull/1902) | 需讨论 | 9 | 群里的后台任务 | 依赖暂缓的 #1887；本地群项目卡、节点会话、重启恢复均自行维护，需先明确所有权。 2026-11-25 09:58 +0800 重审依据更新。关联本批 #2180、#2216 的交接持久化，群后台任务仍需按本地卡片和节点对应执行者与结果。 |
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
| [#1864](https://github.com/Fei2411/DS-Bot/pull/1864) | 采用 | 6 | Qoder CN CLI 探测 | 上游区分可执行文件别名；本地 ACP 启动与路由选择已有调整，acp.js 补丁冲突。 2026-11-25 09:58 +0800 暂缓→部分采用。部分内容已随 #2223 采用：CN 命令别名、设置登录指引和登录状态。ACP 运行时错误中的命令指引余项仍待适配。 |
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
