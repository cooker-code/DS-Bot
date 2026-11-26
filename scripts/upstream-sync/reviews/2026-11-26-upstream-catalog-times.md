# 上游台账时间列与技能入口回执

记录时间：2026-11-26 13:33 +0800（Asia/Taipei）。本次在`chore/upstream-catalog-times`独立工作树，基线951b169e，固定工具候选3370e63c。主目录dev仍只读，不合回；未移植新上游PR、未推进bb1b1592终点。来源仍Fei-Craft/DS-Bot（原Fei2411/DS-Bot，同仓库ID1409013846）。

## 用户可见行为

1. 技能明确PR来源、评估、验证、用户选择和时间写入公共Git目录的SQLite；upstream-changelog.md为去重审计导出。每次执行后，包括无新增/只盘点/补记/重审，都要求先检查服务分支和库，再主动打开网页。主目录dev内原路径仍旧版；本批新版路径为`.worktree/chore%2Fupstream-catalog-times/.agents/skills/sync-upstream/SKILL.md`，未为更新入口写入dev。
2. 网页表格及详情增加“PR提交时间”和“同步时间”，显示Asia/Taipei。GitHub创建PR时间与合入时间分开；例如[PR2028](https://github.com/Fei-Craft/DS-Bot/pull/2028)创建于2026-11-22T04:08:23Z，表格实际显示2026-11-22 12:08:23。同步时间指最近来源资料入库，与采用/安装不同；历史首次记录日期仍保留。本次首次补时间资料，因此历史PR的同步列显示本次补齐时间。
3. 首次读取265项官方GitHub GraphQL时间，按50项批量核对仓库ID、PR号和URL，缓存在SQLite；重复命令返回githubPRsRead=0/updatedPRs=[]。新增sync来源会缓存时间，修改选择/分析不刷新。网络失败不补造时间；未知时间显示“待补齐”。不改变现有状态或用户选择。

## 文件与数据

- 页面：scripts/upstream_catalog/assets/index.html、app.js、style.css；本地HTTP：scripts/upstream_catalog/web.py；CLI：scripts/upstream-catalog.py。
- 库：主目录.git/upstream-sync/upstream.sqlite3，通过git-common-dir定位。时间放在prs.upstream_json的createdAt/sourceSyncedAt，接口统一提供pr_created_at/synced_at，未新增表或改动DSH库。
- 写入前一致性备份：.git/upstream-sync/backups/2026-11-26-before-catalog-times.sqlite3。
- 管理服务切换到本批工作树后继续使用[127.0.0.1:4179](http://127.0.0.1:4179)；仅停止本次自己维护的旧服务，不中断日用DSH或其他会话。

## 验证

- 台账22/22，ResourceWarning按错误处理；含创建时间/同步时间持久化、选择和分析不改同步时间、API失败不改既有行/游标、GraphQL分批/仓库校验，以及首次bootstrap失败保持空库、成功同批写时间和完整游标。
- 独立复核最初发现首次bootstrap先提交游标再查询时间的问题；已改为先取齐元数据，再在同一SQLite事务保存来源/时间/游标，并新增回归用例。最终候选3370e63c独立只读复核通过，独立测试者22/22，确认之前的失败窗口已消除；测试者未写正式DB或停止服务。
- 真实浏览器核查8列表头、PR2028台北时间、详情一致、50项分页、390px无整页横溢、缺失时间说明和pageerror；只读正式选择，不在真实库点保存。
- 官方数据265项补齐，重复0查询；SQLite完整性ok。技能quick_validate、JS语法、diff检查通过。未改包内插件，复用上批.29安装证据，不重复应用全量或DSH冒烟。
- 主目录dev原提交7b9a4fa8与tracked diff保持；原旧服务进程67899和预览77676已退出，4181释放；正式4179由本批工作树PID80764提供，API实读已核对。测试脚本/浏览器退出，临时Chrome目录清空删除。

[页面截图](evidence/2026-11-26-upstream-catalog-times.png)、[结构化验证与清理](evidence/2026-11-26-upstream-catalog-times.json)。本次为工具功能实现及自动/独立核查，不替代用户最终验收。
