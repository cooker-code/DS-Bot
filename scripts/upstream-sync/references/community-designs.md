# 社区功能与设计：帮助决定是否加入本地

先回答：上游改了什么，谁在什么场景用得上，本地已有逻辑会受什么影响，采用还需要补什么。按功能解释，不把文件列表、PR数量或文档合入当成结论。

## 页面与事实

- “社区新功能与设计”包含设计主题和没有设计文件的单项功能/修复。主题显示用途、使用例子、变化摘要、上游阶段及依据、限制、本地注意事项、相关实现PR的四状态与原因/解法。
- 上游阶段与本地采用分开：已实现、进行中、设计/计划、已废除、待核实都必须有依据。仅设计说明合入时注明功能阶段未核实。旧说明遇到新blob先标重审，不能沿用旧阶段作为新版本结论。
- 同一PR可同时改变实现和设计，页面分别关联；纯文档对齐PR的“跳过”不等于功能没有在本地实现。本地状态和“不需要”从既有PR台账读取，主题不新增“部分采用”。
- 固定SHA原文、PR对应版本和当前设计分别链接。后续综合设计明确标记，例如2028本PR无plan变更，不能把后续settings-console全篇归为2028原补丁。
- 全文/原始差异只作可核查来源，先提供中文解释；未知资料和无设计变更明确显示。旧文档索引不是新功能；历史首次补齐不能称为本次新增功能。

## 增量流程

在已登记的专用工作树中执行。先inspect读取schema和来源，schema v1升级前用backup生成一致备份；backup以只读连接读取原库，不触发升级。

```sh
python3 scripts/upstream-sync/upstream-catalog.py inspect
python3 scripts/upstream-sync/upstream-catalog.py backup
python3 scripts/upstream-sync/upstream-catalog.py community-sync
python3 scripts/upstream-sync/upstream-catalog.py community --q 能力包 --kind design
```

community-sync从已缓存PR和固定来源Git补齐正文、版本和关系，不fetch、不改变采用状态或盘点终点。首次升级增加designs/design_versions/pr_designs三表，schema v2保留原六表与偏好。相同来源的重复执行不全量重读设计或刷新条目时间。升级后使用当前工作树或后继版本的新脚本；旧schema v1工具不能读取v2，回滚须先停止管理服务并从一致备份恢复。

之后普通sync自动处理新增、修改、重命名、删除、目录索引和直接提交的设计变化。新/变更设计返回pendingDesigns，补完整评估后才能推进完整盘点游标；失败时来源、PR和设计同事务回滚。

```sh
python3 scripts/upstream-sync/upstream-catalog.py sync --fetch --to upstream/dev
python3 scripts/upstream-sync/upstream-catalog.py design 18
```

这里的18是查询返回的设计id示例，应使用本次community查询实际返回的id。design-annotate接收该id和本次评估JSON文件。新版必须包含下列全部字段，不能只改标题就清重审；无需联网或操作DSH。

| 字段 | 应填写的内容 |
| --- | --- |
| title | 用户能读懂的中文功能名称 |
| purpose | 上游新增/改变什么，带来什么作用 |
| scenario | 具体使用方式、前提和预期结果 |
| limitations | 使用条件、平台和权限限制 |
| upstream_stage | 已实现 / 进行中 / 设计/计划 / 已废除 / 待核实 |
| stage_evidence | 固定来源、已核对实现或仍缺什么证据；不得仅用“已合入”证明完整实现 |
| local_notes | 本地差异、采用考虑；具体PR的状态和解法继续由PR台账维护 |
| scope | plugin / excluded / mixed，依据用户范围和实际用途判断 |

源文件和解释由blob关联，正文版本去重；改名保持主题ID，删除保留最后版本。旧版本解释可追溯。新功能没有设计文件时也从PRS缓存展示，不要求编造设计文件。PR及用户选择只有原来的唯一键。

## 完成检查

用一个有设计的功能、一个无设计的PR、一个上游已实现但本地暂缓的场景，检查用户能否作采用判断。核对来源链接/版本、本地原因与SQLite一致，待补说明和失败不能伪装成功。验证增量和选择保留；网页更新后主动打开`?view=community`，记录本批实际变化、固定终点和未核实项。
