# 设置接口与项目进度读取

岗位说明在仓库中维护，DS Bot 的 Bot ID 标识实际成员。管理脚本将选中的岗位说明传给现有的 `create-bot` 或 `update-bot`，共享技能另行登记，用 `bot-capability` 绑定。只补技能时，脚本保留成员自己的说明。各群成员、管理员、模型覆盖和授权继续由原有服务管理。

操作者通过宿主签发的同一来源会话调用插件。Desktop 自行转发已认证请求，Web 可从本次启动时的登录公告建立脚本会话。宿主写锁的所有者办理在线设置。SQLite 可按稳定 ID 定点只读，修复演练使用停机一致副本。

新增的 `project-task-list` 只返回一个群的集合。它和全队视图复用 `roomTaskSummaries` 计算 task 摘要，使用 `pendingIntakes` 计算待处理收件。按群查询和明细复用原有存储，无需迁移。[分层接口契约](../../../../../.agents/skills/ds-bot-doc/references/runtime-api.md)
