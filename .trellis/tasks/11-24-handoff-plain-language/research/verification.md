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
- 已验证代码合入 dev 后仅追加版本、发布与本回执记录，运行构建一致性并按本地版本打包。首轮交付只生成安装包；日用安装随后按用户明确的打包完成标准补齐，见下方记录。


## dev 本地包

- 四段版本：0.3.10.23；npm 版本：0.3.10-local.23。
- 在 dev 重新构建并通过生成文件一致性检查；npm pack 成功，产物为 ds-bot/ds-bot-0.3.10-local.23.tgz（1,630,979 字节）。
- 已核对 tarball 内 package.json 版本，client.js、task-explanations.js 和 channel.js 与当前源码逐字节一致。
- 首轮交付提供源码与本地包，日用 profile 当时未安装本版；后续日用安装见下方记录。

## 2026-11-24 日用发布补齐

- 用户明确：「打包」包括将新版安装到日用 DSH 实际使用的 profile，达到用户重启即可加载的状态；已写入项目 AGENTS.md，并替换旧的日用安装另行安排表述。
- 确认日用 desktop 为本地包安装，原版本为 0.3.10-local.22。复用已经验证的 ds-bot-0.3.10-local.23.tgz，通过官方 dsh plugin 命令更新到 0.3.10-local.23，不另起版本号。
- 已核对 desktop profile 引用本次安装包，已安装版本正确；包内 169 个文件与安装目录逐字节一致，client.js 也与交付源码一致。
- 本次仅修改项目规则与交付记录，复用原功能候选的测试结果；git diff --check 通过。
- 状态：新版已安装，待用户从 Dock 重启 DSH 后加载。本次没有主动退出或重启 DSH，也未把安装成功表述为运行实例已加载。


## 2026-11-24 Prompt 配置与表达规则补充

用户批注指出旧例子只把 dispatch 换成“已分配”，仍然难懂，并要求将 Prompt 提供为可编辑配置、说明所用 Bot/模型。默认话术已增加具体工作名称、责任人、未确认信息及其实际影响的解释规则与示例；不以“第几步”“业务口径”等词替代解释。

- 新增设置 → 提示词 → 任务人话解释，沿用 Markdown 编辑控件和 set-prefs，支持保存、自定义、恢复默认及只读查看。
- 新偏好 taskExplanationPrompt 存在既有团队 prefs_json；Prompt 的实际内容参与缓存 hash，正在显示的人话也按新配置失效。
- 发送方、接收方、管理员的选 Bot 分支已补直接断言；UI 与文档说明基础模型及普通模型回退，不读取群成员模型覆盖。
- 首轮 63 项中 61 项通过，2 项设置壳用例因工作树缺 harness 公共包失败；补齐测试依赖目录后设置页/设置壳 26/26 通过。
- 扩展专项 72 项中 70 项通过，两个旧提示框夹具未传 roster，发现新增读取需保留既有可选参数契约；修正为 roster?.prefs 后这两项复跑 2/2 通过。
- 接口覆盖 182、生成文件一致性与 diff --check 通过；lint 通过，保留仓库既有警告。
- 实际设置页、Prompt 保存和缓存/宿主重启核查、固定候选独立回执与清理结果在后续追加。


## Prompt 配置固定候选验收

- 候选 b1aade1351f462dbb1324a6eec624b61dada4a33，独立测试者 plain_language_review 只读验收通过，未发现剩余可操作缺陷。
- 72/72 主测试与独立 69/69 专项通过；接口覆盖 182、lint、生成一致性和 diff 检查通过。本次构建差异中的变量编号变化来自新增模块，office.js 无变化。
- 独立审查补齐两点：自定义内容明确作为表达偏好，固定历史解读职责在末尾；模型说明明确基础模型、忽略群成员覆盖及本地 CLI 分支。提示词仍为软约束，不称其为硬权限隔离。
- 真实 UI 验证：editSavePassed、refreshPreservedPrompt、resetPassed、promptInvalidatesCache、activeViewRegenerated、modelRuleVisible 均为 true。
- 重启隔离宿主后：promptPersistedAcrossHostRestart、explanationCacheReusedAfterRestart、settingsReadBackAfterRestart 均为 true。
- UI 与重启脚本退出 0，核实各自 Chrome PID 退出及 1 个本次临时 profile 删除；最终 2 个台架进程已退出，3197/8897 端口释放。
- 最小截图位于功能工作树 gitignored 的 .playwright-mcp/humanprompt/settings-final.png；执行记录 /tmp/ds-bot-prompt-settings-ui.log 与 /tmp/ds-bot-prompt-settings-restart.log。使用正常应用、官方 CLI 隔离宿主与模拟模型，证明设置和调用链路，实际话术质量仍由用户验收。


## 0.3.10.24 交付包

- 四段版本 0.3.10.24，npm 版本 0.3.10-local.24；安装包 ds-bot/ds-bot-0.3.10-local.24.tgz，1,634,228 字节。
- 已核对包内版本、client.js、channel.js、task-explanations.js 和共享 Prompt 与当前源码一致。
- dev 合入固定候选后只追加发布与验收记录、包版本，重新构建并检查生成文件一致。

- 日用 desktop 已通过官方 dsh plugin 命令安装 0.3.10-local.24，复用本次交付包；包内 170 个文件与安装目录逐字节一致，包含客户端、宿主和共享 Prompt。
- 未退出或重启用户 DSH。当前 Desktop 业务 API 缺少有效登录会话（401），本轮未核实运行实例已加载新版；安装结果达到用户从 Dock 重启即可加载的状态。
