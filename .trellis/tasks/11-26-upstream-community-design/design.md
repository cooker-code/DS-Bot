# 技术设计

## 决策路径

社区入口按“功能变化→用途和场景→上游阶段→本地相关PR及原因→原文/代码来源”组织；PR入口保留原表格和选择。两个入口使用同一SQLite事实。社区条目分设计主题与无设计的单项功能/修复，均提供可理解说明。默认进入社区页；已有#pr链接仍进入PR页。筛选条件相互保留。

功能主题不是所有关联PR的统一交付承诺。本地显示各实现PR的四状态与理由，文档对齐PR另列；不把文档跳过等同于本地功能不存在。上游阶段允许已实现、进行中、设计/计划、已废除、待核实，附依据。无法证明时保留待核实。

## 数据流与存储

Git固定SHA/现有PR缓存→prepare读取变化的plan文件和blob→一个SQLite事务保存版本/关联/评估和来源游标→只读API→两个网页入口。新增designs、design_versions、pr_designs三表，DDL及字段字典见下文；旧六表数据保持，schema v1→v2有一致备份、事务迁移与副本验证，不升级无关库。

设计主题以内部整数ID和(repo_id,path)唯一定位，重命名保持ID；版本以(design_id,blob_sha)去重，保存固定源SHA和全文。PR关系区分design_change与implementation，记录该PR源SHA、路径、增删改名类型。designs保存中文用途/场景/限制/上游阶段证据/本地注意事项及reviewed_blob_sha；源版本变化保留旧说明并标needs_review，不能当成新版本已评估。

首次只补当前已登记来源所涉及43个plan路径，README为索引；保留排除模块作为社区信息并标范围。人工说明种子绑定固定blob，只在匹配版本生效。初次历史补齐与本批新变化分开。普通sync先准备源内容，再在原事务写设计和PR，待补说明列入pendingDesigns，完整对账后才推进来源游标；重复不写时间/版本。直接提交和新增无plan PR仍可见。

## API与边界

GET /api/community按关键词、条目类型、上游阶段、本地相关PR状态/范围和最近变化筛选，返回说明和当前关联PR摘要；GET /api/community/<id>返回全文、来源、版本与关系。GET /api/pr/N追加designs，但不改PR判断和选择字段。保留固定允许路径、同源写保护、参数化查询；源码文本用textContent，不执行Markdown中的HTML。CLI补community-sync、design-annotate与查询；写命令仍拒绝dev/main/master。

## 验证和回滚

在v1一致副本验证迁移、旧行与偏好不变、失败回滚、版本去重、重命名/删除/索引、源说明失效与游标。真实浏览器验证两个入口、搜索/筛选、原文/PR链接和窄屏，独立测试者只读。正式切换前备份并只停止本聊天自己的管理服务；新版服务验证后保留运行。回滚停管理服务并用一致备份恢复台账，dev和DSH无需操作。

## 数据模型

设计主键id，来源路径唯一；版本复合主键去重，PR关联同时引用来源PR和设计。

### DDL

```sql
-- designs：按功能设计主题保存中文判断资料与当前来源版本
CREATE TABLE designs (
 id INTEGER PRIMARY KEY, -- 稳定主题ID，改名保持
 repo_id INTEGER NOT NULL REFERENCES sources(repo_id), -- 来源仓库
 path TEXT NOT NULL, -- 当前设计路径
 title TEXT NOT NULL, -- 中文功能名称
 kind TEXT NOT NULL DEFAULT 'design', -- design或index
 document_state TEXT NOT NULL DEFAULT 'active', -- active或deleted
 blob_sha TEXT NOT NULL, -- 当前设计内容对象
 source_sha TEXT NOT NULL, -- 固定来源提交
 changed_at TEXT NOT NULL, -- 上游变更时间
 synced_at TEXT NOT NULL, -- 实际入库时间
 purpose TEXT, -- 功能用途与价值
 scenario TEXT, -- 具体使用场景
 limitations TEXT, -- 前置及限制
 upstream_stage TEXT NOT NULL DEFAULT '待核实', -- 上游实现阶段，独立于本地状态
 stage_evidence TEXT, -- 阶段判断依据
 local_notes TEXT, -- 本地适配注意事项
 scope TEXT NOT NULL DEFAULT 'plugin', -- plugin或excluded或mixed
 reviewed_blob_sha TEXT, -- 解释所核对的源内容
 needs_review INTEGER NOT NULL DEFAULT 1, -- 新版解释待补或待重审
 UNIQUE(repo_id,path)
);
-- design_versions：按内容去重的固定版本全文
CREATE TABLE design_versions (
 design_id INTEGER NOT NULL REFERENCES designs(id), -- 设计主题
 blob_sha TEXT NOT NULL, -- 内容版本
 source_sha TEXT NOT NULL, -- 可定位该全文的来源提交
 path TEXT NOT NULL, -- 该版本路径
 body TEXT NOT NULL, -- 不执行的原始Markdown全文
 captured_at TEXT NOT NULL, -- 首次缓存时间
 PRIMARY KEY(design_id,blob_sha)
);
-- pr_designs：设计变化与具体实现PR分开关联
CREATE TABLE pr_designs (
 repo_id INTEGER NOT NULL, -- 来源仓库
 pr_number INTEGER NOT NULL, -- PR号
 design_id INTEGER NOT NULL REFERENCES designs(id), -- 主题
 role TEXT NOT NULL, -- design_change或implementation
 change_kind TEXT NOT NULL, -- A/M/D/R或related
 path TEXT NOT NULL, -- 该PR中的路径
 previous_path TEXT, -- 重命名前路径
 source_sha TEXT NOT NULL, -- PR合入SHA
 blob_sha TEXT NOT NULL, -- PR设计全文版本
 PRIMARY KEY(repo_id,pr_number,design_id,role),
 FOREIGN KEY(repo_id,pr_number) REFERENCES prs(repo_id,number)
);
CREATE INDEX pr_designs_by_design ON pr_designs(design_id);
```

### 表与字段说明

| 表 | 字段 | 类型 | 业务含义与约束说明 |
| --- | --- | --- | --- |
| designs | id | INTEGER | 稳定主题ID，改名保持 |
| designs | repo_id | INTEGER | 来源仓库 |
| designs | path | TEXT | 当前设计路径 |
| designs | title | TEXT | 中文功能名称 |
| designs | kind | TEXT | design或index |
| designs | document_state | TEXT | active或deleted |
| designs | blob_sha | TEXT | 当前设计内容对象 |
| designs | source_sha | TEXT | 固定来源提交 |
| designs | changed_at | TEXT | 上游变更时间 |
| designs | synced_at | TEXT | 实际入库时间 |
| designs | purpose | TEXT | 功能用途与价值 |
| designs | scenario | TEXT | 具体使用场景 |
| designs | limitations | TEXT | 前置及限制 |
| designs | upstream_stage | TEXT | 上游实现阶段，独立于本地状态 |
| designs | stage_evidence | TEXT | 阶段判断依据 |
| designs | local_notes | TEXT | 本地适配注意事项 |
| designs | scope | TEXT | plugin或excluded或mixed |
| designs | reviewed_blob_sha | TEXT | 解释所核对的源内容 |
| designs | needs_review | INTEGER | 新版解释待补或待重审 |
| design_versions | design_id | INTEGER | 设计主题 |
| design_versions | blob_sha | TEXT | 内容版本 |
| design_versions | source_sha | TEXT | 可定位该全文的来源提交 |
| design_versions | path | TEXT | 该版本路径 |
| design_versions | body | TEXT | 不执行的原始Markdown全文 |
| design_versions | captured_at | TEXT | 首次缓存时间 |
| pr_designs | repo_id | INTEGER | 来源仓库 |
| pr_designs | pr_number | INTEGER | PR号 |
| pr_designs | design_id | INTEGER | 主题 |
| pr_designs | role | TEXT | design_change或implementation |
| pr_designs | change_kind | TEXT | A/M/D/R或related |
| pr_designs | path | TEXT | 该PR中的路径 |
| pr_designs | previous_path | TEXT | 重命名前路径 |
| pr_designs | source_sha | TEXT | PR合入SHA |
| pr_designs | blob_sha | TEXT | PR设计全文版本 |
