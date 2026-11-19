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

### 本地验证

- **只改文档或翻译**时，核对改动涉及的内容、链接和命令即可，跳过应用构建、代码静态检查和单元测试。若改写了可执行示例，验证该示例。
- **改代码**时，从变更的行为和受影响的调用方选择测试。例如，只改群聊搜索时，可在 `ds-bot/` 下运行 `npm test -- test/group-search.test.js`。改动涉及多个模块时，补跑这些模块的相关用例。修改客户端源码时按上文重新构建并检查生成文件。修改 `index.js` 或 `src/host/` 时，还须运行冒烟测试，使用空闲端口，并在结束后停止自己启动的测试环境和进程。
- **影响范围无法可靠界定**（例如更改公共测试加载器），或任务明确要求全量回归时，先核对本工作区最新规则和正在运行的测试，确认需要全量后由一个会话执行 `npm run test:all`。其他会话复用结果。修复失败后，先重跑失败项及修复影响的用例。

交付时说明实际验证的范围。提交拉取请求后，持续集成（CI）会自动运行全量单元测试、生成文件一致性检查和静态检查。

## 合并上游 DS Bot 仓库更新

本仓库只维护插件。以下已删除模块不再跟随上游更新：

- DS Bot 独立桌面应用（`app/`、`start.ps1`）及其安装包。
- iOS 和 Android 客户端（`mobile/`），以及手机配对、远程访问和加密中继（`link/`）。
- Docker 部署（`docker/`、`docker-compose.yml`、`docker-compose.dev.yml`）。

合并时跳过仅涉及这些模块的改动，包括上游为它们新增或改名的文件、专用依赖、文档、测试和构建发布任务。遇到“本地已删除、上游已修改”的冲突，保留本地删除结果。若同一文件同时包含插件改动和已删除模块的改动，只合入插件需要的部分。上游对插件在 DSH Desktop 或 DSH Web 中运行的修复仍按插件改动处理。

## 分支、拉取请求与 Issue

完整流程见 [CONTRIBUTING.md 的 How we work 一节](CONTRIBUTING.md#how-we-work)。智能体必须遵守以下规则。

- 从最新的 `dev` 创建工作分支，按 `fix/<issue>-<name>`、`feat/<issue>-<name>`、`docs/<name>` 或 `chore/<name>` 命名。禁止以 `dev/` 作为分支名前缀。日常开发的拉取请求以 `dev` 为目标分支。只有版本发布和紧急修复才合入 `main`。
- 使用 `scripts/merge-dev.sh` 更新工作分支。脚本会合并 `origin/dev`。如果 `ds-bot/client.js` 有冲突，脚本会采用 dev 分支的版本，再重新构建。禁止对已推送的分支执行变基（rebase），也禁止强制推送。
- 填写拉取请求模板，用 `Fixes #<number>` 关联 Issue。修复缺陷时，写明修复了哪个问题。在 Changelog 栏填写用户可见的变化，禁止编辑 `CHANGELOG.md`。
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
├── CHANGELOG.md          # 按版本记录功能、修复及其他重要变化
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
