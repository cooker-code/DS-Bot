# 内置技能

“内置技能”（bundled skills）是随 Trellis CLI npm 包一同发布的多文件内建技能。不同于用户另行安装到各自 `.claude/skills/` 或其他平台技能根目录中的市场技能，`trellis init` 会自动将内置技能写入每个受支持平台的技能根目录，`trellis update` 则会保持其同步。它们是 Trellis 本身的一部分，而不是第三方内容。

内置技能是在 `packages/cli/src/templates/common/bundled-skills/<skill>/` 下的目录；其中已有自己的 `SKILL.md`（包含 YAML frontmatter），并可带有可选的 `references/`、资源文件或其他辅助文件。Trellis 会将整个目录树原样复制到每个平台的技能根目录，因此引用内容仍可按需加载，而不会被压平为一个过大的 `SKILL.md`。

## 什么属于内置技能（以及相邻概念）

| 源路径 | 类型 | 发布方式 |
| --- | --- | --- |
| `templates/common/bundled-skills/<name>/` | 内置技能（多文件） | 将整个目录复制到每个平台的技能根目录 |
| `templates/common/skills/<name>.md` | 单文件工作流技能 | 用 frontmatter 包装后，写入 `<root>/<name>/SKILL.md` |
| `templates/common/commands/<name>.md` | 斜杠命令／提示词 | 写入各平台的命令目录（`.claude/commands/trellis/`、`.cursor/commands/trellis-*.md`、`.gemini/commands/trellis/*.toml` 等） |
| `templates/<platform>/skills/` | 平台专属技能 | 仅写入该平台目录（例如 `.codex/skills/`） |
| `.claude/skills/<my-skill>/` 等路径下的用户技能 | 市场技能或用户自编写技能 | 完全不由 Trellis 管理 |

Trellis CLI 绝不会触碰非自身模板加载器产出的任何内容。用户手动放入平台技能根目录的任何文件都会保持不变。

## 当前内置技能（v0.6.0）

该集合会在运行时通过列出 `templates/common/bundled-skills/` 下的目录来发现：

| 技能 | 用途 |
| --- | --- |
| `trellis-meta` | 即本技能。向在用户项目中工作的 AI 说明本地 Trellis 架构和自定义入口。 |
| `trellis-session-insight` | 包装 `trellis mem` CLI，使 AI 知道何时以及如何读取过去的 Claude Code / Codex / Pi Agent 对话日志。 |
| `trellis-spec-bootstrap` | 从真实代码库创建或刷新 `.trellis/spec/` 的平台无关工作流（可选集成 GitNexus / ABCoder）。 |
| `trellis-channel` | 能力技能，指导 AI 何时应使用 `trellis channel` 来进行多智能体协作、论坛／线程持久化看板，以及调度器等待模式。 |

该列表在运行时发现，因此在 `bundled-skills/` 下新增目录，就是注册新技能所需的唯一步骤（见下文“新增内置技能”）。

## 各平台的内置技能落点

平台的完整文件集合——命令、工作流技能、智能体、钩子、内置技能——仅由 `collect<Platform>Templates()` 在 `packages/cli/src/configurators/<platform>.ts` 中描述一次。对于内置技能，这个描述由两次调用构成：`resolveBundledSkills(ctx)` 读取 `templates/common/bundled-skills/` 下的每个目录、解析占位符，并返回扁平的 `{relativePath, content}` 条目列表；`collectSkillTemplates(<skillsRoot>, <workflowSkills>, <bundledSkills>)` 将其折叠进平台的 `Map<filePath, content>`，路径为 `<skillsRoot>/<skill>/<relativePath>`。

全部 21 个平台都会获得完整的内置技能集合：

| 平台 | 内置技能根目录 |
| --- | --- |
| Claude Code | `.claude/skills/<skill>/` |
| Cursor | `.cursor/skills/<skill>/` |
| OpenCode | `.opencode/skills/<skill>/` |
| Codex | `.agents/skills/<skill>/` |
| Gemini CLI | `.agents/skills/<skill>/` |
| Pi | `.agents/skills/<skill>/` |
| Kimi | `.agents/skills/<skill>/` |
| Kilo | `.kilocode/skills/<skill>/` |
| Kiro | `.kiro/skills/<skill>/` |
| Antigravity | `.agent/skills/<skill>/` |
| Devin | `.devin/skills/<skill>/` |
| Qoder | `.qoder/skills/<skill>/` |
| Codebuddy | `.codebuddy/skills/<skill>/` |
| Copilot | `.github/skills/<skill>/` |
| Droid | `.factory/skills/<skill>/` |
| Reasonix | `.reasonix/skills/<skill>/` |
| ZCode | `.zcode/skills/<skill>/` |
| Trae | `.trae/skills/<skill>/` |
| OMP | `.omp/skills/<skill>/` |
| Grok | `.grok/skills/<skill>/` |
| Snow | `.snow/skills/<skill>/` |

Codex、Gemini CLI、Pi 和 Kimi 共用 `.agents/skills/` 根目录（上游 Agent Skills 工作区别名）。对于它们中任意多个平台都会写入的每个文件，各自收集器都必须产出逐字节一致的内容。

一份描述，两个消费者：

1. `trellis init` → `configurePlatform(platformId, cwd)` → `writeTemplateMap(cwd, collect<Platform>Templates())`。21 个平台中的 18 个在 `configurators/index.ts` 中的注册表条目实际就是 `fromTemplates(collect<Platform>Templates)`，也就是该组合。Claude Code、Codex 和 ZCode 分别显式实现自己的 `configure`，处理 `Map<path, content>` 无法表达的工作（可选的 `--with-statusline` 标志、刻意创建的空 `.codex/skills/` 目录、一次性控制台提示）；它们都不会重述文件清单。
2. `trellis update` → `collectPlatformTemplates(platformId)`（位于 `configurators/index.ts`）→ 同一张映射表，用于检测漂移并填充 `.trellis/.template-hashes.json`。

由于两个消费者读取同一份描述，init 和 update 不会对内置技能生成哪些文件产生分歧。

## 分发接线（代码路径）

将内置技能自动分发到平台技能根目录的机制位于两个文件中：

1. `packages/cli/src/templates/common/index.ts`
   - `listDirectories("bundled-skills")` 枚举磁盘上的技能目录。
   - `listBundledSkillFiles(skillDir)` 递归遍历每个技能目录，并为每个文件返回 `{relativePath, content}`。
   - `getBundledSkillTemplates()` 返回缓存的 `CommonBundledSkill[]`。

2. `packages/cli/src/configurators/shared.ts`
   - `resolveBundledSkills(ctx)` 将该列表扁平化为 `ResolvedSkillFile[]`，其路径为 `<skill>/<relativePath>`，且已解析占位符。
   - `collectSkillTemplates(skillsRoot, workflowSkills, bundledSkills)` 返回工作流技能和内置技能文件合并后的 `Map<filePath, content>`，其根路径是 `skillsRoot`。
   - `writeTemplateMap(cwd, files)` 是把收集到的映射写入磁盘的唯一写入器。

每个支持技能的平台都会从各自的 `collect<Platform>Templates()` 调用这两个辅助函数：要么直接调用（`claude.ts`、`codex.ts`、`copilot.ts`、`gemini.ts`、`grok.ts`、`kimi.ts`、`kiro.ts`、`omp.ts`、`opencode.ts`、`pi.ts`、`reasonix.ts`、`snow.ts`、`zcode.ts`），要么通过 `collectBothTemplates(ctx, cmdPath, skillRoot)`（位于 `shared.ts`），由后者代表同时拥有命令目录和技能根目录的平台作出同样两次调用（`antigravity.ts`、`codebuddy.ts`、`cursor.ts`、`devin.ts`、`droid.ts`、`kilo.ts`、`qoder.ts`、`trae.ts`）。

## 新增内置技能

形态和分发接线都已是通用机制，所以新增技能只需要变更文件并验证分发。

1. **创建目录树。**

   ```
   packages/cli/src/templates/common/bundled-skills/<my-skill>/
     SKILL.md                     # YAML frontmatter + body
     references/                  # optional
       <topic>.md
     assets/                      # optional (anything readable as utf-8)
   ```

2. **编写有效的 `SKILL.md` 头部。** frontmatter 至少必须包含：

   ```yaml
   ---
   name: <my-skill>
   description: "When the AI should reach for this skill. Triggering phrases go here."
   ---
   ```

   `description` 是每个平台自动触发机制要匹配的内容，因此它应描述用户意图触发条件，而不是技能内部实现。

3. **在适当处使用占位符。** 内置技能内容会经过 `resolvePlaceholders(file.content, ctx)`。`resolvePlaceholders` 支持的任意 `{{platform_name}}`、`{{python_cmd}}` 等 token 都会按平台替换。

4. **不需要增加分发接线。** `listDirectories("bundled-skills")` 会自动发现新目录，因此所有平台会在下一次 `trellis init` 或 `trellis update` 时得到它。

5. **在发布前验证分发路径。** 省略以下任一步骤曾导致功能被记录为内置，但已发布的 npm tarball 却缺少文件：

   - 源文件存在于将要打标签的分支中。
   - `pnpm --filter @mindfoldhq/trellis build` 会将资源复制到 `dist/templates/common/bundled-skills/<skill>/`。
   - `npm pack --dry-run --json` 包含预期的 `dist/**` 路径。
   - 在全新的临时项目中，`trellis init` 会写入 `.claude/skills/<skill>/SKILL.md`、`.agents/skills/<skill>/SKILL.md`、`.zcode/skills/<skill>/SKILL.md` 等文件。
   - `.trellis/.template-hashes.json` 列出生成的文件。
   - 在该临时项目中运行 `trellis update --dry-run` 会报告 “Already up to date!”。

6. **若技能会在其他项目升级到的版本中新增，请添加迁移清单条目。** 没有显式清单条目时，文件仍会通过 `trellis update` 的标准“缺失文件”分支落入项目；但清单会使这项变更出现在更新日志中。

## 在本地覆盖内置技能

不存在正式的“项目本地技能”机制（例如 `.trellis/skills/`）。内置技能基于平台根目录，因此任何覆盖也必须基于平台根目录。

受支持的模式依赖 `trellis update` 既有的模板哈希差异机制：

1. 直接编辑本地文件。例如：`.claude/skills/trellis-meta/SKILL.md`。
2. 该文件的哈希现在会与 `.trellis/.template-hashes.json` 中的条目不同。
3. 下一次 `trellis update` 会检测到用户修改并保持文件不变（除非显式传入 `--force`，Trellis 从不覆盖用户修改过的文件）。

注意事项：

- 覆盖只适用于你编辑过目录的一个平台。例如，要同时覆盖 Claude Code 和 Codex 中的同一技能，必须同时编辑 `.claude/skills/<name>/` 和 `.agents/skills/<name>/`。
- 未来运行 `trellis update --force` 会覆盖本地编辑。请将覆盖内容纳入版本控制，必要时可以重新应用。
- 安装在同一平台技能根目录、但使用不同文件夹名称的市场技能（例如 `.claude/skills/my-custom-meta/`）不会被 Trellis 触碰；当目标是增加行为而非修改内置技能时，这是更干净的选择。
- 团队私有约定应放在 `.trellis/spec/` 或单独的市场式本地技能中，不应修改 `trellis-meta` 本身。参见 `customize-local/add-project-local-conventions.md`。

## 从项目中移除内置技能

内置技能没有按项目禁用的标志。有两种选择：

1. **删除每个平台技能根目录中的目录。** `trellis update` 会看到文件缺失，将其与 `.template-hashes.json` 比较，并把删除视作其他任意用户修改——除非传入 `--force`，它不会静默重新创建该目录。

2. **固定到未发布该技能的 Trellis 版本。** 内置技能集合在构建时确定，因此要永久排除当前版本发布的某个技能，唯一方式是安装旧版 CLI。

第三种选择——全局禁用所有内置技能——不受支持。分发是无条件的：`collect<Platform>Templates()` 不接收参数，因此没有可让标志进入的位置。要增加这种能力，意味着要修改全部 21 个平台的该签名，以及 `configurators/index.ts` 中的 `collectPlatformTemplates`。

## 操作规则

- 将 `templates/common/bundled-skills/` 视为内置技能存在与否的唯一事实来源。不要手动维护逐平台的技能清单。
- 不要在内置 `SKILL.md` 中加入平台专属逻辑。若行为是平台专属的，请将它放入 `templates/<platform>/skills/`。
- 不要将内置技能耦合到特定 CLI 二进制命令（例如 `trellis mem`），除非在技能的 description 和引用材料中呈现该依赖——使用旧版本的用户可能没有该命令。
- 不要把项目私有内容存放在内置技能中。内置技能是公开内容，会发布给每一位用户；项目规则应放在 `.trellis/spec/` 或本地技能中。
