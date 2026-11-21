# 项目工作、会话与运行操作

这些操作和设置共用同一通道，有些会启动工作、发消息或终止执行。查看一个项目的进度用 `project-task-list`，从列表取 `taskId` 再读明细。主卡完成后，同群关联子卡（含多级）同步为 done；删除主卡会解除直接子卡关联，保留其完成状态与历史。全队视图在 `state.rooms[].projectCards` 使用同一套摘要。Bot 会话中的 `project_task` 使用该 Bot 的身份和派工资格。正式派工交给负责成员在任务所属群的当前会话，新派工可在 `project-task-detail` 返回的 `rounds[].executionSession` 查看实际收件会话 ID，开工核对该轮工作树。阻塞恢复核对原执行会话和候选负责人的本群会话。[通道处理器](../../../../ds-bot/src/host/channel.js)

## 群、task 与工作树

[project-tasks.js](../../../../ds-bot/src/host/project-tasks.js) 负责候选、原需求、复核和轮次。[project-branches.js](../../../../ds-bot/src/host/project-branches.js) 负责 Git 工作区。task、计划和执行轮次写群库，原群消息位于其账本。读取分支状态有明确的最近观察时间。

| 操作 | 业务与输入 | 服务和成功值 |
| --- | --- | --- |
| `group-discussions` | 传 `roomId` 读取群自身当前及旧会话各轮，顺序为从旧到新。可传 `detail`（返回的轮 ID）读取单轮。 | `groupDiscussions` 返回含 id、part、turn、time、title 的列表；active 表示仍在执行。单轮详情含 items 正文。只读宿主可查。 |
| `archive-discussions` | 传 `roomId,action,ids`，action 为 archive 或 restore。ids 来自该群完整轮次表。整批验证，含未知或活动轮则拒绝。 | `setDiscussionArchive` 在群库 rooms.extra_json 保存 archivedDiscussions；成功返回 true。通过 state.rooms[].archivedDiscussions 回读。重复请求无重复条目。群搜索命中返回 archived:true。 |
| `room-context` | 传 `roomId`，只读当前成员群会话。 | `memberContext` 按 Bot ID 返回当前段 ID、最近请求模型、推理强度、支持情况、上下文百分比及换段状态。缺失字段表示无读数。群自身仅转发。 |
| `member-summary` | 传 `roomId,botId,sessionId`，指定成员及其当前群段；旧段请求被拒绝。 | `requestMemberSummary` 返回 true 表示受理，工作中等待空闲。轮询 `room-context` 查看 pending、failed 或新段 ID；新旧段映射持久化在群库。 |
| `delete-room` | `id` 删除指定群。 | `deleteRoom` 返回更新后的团队视图。按群 ID 查目录及回读名册。 |
| `room-todo` | `roomId,id,done` 设置共享待办，`action:"remove"` 删除一项，`action:"clear"` 清理已完成项。新建由群成员或主 Bot 在其会话调用 `group_todo` 的 `add`，保留创建者身份。 | `setRoomTodoDone/removeRoomTodo/clearDoneRoomTodos` 返回条目或清理数及剩余 `todos`，写 `room_todos`。[共享待办设计](../../../../docs/plans/2026-11-10-group-todos.md) |
| `project-task-list` | 按群查询进度。只需 `roomId`（字符串，项目群 ID）。只读宿主也能调用。 | `roomTaskSummaries/projectCardSummary/pendingIntakes` 读取目标群的 task、轮次、计划和收件。返回 `{roomId,revision,tasks,pendingIntakes}`。任务栏只显示正式任务；待分类与待澄清的收件仍可用 pendingIntakes 查询。revision 是这次读取的团队修订号。关联卡的列表和详情含 parentTaskId，指向本群主卡。规划者或正在处理用户关联请求的本群管理员用 project_task relate（taskId 为子卡，parentTaskId 为主卡）保存关系于子卡；各卡详情仍按原 ID 读取。tasks 含 taskId、状态、最近轮次的 ownerId 与时间和已有计划摘要，pendingIntakes 是尚在 pending/planning/clarify 的收件。两者分别计数；空群返回两个空数组，未知群返回 `bot/not-found`。回溯重试用下一行的明细。阻塞轮次的技术协调保留原卡与执行状态；仅群管理员明确声明缺少用户需求或团队外权限时，clarify 才标记待补充。 |
| `set-project-workspace-policy` / `project-branches` | 前者用 `roomId,policy`（auto/current/worktree）设置已启用 task 群的默认 Git 工作区策略。auto 由该群任命的任务助理决定，未任命时由主 Bot 兼任。后者用 `roomId,repository?` 读取分支。 | `setProjectWorkspacePolicy` 返回策略字符串；`branchReport` 返回 `count,observedAt,branches`。 |
| `task-reference` / `project-task-detail` | 引用用 `sessionId,roomId,kind,id`，kind 为 member/project/intake。明细用 `roomId,taskId`，可选 `imageId,textOnly,workspaceOnly,workspaceChoices` 指定投影。 | `readTaskReference` 返回同群可见摘要。`projectCardDetail` 默认返回需求、节点、版本、轮次及结果。指定投影分别返回附件、文字或工作区信息。 |
| `select-task-workspace` / `update-project-task-text` | 前者用 `roomId,taskId,previous,selection`，以已读工作区对照选择；后者用 `roomId,taskId,field,previous,value,addImages?,removeImages?` 修订 requirement 或 acceptance。 | `selectTaskWorkspace/updateProjectTaskText` 校验旧值和当前轮次；成功后回读 task 的工作区选择或文本。版本冲突重读。修改需求文字或图片时，群库任务同步追加一份修改前的快照。requirement 取卡片正文，旧卡回退到首条原始收件或标题；关联消息可在完整明细的 requirements 中查阅。默认明细的 requirementHistory 按旧到新返回 {text,images}。缺少快照的旧卡若有需求编辑时间、已覆盖的原始收件且正文不同，读取时用原始收件显示 v1，下次保存需求时一起持久化；当前版本取 requirement、sourceImages 和 fieldImages.requirement。 |
| `continue-project-task` | roomId、taskId、text、requestId 均为字符串。 | 校验任务开启与本群任务归属后，按 requestId 去重，向群当前会话发送带 taskId 的用户消息。返回 true，回读群账本与卡片需求。群内 @ 项目卡并填写正文时，以首个引用为消息上下文，多卡引用保留各卡 ID 与正文顺序；明确点名其他成员时仍按群聊点名规则投递，交给本群管理员处理。 |
| `set-task-node-constraint` | roomId、taskId、version、node、field（fixedOwner 或 independentReview）、value（布尔值）。 | 派工前在原计划上新增一版，保存节点约束；拒绝过期版本。成功返回 true，回读 project-task-detail 的 plans。 |
| `set-task-integration-finish` | 操作者指定 roomId、taskId、version、node，以当前计划的独立测试合并节点作为结单位置。 | 保留原计划和轮次，将未派发的后续节点显示为 omitted，并通知助理处理。拒绝变更已开始的下游或过期计划；回读详情 finishAfterIntegration。 |
| `set-task-human-acceptance` | roomId、taskId、required（布尔值）。 | 更新群库任务的 humanAcceptanceRequired，返回布尔值。已有验收记录或完成后拒绝更改。用 project-task-detail 回读。 |
| `project-acceptance` | `roomId,taskId,reviewId,decision,feedback?`。decision 为 approve 或 return，退回需明确 feedback。 | `decideAcceptance` 仅处理当前候选的人工终验，回读 `humanReview` 和 task 状态。 |
| `room-progress` / `group-rows` / `group-search` | 查活跃群用 `roomId`；分页读群消息用 `roomId,from,to?,anchor?`；检索用 `roomId,query,before?,offset?`。 | `roomProgress/groupRowsView/groupSearch` 返回轮次及发言者、消息页或命中。活跃信息属运行时，持久依据是群账本。 |
| `goal-draft` / `goal-control` | 草拟用 `roomId,text`。操作已有目标用 `roomId,goalId,action,stopWork?`，显式的 stopWork 同时影响执行。 | `goalDraft/goalControl` 返回团队视图。从群目标和实际执行分别回读。[goals.js](../../../../ds-bot/src/host/goals.js) |
| `task-note` / `task-cancel` / `task-delete` | 留言用 `roomId,id,text`，取消用 `roomId,id`，删除看板项用 `roomId,items` 指定对象。 | `taskNote/taskCancel/deleteBoardTasks`。留言写记录并可能作为用户消息发到群，前两者返回团队视图，删除返回 true。[tasks.js](../../../../ds-bot/src/host/tasks.js) |
| `stop-chat` / `stop-member-work` / `stop-room-work` | 分别传 `botId,sessionId?`、`roomId,botId` 或 `roomId`，停止相应实际执行。 | `stopChat/stopMemberWork/stopRoomWork` 处理活动轮次。私聊指定 sessionId 时只停止该 Bot 拥有的对应活动会话，省略时停止当前会话。用 state.partsRunning 回读。 |
| `abandon-work` / `resume` | `id` 为待放弃的单次交接。恢复用 `botId`，指定项目失败轮次时传 `target:{roomId,taskId,round,failedAt}`。 | `abandonWork/resumeBot` 返回确认。核对目标轮次与错误时间，读当前执行判断是否真正恢复。 |

## 会话、附件、请求与回复

会话由 DSH 服务持有，名册保存会话与 Bot、群的关联。消息正文、对话分段缓存、附件和用量各有专用服务。不要用 SQL 修改会话 ID 或删除记录来模拟归档、取消或实际发送。

| 操作 | 业务与输入 | 服务和成功值 |
| --- | --- | --- |
| `add-agent` / `remove-agent` | 新增 DSH Agent 用 `{}`，移除用 `agentId`。 | `addAgent/removeAgent` 返回 Agent 或团队视图，查 `state.agents`。 |
| `agent-session` / `agent-adopt` / `agent-archive` / `agent-rename` | 分别用 `agentId,workspaceId`；`agentId,sessionId`；`agentId,sessionId`；`agentId,sessionId,title`。 | Agent 服务创建、接管、归档、重命名。前两者返回 `{sessionId}`，后两者返回 true。[agents.js](../../../../ds-bot/src/host/agents.js) |
| `bot-new-part` / `bot-open-part` / `bot-delete-parts` / `bot-private-workspace` | 新分段用 `botId,roomId?`，打开用 `botId,sessionId`，删除用 `botId,sessionIds`。挂载现有私聊只传 `botId,sessionId`。 | 前三者走 `newPart/switchPart/deleteParts`。打开历史会话会解除其归档，使它成为当前会话；原会话保留在 openParts，运行轮次、卡片及调度继续归原会话。切换成功返回 true，已在目标会话返回 false。私聊挂载从现有会话的 `header.cwd` 确定目录，通过 `workspaceRegistry.create(path)` 和 `workspace.attachSession(id)` 挂载，成功返回 true。用会话所属工作区确认。[session-list.js](../../../../ds-bot/src/host/session-list.js) |
| `earlier` / `chat` / `session-times` / `thinking` / `run-stats` / `usage` | 历史分页用 `sessionId,cursor?`；私聊用 `botId,cursor?,steps?`；会话时间用 `botId,ids`；思考时间用 `sessionId,turn`；执行统计用 `botId`；用量可传 `timeZone`。 | `earlierPage/chatPage` 返回分页；`session-times` 返回本 Bot 会话映射；`thinking` 返回 `{ms}`、空对象或 null；其余返回会话投影或按区间的用量视图。 |
| `exchange` / `exchange-text` | 双方 ID `a,b` 列出协作往来，`id,a?,b?` 取指定交接。 | `exchangesOf/exchangeText` 返回往来概要或记录正文。 |
| `stage-image` / `file-text` / `file-download` | 暂存 `mediaType,data,name?`；提取纯文本传含 `attachmentId` 的 `file`；下载用 `sessionId` 与 `attachmentId` 或 `seq,index?`，可用 `version` 锁定。 | 暂存返回短期 `{id}`；`fileText/fileDownload` 从附件服务按会话及格式读取。下载按返回元数据和编码取文件。[file-download.js](../../../../ds-bot/src/host/file-download.js) |
| `send` / `answer-question` / `dismiss-question` / `view-reply` / `dismiss-view` / `approval-answer` | 发送用 `sessionId,text,images?`；答问题用 `sessionId,questionId,answer`；答交互视图用 `sessionId,viewId,action,values`；关闭待答用 `sessionId`；批准用 `id,choice`。 | `sendUser/answerQuestion/viewReply/answerApproval` 触发对应用户动作，成功通常为 true。重复答复要检查原请求是否仍有效。 |
| `btw-delete` / `side-new` / `side-ask` / `side-cancel` / `side-close` | 删除旁问用 `sessionId,cardId`；新建旁聊用 `sessionId`；提问用 `sessionId,chatId?,recent?,text`；取消一条用 `chatId,entryId`；关闭用 `chatId`。 | `btwDelete/sideNew/sideAsk/sideCancel/sideClose` 返回对应旁问或旁聊操作结果，回读 `state.btwCards,sideChats`。[side.js](../../../../ds-bot/src/host/side.js) |

## 浏览器运行、诊断与更新

| 操作 | 业务与输入 | 服务和成功值 |
| --- | --- | --- |
| `browser-wait` / `browser-result` | 渲染端用 `clientId,open` 领取浏览器工作；result 回交对应请求的结果。 | `browserChannel.wait/result`，前者返回 `{requests,holds}`，后者确认收件。宿主关闭 Bot 浏览器时返回 `bot/browser-off`。 |
| `browser-takeover` / `browser-give-back` / `browser-stop` | `botId` 指定浏览器。交回可附具体操作的反馈，停止使控制权归用户。 | `browserChannel`、`stopChat` 等更新控制状态，回读 `browserHolds`。[browser.js](../../../../ds-bot/src/host/browser.js) |
| `changes-check` / `diagnostics` / `diagnostics-log` / `diagnostics-clear` | 查看某次变更用 `sessionId,seq`；诊断可传 `client,clientErrors`；读取及清理诊断日志用 `{}`。 | `changesAvailable` 返回布尔；`diagnostics.report` 返回 `facts,entries,total,markdown,issuesUrl`；log 读取日志，clear 清理后返回 true。[diagnostics.js](../../../../ds-bot/src/host/diagnostics.js) |
| `update-check` / `update-install` / `dsh-update-install` / `repo-stars` | 查版本可用 `fresh:true`，启动插件或宿主安装、查仓库星标用 `{}`。 | `updateCheck/updateStart/dshUpdateStart/repoStars` 返回检查结果、安装启动结果或仓库统计。发起安装后按实际加载版本确认。[update.js](../../../../ds-bot/src/host/update.js) |

### 功能分支开发、独立测试与 dev 集成

有任务助理的群中，小圈对明确需求使用 `project_task reply`，同时提交 `acceptWork=true,plan,acceptance,message`，成功回执包含 `delegated:true`。也可在原收件先回复再 delegate。助理比较已有卡，需要时 relate，并保存完整节点和依赖。开发轮 submit 提交功能分支的完整 commit。功能任务的独立测试节点设置 independentReview=true、writePaths=[]，依赖已认可的开发轮。测试只读验证该功能分支的固定候选，按提交号给出证据，submit 测试报告后由管理者认可结单，候选保留在功能分支。测试失败用 return_for_changes 提供 feedback 与 evidence，由助理安排开发返工后复测。环境故障用 block。需要集成时另行安排。新建计划或改版新增 mergeToDev 节点会被拒绝。已有历史 mergeToDev 节点仍按原约定使用 record_merge 和 testedCommit，可在 rounds 查看合并回执。群库保存节点设置、轮次证据及原始退回意见。实现见 project-tasks.js、project-plan.js 和 project-branches.js。

新版计划派回原开发归档时，若前驱测试已认可并记录集成，宿主核实旧轮已经改版、原执行已停止、同一工作树干净且仍指向刚集成的候选，才将重叠路径交回原开发。原轮 rounds[].ownershipTransfer 记录接收节点、候选和集成轮。

编辑未完成计划卡的需求或验收后，系统通知任务助理（未配置时通知管理员）读取最新卡片、更新受影响节点并继续派工；同一字段编辑重试复用通知。换版后，任务助理直接派发当前版本的就绪节点。派工事务核实同一开发人的旧执行已停止且无待处理的原派工消息、同一工作树干净、分支仍在旧轮开工提交或已有独立集成凭据，随新派工登记旧轮的 ownershipTransfer。同节点、同人、同一开工提交上的未提交修改若全部位于新旧两版共同授权的路径内，会原地保留并在派工消息中提示接续。旧回执保留在旧轮；新开工看当前版本轮次的 startedAt。
