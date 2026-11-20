# 从一个 task 看开发进度

用户打开 task 可看到需求、验收条件和当前阶段，展开计划节点可查看执行轮次。开发提交结果后进入复核。查看某次执行时还要留意阻塞记录，以及该节点是否已被新版计划替代。

task 详情由 `ds-bot/src/host/project-tasks.js` 的 `projectCardDetail` 汇集来源、计划和轮次。`ds-bot/src/host/project-status.js` 的 `projectStatus` 解释一个轮次，`taskPhase` 计算看板上的 task 阶段。一个 task 可以包含多个节点。判断是否反复失败时，先找到同一节点的历次执行，再核实失败原因和后续结果。

这份导览覆盖 task 详情与状态解释。多个 task 的负荷、积压和交付质量属于后续统计需求。
