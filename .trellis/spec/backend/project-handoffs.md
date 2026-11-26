# 项目卡受理与可靠交接

## 范围和触发

修改接单、群任务助理任命、未分配卡扫描或交接恢复时遵守本契约。实现见 [project-handoffs.js](../../../ds-bot/src/host/project-handoffs.js) 和 [project-tasks.js](../../../ds-bot/src/host/project-tasks.js)。

## 签名

- `project_task {action:"reply",acceptWork:true,title?,plan?,acceptance?,message,classificationReason?}`：接受工作并先保存原卡；同时提供需求和验收时独立保存两项正文。
- `project_task {action:"scan"}`：本群管理员或管理助理读取 `{roomId,assistantId?,unassigned:[{taskId,title,status,reason,retryable,...}]}`。
- `project_task {action:"retry_handoff",taskId,title?,plan?,acceptance?}`：本群管理员更新未派工原卡并重试交给当前助理。
- 操作者 `project-task-list {roomId}` 也返回 `unassigned`，供只读核查。

## 持久契约

`pendingIntakes` 只包含未分类收件。已受理卡通过原卡的计划、执行和交接状态判断，不能因退出该列表就失去管理入口。标题、需求和验收保存在原任务字段；交接状态在 `tasks.extra_json.managementHandoff`，管理员批次通知在 `rooms.extra_json.projectHandoffScan`。后者不出现在公开 state。

发送前保存固定 exchangeId。相同目标、来源序号和正文指纹复用投递记录；结果不确定时先核对当前及历史会话，已入队或已记入持久消息的不重发。修订正文产生新交接；入队前再次校验角色和当前记录身份，不能让旧正文迟到。`handoff` 是最近记录，`scan/unassigned` 才是当前正文的诊断结果。

宿主在保存、任命变更及重载后通知空闲管理员；多卡共用一条群级批次通知，不将该通知绑定到单张卡。失败按30秒提醒管理员检查，最多三轮；管理员决定并调用正式重试。关闭时取消定时器并等待扫描及投递完成。

## 验证和错误矩阵

| 状况 | 扫描结果和动作 |
| --- | --- |
| 有来源，缺规范正文 | `needs_document`，管理员整理原卡后重试 |
| 正文完整，历史暂不可读 | 允许沿原卡发送完整正文 |
| 正文不全且无来源 | `missing_source`，通知管理员解释，不能凭空补全 |
| 助理绑定失效 | `invalid_assistant`，允许 scan，写入重试返回 `TASK_ASSISTANT_INVALID` |
| 投递失败或回执不确定 | `uncertain`，保留正文、错误及消息身份，核对后安全重试 |
| 已有计划或执行轮次 | 不做首次交接恢复；保留原计划和实际轮次 |
| 越权或跨卡执行 | 拒绝；只允许本群当前管理员的管理会话恢复 |

## 基线与错误案例

先接单、后任命助理：宿主唤醒管理员扫描，管理员对原 taskId 重试，助理保存计划并派工，执行者 start 后原轮出现 startedAt。接单后发送失败：原卡保留规范正文和错误。实际已经送达而保存回执中断：重启后核对会话，不能重复发送。

## 所需测试

`project-handoffs.test.js` 覆盖原因、去重、失败、修订及重启；`group-work.test.js` 覆盖真实运行时的管理员、助理、执行者权限与开工链路，以及发送等待期间角色或正文变更；`client-channel.test.js` 检查公开诊断和内部记录隐藏；`task-interactions.test.js` 检查交接审计正文。`dev/project-handoff-smoke.mjs` 在隔离模拟模型宿主验证只任命助理即可启动原卡，结束后停止本次 bench 并核查进程和端口。

## 错误与正确做法

错误：卡片已从 pendingIntakes 消失，便认为已下发；或者消息返回成功便标记已开工。

正确：扫描已受理原卡，分别验证交接 delivered、助理的 task_plans 和执行者 start 写入的 task_rounds.started_at。隔离验证与日用实际生效分别记录。
