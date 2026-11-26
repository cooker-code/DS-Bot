# 执行计划清单与项目逐题补充：验收回执

2026-11-26，功能分支 `feat/task-plan-questions`，基线 `ec64d5e07b3c13c8857a29b9242e71146384b9e2`。本回执区分实现、独立验证与用户验收；用户验收等待实际使用反馈。

## 编号结果

1. **O1：执行计划清单与版本承接，通过。** 独立测试者在实际隔离 DSH Web 任务详情看到 v1/v2，v2 清单显示已完成 1/4，首项 verified，保留原核验。展开才显示执行要求和产物，完整元数据与比较收在详情。稳定工作项重排、未变在途轮次、变更验收要求、固定负责人和历史约束有针对性回归。[清单与下一题](evidence/task-questions-after-option.png)。
2. **O2：输入框逐题答复与原卡续接，通过。** 独立界面测试先选 All teacher and user chats，自动进入日期题，填写 2026-01-01；刷新后原卡保留两题及送达记录。[答复历史](evidence/task-questions-history.png)。最终宿主重启加载冻结代码后，独立执行 `node ds-bot/dev/project-question-smoke.mjs task-question-final 3198 answer`，回报 passed、planVersion=2、carriedCompletion=true、questions=2、continuedOnOriginalCard=true。脚本等待两题 deliveredAt 及同一原卡 v2 轮次 startedAt，因此 Coder 确认正式开工。普通补充不自动关闭问题；同答复幂等、不同答案竞争、旧问题迁移、重启送达和管理员换卡期间不丢回执均通过。独立界面样本 task=f7accbb8-f32c-4cdf-97c0-4c2774ade754，最终宿主样本 task=42ef2d33-1790-4e3b-874e-4d1e4b4057c3，两次均为隔离模拟任务。
3. **O3：来源 IM 问题/简单表单与答复归属，通过。** 适配上游 PR #2014，并保留本地 project_task 的提交、认可、独立核验和并行会话。模拟 IM 连接器覆盖按钮/数字、重启来源恢复、错误连接/聊天/绑定、过期按钮、项目原提出人、显式 /answer 自由文本、连续问题及原卡续接；公共 state/detail 不暴露来源路由或内部投递回执。独立最终回归 96/96 通过。

## 界面与自动检查

- 独立浏览器验收发现的群索引读取错误和空 focusTarget 异常已修复并复测，组件回归覆盖加载前/非群会话和规范 roomsById 索引。
- 390×844 窄屏下消息输入区域无横向溢出。[窄屏](evidence/task-questions-narrow.png)。
- 相关测试首次、修复后定向重跑的去重结果：404 个不同用例均通过。包含项目轮次/恢复/验收、计划、问题、IM、通道隐私、拆库持久化、结果和交接。独立测试者另跑三份相关文件 96/96 通过。
- npm run build、生成文件一致性检查通过；lint 无错误，保留仓库既有警告；接口覆盖检查确认 191 个操作者入口各记录一次。
- 通用宿主 smoke：55 通过、2 失败。未修改的同一 dev 基线、相同配置也为 55 通过、相同 2 失败：大 view 当前段回读缺卡、compact 阶段提前换段。本次未修改这两项长上下文行为，不将该通用 smoke 表述为全通过。新功能的最终模拟模型流程与独立界面验收均通过。

## 资源与边界

- 隔离服务 task-plan-questions、task-question-ui、task-question-final、task-question-baseline 均已停止；3197/8897、3198/8898、3199/8899 无监听。最后一组 web/mock PID 12193/12049 已退出，未残留本次 Node 验证脚本进程。
- 独立 Playwright 验证使用嵌套 finally 关闭上下文和浏览器，专属 Chrome profile 与临时目录已清理，未操作用户浏览器。
- 本次全部模型与 IM 验证使用项目模拟模型/模拟连接器；没有向真实外部 IM 群发消息，没有查询或修改日用 DSH 数据。
- 代码保留功能分支；没有合 dev、推送、PR、版本发布或日用安装。Desktop/Web 继续使用本机授权操作者；未新增多用户账号和任意指定答复人系统。
