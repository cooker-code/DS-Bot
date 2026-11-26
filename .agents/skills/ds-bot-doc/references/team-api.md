# 团队设置接口

外层请求和失败协议见[认证与调用](operator.md)。下表每行是一个或多个 `endpoint`。参数均属于 `payload`。`id`、`botId`、`roomId`、`sessionId` 均为对应实体的字符串标识，不能把显示名称当 ID。`?` 表示可省略。`state` 返回的名册、模型、权限列表给出当前可选值。`true` 作为返回值表示该动作得到确认，运行结果按各自入口回读。

## 名册、目录和群

业务层通过 [team-actions.js](../../../../ds-bot/src/client/team-actions.js) 发请求。[channel.js](../../../../ds-bot/src/host/channel.js) 选择服务。名册服务在 [roster.js](../../../../ds-bot/src/host/roster.js)，工作目录在 [folders.js](../../../../ds-bot/src/host/folders.js)，权限应用到会话的规则在 [permissions.js](../../../../ds-bot/src/host/permissions.js)。下表的目录库、基础库、群库及具体 SQL 见[数据层](storage.md)。

| 操作 | 业务及输入 | 服务、返回与回读 |
| --- | --- | --- |
| `state` | 读整个团队。`{}` 完整读取。增量读可传 `since`（整数修订号）、`models`（上次模型键）、`live`（上次运行状态键）和 `locale`。 | `view/liveAnswer` 合并团队各库、宿主及运行时状态。返回 `bots,rooms,capabilities,prefs,revision,liveKey,readOnly` 等。`unchanged:true` 时只合并本次返回字段。首次可写读取会触发 bootstrap。 |
| `create-bot` | 创建。`name` 为名称，`role?` 岗位标签，`instructions?` 持久说明，`brief?` 首轮上下文，`model?,effort?,workDir?,color?,avatar?,section?,sectionId?` 为初始配置。 | `createBot` 创建宿主会话并写基础库。返回 Bot 对象，`id` 为后续操作目标。核对 `state.bots`。 |
| `update-bot` | `id` 和差量 `name,role,instructions,model,effort,workDir,color,avatar,permission,private,browserGrants,section,sectionId`。`role` 最长 24 字，名称最长 40 字。工作目录按实际存在和隐私边界校验。模型引用选择当前目录中的值。 | `updateBot` 更新基础库、必要时重选模型或权限、跟随目录并通知资料变更。返回更新后的 Bot。`instructions` 用真实换行，空串清空。浏览器授权见[集成表](integration-api.md)。 |
| `duplicate-bot` | `id` 指向要复用岗位设置的 Bot。 | `duplicateBot` 返回新 Bot。使用新 `id`，核对新身份与配置。 |
| `delete-bot` / `private-release` | 前者 `id` 指定要删除的 Bot，后者 `id` 指定要释放的私有归档。 | `deleteBot/releaseArchive` 更新名册或归档，返回团队视图。删除还影响成员、会话与关联状态。 |
| `set-main` | `id` 为 Bot，`main` 为是否拥有主 Bot 身份。`primary?` 设为首位，`replace?` 为替换目标。 | `setMain` 更新目录库 `team_state.main_bot_ids_json`，返回团队视图。核对 `mainBotIds` 的成员及顺序。 |
| `create-room` | `members` 为至少两位有效 Bot 的 ID 数组。`name?,admin?,section?,sectionId?` 设名、管理员与分组。`greet:true` 会启动问候。 | `createRoom` 建群会话、登记目录和群库，返回群对象及 `id`。群公告、模式、权限与成员覆盖通过 `update-room` 修改。 |
| `update-room` | `id` 为群。`name?,notice?,mode?,admin?,members?,add?,remove?,workDir?,permission?,section?,sectionId?`。`mode` 为 `admin/everyone`。`members` 为完整列表，`add/remove` 为增删。按名称或 ID 传分组。 | `updateRoom` 返回 `{room,changes}`，群库保存公告、管理员、成员与配置。`taskManagementEnabled` 为布尔值，默认 true。用户传 `projectAssistantId`（本群非管理员成员 ID 或 null）任免助理。群库 rooms 的扩展字段保存设置，回读 state.rooms。公告保存为背景文字。 |
| `folders` / `folder-list` / `folder-pick` | `folders {}` 返回可用工作区。`folder-list {path}` 浏览支持的宿主路径。`folder-pick {}` 需宿主原生选择器。程序化设置已知路径可直接用对应写接口。 | `folderEndpoint` 返回 `{team,picker,folders}`、目录列表或选择结果。实际目录与注册表来自宿主。 |
| `team-workspace` | `path` 为团队默认工作区绝对路径。 | `setTeamWorkspace` 校验目录并注册工作区，返回 `{team}`。用 `folders.team` 回读。 |
| `set-flags` | `id` 为侧栏实体，`pinned?,hidden?,sectionId?` 控制置顶、隐藏、分组。 | `setFlags` 返回修改后的条目，保存到相应 Bot、群或 Agent 状态。 |
| `section-save` / `section-order` / `section-delete` | 保存分组用 `id?,name?,collapsed?,color?,items?,add?,remove?`；排序用 `ids` 数组；删除用 `id`。 | `saveSection/reorderSections/deleteSection` 修改目录库的分组与成员归属。保存返回分组，排序与删除返回团队视图。回读 `state.sections`。 |
| `avatar-library` / `avatar-import` / `avatar-delete` | 读库用 `offset?,limit?`；导入用 `items:[{name,image}]`，image 为受支持图片的 data URL；删除按图片 `id`。 | `avatarLibraryView/Import/Delete` 使用头像索引和图片文件。列表含 `items,total,next`，导入分别报告新增、重复、失败，删除返回布尔值。 |

群详情使用 `update-room` 的 `{id,contextPolicy:"summary"}` 启用各成员独立按预警线带摘要换段，`system` 恢复系统判断。未设置时采用 system。通过 `state.rooms[].contextPolicy` 回读。偏好由 `updateRoom` 写入群库 rooms.extra_json。

`update-room` 也提供单成员变更。用 `{id,memberSetting:{botId,model?,workDir?}}` 调 `updateRoomMember`。该分支只处理成员设置，其他群字段分开请求。`workDir:null` 清除成员覆盖以继承，空字符串表示显式采用默认工作目录，`model:null` 清除成员模型。省略某项保留原设置。返回 `{room,changes:[]}`，用 `room.memberSettings` 和实际群成员会话核对。数据位于群库 `room_member_settings`，Bot 私聊的默认配置仍由基础库提供。

## 偏好、模型与共享能力

| 操作 | 业务及输入 | 服务、返回与数据层 |
| --- | --- | --- |
| `set-prefs` | 差量对象。`theme` 主题，`accent` 为十六进制颜色或 null，`layout` 为 bubble/flat，`width/flatWidth` 为 50–100 的整数百分比，`effects` 为 full/reduced/off，`motion` 为 normal/quiet/lively。`thinking,enterToSend,memoryAutoRecall` 为开关。`defaultBotModel` 为模型引用或 null。`taskExplanationPrompt` 为任务人话解释的自定义话术提示词（字符串，最多 20000 字符）；传 null 或空白恢复默认。`memoryLimits` 以 bot/group/team 映射到每层 1000–200000 个字符。 | `channel.setPrefs` 写 `team_state.prefs_json`，返回完整 prefs。用 `state.prefs` 回读。taskExplanationPrompt 仅影响任务解释，保存后新生成或已打开的人话视图按新 Prompt 重新生成，旧缓存按实际 Prompt 失效；不更改消息、Bot 简介或执行模型。 |
| `models` / `efforts` | `models {}` 刷新目录；`efforts {ref}` 查询某一模型支持的思考强度。 | `catalog/reasoningOf` 返回 `{modelsKey}` 和强度结构（无候选时 `{efforts:[]}`）。模型清单从 `state.models` 获取。 |
| `providers` / `provider-key` | 读取可配置供应商用 `{}`。设置密钥用 `{provider,value}`，`value:null` 清除。 | [providers.js](../../../../ds-bot/src/host/providers.js) 的 `providersView/setProviderKey/clearProviderKey`，使用 DSH settings 和 credentials。返回供应商视图，读取可用状态与是否已配置。 |
| `provider-add` / `provider-remove` | 添加用 `provider,custom?,key?`，自定义供应商还提供 `name,api,baseURL,models`。移除用 `provider`。 | `addProvider/removeProvider` 操作宿主供应商配置及其凭据，返回更新后的供应商视图。 |
| `provider-models` / `provider-models-save` | 发现候选用已有 `provider` 或待配置的 `baseURL,api,key?`。保存用 `provider,models,revision?`，revision 来自读取的配置版本。 | `discoverModels` 返回候选数组。`saveProviderModels` 写宿主模型配置，返回供应商视图，版本冲突时重读。 |
| `local-agents` / `local-agent-refresh` / `local-agent-models` | 前两者 `{}` 列出本地智能体，refresh 重扫；模型查询用 `route`。 | [localAgentsEndpoint](../../../../ds-bot/src/host/local-agents/index.js) 返回 `{available,detected,custom}` 或该路由的模型信息。探测依赖本机可执行文件和实际登录状态。 |
| `local-agent-add` / `local-agent-update` / `local-agent-remove` | 增加自定义智能体用 `name,command,args?`，更新再传 `id`，删除按 `id`。 | 同一服务写 `team_state.local_agents_json` 并更新宿主模型路由。增改返回含 `id,route` 的条目，删除返回剩余自定义条目。 |
| `capability-save` | `{name,kind,description}`。`kind:skill` 提供 `content`；`pack` 的 `items` 为已登记的技能或 MCP 名；`mcp` 用 `transport,command,args,env` 或 `transport,url,headers`。同名同类文本条目使用完整配置更新。 | [capabilitySave](../../../../ds-bot/src/host/capabilities.js) 写 `team_state.capabilities_json`，返回保存条目。操作者配置本地 MCP 命令会涉及执行授权。 |
| `capability-import` | `files` 是文件数组，每项含 `path` 和 base64 `bytes`，空目录可用 `{path,directory:true}`。根 `SKILL.md` 必须含 `name,description`。 | `capabilityEndpoint → importSkillFiles` 完整落盘后发布目录，返回技能名。目录键在能力条目 `folderId`，文件在 `skill-folders` 内。重名或导入失败不会覆盖原条目。[文件导入实现](../../../../ds-bot/src/host/skill-folders.js) |
| `capability-approve` / `capability-delete` | `name` 指定已有能力。批准适用于 stdio MCP，删除适用于能力库条目。 | `capabilityEndpoint/capabilityDelete`，批准返回条目，删除返回 true，并清理相关绑定和目录内容。 |
| `bot-capability` | `botId,name,attached`，attached 必须显式传布尔值。输入为 Bot ID、共享库中的能力名、所需开关状态。 | `capabilityEndpoint → setAttached` 写 `bots.capabilities_json`，返回该 Bot 完整绑定名数组。`state.capabilityStatuses` 提供运行时状态。 |
| `schedules` / `schedule-create` / `schedule-delete` | 查询 `{}`。创建用 `{target,title,prompt,when}`，target 为 Bot 或群 ID。单次用 `{kind:"at",at:"2030-01-01T10:00:00Z"}`。每日用 `kind:"daily",time,timeZone?`，每周用 `kind:"weekly",time,weekdays,timeZone?`（星期取 1–7），间隔用 `kind:"every",minutes`。删除用 `{sessionId,id}`。 | [scheduleEndpoint](../../../../ds-bot/src/host/schedules.js) 调 DSH 调度服务。返回 `{available,tasks}`，id、目标会话和下一次执行时间以实际记录为准。 |

DSH 自身的字体、外观、开发工具、账号、插件和其他宿主设置由注册设置项的模块维护。例如开发工具用 `configForms.developerTools.setEnabled`，读取配置文档用 `remote.settings.openSettingsDocument`。它们使用对应 DSH 版本公开的设置服务，独立于团队偏好表。[设置项组装](../../../../ds-bot/src/client/settings.js) · [宿主设置接入](../../../../ds-bot/src/client/settings-shell.js)

任命或更换任务助理后，服务会安排管理员扫描尚无计划、尚无执行轮次的原卡，说明未交接原因并按条件重试；不重新派发在途工作。扫描与重试契约见 [项目工作与运行接口](runtime-api.md#管理员扫描与重试交接)。
