# 项目任务开始时间固定显示月日时分秒

DS Bot 原卡：363786dc-eb00-44fe-989f-ac3bf2580a72；计划 v3，执行 round 3（恢复 round 2 候选），节点 1。
基线：54f6271478313b25cdd027d94c79313ea6498051。
分支：fix/task-start-time-format。
原图 SHA256：137910d5156f15c985d1cc56ecd4540f7e1c4b5ee29e90548725e2a043b6b759（群 #102；#117 更正格式）。

## 更正后唯一需求

截图红框内 ProjectCard 的开始时间固定显示 MM-dd HH:mm:ss，例如 11-24 09:29:05。
历史格式只保留为需求溯源，不作为实现或测试期望。

## 验收

- 月、日、小时、分钟、秒全部两位补零；01-02 00:00:05 正确。
- 保留 Started {time} 翻译标签、startedAt 原始值及客户端本地时区语义。
- 多时区跨日正确；无有效开始时间不显示开始/耗时。
- projectElapsed、成员 TaskRow、聊天和共享 messageClock 不变；无额外样式或布局重设计。
- 源码和构建 client.js 一并提交；相关测试、构建、生成一致性、静态检查、diff 检查通过。
- 独立测试末节点负责真实隔离 Web、合入 dev、record_merge、同版复验及日用安装；本节点不安装、不重启、不推送。

## 产品上下文

按 impeccable teach 从 docs/vision.md、AGENTS.md 和 docs/design/ui-standard.md 第 0/1/11/12 节提取既有事实到根 PRODUCT.md，每段附来源；不新增 DESIGN.md，不发明品牌或 WCAG 等级。
初次 loader 无上下文且 migrated=false；teach 后完整重载 hasProduct=true。
shape=not_required；image_gate=skipped:无新视觉素材、沿原图和末节点真实Web。
API/权限/存储没有变化；ds-bot-doc 契约无需改动。
