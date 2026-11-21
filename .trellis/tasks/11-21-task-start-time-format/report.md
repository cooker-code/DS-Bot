# 开发候选自测报告

原卡 363786dc-eb00-44fe-989f-ac3bf2580a72，计划 v3 / 节点 1 / round 3（恢复 round 2 候选）。
实际工作树与分支核对通过，基线 54f6271478313b25cdd027d94c79313ea6498051；本轮 project_task start 返回 active/version=3/execution.round=3。
恢复时精确 10 个文件，无新增无法识别改动、暂存区为空；源码、测试和构建产物未变，复用下列 round 2 的实际测试与构建结果。本轮重查生成产物一致性与 git diff --check 均通过；全部工作树版本盘点仍为本候选 local.26、其他最高 local.25（含 dev），包清单和锁文件版本一致。只更新本任务轮次记录后按管理员确认的单批范围提交。

## 影响范围

仅 task-board.js 的 ProjectCard 开始时间调用改用本文件私有 projectStartLabel，本地 Date getter 加两位补零。Started 标签、startedAt、projectElapsed、成员 TaskRow 的 clockLabel、共享 text.js 的 messageClock 和聊天均不变。没有 API、存储或样式变化。client.js 由构建生成。

PRODUCT.md 完全取自已有仓库资料并附链接。初次 loader hasProduct=false/hasDesign=false/migrated=false；teach 后完整 JSON hasProduct=true/productPath=PRODUCT.md。未新增 DESIGN.md，遵循现有 UI 标准。
IMPECCABLE_PREFLIGHT: context=pass product=pass command_reference=pass shape=not_required image_gate=skipped:无新视觉素材、沿原图和末节点真实Web mutation=open

## 实际命令与结果

在 ds-bot 目录（除注明外）：

- `node --test test/project-start-time.test.js`：5/5 通过；覆盖 11-24 09:29:05、01-02 00:00:05、UTC/Asia-Taipei/America-Los_Angeles 跨年跨日、无有效开始、耗时/成员时间回归。
- `npm ci --no-audit --no-fund`：工作树起初无 esbuild，安装 69 个包成功。
- `npm run build`：通过。
- `node scripts/build-client.mjs --check`：通过。
- `npm test -- test/project-start-time.test.js test/client-bundle.test.js test/tasks.test.js`：24/24 通过。任务测试夹具输出 workspaceRegistry.list 缺失等诊断，但没有失败。
- `DSH_HARNESS=/Users/blank/wangliang/gitcode/DS-Bot/ds-bot/dev/harness npm run lint`：退出 0；既有非本次修改文件警告，本次源码/新增测试没有警告。默认 lint 首次因当前树无 oxlint 退出 2，随后复用主树既有 harness 依赖成功。
- `git diff --check`：通过。
- package.json、锁文件顶层及 packages[""] 版本程序化比较一致。

初次新增测试错误假设成员 TaskRow 使用 messageClock，1 项失败；核对实际源码后将回归断言改为既有 clockLabel(task.startedAt)，之后全部通过，未改成员逻辑。

## 版本准备与交接

只读盘点全部 Git 工作树 package 版本及主树 local-changelog，已使用最大版本 0.3.8.25；当前没有其他活跃开发/测试写入者。按最大 +1 准备 0.3.8.26（npm 0.3.8-local.26），同步清单、锁和发布记录。
本节点未安装、未运行日用实例测试、未重启、未推送或创建 PR。独立测试节点核对最新版本占用后，负责真实隔离 Web 下的布局/开始标签/秒精度、候选合入 dev 与 record_merge、同版合并后检查、实际安装及运行实例是否加载的分别报告。
