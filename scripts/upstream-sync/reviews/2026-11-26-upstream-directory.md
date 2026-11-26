# 上游同步目录迁移回执

记录时间：2026-11-26，Asia/Taipei。本批分支`chore/upstream-sync-directory`，工作树位于项目主目录`.worktree/chore%2Fupstream-sync-directory/`，基线`a2b1873dce3a2d136c842022cd0f7c1ac8c569ac`。固定候选`1f10d12b253a9032b19f7d37ac6cfba26d1a6490`已由独立测试者只读复核。本地dev保持`7b9a4fa8fa7ba9ee3236e6c516ac5679b4ee141d`；其原有已跟踪差异与执行前逐字一致，未合回或推送。

1. **目录和后续约定已统一。** 85个既有文件迁入`scripts/upstream-sync/`，包括入口、预检、Python模块、网页、测试、参考资料、同步记录、PR评估、两份本地同步设计、历史报告/证据与6个已完成同步任务。`AGENTS.md`与[技能入口](../../../.agents/skills/sync-upstream/SKILL.md)规定今后相关管理材料也归该目录。技能发现入口、项目通用规则/发布日志和实际插件代码沿用平台及模块位置；旧分支原有文件不因本次迁移被改写。

2. **SQLite及全部备份已迁到指定目录。** 主库为`/Users/blank/wangliang/gitcode/DS-Bot/scripts/upstream-sync/upstream.sqlite3`，备份为同目录`backups/`。3份历史一致性备份全部迁移，另保留`2026-11-26-144654-before-directory-move.sqlite3`。停止了本会话旧管理服务，通过SQLite备份接口和逐表比较迁移，随后恢复服务；确认旧目录无进程占用、目标完整后退役`.git/upstream-sync/`。未复制运行中的裸主文件或遗漏WAL内容。

3. **台账事实与用户判断保留。** schema仍为v2：265 PR、3条用户选择、42设计主题与1目录索引、113设计版本、192 PR设计关联。采用95、需讨论5、暂缓108、跳过57；“不需要”仍2项。除#2130相对证据链接及ledger_file/ledger_digest外，PR字段及其修订、源时间、采用状态、权重、选择、来源游标均保留；其余7张表逐表一致。迁移后的完整性检查为ok，导出待处理0。未fetch或增加上游PR，终点仍`bb1b1592472084c32278c12287944ee40b8087c5`。

4. **换工作树与导出位置已验证。** 数据库通过Git工作树清单定位项目主目录，多个工作树共享同一库；审计导出只写执行工作树的`scripts/upstream-sync/upstream-changelog.md`。CLI默认仓库从入口脚本位置解析，任意启动目录可用；backup默认在共享库旁`backups/`生成带Asia/Taipei时间的文件。日用数据按精确规则忽略，未改变主目录dev的代码或文档。隔离测试可显式指定临时库，结束后清理。

5. **网页和原有功能已核实。** [管理页](http://127.0.0.1:4179/?view=community)来自本批分支、读取新主库；真实HTTP确认JS/CSS、社区和PR接口正常，零变更导出无重复。浏览器通过社区主题筛选/设计详情、PR筛选/详情、历史“不需要”选择和新存储路径显示，页面无脚本错误。[实际页面](evidence/2026-11-26-upstream-directory.png)。

6. **验证范围和资源清理。** `python3 -m unittest discover -s scripts/upstream-sync/tests -v`通过34项，含原32项与新增跨工作树共享偏好、迁移后CLI导出及默认备份路径。JS语法、skill结构及Git改动格式检查通过。相对链接检查覆盖迁移文件与调用方；另一个既有任务原有两张prototype图片缺失不属于本次迁移，保持原状。浏览器脚本、旧管理服务与本次Chrome进程均已核实退出，临时Chrome目录无残留；交付管理服务4179按要求保留。未改DSH插件API、源码或包内容，沿用`0.3.10-local.29-upstream`，无需重装，日用DSH未被停止或重启。

独立只读复核：**通过**。测试者独立运行34/34项，通过从`/tmp`启动CLI、跨工作树共享库/偏好、导出位置与默认备份等验证；正式主库只读integrity及foreign_key_check均正常，4份备份完整性均正常，旧数据目录已退役。独立比较dev的HEAD与执行前tracked diff均一致，测试临时fixture/进程已退出清理；未写正式库或停止交付服务与DSH。复核记录时间：2026-11-26T14:53:49+08:00。

[结构化证据](evidence/2026-11-26-upstream-directory.json)保留逐表数量、API元信息、浏览器结论及清理记录；[目录与命令](../README.md)提供日后入口。历史回执中的分支、绝对目录和执行命令继续表示当时事实，当前可点击相对链接已调整。
