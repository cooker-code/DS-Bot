# 上游更新台账

本目录集中管理同步上游仓库所需的全部工具和材料。技能入口仍在`.agents/skills/sync-upstream/SKILL.md`，以后新增同步相关文件都放在这里。页面和命令不会自动合代码、回滚插件或重启DSH。

| 内容 | 固定位置（相对仓库根目录） |
| --- | --- |
| 命令与预检 | `scripts/upstream-sync/upstream-catalog.py`、`preflight.py` |
| 网页与HTTP服务 | `scripts/upstream-sync/upstream_catalog/assets/`、`upstream_catalog/web.py` |
| SQLite主库 | **主工作目录**的`scripts/upstream-sync/upstream.sqlite3` |
| 一致性备份 | **主工作目录**的`scripts/upstream-sync/backups/` |
| 去重审计导出 | **本批工作树**的`scripts/upstream-sync/upstream-changelog.md` |
| 评估、设计、任务、验证 | 本目录下`docs/`、`plans/`、`tasks/`、`reviews/`与`references/` |

Git工作树清单的第一项是主工作目录，程序据此定位共享库。换同步分支/工作树仍使用同一份PR资料与用户选择，受Git管理的源码和导出则保留在各自工作树。主目录仍在dev时，仅写精确忽略的共享库和备份，不改dev代码或文档；SQLite与事务日志不提交。它与DSH团队数据库无关。历史回执保留执行当时的路径；当前命令和文档链接已迁移。

## 先读功能，再判断是否采用

页面新增“社区新功能与设计”和“PR采用清单”两个入口。没有指定PR链接时默认看社区功能；原#pr链接继续打开PR清单。社区按功能主题和无设计的单项变更显示用途、场景、变化摘要、上游阶段/证据/限制、本地相关实现PR状态及原因和完整解法，可按关键词、类型、阶段、相关实现PR状态、适用范围和上次有变化批次筛选。

设计原文及该PR设计差异均可本地阅读，并附固定版本GitHub原文与PR链接。设计整理PR另列，不把它的跳过当成本地功能不存在；后续综合设计也不冒充原PR补丁。未知阶段明确待核实，旧说明与新版源内容不匹配时标重审。未携带设计的新功能与修复仍可见。

首次从已缓存来源补齐设计用`community-sync`；它不fetch或改变采用状态。之后普通sync自动处理设计增量，待补设计说明返回pendingDesigns。上游阶段和PR四状态独立，不增加“部分采用”。完整命令及评估字段见[技能说明](references/community-designs.md)。

## 打开页面

在本批专用工作树根目录执行。首次导入使用已经完整盘点的固定终点；不把新的上游终点冒充已有覆盖范围。

```sh
python3 scripts/upstream-sync/upstream-catalog.py bootstrap
python3 scripts/upstream-sync/upstream-catalog.py serve --port 4179
```

终端返回本地URL、实际执行分支和数据库位置。浏览器打开`http://127.0.0.1:4179`，停止服务用该终端的Ctrl+C。无需安装第三方Python依赖。主目录仍在dev时，从专用工作树运行这些命令；写命令拒绝dev/main/master及detached HEAD。

主表新增“PR提交时间”和“同步时间”，均显示为Asia/Taipei。提交时间取GitHub创建PR时间（createdAt），同步时间取来源资料实际写入本台账的时间；仅修改选择或分析不刷新它，代码采用和安装时间另记。缺失显示“待补齐”，不拿合并时间替代。时间缓存在prs.upstream_json的createdAt/sourceSyncedAt字段，查询接口提供pr_created_at/synced_at；无需修改现有SQLite表结构。

主表显示265个历史PR及其中文作用和来源，详情提供具体场景、差异、方案、验证和历史。可组合筛选关键词/PR号、状态、我的选择、权重、依赖组、类型与需重审；默认状态→权重降序→PR号升序，也能按最近变更排序。

筛选框、表格和PR详情的依赖组统一显示“编号 · 中文名称”，例如“G01 · 测试基线、翻译与测试维护”和“G16 · 设置导航、搜索与组件入口”。中文名称直接取自scripts/upstream-sync/docs/upstream-remaining-review.md的分组标题，由/api/meta的groupNames提供；数据库及筛选参数仍使用Gxx。未分组显示“—”，缺少名称的编号明确显示“名称待补齐”。

“依赖组”将同一功能、需要配套适配或验证的PR归到一组，用于安排处理顺序；例如G16为设置导航、搜索与组件入口。同组不表示必须全部合入，具体前置关系看每项PR的原因和完整解决方式。筛选栏与表格表头均有圆圈问号：悬停、点击或键盘聚焦可看说明，Esc或点击外部关闭。

“我的选择”保存待评估、需要、不需要以及理由，可以撤销。不需要项不会被下一次来源刷新覆盖或重新推荐；已安装代码仍保留真实采用结果。点击“更新同步记录”只更新当前同步分支的`scripts/upstream-sync/upstream-changelog.md`，不自动提交。若文件被其他会话改动，导出拒绝覆盖，先对账后再继续。

## 补齐历史时间

```sh
python3 scripts/upstream-sync/upstream-catalog.py metadata
```

需要可用且已登录的GitHub CLI（gh）。按最多50个PR一次读取GitHub官方GraphQL，核对仓库ID、PR号及URL；只补缺失的createdAt，重复运行零远程读取、不刷新时间。失败不补造时间；不改变状态、选择或完整盘点游标。bootstrap首次导入和sync新增来源同样缓存时间。

## 后续只补增量

```sh
python3 scripts/upstream-sync/upstream-catalog.py inspect
python3 scripts/upstream-sync/upstream-catalog.py list --q 设置
python3 scripts/upstream-sync/upstream-catalog.py show 2028
python3 scripts/upstream-sync/upstream-catalog.py sync --fetch --to upstream/dev
python3 scripts/upstream-sync/upstream-catalog.py reassess
```

`sync`的默认行为不联网；`--fetch`明确刷新上游。它只读取上次终点到指定终点的第一父链，缓存PR合入点、正文、改动路径和设计差异。同一SHA直接复用缓存；新区间失败不推进游标，失败批次保留原因。无变化不新增同步批次。上游历史不连续或来源地址不符时停止核对，不用全量重扫掩盖问题。

有新PR时，先补功能说明和本地判断，再推进完整盘点。未解释的条目显示待评估，不能因为已缓存代码而称为采用。按命令返回的`pendingAnalysis`更新对应PR：

```sh
python3 scripts/upstream-sync/upstream-catalog.py annotate 2028 scripts/upstream-sync/reviews/evidence/2026-11-26-upstream-2028-assessment.json
python3 scripts/upstream-sync/upstream-catalog.py sync --to upstream/dev
python3 scripts/upstream-sync/upstream-catalog.py export
```

评估JSON允许purpose、scenario、effect、category、status、weight、dependency_group、dependencies_json、reason、local_difference、solution、verification。采用必须有本次候选验证证据。状态仅采用、需讨论、暂缓、跳过；重复的相同评估不刷新时间或新增事件。直接提交以完整SHA缓存，命令`review-commit <SHA> <JSON文件>`登记功能/原因/方案/状态及采用证据；导出按SHA去重。

本地基线或未提交文件变化时，`reassess`只标记与缓存改动路径相交的PR，不把上游没有更新等同于本地仍兼容。用户标记不需要的项不进入重审建议。

## 备份与核查

```sh
python3 scripts/upstream-sync/upstream-catalog.py backup
python3 scripts/upstream-sync/upstream-catalog.py --help
```

备份通过SQLite一致性备份接口生成，不直接复制运行中的主文件。`--database`仅用于隔离临时验证库，日用库使用上述固定位置；程序拒绝给已有非台账数据库创建表。`inspect`不访问网络。详情中的原始来源、当前功能解释和历史部署证据分别显示；类型初值来自历史标题，完整评估可修订。

## 本地管理接口

| 请求 | 参数和结果含义 |
| --- | --- |
| GET /api/community | q、kind(design/pr)、stage、status(相关实现PR状态)、scope、recent、offset/limit；返回total、rows、designCount、standaloneCount、lastUpdate。阶段与本地状态分开。 |
| GET /api/design/id | 返回用途/场景/阶段依据/限制、本地注意事项、当前固定原文、实现PR与设计更新PR、版本列表；needs_review时effective_stage为待核实。 |
| GET /api/pr/N | 原字段保持，追加designs：包含固定原文、PR对应版本、change_kind及本地缓存全文。related明确为后续/关联设计，不能倒算到原补丁。 |

这些是独立管理工具的只读接口，DSH插件API不变。写选择和导出的原同源接口继续使用。首次升级schema v2应先备份、community-sync，再用本批或后继版本启动管理页；旧v1工具不支持新库。

本次完整结果见[实施回执](reviews/2026-11-26-upstream-community-implementation.md)。
