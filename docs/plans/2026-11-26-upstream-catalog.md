# 上游同步台账、增量更新与PR管理页（设计草案）

- 日期：2026-11-26
- 状态：规则修改与现状复核已完成；本设计待用户确认，SQLite、服务和HTML尚未实现。
- 相关：[PR2028复核](../reviews/2026-11-26-upstream-2028-review.md)、[同步技能](../../.agents/skills/sync-upstream/SKILL.md)。

## 为什么

用户需要先读懂每个PR的作用、比较本地差异，再决定是否要。现有Markdown有265个唯一PR，长篇历史不便筛选；重复全量查Git和GitHub浪费时间，也容易覆盖用户已明确“不需要”的决定。

## 已定的行为

- 当前采用结果仅四种：采用、需讨论、暂缓、跳过。历史落地片段另列版本、行为、验证及未完成路径，不作为第五种状态。
- 每个PR提供问题/触发场景、改了什么、实际用法与例子、本地价值和限制、来源链接；暂缓和需讨论给具体差异、原因、解法与验收条件。
- 同步不动dev，在专用分支进行；实际采用结果、验证与版本继续记录upstream-changelog.md。

## 待确认的具体方案

### 本地SQLite与HTML

独立本地管理页用于上游决策，插件内设置页承接PR2028。管理页不进入聊天和项目卡界面。只用Python标准库提供回环HTTP服务并读写SQLite，HTML经有限JSON接口查询和保存，浏览器不直接执行SQL。

数据库拟放本项目公共Git目录的`upstream-sync/upstream.sqlite3`，本机通常为`DS-Bot/.git/upstream-sync/upstream.sqlite3`。通过`git rev-parse --git-common-dir`定位，所有专用工作树共用同一台账，不随分支丢失标记，也不向dev工作树写文件。不把SQLite二进制及事务日志提交Git；用一致性备份保留数据库，Markdown作为可审阅的提交交付。它与日用DSH团队数据库完全独立。

### 首次导入与增量

1. 首次从当前upstream-changelog.md导入265个来源键、状态、权重、原始依据和历史版本，不因导入新建265条批次。补齐PR正文、合入SHA、路径和设计证据并缓存；既有资料不足则显式标记说明待补，不能编造功能解释。
2. 下次按source记录的完整盘点终点到固定新终点查第一父链，新增或更新对应键，缓存未变的正文和设计；没有新上游变化不重复全量远端检索。
3. 本地基线或未提交改动变化时，依据文件交集只重审受影响PR。缓存了上游内容不代表本地适配判断永远有效。
4. 一次增量对账、说明和来源写入在事务中完成，成功才推进source游标；失败回滚。上游历史不连续时先报告，不无依据跳过缺失区间。
5. SQLite负责结构化当前事实和决策历史，Markdown由台账更新对应来源行并保留旧批次文字。检测到Markdown被其他工作树改动时先对账再导出，不直接覆盖。管理页显示尚未导出的变更数量，点击导出只更新当前专用分支记录，不自动commit、merge或push。

### 页面和标记

主页面用筛选栏加PR表格，点击一行展开右侧详情，窄屏改为上下阅读，不用重复卡片网格。沿用项目系统字体、表格和克制的状态色；主要任务是读解释、比较差异、标记选择。

| 区域 | 内容与行为 |
| --- | --- |
| 筛选栏 | 关键词/PR号、采用结果、我的选择、权重范围、依赖组、修复/功能/维护、需重新评估；可清空筛选。 |
| 主表 | PR号链接、中文功能作用、采用结果、我的选择、权重、依赖组、最近变更时间。默认按状态→权重降序→PR号升序，另可按时间排序。 |
| 详情 | 完整解释与具体例子、上游/本地差异、原因、前置、解决方式、验证、部署版本、历史变更和原PR链接。 |
| 我的选择 | “待评估 / 需要 / 不需要”，保存时间与可选理由，可撤销；写SQLite后重新加载仍在，增量同步不覆盖。 |
| 已采用但不需要 | 保留真实“采用”结果，并显示“不需要，后续不再跟进”；不会自动删除已装代码。尚未采用且不需要的后续建议为跳过，仍保留原判断历史。 |
| 状态反馈 | 加载、无匹配、说明待补、保存中/成功/失败、数据库暂忙、并发编辑冲突都明确显示；保存失败不假装成功。 |

标记例子：将[PR2039](https://github.com/Fei-Craft/DS-Bot/pull/2039)标为“不需要”，以后同步即使再次遇到同一来源也保留选择；这不会删除你本地的并行会话。撤销标记只恢复评估资格，不自动合并。

本地服务仅绑定127.0.0.1，写接口校验同源与允许的动作。接口参数化查询，不开放任意SQL、文件读取或Git目录下载。标记只能改变台账和导出记录，页面没有合并代码、装插件、读取DSH凭证或重启功能。

### PR2028完整适配

保留设置对话框和本地导航入口、提示词/项目设置及原路由；补齐概览配置缺口与状态、修复入口、具体设置项及模型搜索/批量操作、域内锚点和完整外观预览。参考上游能力而不覆盖整个文件；未支持与已排除模块不显示假入口。PR2006额外导览、PR2027浮层改造独立处理。

## 数据模型草案

以下DDL是拟实现契约，尚未执行。所有时间保存含时区的ISO8601，展示用Asia/Taipei；历史不明时间为NULL，不用本次导入时间假充原发生时间。

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
  outcome TEXT NOT NULL CHECK(outcome IN ('running','complete','failed')), -- 运行结果，不是采用状态
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
CREATE INDEX prs_status_weight ON prs(status,weight DESC,number);
CREATE INDEX prs_group ON prs(dependency_group);
```

连接启用外键和busy_timeout，写入使用短事务；重复导入按复合键upsert，不重复事件。用户选择表由用户动作维护，来源刷新不覆盖。schema版本用PRAGMA user_version；首次创建之前备份已有文件，升级失败保持原库。回滚使用一致备份，不用删除日用DSH数据。

## 验证与交付条件

- 一次导入恰好265个唯一PR；重复导入零重复、零用户选择丢失；同一PR迁名仍唯一。
- 受控新增/更新增量只处理差异，失败不推进SHA；本地变更触发相关项重审。
- 标记不需要、刷新、停启服务和第二次同步后仍保留；撤销可用，已采用代码不回滚。
- 筛选可组合、排序正确、所有PR均有链接和能理解的解释；页面/SQLite/Markdown结果一致。
- PR2028按专项复核的每项完整验证，包括无providers/只读/失败、字段跳转、模型动作、草稿保留、键盘/窄屏、偏好保存与清理。
- 固定插件候选由独立测试者只读验收，通过后构建打包、安装web/desktop并核对文件；新版本另记，不复用.28号，不合dev、不重启日用DSH。管理页测试用临时数据库。

## 不做什么

不删本地并行会话和项目卡，不自动合dev或push，不把尚未实现的SQLite/HTML称为已交付；管理页不直接执行代码合并或操作日用DSH。

## 变更

- 2026-11-26：按用户要求确定四状态和逐PR功能解释，提出增量台账与筛选/标记页面；等待实施方案确认。
