# 技术设计

产品行为、数据模型DDL及各字段备注、约束、迁移回滚、服务/页面边界统一维护在[设计草案](../../../docs/plans/2026-11-26-upstream-catalog.md)，避免两份模型不一致。

插件应用基线chore/upstream-2130-complete@5c364e05，dev@7b9a4fa8只读。SQLite拟放公共Git目录，专用分支脚本统一访问；来源缓存、当前分析、用户选择和事件分表。仅回环HTTP有限API，不接DSH团队库，不允许任意SQL或自动代码合并。Markdown为审计导出。

本任务七项规划画像均为true，复杂等级complex。独立页面和PR2028接口/导航实现尚未批准，当前仅规则与研究文档写入。
