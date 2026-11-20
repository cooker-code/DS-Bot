# 集成、权限与记忆接口

每组给出服务入口和实际存储。以下动作均通过同一个已认证的 `POST /api/bot` 发起。运行时询问、第三方同意、系统权限由各自提供者决定。按具体授权执行会连接外部服务、发送信息或扩大权限的操作。

## 连接器和邮件

[connectorEndpoint](../../../../ds-bot/src/host/connectors/index.js) 使用目录库 `team_state.connectors_json` 和实际连接运行时。认证值由密钥服务保存。状态从 `state.connectors` 取。[邮件服务](../../../../ds-bot/src/host/connectors/mail/index.js) 还管理账号、发件规则及待处理请求。

| 操作 | 业务及入参 | 出参与生效判断 |
| --- | --- | --- |
| `connector-add` / `connector-remove` | 新建用 `name` 加 `url,headers?` 或 `command,args?,env?`。删除自定义连接用 `id`。 | 返回连接器视图。操作后按 id 核对存在性及连接状态。 |
| `connector-connect` / `connector-disconnect` / `connector-retry` / `connector-cancel` | 均按连接 `id`。connect 按该连接的认证方式提供 `token`、`key` 或发起登录。其他动作分别断开、重连或取消登录。 | 更新后的连接器视图；发起登录或开始连接后还须查看最终状态。 |
| `connector-sign-in-code` / `connector-client` | 前者传 `id,input` 回交本次登录生成的码或回调。后者以 `id,clientId,clientSecret?` 配置 OAuth 客户端。 | 返回连接器视图。秘密经安全输入送达，不打印出参全集。 |
| `connector-set` | `id,readOnly?,offFor?`。offFor 是禁用该连接的 Bot ID 列表。 | 返回连接器视图，核对保存的范围与能力。 |
| `connector-import-scan` / `connector-import` | 用 `{}` 扫描可导入来源，再用 `items` 传选中的来源与名称。 | 扫描返回候选，导入返回 `{view,created}`。检查实际创建的连接 ID。 |
| `connector-request-cancel` | `requestId` 指定尚未处理的连接申请。 | true，之后按原申请核实已处理。 |
| `mail-account-add` / `mail-account-remove` | 添加用 `address,provider?,password?` 或 `google:true` 发起 Google 登录。自定义服务器传 `imapHost,imapPort,imapTls,smtpHost,smtpPort,smtpTls` 等服务支持的配置。删除用 `id` 或 `address`。 | 返回邮件视图或本次登录状态。已配置账号与认证状态分别核实。 |
| `mail-sign-in-code` / `mail-rule-set` | 登录回交 `address,input`。规则可传 `mode,botId,recipients`（如 allow-recipient、require-approval），或 `addRecipient/removeRecipient/noDraft` 更新指定范围。 | 由邮件服务返回更新结果，用邮件视图回读账号、收件人规则和 Bot 范围。 |
| `mail-send-answer` | `requestId,choice`，可传 `fields` 修改待发送内容、`rule` 更新相应规则。`choice:"send"` 会实际发送。 | 按请求记录核对已取消、已发送或失败，勿将规则保存当作送达。 |

## 即时通信（IM）与团队密钥

[imEndpoint](../../../../ds-bot/src/host/im/index.js) 写 `team_state.im_json`，连接运行时和敏感字段另管。`state.im.platforms` 给出平台及所需字段。团队密钥走 [secretEndpoint](../../../../ds-bot/src/host/secrets.js)，取持久方式及状态用 secret-store。数据库中请求及权限元数据不能代替真实凭据。

| 操作 | 业务及入参 | 出参与回读 |
| --- | --- | --- |
| `im-add` / `im-update` / `im-remove` | 创建传 `platform,botId,fields`。更新用 `id` 加 `botId?,enabled?,fields?`。删除用连接 `id`。 | 增改返回单条连接视图，删除返回 true。`state.im` 核对绑定，`imStatus` 核对运行连接。 |
| `im-pair` / `im-unpair` | `id,senderId` 标识连接及发件人，配对申请用 `allow` 给出决定。 | true。用连接的已配对和待处理列表核实。 |
| `im-chat` / `im-retry` | 聊天映射用 `id,chatKey,target`，null 清除目标，`remove:true` 删映射。重连用 `id`。 | true，路由及实际连接状态分别查看。 |
| `im-login-start` / `im-login-wait` | 对支持扫码的平台传 `platform,botId` 开始，轮询同一 `loginId,botId,platform`。 | 开始返回 `loginId,qr,expiresAt,botId`，等待返回 `status`，成功另有连接 `id`。 |
| `secret-store` / `secret-unlock` / `secret-encrypt` / `secret-decrypt` | 查存储状态用 `{}`。解锁、启用加密或解除加密按服务要求传 `passphrase`。 | 返回存储状态，可检查模式和锁定情况。原始密钥值不在此响应中。 |
| `secret-set` / `secret-update` | 设置值用 `name,value,purpose?,scope?`，回应申请时用 `requestId,value,scope?`。更新用途或授权范围用 `name,purpose?,scope?`。 | 返回该项可展示的元数据。团队申请和密钥库分别保存。 |
| `secret-allow` / `secret-cancel` / `secret-delete` | 授予已有申请或取消用 `requestId`，删除已有密钥用 `name`。 | 授权返回条目元数据；取消、删除核对申请或条目的最终状态。 |

## 浏览器、电脑与记忆

浏览器长期授权走团队表中的 `update-bot`，`browserGrants` 为授权数组，条目字段见 [cleanBrowserGrants](../../../../ds-bot/src/host/roster.js)。传 null 清除。下面的电脑操作由 [computerEndpoint](../../../../ds-bot/src/host/computer/index.js) 实现，整体和 Bot 各自的配置在 `team_state.computer_json` 和 `bots.computer_json`；租约、光标、截图及待答请求属于运行状态。这里记录如何配置项目已有的电脑能力，普通设置直接调用 API。

| 操作 | 业务及入参 | 出参与回读 |
| --- | --- | --- |
| `computer-set-enabled` / `computer-provider-retry` | `enabled` 为团队开关，重试提供者用 `{}`。 | 返回电脑设置视图，查 `state.computer` 和 `computerLive`。 |
| `computer-set-level` / `computer-revoke-app` | 按 `botId,level` 调整等级，按 `botId,appKey` 撤销应用许可。 | 返回该操作的电脑配置结果，在同一 Bot 的授权范围回读。 |
| `computer-system-status` / `computer-permission` / `computer-open-settings` | 查询用 `{}`。申请或打开系统面板传 `permission`，支持 accessibility、screenRecording。 | 查询返回 OS 能力状态或 null，申请返回宿主结果，打开面板返回 true。OS 最终授予结果须重新查。 |
| `computer-stop` / `computer-takeover` / `computer-handback` / `computer-allow-foreground` | 操作 `botId` 的当前控制权。stop 可显式传 `all:true`。 | 回读 `computerLive` 核实控制方、租约和前台状态。 |
| `computer-app-answer` / `computer-hold-answer` | 应用申请用 `id,answer`，暂停请求用 `botId,callId?,outcome`（done/skip/takeover）。 | 返回该请求的处理结果，已失效的请求需核对新状态。 |
| `computer-cursor-wait` / `computer-user-active` / `computer-shot` | 等待游标用序号 `after`，报告用户活动用 `idleSeconds`，取已登记截图用 `attachmentId`。 | 分别返回 `{now,events}`、确认、`{dataUrl}` 或 null。 |

[记忆服务](../../../../ds-bot/src/host/memory.js) 以 `botId` 或 `roomId` 选择记忆面板。`scope,topic,text` 定位具体条目。正文、历史和整理记录由记忆存储维护。[学习提案服务](../../../../ds-bot/src/host/learning.js) 会更新提案并可能登记和绑定技能。

| 操作 | 业务及入参 | 出参与回读 |
| --- | --- | --- |
| `memory-view` / `memory-ask` | 读取面板用目标 ID，询问或要求调整传目标 ID 和 `text`。 | 查看返回面板各作用域及条目，ask 返回回答与变更。ask 能实际修改记忆。 |
| `memory-pin` / `memory-layer` / `memory-move` / `memory-forget` | 在目标面板定位条目。pin 传 `pin` 布尔值，layer 传 `topic,text,always`，移动传 `scope,topic,text,to`，遗忘传 `scope,topic,text`。 | 依据服务结果回读原作用域和目标作用域，检查钉选、层级、移动或删除。 |
| `memory-tidy-undo` / `memory-history` / `memory-restore` | 撤销整理用目标 ID、`scope,batch`；查历史可传游标 `before`；恢复传目标和历史行 `id`。 | 返回整理、分页历史或恢复结果，用面板回读。 |
| `learning-answer` | `id,approve` 表示提案及用户决定。 | `learningEndpoint → answer` 处理提案，回读 `state.learning,learningSettled` 及相关技能绑定。 |
