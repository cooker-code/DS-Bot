# 上游更新台账

台账位于本项目公共Git目录的`upstream-sync/upstream.sqlite3`。各同步工作树使用同一份数据；它与DSH团队数据库无关，不提交SQLite或事务日志。页面和命令都不会合代码、回滚插件或重启DSH。

## 打开页面

在本批专用工作树根目录执行。首次导入使用已经完整盘点的固定终点；不把新的上游终点冒充已有覆盖范围。

```sh
python3 scripts/upstream-catalog.py bootstrap
python3 scripts/upstream-catalog.py serve --port 4179
```

终端返回本地URL、实际执行分支和数据库位置。浏览器打开`http://127.0.0.1:4179`，停止服务用该终端的Ctrl+C。无需安装第三方Python依赖。主目录仍在dev时，从专用工作树运行这些命令；写命令拒绝dev/main/master及detached HEAD。

主表显示265个历史PR及其中文作用和来源，详情提供具体场景、差异、方案、验证和历史。可组合筛选关键词/PR号、状态、我的选择、权重、依赖组、类型与需重审；默认状态→权重降序→PR号升序，也能按最近变更排序。

“我的选择”保存待评估、需要、不需要以及理由，可以撤销。不需要项不会被下一次来源刷新覆盖或重新推荐；已安装代码仍保留真实采用结果。点击“更新同步记录”只更新当前同步分支的upstream-changelog.md，不自动提交。若文件被其他会话改动，导出拒绝覆盖，先对账后再继续。

## 后续只补增量

```sh
python3 scripts/upstream-catalog.py inspect
python3 scripts/upstream-catalog.py sync --fetch --to upstream/dev
python3 scripts/upstream-catalog.py reassess
```

`sync`的默认行为不联网；`--fetch`明确刷新上游。它只读取上次终点到指定终点的第一父链，缓存PR合入点、正文、改动路径和设计差异。同一SHA直接复用缓存；新区间失败不推进游标，失败批次保留原因。无变化不新增同步批次。上游历史不连续或来源地址不符时停止核对，不用全量重扫掩盖问题。

有新PR时，先补功能说明和本地判断，再推进完整盘点。未解释的条目显示待评估，不能因为已缓存代码而称为采用。按命令返回的`pendingAnalysis`更新对应PR：

```sh
python3 scripts/upstream-catalog.py annotate 2028 docs/reviews/evidence/2026-11-26-upstream-2028-assessment.json
python3 scripts/upstream-catalog.py sync --to upstream/dev
python3 scripts/upstream-catalog.py export
```

评估JSON允许purpose、scenario、effect、category、status、weight、dependency_group、dependencies_json、reason、local_difference、solution、verification。采用必须有本次候选验证证据。状态仅采用、需讨论、暂缓、跳过；重复的相同评估不刷新时间或新增事件。直接提交以完整SHA缓存，命令`review-commit <SHA> <JSON文件>`登记功能/原因/方案/状态及采用证据；导出按SHA去重。

本地基线或未提交文件变化时，`reassess`只标记与缓存改动路径相交的PR，不把上游没有更新等同于本地仍兼容。用户标记不需要的项不进入重审建议。

## 备份与核查

```sh
python3 scripts/upstream-catalog.py backup /tmp/ds-bot-upstream-backup.sqlite3
python3 scripts/upstream-catalog.py --help
```

备份通过SQLite一致性备份接口生成，不直接复制运行中的主文件。`--database`仅用于明确选择独立台账或临时验证库；程序拒绝给已有非台账数据库创建表。`inspect`不访问网络。详情中的原始来源、当前功能解释和历史部署证据分别显示；类型初值来自历史标题，完整评估可修订。
