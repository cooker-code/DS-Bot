# AGENTS.md

这份指南供在本仓库工作的 AI 编程智能体使用。本地验证按下文选择检查范围。向项目提交贡献的完整流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目概览

DS Bot 仅以 DeepSeek Harness（DSH）插件提供。团队功能和界面位于 `ds-bot/`，可由 DSH Desktop 或 DSH Web 加载。

Bot 团队的工作方式如下。

- 每个 Bot 都有持久身份，通过 DSH 会话（Session）工作。它的私聊和它加入的每个群聊各有独立会话。某个会话的上下文用满后，会新建会话接续，旧会话仍可查阅。每一轮交互都使用 DSH 的标准智能体循环、工具和模型路由。
- Bot 可以互发消息、参与同一群聊，也可以查看其他 Bot 正在做什么。每个 Bot 独立运行，互不干扰。
- Bot 分工明确。主 Bot（Main Bot）拥有最高权限，可以创建、修改和移除其他 Bot。只有主 Bot 拥有这些权限，一个团队可以有多个主 Bot。
- 用户可以自定义每个 Bot 的名称、角色标签、指令、模型和角色形象。
- Bot 的行为必须可靠。它应根据证据行动，在既定目标范围内工作，并确保结果可核查。

## 硬性规则

1. **基于 DSH 开发，严禁给 DSH 打补丁。** Bot 功能必须使用文档公开的插件接口（API）。禁止修改 DeepSeek Harness，也禁止依赖 DSH 安装目录中的内部文件。如果 DSH 缺少所需能力，应停止并说明缺口，禁止用补丁绕过。
2. **严禁泄露敏感信息。** 禁止写入、打印或提交 API 密钥、令牌、Cookie 或 `DSH_HOME` 的内容。测试使用模拟模型（`ds-bot/dev/mock-llm.mjs`），无需密钥。
3. **DS Bot 自身的界面只使用原创素材。** 禁止从其他产品或网站复制代码、文字、图标、标志或图形。唯一例外是许可证与 Apache 2.0 兼容的代码，使用时必须注明来源，并将其声明加入 `NOTICE` 文件。在界面中标识 DS Bot 对接的第三方产品时（例如 Bot 所用的智能体命令行工具），应使用该产品的官方标志，并在 `NOTICE` 中列明来源和权利人。
4. **`client.js` 由构建生成。** 修改 `ds-bot/src/client/` 下的源文件后，运行 `npm run build`，将源文件和生成文件一并提交。禁止手动编辑 `client.js`。
5. **禁止改动用户自己的 DSH 数据。** 测试环境将数据保存在 `.dsh-test-<name>/` 中。禁止将测试指向 `~/.dsh` 或用户正在运行的 DSH 实例。

## 设置、API 和 SQLite

- 每次改动前先看项目技能 [ds-bot-doc](.agents/skills/ds-bot-doc/SKILL.md)，判断是否影响业务操作、API、鉴权、运行时副作用或数据存储。能够通过已授权 API、命令行或 SQLite 完成的设置、查询和核查，直接走程序化入口。Computer Use 仅用于交付目标确实包含界面行为的场景。
- 设置优先调用持有团队写锁的宿主 API。SQLite 适合按需只读核查和已授权的离线维护。先识别目标实例、库和 `state.lock`，保留 SQLite 事务日志及所有权。测试继续使用隔离实例。
- 用户从 Dock 正常打开 Desktop。脚本调用先用 `python3 .agents/skills/ds-bot-doc/scripts/request.py state --desktop --jq '{readOnly,revision}'`。每次根据本机团队写锁定位当前用户的 Desktop 后端，核对父进程与回环监听，用匿名只读请求识别 API，再用官方登录公告或操作者提供的同源有效会话认证。后续操作也带 `--desktop`。缺少本次登录材料或有效会话时，只读核查走 SQLite；写操作报告具体认证缺口。保留用户的 Dock 启动习惯，不为获取凭据重启、切换宿主、操作界面或读取浏览器私有存储。详见[认证与命令](.agents/skills/ds-bot-doc/references/operator.md)。
- 新增、修改或移除 API 时，同一改动更新技能中的业务入口、请求与返回字段含义、服务函数、存储位置、副作用和回读示例。仓库 CI 运行技能中的接口名覆盖检查；字段或行为变化还要逐项核对服务与例子。现有 API 无法表达某项设置时，先核对鉴权、宿主版本和锁，确认业务入口缺失后，在插件服务和通道补齐，复用原有权限与校验，并用隔离实例验证。

### 修改 Bot 简介和群公告

修改和核查这两项设置一律不用 Computer Use。先确定目标团队、Bot ID 或群 ID，以及本次应保存的完整正文。用户照常从 Dock 打开 Desktop。

1. **有有效会话时走 API。** 确认当前 Desktop 持有团队写锁后，用 `update-bot` 按 Bot ID 写 `instructions`，或用 `update-room` 按群 ID 写 `notice`。写入后通过 `state` 按同一 ID 取回对应字段全文，与预期正文逐字比较。
2. **没有有效会话时等用户退出 Desktop。** 用户退出后，确认 Desktop 已结束、团队写锁已释放且没有其他写入宿主，再按 [SQLite 离线维护流程](.agents/skills/ds-bot-doc/references/storage.md) 备份并在一致副本上修改。Bot 简介按 `bot_id` 定位；群公告先按 `room_catalog` 查群库，再按 `room_id` 定位。事务仅更新目标对象，检查命中行数、修订号和数据库完整性后应用改动。
3. **离线修改后等用户从 Dock 重新打开 Desktop。** 核对当前团队，按原 Bot ID 或群 ID 回读简介或公告全文。有有效会话就读 API，否则用只读 SQLite 查询日用团队库。全文与预期逐字一致才报告已保存；有差异时说明差异。

## 开发命令

以下是 `ds-bot/` 目录下的常用命令，按需选用。单元测试和静态检查工具从 `dev/harness/` 加载 `@deepseek-ai/*` 软件包。`npm run harness` 会按 `dev/harness/package.json` 指定的 DSH 版本从 npm 安装这些包。也可以通过 `DSH_HARNESS` 指定其他 DSH 安装目录或 DeepSeek Harness 源码检出目录。运行测试环境需要一份源码，版本以 README 为准，默认路径为 `../deepseek-harness`，也可通过 `DSH_HARNESS` 指定。

```sh
npm ci                                 # 安装插件依赖
npm run harness                        # 安装单元测试和静态检查所需的 DSH 软件包，只需运行一次
npm run build                          # 从 src/client 生成 client.js
npm test -- test/group-search.test.js  # 只跑列出的测试文件
node scripts/build-client.mjs --check  # 检查 client.js 是否与 src/client 一致
npm run lint                           # 使用 oxlint 进行静态检查
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3096 8796 reset && node dev/smoke.mjs smoke 3096   # 冒烟测试
dev/bench.sh smoke 3096 8796 stop
```

### 功能任务验收

所有功能任务在功能分支固定候选，由独立测试者只读验证。测试者在原卡登记当前检查、已通过项及既有证据。验收通过并完成清理后，测试者提交只读回执。测试方法与样本数量由实际风险决定，用户未指定的方法不能列为用户要求。功能分支开发完成并通过测试后，将已验证的提交合并到 `dev`。在 `dev` 上按「本地二次开发发版」更新版本号和发布记录，构建并核对生成文件，运行 `npm pack`。用户要求「打包」时，核对包内版本后继续完成下文规定的日用安装与核对；交付回执给出四段版本号、npm 包版本、安装包路径、已更新的 profile 及加载状态，管理者认可后结单。对外发布另行安排。Trellis 用于需求与证据记录，已授权的功能分支提交由开发者自行分组。

功能任务的用户可见验收结果按以下规则交付：

1. 派工时从原卡提取需要证明的用户可见行为。一个独立结果占一个编号，同一行为的不同样本、测试命令、环境与清理记录归入该项证据。编号数量随需求决定。
2. 测试者在原卡用一句话写清每项的实际观察和结论。例如“项目卡显示‘开始 11-24 09:29:05’，与约定格式一致”。需要 UI 证据时，截取能读清目标值及必要标签的最小区域。一张局部图能证明就交这一张；仅当另一状态或布局关系影响判断时补图。通过项直接引用已有证据；失败项给出预期、实际和最短复现步骤，未验证项说明缺口。
3. 原卡回执是默认交付物。明确需要 Markdown 报告时，正文沿用相同的编号结论和必要证据链接；诊断日志、命令和环境细节留在执行记录。管理者按原卡条件认可或退回，所需结论与清理均已核实即可结单。与需求有关的真实回归须处理，自选的额外样本或报告形式不能成为结单门槛。

### 打包与日用发布的完成标准

- 本项目中，用户要求「打包」，完成条件是新版已构建、验证并安装到日用 DSH 实际使用的 profile，用户从 Dock 重启 DSH 后即可加载。打包请求包含完成这次日用安装与核对，不再将其留作另行安排。
- 仅生成 `.tgz`、把安装包留在仓库或其他目录，不算打包完成。先核对日用安装方式和目标 profile；包安装更新该 profile 的已安装插件，链接安装核对实际指向和构建产物，不得以其他路径中的文件代替日用安装结果。
- 安装后核对已安装版本、客户端构建产物及本次变更涉及的宿主文件，与交付包或获准源码一致后，才能报告「新版已安装，重启 DSH 后生效」。沿用已经打好的同版本包补装时不另起版本号。
- 交付时区分「已安装，待用户重启加载」和「已在运行实例中加载」。保留用户从 Dock 启动的习惯，不擅自退出或重启 DSH，不中断正在进行的会话。

### 更新本机 DSH 插件

按上述打包要求或单独安排本机部署时，先完成构建和针对性验证，再将获准部署的版本同步到本机已安装 DS Bot 的日用 DSH profile。先核对安装方式：链接安装核对实际指向和构建产物；本地包安装用当前源码运行 `npm pack`，通过 `dsh plugin --profile <name> add <本地包路径>` 更新。已有同版本交付包时直接复用，不重复打包。部署本地测试版本时按下节发版，并核对实际安装内容。交付时分别说明哪些 profile 已更新、是否已在运行实例中加载；需要重启才能生效时说明，避免中断正在进行的会话。运行测试仍使用隔离的测试 profile。仅改文档或仓库技能时无需重装。

#### Desktop 本地包安装报 ERR_PNPM_NO_MATCHING_VERSION

2026-11-20 更新 DS Bot 时，`npm pack` 已成功，失败发生在 `dsh plugin --profile desktop add`。安装本地包也会解析该 profile 的其他插件依赖。Desktop 固定使用 `@lsfcy/dsh-composer-predictions@0.1.3`，当时安装日志指向的 `registry.npmmirror.com` 缺少该版本，而 npm 官方源已有该版本。

遇到同一报错，先看日志中缺少的包、精确版本和实际访问的源，对照 npm 官方源的版本清单。确认是镜像缺版本后，复用已打好的包，将官方源作为本次 pnpm 调用的显式参数。本机实测仅设置 `npm_config_registry` 后，DSH 仍使用原镜像。

在 `ds-bot/` 下执行以下命令，`pkg` 为本次 `npm pack` 生成的 tarball 绝对路径：

```sh
dsh plugin --profile desktop --config.registry=https://registry.npmjs.org/ add "$pkg" &&
  cmp client.js "$HOME/.dsh/profiles/desktop/node_modules/ds-bot/client.js"
```

此参数只对本次命令生效。同版本重装后，用上面的 `cmp` 核对已安装的客户端产物；运行中的窗口是否加载新版另行确认。

### 本地二次开发发版

- 从 `dev` 打包交付新版本或以链接方式部署新版本时，按下述规则分配一次版本号。后续安装同一个已打好的包沿用该版本号。单独运行构建、单元测试或隔离冒烟测试不触发发版。
- 前三段沿用上游版本，第四段是本地发布序号，从 1 开始。以当前上游 `0.3.8` 为例，首版为 `0.3.8.1`。后续每次取该上游版本已使用的最大序号加 1，`0.3.8.9` 的下一版为 `0.3.8.10`，序号无上限。npm 包要求兼容语义化版本，包清单和锁文件中的本包版本使用对应的 `0.3.8-local.1`，发布记录和拉取请求使用四段版本号。
- 每次发版在根目录 [local-changelog.md](local-changelog.md) 顶部新增一条记录，写明四段版本号、发布日期和相对上一版的实际变更。版本号、发布记录和对应代码一并进入该版本的拉取请求（PR）。
- 本地二开发版先将任务分支合入 `dev`，在 `dev` 上验证并交付验收。验收通过后，发布 PR 以二开仓库的主分支 `origin/main` 为目标。

### 本地验证

- **只改文档或翻译**时，核对改动涉及的内容、链接和命令即可，跳过应用构建、代码静态检查和单元测试。若改写了可执行示例，验证该示例。
- **改代码**时，从变更的行为和受影响的调用方选择测试。例如，只改群聊搜索时，可在 `ds-bot/` 下运行 `npm test -- test/group-search.test.js`。改动涉及多个模块时，补跑这些模块的相关用例。修改客户端源码时按上文重新构建并检查生成文件。修改 `index.js` 或 `src/host/` 时，还须运行冒烟测试，使用空闲端口，并在结束后停止自己启动的测试环境和进程。
- **影响范围无法可靠界定**（例如更改公共测试加载器），或任务明确要求全量回归时，先核对本工作区最新规则和正在运行的测试，确认需要全量后由一个会话执行 `npm run test:all`。其他会话复用结果。修复失败后，先重跑失败项及修复影响的用例。

交付时说明实际验证的范围。提交拉取请求后，持续集成（CI）会自动运行全量单元测试、生成文件一致性检查和静态检查。

## 合并上游 DS Bot 仓库更新

盘点或移植 upstream 更新时，使用 [sync-upstream](.agents/skills/sync-upstream/SKILL.md)。逐项维护根目录的 [upstream-changelog.md](upstream-changelog.md)，按来源去重并记时间。每批都核对上游 `docs/plans/` 正文和索引，说明新增功能、设计变更及尚在计划中的行为。

修复问题或调整设计前，按相关功能、症状或模块查这份记录。若命中暂缓项或部分采用的余项，先提醒用户对应的上游 PR、处理逻辑和当时的本地差异。暂缓项保持现状，后续采用时再更新原条目。

本仓库只维护 macOS 上的插件。上游同步时跳过 Windows 和 Linux 专用代码、测试、夹具和 CI 作业。以下已删除模块不再跟随上游更新：

- DS Bot 独立桌面应用（`app/`、`start.ps1`）及其安装包。
- iOS 和 Android 客户端（`mobile/`），以及手机配对、远程访问和加密中继（`link/`）。
- Docker 部署（`docker/`、`docker-compose.yml`、`docker-compose.dev.yml`）。

合并时跳过仅涉及这些模块的改动，包括上游为它们新增或改名的文件、专用依赖、文档、测试和构建发布任务。遇到“本地已删除、上游已修改”的冲突，保留本地删除结果。若同一文件同时包含插件改动和已删除模块的改动，只合入插件需要的部分。上游对插件在 DSH Desktop 或 DSH Web 中运行的修复仍按插件改动处理。

## 分支、拉取请求与 Issue

完整流程见 [CONTRIBUTING.md 的 How we work 一节](CONTRIBUTING.md#how-we-work)。智能体必须遵守以下规则。

- 首次修改代码、文档或配置前，在实际工作目录核对当前分支。禁止在 `main`、`master` 上直接开发或提交。当前在这两个分支时，先切到 `dev` 或独立工作分支。`dev` 允许直接开发和本地提交。保留已有改动；共享目录或含无关改动时，为新任务建立独立工作树。紧急修复从 `main` 切出 `fix/hot-<name>`。
- 项目群中，主 Bot 在派发写入任务前核对并绑定任务分支及工作目录。执行 Bot 在首次写入前核对实际目录和分支与分配一致，并遵守上一条。群已建好合规工作树时直接复用；若分配到了 `main`、`master` 或错误目录，交由主 Bot 更正任务分配后继续。
- 日常任务需要独立工作分支时，从最新的 `dev` 切出，按 `fix/<issue>-<name>`、`feat/<issue>-<name>`、`docs/<name>` 或 `chore/<name>` 命名。禁止以 `dev/` 作为分支名前缀。日常开发的拉取请求以 `dev` 为目标分支。上游版本发布和紧急修复以 `main` 为目标。本地二开发版的合并、验收和发布顺序见「本地二次开发发版」。
- 使用 `scripts/merge-dev.sh` 更新工作分支。脚本会合并 `origin/dev`。如果 `ds-bot/client.js` 有冲突，脚本会采用 dev 分支的版本，再重新构建。禁止对已推送的分支执行变基（rebase），也禁止强制推送。
- 填写拉取请求模板，用 `Fixes #<number>` 关联 Issue。修复缺陷时，写明修复了哪个问题。在 Changelog 栏填写用户可见的变化，常规贡献由维护者在发版时汇总到 `CHANGELOG.md`。本地同步上游时，按 sync-upstream 技能更新该文件的本地插件章节。
- 带有 `maintainer` 标签的 Issue 或拉取请求留给维护者处理。禁止接手已分配给他人的 Issue。
- 修改行为前，先阅读 `docs/plans/` 中对应的设计和 `docs/vision.md`。涉及界面时，还须阅读 `docs/design/ui-standard.md`。更改已确定的设计须经维护者同意。新增大型功能时，须在同一个拉取请求中附上设计说明。
- 关闭 Issue 必须有依据。已修复的问题应给出对应的拉取请求或提交，重复问题应指向已有 Issue，决定不修复时应说明原因。
- 对 Issue 进行分类和处置时，遵循 [.agents/skills/issue-triage/SKILL.md](.agents/skills/issue-triage/SKILL.md)。
- 为界面改动录制演示 GIF 时，遵循 [.agents/skills/record-browser-gif/SKILL.md](.agents/skills/record-browser-gif/SKILL.md)。

## 目录结构

```text
DS-Bot/
├── ds-bot/               # DSH 插件，Bot 功能的主要开发目录
│   ├── plugin.js         # DSH 加载插件的入口，激活时调用 index.js
│   ├── index.js          # 初始化插件服务端，接入宿主提供的服务
│   ├── src/
│   │   ├── host/         # Bot 名册与存储、工具、会话、群聊、消息投递和 api/bot 通道等
│   │   └── client/       # Bot 界面源码，包括侧边栏、聊天、设置和浏览器面板
│   ├── client.js         # 由 src/client/ 构建生成，修改界面时编辑源码
│   ├── web-search.js     # 独立于 Bot 团队代码的 auto 网页搜索服务
│   ├── test/             # 插件单元测试和测试夹具
│   └── dev/              # 模拟模型、测试环境、冒烟测试、角色形象生成器
│       └── harness/      # 测试和静态检查所需的 DSH 软件包
├── browser-plugins/      # Bot 可选的浏览器操作插件，分别支持按元素操作、执行脚本和按目标完成任务
├── scripts/              # 仓库维护脚本，用于合并最新 dev 和扫描待提交材料中的敏感信息
├── docs/                 # 项目文档，包括产品愿景、功能设计和界面规范
│   ├── plans/            # 功能设计
│   └── design/           # 界面设计规范
├── README.md             # 英文项目首页，介绍 DS Bot、安装方式和用法
├── README.zh.md          # 中文项目首页
├── AGENTS.md             # 本指南，约定编程智能体的开发范围、工作流程和验证方式
├── CONTRIBUTING.md       # 英文贡献指南，说明如何开发、测试及提交拉取请求
├── CONTRIBUTING.zh.md    # 中文贡献指南
├── local-changelog.md    # 本地二次开发的逐版部署测试记录
├── CHANGELOG.md          # 上游按版本记录的功能、修复及其他重要变化
├── SECURITY_MODEL.md     # 安全模型，说明各运行环境的信任边界和权限
├── LICENSE               # 本项目采用的 Apache 2.0 许可证全文
├── NOTICE                # 项目版权声明，以及第三方代码和素材的来源与权利人
├── .agents/              # 本仓库的智能体技能，包括 Issue 分诊和界面演示 GIF 录制
├── .github/              # GitHub 的 Issue 和拉取请求模板，以及测试和发布工作流
├── .editorconfig         # 编辑器约定，包括字符编码、缩进和换行方式
├── .gitattributes        # Git 对特定文件的处理规则，保留脚本和测试夹具所需的换行格式
├── .gitignore            # Git 忽略规则，排除本地依赖、测试数据等
├── .git/                 # 本地 Git 元数据，保存对象、分支引用、索引和仓库配置
├── .dsh-test-project-task-final/     # 本地 DSH 测试数据，对应 project-task-final 测试环境
├── .dsh-test-project-task-native/    # 本地 DSH 测试数据，对应 project-task-native 测试环境
└── .dsh-test-project-task-scenario/  # 本地 DSH 测试数据，对应 project-task-scenario 测试环境
```

`.dsh-test-<name>/` 由测试环境按名称创建，已被 Git 忽略。上面列出的是当前工作区的实例，其他检出目录中的实例名和数量可能不同。

## 代码与提交风格

- 沿用修改位置周围代码的风格。函数保持短小，命名简明易懂。
- 仅在代码难以表达原因时添加注释，例如说明隐含约束、必须始终成立的条件或采用变通方案的原因。避免用注释复述代码行为。
- 提交信息使用英文，标题使用祈使句，正文说明修改原因。每次提交的改动应尽量小。
- 提交作者（author）应为提出修改请求的人。禁止将 AI 智能体或 Bot 设为作者或提交者（committer），也禁止为其添加 `Co-authored-by` 行。
- 插件中面向用户的文字使用英文。修改 README 或 README.zh.md 时，须同步更新另一份。
