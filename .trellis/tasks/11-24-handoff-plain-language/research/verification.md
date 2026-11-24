# 验证记录

- 首轮相关测试 170/170 通过，覆盖 memory、client-channel 和任务往来组件。
- 独立审查发现并修复：多输出解释未齐时不能合并复制；搜索态不标记 Markdown 为选中；工作树使用真实 node_modules 重新构建，避免依赖路径污染生成文件。
- 修复后的任务/API/组件专项 39/39 通过；额外补了生成期间丢失团队写锁时不保存的用例。
- 182 个宿主 API 均恰好记录一次；生成文件一致性与 git diff --check 通过。
- oxlint 通过，警告均来自已有代码，本次文件无新增警告。
- 隔离 humantext 台架 57 步冒烟全部通过。DSH 源码缺编译产物，改用官方 CLI 启动，不修改 DSH。
- UI、固定候选的独立验收及资源清理继续在本记录追加实际结果。


## 固定候选的独立只读回执

- 候选：944ebabc38e6a0aacae92c43806b432a969b5fa9。
- 独立测试者 plain_language_review：通过，未发现仍需修改的正确性、安全性、回归或兼容性问题。
- O1：输入、单输出和并行输出保留稳定消息归属；人话/Markdown 切换、分别复制、未齐时禁止合并复制通过。实际页面 inputOriginalPreserved=true、outputOriginalPreserved=true。
- O2：按需、同源并发去重和重启缓存专项通过；实际页面 generatedOnClick=true、cachedOnRepeat=true、cachedOnReopen=true，输出仅发起一次解释请求。
- O3：表达规则和普通模型/本地 CLI 路由实现已核实，不把派工夸大为开工、不把部分验证夸大为整体验收；模拟模型不能证明真实措辞效果，实际话术由用户验收。
- O4：失败重试、空答不保存、不完整源拒绝、同卡边界、只读读取与生成期间丢失写锁不保存均通过。
- 独立复跑 39/39 专项，生成一致性、接口覆盖 182、lint、git show --check 通过；只读回执基于同一固定候选。
- 正常应用、官方 CLI 隔离宿主和仓库模拟模型验证了 UI 链路。本地截图位于该功能工作树 gitignored 的 .playwright-mcp/humantext/plain-language.png，执行记录为 /tmp/ds-bot-plain-language-ui.log；均不作为真实模型话术质量证据。
- Playwright 脚本退出 0，核实 Chrome PID 已退出、1 个本次临时 profile 已删除；捕获的两个台架进程均已退出，3196/8896 无监听。独立测试者再次核对端口与进程清理通过。
- 已验证代码合入 dev 后仅追加版本、发布与本回执记录，运行构建一致性并按本地版本打包；日用安装和远端发布不在本次交付范围。


## dev 本地包

- 四段版本：0.3.10.23；npm 版本：0.3.10-local.23。
- 在 dev 重新构建并通过生成文件一致性检查；npm pack 成功，产物为 ds-bot/ds-bot-0.3.10-local.23.tgz（1,630,979 字节）。
- 已核对 tarball 内 package.json 版本，client.js、task-explanations.js 和 channel.js 与当前源码逐字节一致。
- 交付源码与本地包，日用 profile 未安装本版，运行窗口尚未加载；不以本地打包表示日用已更新。
