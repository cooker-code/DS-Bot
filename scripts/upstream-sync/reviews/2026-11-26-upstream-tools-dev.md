# 同步管理工具集成dev

记录时间：2026-11-26T15:47:31+08:00。本批从dev@b36afbaf建立`chore/upstream-tools-in-dev`，从6dac17c7提取管理工具、skill、同步材料和引用路径；应用源码未提取。用户本次授权管理工具合入dev，并要求页面不展示分支信息。

1. 页面标题、来源区和存储说明均不显示本地/上游分支或含分支名的执行工作树，保留可点击upstream地址、来源覆盖时间、日期排序与315 PR资料。后端元信息继续用于确认服务身份与写入权限。
2. 工具集成后可从主目录dev运行`python3 scripts/upstream-sync/upstream-catalog.py serve --port 4179`，浏览器访问http://127.0.0.1:4179/；已有服务直接访问。日常页面可保存需要/不需要到共享SQLite，来源同步/评估及Markdown导出仍要求专用工作树。canExport=false时按钮禁用并解释通过同步技能导出，不会从dev改写审计记录。
3. 39项隔离工具测试通过，含从dev实际启动CLI、dev页面可保存偏好但不能导出/同步。真实浏览器验证分支隐藏、仓库链接、三种排序、覆盖信息、2028时间、2296说明、不需要选择和窄屏；JS语法/技能与链接检查通过。脚本和Chrome临时资源已清理。
4. 管理工具集成不包含#2028/#2130等历史应用候选，也不包含本批50个新上游PR的应用代码。历史采用/安装事实保留原候选和版本依据；本次不更新DSH插件包。合入前后对ds-bot目录和包版本核对不变。
5. 主目录7份既有未提交文件已保存逐字原始副本和完整patch至共享backups下的before-dev-tools-integration目录。旧同步skill/规则及265 PR历史由新版集中记录承接；贡献流程文档原改动需保持，不强制纳入本次提交。合入时用Git快进保留dev现有提交，若dev前进先重核，不覆盖他人工作。

独立只读验收候选2c1af42a通过，管理工具已从dev@b36afbaf快进合入。主目录dev实际执行serve启动4179成功，真实浏览器重新核实隐藏分支、展开存储说明、来源链接、原有排序/筛选/315项资料和窄屏；canExport=false。自有4187预览及旧临时工作树服务已停止，应用ds-bot目录和包版本相对b36afbaf完全不变。交付记录时间：2026-11-26T15:53:01+08:00。

[使用说明](../README.md) · [验证记录](evidence/2026-11-26-upstream-tools-dev.json) · [实际页面](evidence/2026-11-26-upstream-tools-dev.png)。

原有未提交内容处理：.github/pull_request_template.md、CONTRIBUTING.md、CONTRIBUTING.zh.md逐字恢复；AGENTS非同步段两处修改（功能验收后另行授权集成、中文提交规范）原文恢复并仍未提交。旧同步skill/verification/265项ledger由新版承接，过时版本不覆盖新315项审计；七文件原始字节与完整patch保留在`<repo>/scripts/upstream-sync/backups/2026-11-26-154644-before-dev-tools-integration`，另保留Git stash `f7ae67868176a1adeba34d1d6727dfbee0dc0923`，未丢弃。用户已有未跟踪文件与工作树不动。
