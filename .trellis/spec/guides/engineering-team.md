# 工程团队的本地工具与交接

先从群设置取得项目工作目录，再从 task 取得本次执行的工作树和候选版本。下列命令均在相应项目根目录执行。角色资料只描述岗位，目录、task 编号、索引和导览名称跟随项目。

| 组件 | 写入者 | 下一位 Bot 怎样使用 |
| --- | --- | --- |
| DS Bot task | 管理员收件，任务助理规划与派工，各负责人登记开工和提交 | 依据本群的 `taskId` 读取验收条件、计划节点、轮次和阻塞。管理员在原群答复用户。 |
| Trellis | 管理员写 PRD，验收员提供验证证据，任务助理写完成报告 | 在 task 中写明 Trellis 目录，在 PRD 中记录群和 `taskId`。同目录的 `report.md` 记录候选版本、逐项结果、证据、遗留项和合并／发布状态。 |
| GitNexus | 本群架构责任人维护代码索引 | 先检查版本，再按符号查看上下游。其他 Bot 复用定位结果，涉及未提交修改时核对实际文件。 |
| Diffmap | 本群架构责任人随改动维护项目导览 | 从 Trellis 报告链接到受影响章节。写清修改前后、实际读写者、用户可见结果与源码位置。 |

本机确认可用的版本为 `@mindfoldhq/trellis@0.7.0-beta.4`、`gitnexus@1.6.12` 和 `@tanishqkancharla/diffmap@0.13.0`。前两者已有本地可执行文件，Diffmap 可通过 npm 本地缓存离线启动。首次接入时，开发负责人在实际执行 Bot 的工作目录运行以下检查。相邻的本地源码分别在 `Trellis/packages/cli`、`GitNexus/gitnexus`、`diffmap`；其他项目按自己的工具目录定位。

```sh
trellis --version
gitnexus --version
npm exec --offline --package=@tanishqkancharla/diffmap@0.13.0 -- diffmap --version
```

新环境缺工具时，按项目现有锁文件或已批准的本地发行包装入工具目录。举例，设 `tool_dir` 为该项目的工具安装目录，`package_file` 为已构建的本地 npm 压缩包，运行 `npm install --prefix "$tool_dir" "$package_file"`，在执行 Bot 环境将 `$tool_dir/node_modules/.bin` 加入 PATH。先核对 Trellis 提供 `init --dsh`、GitNexus 提供 `analyze --branch` 和 `--index-only`，再按下文做一次业务验证。仅导入同名 DS Bot 技能不会安装这些程序。

## 首次接入

1. 群管理员确认本群成员、工作目录和架构责任人。DS Bot 在群公告包含 `[taskId]` 时启用项目 task 路由。若用户已单独一行写入 `[taskAssistant:成员名]` 并绑定成功，由该成员规划与派工。任命独立任务助理是用户操作，尚未任命时管理员直接统筹。需要配置群工作目录时由主 Bot 按授权处理。
2. 开发负责人检查本项目组件。新接入 Trellis 时，在已安装其命令行工具的环境运行 `trellis init --dsh --skip-existing --language zh -y`。已经初始化的项目沿用既有配置和启用条件。管理员记录本项目的分支、提交、PR、评审、发布和维护权限。
3. 架构责任人给出一个带版本、可追到实际入口与存储的示例。没有专职架构工程师时，由群里已指定的开发或数据成员负责相同交付。初始化 task 或首个实际需求可用于验证收件、派工、执行者开工、独立复核和报告回读。[初始化的完成条件](../../../vision.md#项目的初始阶段怎样完成)

受理新的开发需求时，以下命令可创建对应的 Trellis 记录。

```sh
python3 .trellis/scripts/task.py create '展示任务重试记录' --slug task-retries --description '区分执行失败后的重试与首次派工，提供原轮次证据' --no-start
```

以命令返回的目录为准，填写其中的 `prd.md`。补充同一需求时沿用原目录。结束前，验收员将每项 PRD 条件映射到实际观察，任务助理确认最终报告可定位到同一个 task、同一版候选。

## 多分支索引与检索核验

以下命令适用于本机 GitNexus 1.6.12。先进入 task 指定的工作树，再判断本次需要的是集成分支现状、功能分支候选，还是尚未提交的修改。

1. **绑定版本。** 用下面四条 Git 命令与 task 登记的候选比对。最后一条列出暂存、未暂存和未跟踪文件。若正在分离头指针（detached HEAD）上验收，分支名会为空，此时按提交读源码，或使用已明确绑定到该提交的索引。保留其他 Bot 正在使用的检出状态。
2. **维护索引。** 架构责任人在目标分支的实际工作树运行 status，比对显示的仓库、分支、索引提交和候选提交。缺索引、候选提交不符或索引来源不明时，由维护人对同一工作树串行建索引，完成后在同一目录核对版本。他人继续使用各自的工作树。两个工作树即使分支名相似，也要显式指定仓库路径。只有通过版本和相关文件检查的结果才可共用。
3. **核实关系。** 检索时显式传仓库路径和分支，遇到同名符号再限定文件或符号 ID。对会改变派工、接口设计或验收范围的调用关系，打开调用方和被调用方，核实入口、调用方向及触发条件。动态注册、消息投递或配置驱动的路径需要继续查看绑定位置。要声称运行时行为已生效，还要有对应的运行证据。
4. **处理偏差。** 若相关文件有未提交改动，查看暂存和未暂存差异，直接读取新文件，只把索引当作定位线索。索引与源码冲突时，以候选源码修正结论，通知维护人核对并刷新。刷新后仍缺边，就记录缺失关系和替代证据。零命中只说明该次查询未找到。task 的执行记录注明工作树、分支、提交、相关本地差异，以及支撑结论的文件、符号和未核实路径。候选变化由开发负责人告知助理，助理通知依赖该结论的节点。

在目标工作树中核对仓库、分支和本地差异。

```sh
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short --untracked-files=all
gitnexus status --json
```

以下以 DS Bot 的 task 详情函数为例，仅在已核对的具名分支执行。圆括号让目录或分支检查失败时只退出这个命令块。analyze 行由维护人在需要建库或刷新时运行。已有适用索引的成员确定仓库和分支后即可用 context 行查询。

```sh
(
  cd "$(git rev-parse --show-toplevel)" || exit 1
  target_branch=$(git symbolic-ref --quiet --short HEAD) || exit 1
  gitnexus analyze --index-only --branch "$target_branch" || exit 1
  gitnexus status --json || exit 1
  gitnexus context projectCardDetail --repo "$PWD" --branch "$target_branch" --file ds-bot/src/host/project-tasks.js
)
```

本机隔离验证中，两个分支同一文件的入口分别调用不同函数，显式指定分支后可分别查到各自的目标函数。随后直接修改功能分支文件、保留相同提交且不刷新索引，查询仍返回原目标。因此提交号匹配后仍需检查相关工作区差异。此验证覆盖静态直接调用。

## 更新导览

架构责任人将已核实的变化写进受影响的章节，再校验导览。以下示例用本机缓存版本，换机可去掉 --offline 完成首次安装。validate 检查结构，serve 按需启动本地预览。

```sh
npm exec --offline --package=@tanishqkancharla/diffmap@0.13.0 -- diffmap validate .diffmap/specs/project-task
npm exec --offline --package=@tanishqkancharla/diffmap@0.13.0 -- diffmap serve .diffmap/specs/project-task
```

## 第一次试运行看什么

从原群消息找到对应的 task 和 PRD，从 task 看执行者、当前节点和进度，从报告找到同一候选及复验结果。若同一节点反复执行，记录每轮原因、发起者和结果。统计积压列明观察时间与等待时长，统计质量时分开记录环境错误、依赖等待和验收退回。缺记录时保留“原因待核实”。
