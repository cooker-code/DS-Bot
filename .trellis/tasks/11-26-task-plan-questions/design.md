# 实现设计

计划使用原卡 extra_json 的 planItemLinks 和 planCarriedRounds 保存跨版本身份及在途引用，原 task_plans/task_round_plans 不改写。完成依据仍为轮次 acceptedAt/artifact，依赖按已认可 round 对照。固定负责人和独立核验约束随身份保留。

questions 保存于 tasks.extra_json，题目持有稳定工作项身份；answer 内保存正文、操作者、时间、送达状态和固定消息 ID 的逐 Bot 回执。普通补充不回答问题。群收件来源保存于 rooms.extra_json.projectIntakeOrigins，公开投影剔除来源；IM 卡镜像到现有 questions 通道，回答进入原卡接口后通知管理员及任务助理。

使用现有 SQLite JSON 扩展字段，DDL 无变化，不做表迁移；旧卡 clarification 首次答复转为结构化问题。回退代码前须保留未完成答复的记录，不删除持久数据。现有 Desktop/Web 认证仍是本机操作者权限；IM 以已配对来源提出人校验，不增加账号系统。
