# 已确认设计

用户选择：按需解释，点「人话」时生成，保留结果供下次查看。

组件传 roomId/taskId/messageKey → task-explanation → taskInteractions 核对同卡完整原文 → botShot 单次调用 → 原子保存派生 JSON → 界面显示。原消息和任务 SQLite 不修改。

仅任务往来的输入输出启用人话，计划和重试原因保留原展示。使用稳定消息 key，按原有明确关联保留并行输出归属。缓存按房间、卡和消息/语言定位，以原文、说话人上下文和规则版本核对有效性。同源并发共享 Promise，失败与空答不保存，只读仅复用有效缓存。

表达默认值在共享 Prompt 定义中，自定义写法保存到团队偏好；不复制或运行时读取用户级 AGENTS.md。


## 可编辑 Prompt

话术默认值和 20000 字符上限在 shared/task-explanation-prompt.js，由设置页和宿主共享。固定职责边界保留在宿主，历史材料通过 JSON 单独传入。set-prefs 在修改状态前验证自定义提示词；保存到既有 prefs_json，不改表结构。缓存 hash 包含实际有效 Prompt，前端 explanationVersion 使正在显示的旧解释失效。

模型选择沿用发送方 Bot 的基础模型，当前不采用群成员覆盖；本次仅将其规则明确展示，不增加独立模型选择器。
