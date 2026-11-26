# 技术设计

产品行为与契约以[已定设计](../../plans/2026-11-26-upstream-catalog.md)为准。SQLite使用公共Git目录，来源、分析、用户选择、事件、批次和内部元数据六表；回环有限HTTP不接DSH团队库，不允许任意SQL或自动合并。下面字段与当前契约一致。

基线21556159，实际分支chore/upstream-2028-catalog，dev7b9a4fa8只读。插件e25f6caf与工具118245cf均独立复核通过，.29已装web/desktop；最终用户验收及日用加载另行判断。

## DDL

```sql
CREATE TABLE sources (
  repo_id INTEGER PRIMARY KEY, -- 稳定GitHub仓库ID，迁名不变
  canonical_url TEXT NOT NULL, -- 当前来源地址
  branch TEXT NOT NULL, -- 来源分支
  checkpoint_sha TEXT, -- 最近完整对账的终点
  scanned_at TEXT -- 对账完成时间
);
CREATE TABLE prs (
  repo_id INTEGER NOT NULL REFERENCES sources(repo_id), -- 来源
  number INTEGER NOT NULL, -- PR号
  url TEXT NOT NULL, -- 原PR链接
  title TEXT NOT NULL, -- 原标题
  purpose TEXT, -- 中文问题与功能说明
  scenario TEXT, -- 触发条件和具体用法例子
  effect TEXT, -- 修复前后/功能效果与限制
  category TEXT, -- fix/feature/maintenance，未核实为NULL
  status TEXT NOT NULL CHECK(status IN ('采用','需讨论','暂缓','跳过')), -- 当前真实采用结果
  weight INTEGER NOT NULL CHECK(weight BETWEEN 1 AND 10), -- 本地优先级
  dependency_group TEXT, -- 当前依赖组
  dependencies_json TEXT NOT NULL DEFAULT '[]', -- 前置PR键
  merge_sha TEXT, -- 固定合入点
  upstream_json TEXT, -- 缓存正文、文件路径和设计证据
  local_sha TEXT, -- 本地分析基线
  reason TEXT, -- 原因类型和事实
  local_difference TEXT, -- 双方差异及影响
  solution TEXT, -- 完整修法与通过条件
  verification TEXT, -- 实际验证证据及缺口
  legacy_deployed_json TEXT NOT NULL DEFAULT '[]', -- 历史片段版本/范围/证据
  first_seen_at TEXT, -- 首次记录时间
  analyzed_at TEXT, -- 最近实质评估时间
  updated_at TEXT NOT NULL, -- 当前记录变更时间
  revision INTEGER NOT NULL DEFAULT 1, -- 并发编辑版本
  needs_review INTEGER NOT NULL DEFAULT 0, -- 本地变化后需重审
  PRIMARY KEY(repo_id,number)
);
CREATE TABLE preferences (
  repo_id INTEGER NOT NULL, -- 来源
  pr_number INTEGER NOT NULL, -- PR号
  wanted INTEGER CHECK(wanted IN (0,1)), -- NULL待评估，0不需要，1需要
  reason TEXT, -- 用户选择理由
  decided_at TEXT NOT NULL, -- 保存时间
  revision INTEGER NOT NULL DEFAULT 1, -- 防止两个页面互相覆盖
  PRIMARY KEY(repo_id,pr_number),
  FOREIGN KEY(repo_id,pr_number) REFERENCES prs(repo_id,number)
);
CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY, -- 批次ID
  repo_id INTEGER NOT NULL REFERENCES sources(repo_id), -- 来源
  from_sha TEXT, -- 盘点起点
  to_sha TEXT NOT NULL, -- 固定终点
  local_branch TEXT NOT NULL, -- 独立同步分支
  local_sha TEXT NOT NULL, -- 本地比较基线
  started_at TEXT NOT NULL, -- 开始时间
  completed_at TEXT, -- 完成时间
  outcome TEXT NOT NULL CHECK(outcome IN ('running','complete','failed','needs_analysis')), -- 运行结果，不是采用状态
  error TEXT -- 失败原因
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY, -- 顺序事件ID
  repo_id INTEGER NOT NULL, -- 来源
  pr_number INTEGER NOT NULL, -- PR号
  kind TEXT NOT NULL, -- analysis/preference/import等变更类别
  before_json TEXT, -- 变更前数据
  after_json TEXT NOT NULL, -- 变更后数据
  actor TEXT NOT NULL, -- 用户或同步执行者
  recorded_at TEXT NOT NULL, -- 发生/记录时间
  run_id INTEGER REFERENCES sync_runs(id), -- 可选关联批次
  FOREIGN KEY(repo_id,pr_number) REFERENCES prs(repo_id,number)
);
CREATE TABLE metadata (
  key TEXT PRIMARY KEY, -- 台账元数据名称
  value TEXT NOT NULL -- JSON值：Markdown摘要、导出事件游标和按SHA缓存的直接提交
);
CREATE INDEX prs_status_weight ON prs(status,weight DESC,number);
CREATE INDEX prs_group ON prs(dependency_group);
```

## 字段字典

| 表 | 字段 | 类型 | 含义/约束 |
| --- | --- | --- | --- |
| sources | repo_id | INTEGER | 稳定GitHub仓库ID，迁名不变 |
| sources | canonical_url | TEXT | 当前来源地址 |
| sources | branch | TEXT | 来源分支 |
| sources | checkpoint_sha | TEXT | 最近完整对账的终点 |
| sources | scanned_at | TEXT | 对账完成时间 |
| prs | repo_id | INTEGER | 来源 |
| prs | number | INTEGER | PR号 |
| prs | url | TEXT | 原PR链接 |
| prs | title | TEXT | 原标题 |
| prs | purpose | TEXT | 中文问题与功能说明 |
| prs | scenario | TEXT | 触发条件和具体用法例子 |
| prs | effect | TEXT | 修复前后/功能效果与限制 |
| prs | category | TEXT | fix/feature/maintenance，未核实为NULL |
| prs | status | TEXT | 当前真实采用结果 |
| prs | weight | INTEGER | 本地优先级 |
| prs | dependency_group | TEXT | 当前依赖组 |
| prs | dependencies_json | TEXT | 前置PR键 |
| prs | merge_sha | TEXT | 固定合入点 |
| prs | upstream_json | TEXT | 缓存正文、文件路径和设计证据 |
| prs | local_sha | TEXT | 本地分析基线 |
| prs | reason | TEXT | 原因类型和事实 |
| prs | local_difference | TEXT | 双方差异及影响 |
| prs | solution | TEXT | 完整修法与通过条件 |
| prs | verification | TEXT | 实际验证证据及缺口 |
| prs | legacy_deployed_json | TEXT | 历史片段版本/范围/证据 |
| prs | first_seen_at | TEXT | 首次记录时间 |
| prs | analyzed_at | TEXT | 最近实质评估时间 |
| prs | updated_at | TEXT | 当前记录变更时间 |
| prs | revision | INTEGER | 并发编辑版本 |
| prs | needs_review | INTEGER | 本地变化后需重审 |
| preferences | repo_id | INTEGER | 来源 |
| preferences | pr_number | INTEGER | PR号 |
| preferences | wanted | INTEGER | NULL待评估，0不需要，1需要 |
| preferences | reason | TEXT | 用户选择理由 |
| preferences | decided_at | TEXT | 保存时间 |
| preferences | revision | INTEGER | 防止两个页面互相覆盖 |
| sync_runs | id | INTEGER | 批次ID |
| sync_runs | repo_id | INTEGER | 来源 |
| sync_runs | from_sha | TEXT | 盘点起点 |
| sync_runs | to_sha | TEXT | 固定终点 |
| sync_runs | local_branch | TEXT | 独立同步分支 |
| sync_runs | local_sha | TEXT | 本地比较基线 |
| sync_runs | started_at | TEXT | 开始时间 |
| sync_runs | completed_at | TEXT | 完成时间 |
| sync_runs | outcome | TEXT | 运行结果，不是采用状态 |
| sync_runs | error | TEXT | 失败原因 |
| events | id | INTEGER | 顺序事件ID |
| events | repo_id | INTEGER | 来源 |
| events | pr_number | INTEGER | PR号 |
| events | kind | TEXT | analysis/preference/import等变更类别 |
| events | before_json | TEXT | 变更前数据 |
| events | after_json | TEXT | 变更后数据 |
| events | actor | TEXT | 用户或同步执行者 |
| events | recorded_at | TEXT | 发生/记录时间 |
| events | run_id | INTEGER | 可选关联批次 |
| metadata | key | TEXT | 台账元数据名称 |
| metadata | value | TEXT | JSON值：Markdown摘要、导出事件游标和按SHA缓存的直接提交 |
