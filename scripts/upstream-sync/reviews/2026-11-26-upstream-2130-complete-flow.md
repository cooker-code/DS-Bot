# PR 2130 完整流程复核：为什么当前实现不能作为完整交付

- 复核时间：2026-11-26 10:00 +0800（Asia/Taipei）
- 性质：原因分析与交付约束修订；没有继续移植、回退运行代码或安装插件。
- 本地代码：`dev-upsteam@fc06b57d`；本审查分支从其规则修订后继 `2d65e37f` 创建，应用源码相同。
- 上游 PR：[2130](https://github.com/Fei-Craft/DS-Bot/pull/2130)，合入点 `94aa5a451f5746e5917132e9012013e3962cb0aa`；历史盘点终点仍为 `bb1b1592472084c32278c12287944ee40b8087c5`，未刷新 upstream。
- 当前安装：只读核实 web/desktop 均为 `0.3.10-local.27-upstream`，其 work-protocol.js、tools.js、resume.js 与本次受审源码逐字节一致。日用运行实例实际加载版本未核实。

## 结论

不是证明这项功能无法与本地共存，而是**不能直接套上游文件，且上一轮没有完成整条本地适配路径**。此前把五个同名工具和部分专项检查作为可安装依据，遗漏了正式项目派工、静默缓冲、恢复和暂停继续等路径。应纠正该交付判断。

历史采用状态保留“部分采用”，因为代码已经在候选和安装包中，不能改成未采用来掩盖事实；完整功能的交付检查不通过，停止把现有片段作为新功能继续部署。本轮未回退或卸载，避免在未识别在途委托的情况下破坏现场。

## 查实的差异与修法

| 路径 | 当前 .27 的事实 | 上游或本地需要的完整行为 | 原因与解决方式 |
| --- | --- | --- | --- |
| 正式项目派工后的追问、取消 | `delegate_work` 带 `card_round` 时转 `message_bot(reply_to:user)`。这条旧路径不会创建协议 work。接收者调用 `ask_back` 报 `Name the delegated work_id.`；即使显式传入该次 exchangeId，也因不存在协议 work 被拒；同一轮 `cancel_work` 亦被拒。 | 项目派工也应有可追问、答复、取消的唯一委托，始终绑定原卡及执行轮。 | **已复现的流程断点。** 不能只将旧派工改个工具名；为正式派发建立 work 与原 taskId/round/dispatchId/session 的关联，所有入口共用此状态，同时保留 project_task 的提交与验收职责。 |
| 忙碌 Bot 接新工作 | 本地新工具始终排进现有私聊或群成员会话，没有上游 `spawnBotHandoffTask`。 | 前台忙碌时可在独立后台会话执行，原用户会话和手动多会话继续可用。 | **缺失执行底座及线程适配。** 上游使用 `bot.tasks`，本地使用 `bot.openParts`；完整移植前应让两种线程共存并适配 owner 查找、换段、取消、恢复，不能复制上游 threads.js 抹掉本地会话。 |
| 项目卡 ID 与后台执行 ID | 本地 `source.taskId` 是持久项目卡 UUID；上游后台消息的 `taskId` 是 `k_` 开头的后台任务 ID。本地 routing 明确拒绝非卡 UUID。 | 同一个后台执行必须仍能指向原项目卡和原派工轮。 | **具体字段语义冲突。** 保留本地 taskId 含义，用独立后台执行字段/映射关联 work；不能用后台 ID 覆盖卡 ID。 |
| 静默通知 | 目标正在运行时，本地 `note_bot` 仍直接 `agent.inject()`，source 没有 `silent:true`。调用跟踪确认注入发生在 turn/end 之前。 | 上游要求忙时缓冲、空闲再注入，并在换段、本地 CLI、IM 和未读判断中保留静默语义。 | **同名工具的行为不等价。** 应走统一静默投递及缓冲路径，复用到 note、cancel 和 stop，不只验证“没有 followup”。 |
| 宿主重启 | 新委托消息有 workProtocol 和 parentExchangeId，但 `resume.js:triggerOf` 写 inflight.json 时没有保留它们；隔离读取确认两字段丢失。 | 恢复须保留原 work、卡、轮及状态；need_input/paused 仍等待，取消的工作不能被重放唤醒。 | **已验证的持久化边界缺口。** 统一保存/回读 trigger 契约，覆盖恢复后回答、超过关闭回执保留量后的晚到结果、重复投递和原卡归属。单纯“SQLite 能存 work”不能证明恢复完整。 |
| 防止空转、可见暂停与继续 | 当前适配没有移入配对/群成环守卫、实质工作计数、paused 状态及 WorkPauseCard/继续取消接口。 | 无进展的往返应暂停并让用户可继续或取消，正常问答与多人并行不能被误停。 | **完整功能缺项。** 这些正是 PR2130 的主要目的，不能按“保护现有 UI”省掉。保留本地布局，在原有界面补可操作的状态，不替换原项目卡。 |
| 工具参数与现有调用 | 上游 note_bot 用 note，本地要求 message；上游 cancel_work 用 target，本地要求 work_id。用上游参数调用当前工具，实际得到缺少必填参数的错误；when、deliver_to 等分支也没有完整对应。 | 提示、技能、模型工具定义、调用方和恢复记录使用同一契约；已有调用有明确兼容规则。 | **接口契约不一致。** 统一入口和身份解析，写清已有调用如何继续可用，不能仅保留同名工具。 |
| SQLite | 含 workSeq、closedWorks、pairLoops、bot.tasks 的合成团队在本地 SQLite 中完整保存/读取一致。 | 所选生命周期状态须事务保存、重启后可恢复。 | **已排除“SQLite 无法保存”的笼统阻塞。** 当前 extra_json 边界能保留扩展属性；仍应验证宿主 store、trigger 和恢复执行，不需要为了采用功能替换本地存储。 |

关键本地位置：[委托入口与身份检查](../../../ds-bot/src/host/work-protocol.js)、[旧正式派工](../../../ds-bot/src/host/tools.js)、[恢复触发字段](../../../ds-bot/src/host/resume.js)、[线程归属](../../../ds-bot/src/host/threads.js)、[SQLite 编解码](../../../ds-bot/src/host/team-storage/records.js)。

## 哪些确实不能直接套用

对 PR 合入点相对第一父提交的补丁做了只读 `git apply --check`，排除了生成客户端、已删除手机端及手册的专用路径。检查有上下文不匹配及缺少文件的报错；这只证明不能原样套补丁，不等于功能无法适配。

除本地没有的 bot-tasks.js 及对应线程导出外，改动后的插件宿主还引用了当前缺少的 room-reports.js、im/origin.js、im/outbound-images.js、im/view-choices.js、im/view-form.js、manual-skills.js、builtin-packs.js。手机专用 preview.js 仍按排除范围跳过，不能把它列为插件必须补的阻塞。

前置和后续加固要分开：

- [PR1887：后台任务](https://github.com/Fei-Craft/DS-Bot/pull/1887) 已是 PR2130 第一父提交的祖先。后台、线程、owner 索引和生命周期是明确基础依赖。
- [PR2125：群回报加固](https://github.com/Fei-Craft/DS-Bot/pull/2125) 在 PR2130 之前引入了群报告与 IM 来源相关模块；对应能力需与本地卡/轮和 IM 路由一起适配。
- 手册、能力包及权限相关导出必须按本地现有职责衔接；不能为了消除 import 错误盲目引入整套上游底座，也不能把所需行为删去。
- [PR2139：派活与后台统一](https://github.com/Fei-Craft/DS-Bot/pull/2139)、[PR2144：投递持久化与恢复](https://github.com/Fei-Craft/DS-Bot/pull/2144)、[PR2180：显式转后台](https://github.com/Fei-Craft/DS-Bot/pull/2180)、[PR2216：交接失败保留输入](https://github.com/Fei-Craft/DS-Bot/pull/2216) 均在 PR2130 之后，不能反过来说它们是 PR2130 的先决条件。要交付固定终点行为时，应将适用加固纳入同一完整候选。
- [PR2039](https://github.com/Fei-Craft/DS-Bot/pull/2039) / [PR2042](https://github.com/Fei-Craft/DS-Bot/pull/2042) 的删除多会话决定继续跳过。保留并行会话与新增后台执行可以共同设计，不存在已证明“二者只能留一个”的结论。

## 以后整条流程应如何运作

以下是完整适配的目标，**尚未实施或验收**。它将替代上一轮“先接五个工具、其他以后再说”的交付拆法。

1. 原项目卡创建执行轮并派工，登记唯一 work。work 关联原 taskId、round、dispatchId、派发会话及接收会话；只有进入独立后台时才增加后台执行身份。
2. 接收者空闲则执行；前台忙碌且需要立即处理时，用独立后台会话执行，保留用户当前前台和手动多会话。排队请求仍按其排队语义处理。
3. 接收者缺信息时，work 进入 need_input，问题回原派发方；项目卡没有被提交或批准。派发方答复后恢复原 work 的原执行会话，不另建卡或轮。
4. 无实质进展的循环进入 paused，现有界面可见并支持继续/取消；继续只恢复一次。正常问答、有效纯文字工作和并行扇出继续按设计运行。
5. 完成结果回原卡、原轮和正确 IM 来源，只产生该轮的交付证据。项目卡按照原有提交、复核及人工验收条件推进，不能因 work 关闭就自动通过。
6. 取消关闭指定 work 及其子工作，停止对应运行/排队执行；保留其他会话和其他卡，迟到结果不能重开或提交。
7. 宿主重启后按原身份和原状态恢复：执行中的接续，等答复的继续等，暂停的仍暂停，取消/完成的不重发。界面回执与持久状态一致。

详见[本地已定适配说明](../plans/2026-11-25-local-upstream-decisions.md)。实现可在隔离分支分步开发，但完整路径通过前不能继续合入交付分支或更新日用插件。

## 实际验证与边界

本轮复用了插件真实服务与 SQLite 编解码，宿主上下文和模型为测试夹具；未使用日用数据、真实模型或外部发送。六个诊断用例按预期确认上述缺口及 SQLite 可保存结论。**诊断用例通过是问题得到复现，不表示功能验收通过。**

正式派工样本实际经过 project_task plan → dispatch → delegate_work(card_round) → 接收方 ask_back，使用同一卡和轮；不是仅手工构造一条 works 数据。恢复样本实际读取 inflight.json；SQLite 样本实际创建、写入和读取隔离数据库。

结构化结果见[六项复核证据](evidence/2026-11-26-upstream-2130.json)。完整临时复现脚本为 `/tmp/ds-upstream-2130-repro.test.js`，日志为 `/tmp/ds-upstream-2130-repro.log`，只读补丁检查为 `/tmp/ds-upstream-2130-apply-check.log`。没有重跑应用全量回归，因为本轮没有修改运行代码。

旧的163项专项、独立验收和已安装事实保留为当时范围的证据，不能升级为上述完整流程的验收结论。本轮采用历史记忆卡 `ds-bot:mem-4f6479cacb1b` 的“旧流程或局部结果不能证明新流程已验证”结论，仅用于这个证据边界；没有拿该卡旧任务/提交充当本次运行样本。

## 本地隔离与旧工作树登记

本轮新建目录遵守单数 `.worktree/` 规则，创建了 docs/upstream-2130-complete-flow 分支；本地 info/exclude 已排除该目录。应用代码与dev提交均未改变，临时诊断测试和依赖链接已移出工作树。

按 Git 登记和实际目录检查，初始65个登记中，26个旧同级路径已不存在并标记prunable；38个仍存在的旧工作树位于 `.worktrees/`，另有主工作树。没有发现未登记的同仓库工作树；有未提交内容的目录已逐项记下。新审查工作树随后单独加入清单。完整路径、分支、提交包含关系及未提交状态见[工作树盘点](../../../docs/reviews/evidence/2026-11-26-worktree-inventory.json)。这些旧目录与清理不属于本次原因分析范围，本轮未移动、删除或修复其登记。
